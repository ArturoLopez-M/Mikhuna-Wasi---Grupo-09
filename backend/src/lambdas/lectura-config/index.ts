import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { resolveIdentity } from "../../core/identity";
import { handleRestEvent, toProxyResult } from "../../core/rest";
import { getDb } from "../../core/runtime";
import { ordersReadRoutes } from "../../modules/orders/routes";

// Lambda Lectura y Configuración: consultas, perfil y configuración. API
// Gateway REST la invoca directamente (sin cola) porque el usuario espera la
// respuesta en pantalla.
export const routes = [...ordersReadRoutes];

export async function handler(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  return toProxyResult(
    await handleRestEvent(getDb(), routes, event, resolveIdentity),
  );
}
