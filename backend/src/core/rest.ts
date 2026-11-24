import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import type { Database } from "../db/pool";
import { HttpError } from "../utils/httpError";
import { dispatch, errorResult, internalErrorResult, invalidJson } from "./dispatch";
import type { ApiResult, ResolveIdentity, Route } from "./types";

function lowerKeys(
  headers: Record<string, string | undefined> | null | undefined,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(headers ?? {})) out[k.toLowerCase()] = v;
  return out;
}

function parseBody(raw: string | null, isBase64: boolean): unknown {
  if (raw === null || raw === "") return undefined;
  const text = isBase64 ? Buffer.from(raw, "base64").toString("utf8") : raw;
  try {
    return JSON.parse(text);
  } catch {
    throw invalidJson();
  }
}

// Evento de API Gateway REST (integración proxy) -> resultado del contrato.
// El autorizador de Cognito de API Gateway ya validó el token; si aun así no
// llega el `sub`, se responde 401 (falla cerrado).
export async function handleRestEvent(
  db: Database,
  routes: readonly Route[],
  event: APIGatewayProxyEvent,
  resolve: ResolveIdentity,
): Promise<ApiResult> {
  const ctx = { method: event.httpMethod, resource: event.resource };
  try {
    const sub = event.requestContext?.authorizer?.claims?.sub as string | undefined;
    if (!sub) {
      throw new HttpError(401, "UNAUTHENTICATED", "Autenticación requerida");
    }
    const identity = await resolve(db, sub);

    return await dispatch(db, routes, {
      method: event.httpMethod,
      resource: event.resource,
      params: (event.pathParameters ?? {}) as Record<string, string>,
      query: event.queryStringParameters ?? {},
      headers: lowerKeys(event.headers),
      body: parseBody(event.body, event.isBase64Encoded),
      identity,
      requestId: event.requestContext?.requestId,
    });
  } catch (err) {
    if (err instanceof HttpError) return errorResult(err, ctx);
    return internalErrorResult(err);
  }
}

export function toProxyResult(result: ApiResult): APIGatewayProxyResult {
  return {
    statusCode: result.status,
    headers: { "Content-Type": "application/json", ...result.headers },
    body: JSON.stringify(result.body),
  };
}
