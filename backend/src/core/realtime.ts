import {
  ApiGatewayManagementApiClient,
  GoneException,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import type { AuthIdentity } from "../types/auth";
import { type Cache, tryCache } from "./cache";
import type { ApiResult } from "./types";

// Una conexión de API Gateway WebSocket dura como máximo 2 horas.
const CONNECTION_TTL = 2 * 60 * 60;

const connKey = (id: string) => `ws:conn:${id}`;
const restaurantKey = (id: string) => `ws:restaurant:${id}`;
const userKey = (id: string) => `ws:user:${id}`;

// Registro de conexiones en ElastiCache: por conexión (para saber de quién
// es al desconectarse), por restaurante y por usuario.
export async function registerConnection(
  cache: Cache,
  connectionId: string,
  identity: AuthIdentity,
): Promise<void> {
  await cache.set(connKey(connectionId), JSON.stringify(identity), CONNECTION_TTL);
  await cache.addToSet(restaurantKey(identity.restaurantId), connectionId, CONNECTION_TTL);
  await cache.addToSet(userKey(identity.userId), connectionId, CONNECTION_TTL);
}

export async function removeConnection(cache: Cache, connectionId: string): Promise<void> {
  const raw = await cache.get(connKey(connectionId));
  if (raw) {
    const identity = JSON.parse(raw) as AuthIdentity;
    await cache.removeFromSet(restaurantKey(identity.restaurantId), connectionId);
    await cache.removeFromSet(userKey(identity.userId), connectionId);
  }
  await cache.del(connKey(connectionId));
}

// Envía un mensaje a una conexión. "gone" si el cliente ya se desconectó.
export interface Notifier {
  send(connectionId: string, payload: unknown): Promise<"ok" | "gone">;
}

// `endpoint` es la URL de la etapa del WebSocket:
// https://{api-id}.execute-api.{region}.amazonaws.com/{stage}
export function createWebSocketNotifier(endpoint: string): Notifier {
  const client = new ApiGatewayManagementApiClient({ endpoint });
  return {
    async send(connectionId, payload) {
      try {
        await client.send(
          new PostToConnectionCommand({
            ConnectionId: connectionId,
            Data: Buffer.from(JSON.stringify(payload)),
          }),
        );
        return "ok";
      } catch (err) {
        if (err instanceof GoneException) return "gone";
        throw err;
      }
    },
  };
}

async function sendAll(
  cache: Cache,
  notifier: Notifier,
  connectionIds: string[],
  payload: unknown,
): Promise<void> {
  await Promise.all(
    connectionIds.map(async (id) => {
      try {
        if ((await notifier.send(id, payload)) === "gone") {
          await tryCache(() => removeConnection(cache, id), undefined);
        }
      } catch (err) {
        // Una pantalla que no recibe el aviso se pone al día con el polling
        // cada 15 s (RNF03); no se reintenta la escritura por esto.
        console.error(`No se pudo avisar a la conexión ${id}:`, err);
      }
    }),
  );
}

function isOrder(body: unknown): body is { id: string } {
  return typeof body === "object" && body !== null && "id" in body;
}

// Tras procesar una escritura de la cola:
//   - quien la hizo recibe el resultado ("write.result"), sea éxito o error;
//   - si el pedido cambió (2xx), todo su restaurante recibe "order.updated".
export async function notifyWriteResult(
  cache: Cache,
  notifier: Notifier,
  identity: AuthIdentity,
  requestId: string,
  result: ApiResult,
): Promise<void> {
  const own = await tryCache(() => cache.members(userKey(identity.userId)), []);
  await sendAll(cache, notifier, own, {
    type: "write.result",
    requestId,
    status: result.status,
    body: result.body,
  });

  if (result.status >= 200 && result.status < 300 && isOrder(result.body)) {
    const all = await tryCache(() => cache.members(restaurantKey(identity.restaurantId)), []);
    await sendAll(cache, notifier, all, { type: "order.updated", order: result.body });
  }
}
