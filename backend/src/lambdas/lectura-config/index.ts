import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { resolveIdentity } from "../../core/identity";
import { handleRestEvent, toProxyResult } from "../../core/rest";
import { getCache, getDb, getNotifier, getReadDb, getVerifier } from "../../core/runtime";
import { handleWebSocketEvent, type WebSocketEvent } from "../../core/websocket";
import { ordersReadRoutes } from "../../modules/orders/routes";
import { productRoutes } from "../../modules/products/routes";
import { profileRoutes, restaurantRoutes } from "../../modules/restaurant/routes";

// Lambda Lectura y Configuración:
//   - API Gateway REST la invoca directamente (sin cola) para consultas,
//     perfil y configuración, porque el usuario espera la respuesta en
//     pantalla. Lee de ElastiCache o de la instancia de lectura de Aurora y
//     guarda la configuración (modalidad y menú) en la de escritura.
//   - API Gateway WebSocket la invoca al abrir ($connect) y cerrar
//     ($disconnect) una conexión, para registrarla en ElastiCache.
export const routes = [...ordersReadRoutes, ...profileRoutes, ...restaurantRoutes, ...productRoutes];

function isWebSocket(event: unknown): event is WebSocketEvent {
  const ctx = (event as { requestContext?: { connectionId?: unknown } }).requestContext;
  return typeof ctx?.connectionId === "string";
}

export async function handler(
  event: APIGatewayProxyEvent | WebSocketEvent,
): Promise<APIGatewayProxyResult | { statusCode: number }> {
  if (isWebSocket(event)) {
    return handleWebSocketEvent(getReadDb(), event, {
      cache: getCache(),
      verifyToken: getVerifier(),
      resolve: resolveIdentity,
    });
  }

  return toProxyResult(
    await handleRestEvent(getReadDb(), routes, event, resolveIdentity, {
      cache: getCache(),
      writeDb: getDb(),
      notifier: getNotifier(),
    }),
  );
}
