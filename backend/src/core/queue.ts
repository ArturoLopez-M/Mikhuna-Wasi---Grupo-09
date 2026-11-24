import type { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";
import { z } from "zod";
import type { Database } from "../db/pool";
import { HttpError } from "../utils/httpError";
import { dispatch, errorResult, invalidJson } from "./dispatch";
import type { ApiResult, ResolveIdentity, Route } from "./types";

// Mensaje que API Gateway REST deja en la cola del módulo (integración directa
// con SQS, mapping template). `sub` viene del autorizador de Cognito, nunca
// del cliente; `body` es el cuerpo tal cual llegó, como texto.
export const queueMessageSchema = z.object({
  method: z.string(),
  resource: z.string(),
  pathParameters: z.record(z.string(), z.string()).nullish(),
  headers: z.record(z.string(), z.string()).nullish(),
  body: z.string().nullish(),
  sub: z.string().min(1),
  requestId: z.string().min(1),
});

export type QueueMessage = z.infer<typeof queueMessageSchema>;

// `done`: el mensaje se procesó (bien o con un error de negocio) y se borra de
// la cola. `retry`: error técnico; SQS lo reentrega y, al tercer intento
// fallido, lo mueve a la DLQ (maxReceiveCount = 3).
export type QueueOutcome =
  | { kind: "done"; requestId?: string; result: ApiResult }
  | { kind: "retry"; error: unknown };

function lowerKeys(h: Record<string, string> | null | undefined) {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(h ?? {})) out[k.toLowerCase()] = v;
  return out;
}

export async function processMessage(
  db: Database,
  routes: readonly Route[],
  raw: string,
  resolve: ResolveIdentity,
): Promise<QueueOutcome> {
  let message: QueueMessage;
  try {
    message = queueMessageSchema.parse(JSON.parse(raw));
  } catch (err) {
    // Un mensaje mal formado no se arregla reintentando: se registra y se
    // descarta. Indica un error de configuración de API Gateway.
    console.error("Mensaje de cola inválido:", err instanceof Error ? err.message : err);
    return {
      kind: "done",
      result: errorResult(invalidJson(), { method: "?", resource: "?" }),
    };
  }

  const ctx = { method: message.method, resource: message.resource };
  try {
    const identity = await resolve(db, message.sub);
    let body: unknown;
    if (message.body !== null && message.body !== undefined && message.body !== "") {
      try {
        body = JSON.parse(message.body);
      } catch {
        throw invalidJson();
      }
    }

    const result = await dispatch(db, routes, {
      method: message.method,
      resource: message.resource,
      params: message.pathParameters ?? {},
      query: {},
      headers: lowerKeys(message.headers),
      body,
      identity,
      requestId: message.requestId,
    });
    return { kind: "done", requestId: message.requestId, result };
  } catch (err) {
    if (err instanceof HttpError) {
      return { kind: "done", requestId: message.requestId, result: errorResult(err, ctx) };
    }
    return { kind: "retry", error: err };
  }
}

// Resultado de la operación. En la fase 2 se enviará por WebSocket a las
// pantallas del restaurante; por ahora queda en CloudWatch Logs.
function logOutcome(outcome: Extract<QueueOutcome, { kind: "done" }>): void {
  console.log(
    JSON.stringify({
      event: "WRITE_RESULT",
      requestId: outcome.requestId ?? null,
      status: outcome.result.status,
      at: new Date().toISOString(),
    }),
  );
}

// Handler de SQS con ReportBatchItemFailures: solo se reintentan los mensajes
// que fallaron por un error técnico; los demás del lote se confirman.
export function createQueueHandler(
  routes: readonly Route[],
  getDb: () => Database,
  resolve: ResolveIdentity,
) {
  return async (event: SQSEvent): Promise<SQSBatchResponse> => {
    const db = getDb();
    const batchItemFailures: SQSBatchResponse["batchItemFailures"] = [];

    // En orden: dos cambios del mismo pedido no deben invertirse.
    for (const record of event.Records as SQSRecord[]) {
      const outcome = await processMessage(db, routes, record.body, resolve);
      if (outcome.kind === "retry") {
        console.error(
          `Error técnico, se reintentará el mensaje ${record.messageId}:`,
          outcome.error,
        );
        batchItemFailures.push({ itemIdentifier: record.messageId });
      } else {
        logOutcome(outcome);
      }
    }

    return { batchItemFailures };
  };
}
