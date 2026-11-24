import type { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";
import { z } from "zod";
import type { Database } from "../db/pool";
import { HttpError } from "../utils/httpError";
import { dispatch, errorResult, invalidJson } from "./dispatch";
import type { AuthIdentity } from "../types/auth";
import { type Cache, orderCacheKey, tryCache } from "./cache";
import { type Notifier, notifyWriteResult } from "./realtime";
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
  | { kind: "done"; requestId?: string; identity?: AuthIdentity; result: ApiResult }
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
  let identity: AuthIdentity | undefined;
  try {
    identity = await resolve(db, message.sub);
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
    return { kind: "done", requestId: message.requestId, identity, result };
  } catch (err) {
    if (err instanceof HttpError) {
      return {
        kind: "done",
        requestId: message.requestId,
        identity,
        result: errorResult(err, { ...ctx, identity }),
      };
    }
    return { kind: "retry", error: err };
  }
}

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

function requestIdOf(raw: string): string | undefined {
  try {
    const id = (JSON.parse(raw) as { requestId?: unknown }).requestId;
    return typeof id === "string" && id !== "" ? id : undefined;
  } catch {
    return undefined;
  }
}

export interface QueueDeps {
  // ElastiCache y WebSocket son opcionales: sin ellos el consumidor sigue
  // funcionando (RNF07) y la base evita duplicados por la idempotencia.
  cache?: Cache;
  notifier?: Notifier;
}

// RNF02: detección de duplicados en ElastiCache por requestId.
//   - "done:<id>": el mensaje ya se procesó -> se descarta sin tocar la base.
//   - "lock:<id>": otra Lambda lo está procesando ahora (SQS estándar puede
//     entregar el mismo mensaje dos veces) -> se devuelve a la cola para más
//     tarde, así no se pierde si la otra Lambda falla.
const DONE_TTL = 24 * 60 * 60;
const LOCK_TTL = 30;
const doneKey = (id: string) => `dedup:done:${id}`;
const lockKey = (id: string) => `dedup:lock:${id}`;

type Step = "process" | "skip" | "busy";

async function claim(cache: Cache | undefined, requestId: string | undefined): Promise<Step> {
  if (!cache || !requestId) return "process";
  if (await tryCache(() => cache.get(doneKey(requestId)), null)) return "skip";
  // Si ElastiCache falla, se procesa igual (la base evita el duplicado).
  const locked = await tryCache(() => cache.set(lockKey(requestId), "1", LOCK_TTL, true), true);
  return locked ? "process" : "busy";
}

// Handler de SQS con ReportBatchItemFailures: solo se reintentan los mensajes
// que fallaron por un error técnico; los demás del lote se confirman.
export function createQueueHandler(
  routes: readonly Route[],
  getDb: () => Database,
  resolve: ResolveIdentity,
  getDeps: () => QueueDeps = () => ({}),
) {
  return async (event: SQSEvent): Promise<SQSBatchResponse> => {
    const db = getDb();
    const { cache, notifier } = getDeps();
    const batchItemFailures: SQSBatchResponse["batchItemFailures"] = [];

    // En orden: dos cambios del mismo pedido no deben invertirse.
    for (const record of event.Records as SQSRecord[]) {
      const requestId = requestIdOf(record.body);
      const step = await claim(cache, requestId);

      if (step === "skip") {
        console.log(JSON.stringify({ event: "DUPLICATE_SKIPPED", requestId }));
        continue;
      }
      if (step === "busy") {
        batchItemFailures.push({ itemIdentifier: record.messageId });
        continue;
      }

      const outcome = await processMessage(db, routes, record.body, resolve);

      if (outcome.kind === "retry") {
        console.error(
          `Error técnico, se reintentará el mensaje ${record.messageId}:`,
          outcome.error,
        );
        if (cache && requestId) await tryCache(() => cache.del(lockKey(requestId)), undefined);
        batchItemFailures.push({ itemIdentifier: record.messageId });
        continue;
      }

      logOutcome(outcome);
      if (cache && requestId) {
        const id = requestId;
        await tryCache(() => cache.set(doneKey(id), String(outcome.result.status), DONE_TTL), false);
        await tryCache(() => cache.del(lockKey(id)), undefined);
      }

      const body = outcome.result.body as { id?: unknown } | undefined;
      const ok = outcome.result.status >= 200 && outcome.result.status < 300;
      if (cache && outcome.identity && ok && typeof body?.id === "string") {
        const key = orderCacheKey(outcome.identity.restaurantId, body.id);
        await tryCache(() => cache.del(key), undefined);
      }

      // El aviso nunca provoca un reintento: la escritura ya se guardó.
      if (cache && notifier && outcome.identity && requestId) {
        try {
          await notifyWriteResult(cache, notifier, outcome.identity, requestId, outcome.result);
        } catch (err) {
          console.error("No se pudo enviar el aviso por WebSocket:", err);
        }
      }
    }

    return { batchItemFailures };
  };
}
