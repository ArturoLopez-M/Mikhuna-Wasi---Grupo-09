import type { RequestHandler } from "express";
import type { VerifyToken } from "../auth/cognito";
import type { Database } from "../db/pool";
import { ROLES, type Role } from "../types/auth";
import { HttpError } from "../utils/httpError";

interface UserRow {
  id: string;
  restaurant_id: string;
  role: string;
  is_active: boolean;
}

interface AuthenticateDeps {
  db: Database;
  verifyToken: VerifyToken;
}

function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

// Autenticación real (Docs/api-contract.md, sección 2):
//   1. Authorization: Bearer <access token>  -> 401 si falta o es inválido.
//   2. Con el `sub` del token se busca al usuario en la tabla `users`.
//   3. Sin fila o inactivo -> 403. No existe restaurante por defecto.
//   4. restaurantId y rol salen de la BASE, nunca del cliente ni del token.
export function createAuthenticate({
  db,
  verifyToken,
}: AuthenticateDeps): RequestHandler {
  return async (req, _res, next) => {
    try {
      const match = /^Bearer\s+(\S+)$/i.exec(req.header("authorization") ?? "");
      if (!match) {
        throw new HttpError(401, "UNAUTHENTICATED", "Falta el token de acceso");
      }

      let sub: string;
      try {
        ({ sub } = await verifyToken(match[1]!));
      } catch {
        // No se revela el motivo (firma, vencimiento, emisor...): solo "inválido".
        throw new HttpError(401, "UNAUTHENTICATED", "Token inválido o vencido");
      }

      // Un fallo de la base NO se disfraza de 401: sube como error 500.
      const { rows } = await db.query<UserRow>(
        `SELECT id, restaurant_id, role, is_active
           FROM users
          WHERE cognito_sub = $1`,
        [sub],
      );
      const user = rows[0];

      if (!user || !user.is_active || !isRole(user.role)) {
        throw new HttpError(
          403,
          "FORBIDDEN",
          "El usuario no tiene acceso al sistema",
        );
      }

      req.identity = {
        userId: user.id,
        restaurantId: user.restaurant_id,
        role: user.role,
      };
      next();
    } catch (err) {
      next(err);
    }
  };
}
