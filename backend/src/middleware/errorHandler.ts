import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../utils/httpError";

export function notFoundHandler(
  _req: Request,
  _res: Response,
  next: NextFunction,
): void {
  next(new HttpError(404, "NOT_FOUND", "Ruta no encontrada"));
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof HttpError) {
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