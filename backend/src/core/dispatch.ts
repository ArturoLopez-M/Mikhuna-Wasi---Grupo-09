import type { Database } from "../db/pool";
import type { AuthIdentity } from "../types/auth";
import { HttpError } from "../utils/httpError";
import type { ApiRequest, ApiResult, Route, RouteDeps } from "./types";

export function findRoute(
  routes: readonly Route[],
  method: string,
  resource: string,
): Route | undefined {
  return routes.find((r) => r.method === method && r.resource === resource);
}

interface LogContext {
  method: string;
  resource: string;
  identity?: AuthIdentity;
}

// RNF05: los accesos rechazados (401/403) se registran con usuario,
// restaurante (si se conocen), ruta y fecha/hora. Es una línea JSON para que
// CloudWatch Logs pueda filtrarla con un metric filter y disparar una alarma.
// Nunca se registra el token ni el cuerpo de la petición.
function logAccessDenied(ctx: LogContext, err: HttpError): void {
  console.warn(
    JSON.stringify({
      event: "ACCESS_DENIED",
      status: err.statusCode,
      code: err.code,
      userId: ctx.identity?.userId ?? null,
      restaurantId: ctx.identity?.restaurantId ?? null,
      method: ctx.method,
      path: ctx.resource,
      at: new Date().toISOString(),
    }),
  );
}

// Formato único de error del contrato (Docs/api-contract.md, sección 3).
export function errorResult(err: HttpError, ctx: LogContext): ApiResult {
  if (err.statusCode === 401 || err.statusCode === 403) {
    logAccessDenied(ctx, err);
  }
  return {
    status: err.statusCode,
    body: {
      error: {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      },
    },
  };
}

// Error inesperado: el detalle va solo al log, la respuesta no filtra nada.
export function internalErrorResult(err: unknown): ApiResult {
  console.error(err);
  return {
    status: 500,
    body: {
      error: { code: "INTERNAL_ERROR", message: "Error interno del servidor" },
    },
  };
}

export const invalidJson = () =>
  new HttpError(400, "VALIDATION_ERROR", "Solicitud inválida");

// Ejecuta la ruta: (1) existe, (2) rol permitido, (3) handler. Los errores de
// negocio (HttpError) se devuelven como resultado; los inesperados se lanzan
// para que quien llama decida (500 en REST, reintento en SQS).
export async function dispatch(
  db: Database,
  routes: readonly Route[],
  req: ApiRequest,
  deps: RouteDeps = {},
): Promise<ApiResult> {
  try {
    const route = findRoute(routes, req.method, req.resource);
    if (!route) throw new HttpError(404, "NOT_FOUND", "Ruta no encontrada");

    if (route.roles && !route.roles.includes(req.identity.role)) {
      throw new HttpError(
        403,
        "FORBIDDEN",
        "No tienes permiso para realizar esta acción",
      );
    }

    const target = route.write ? (deps.writeDb ?? db) : db;
    return await route.handle(target, req, deps);
  } catch (err) {
    if (err instanceof HttpError) return errorResult(err, req);
    throw err;
  }
}
