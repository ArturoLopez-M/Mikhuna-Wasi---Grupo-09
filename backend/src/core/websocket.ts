import type { VerifyToken } from "../auth/cognito";
import type { Database } from "../db/pool";
import type { AuthIdentity } from "../types/auth";
import { HttpError } from "../utils/httpError";
import { type Cache, tryCache } from "./cache";
import { errorResult } from "./dispatch";
import { registerConnection, removeConnection } from "./realtime";
import type { ResolveIdentity } from "./types";

// Lo que se usa del evento de API Gateway WebSocket.
export interface WebSocketEvent {
  requestContext: { routeKey: string; connectionId: string };
  queryStringParameters?: Record<string, string | undefined> | null;
}

export interface WebSocketDeps {
  cache?: Cache;
  verifyToken?: VerifyToken;
  resolve: ResolveIdentity;
}

export interface WebSocketResult {
  statusCode: number;
}

// $connect: el navegador no puede mandar cabeceras al abrir un WebSocket, así
// que el access token de Cognito llega en ?token=. Se valida igual que en
// REST (firma, emisor, vencimiento, tipo access y client_id) y luego se busca
// al usuario en la base. Solo el personal autenticado recibe los cambios de
// su restaurante (diagrama: "valida token (REST y WebSocket)").
async function connect(
  db: Database,
  event: WebSocketEvent,
  deps: WebSocketDeps,
): Promise<WebSocketResult> {
  const ctx = { method: "WS", resource: "$connect" };
  let identity: AuthIdentity | undefined;
  try {
    const token = event.queryStringParameters?.token;
    if (!token || !deps.verifyToken) {
      throw new HttpError(401, "UNAUTHENTICATED", "Falta el token de acceso");
    }

    let sub: string;
    try {
      ({ sub } = await deps.verifyToken(token));
    } catch {
      throw new HttpError(401, "UNAUTHENTICATED", "Token inválido o vencido");
    }

    identity = await deps.resolve(db, sub);
  } catch (err) {
    if (err instanceof HttpError) {
      return { statusCode: errorResult(err, { ...ctx, identity }).status };
    }
    throw err;
  }

  // Sin ElastiCache no hay dónde registrar la conexión: se rechaza y la
  // pantalla usa el polling cada 15 s (RNF03).
  if (!deps.cache) return { statusCode: 503 };
  await registerConnection(deps.cache, event.requestContext.connectionId, identity);
  return { statusCode: 200 };
}

export async function handleWebSocketEvent(
  db: Database,
  event: WebSocketEvent,
  deps: WebSocketDeps,
): Promise<WebSocketResult> {
  const { routeKey, connectionId } = event.requestContext;

  if (routeKey === "$connect") return connect(db, event, deps);

  if (routeKey === "$disconnect") {
    const cache = deps.cache;
    if (cache) await tryCache(() => removeConnection(cache, connectionId), undefined);
    return { statusCode: 200 };
  }

  // Los clientes no envían mensajes por el WebSocket: las acciones van por
  // REST. Cualquier otro mensaje se ignora.
  return { statusCode: 200 };
}
