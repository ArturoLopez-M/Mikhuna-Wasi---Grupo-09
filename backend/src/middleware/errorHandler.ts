import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../utils/httpError";

export function notFoundHandler(
  _req: Request,
  _res: Response,
  next: NextFunction,
): void {
  next(new HttpError(404, "NOT_FOUND", "Ruta no encontrada"));
}

// RNF05: los accesos rechazados (401/403) se registran con usuario,
// restaurante (si se conocen), ruta y fecha/hora. Es una línea JSON para que
// CloudWatch Logs pueda filtrarla con un metric filter y disparar una alarma.
// Nunca se registra el token ni el cuerpo de la petición.
function logAccessDenied(req: Request, err: HttpError): void {
  console.warn(
    JSON.stringify({
      event: "ACCESS_DENIED",
      status: err.statusCode,
      code: err.code,
      userId: req.identity?.userId ?? null,
      restaurantId: req.identity?.restaurantId ?? null,
      method: req.method,
      path: req.originalUrl.split("?")[0],
      at: new Date().toISOString(),
    }),
  );
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof HttpError) {
    if (err.statusCode === 401 || err.statusCode === 403) {
      logAccessDenied(req, err);
    }
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      },
    });
    return;
  }

  // Express (body-parser) marca un JSON mal formado con status 400.
  // El contrato solo define este caso como VALIDATION_ERROR; cualquier otro
  // error de Express cae al 500 y queda en el log.
  if (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    err.status === 400
  ) {
    res.status(400).json({
      error: { code: "VALIDATION_ERROR", message: "Solicitud inválida" },
    });
    return;
  }

  // El detalle va solo al log; la respuesta no filtra información interna.
  console.error(err);
  res.status(500).json({
    error: { code: "INTERNAL_ERROR", message: "Error interno del servidor" },
  });
}