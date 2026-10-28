import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../utils/httpError";

export function notFoundHandler(
  _req: Request,
  _res: Response,
  next: NextFunction,
): void {
  next(new HttpError(404, "Ruta no encontrada"));
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof HttpError) {
    res.status(err.statusCode).json({ error: { message: err.message } });
    return;
  }

  // Errores de cliente generados por Express (por ejemplo, un JSON mal formado).
  if (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    typeof err.status === "number" &&
    err.status >= 400 &&
    err.status < 500
  ) {
    res.status(err.status).json({ error: { message: "Solicitud inválida" } });
    return;
  }

  console.error(err);
  res.status(500).json({ error: { message: "Error interno del servidor" } });
}
