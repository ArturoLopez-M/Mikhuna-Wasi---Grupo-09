import type { NextFunction, Request, Response } from "express";
import type { Role } from "../types/auth";
import { HttpError } from "../utils/httpError";

// Autoriza una ruta solo para los roles indicados. Debe ir DESPUÉS del
// middleware de autenticación y ANTES del handler.
export function requireRole(...allowed: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.identity) {
      next(new HttpError(401, "UNAUTHENTICATED", "Autenticación requerida"));
      return;
    }

    if (!allowed.includes(req.identity.role)) {
      next(
        new HttpError(
          403,
          "FORBIDDEN",
          "No tienes permiso para realizar esta acción",
        ),
      );
      return;
    }

    next();
  };
}