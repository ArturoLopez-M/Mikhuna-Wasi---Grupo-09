import type { RequestHandler } from "express";
import { HttpError } from "../utils/httpError";

// Marcador temporal: rechaza todo hasta que la rama feat/auth-cognito lo
// reemplace por la verificación real del token. Negar por defecto es lo seguro.
export const authenticatePlaceholder: RequestHandler = (_req, _res, next) => {
  next(
    new HttpError(401, "UNAUTHENTICATED", "La autenticación no está configurada"),
  );
};