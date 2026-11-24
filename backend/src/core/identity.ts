import type { Database } from "../db/pool";
import { ROLES, type AuthIdentity, type Role } from "../types/auth";
import { HttpError } from "../utils/httpError";

interface UserRow {
  id: string;
  restaurant_id: string;
  role: string;
  is_active: boolean;
}

function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

// Docs/api-contract.md, sección 2. API Gateway ya validó el access token de
// Cognito (firma, emisor, vencimiento); aquí, con su `sub`:
//   - se busca al usuario en `users`;
//   - sin fila, inactivo o con un rol desconocido -> 403;
//   - restaurantId y rol salen de la BASE, nunca del cliente ni del token.
// Un fallo de la base NO se disfraza de 403: se propaga como error técnico.
export async function resolveIdentity(
  db: Database,
  sub: string,
): Promise<AuthIdentity> {
  const { rows } = await db.query<UserRow>(
    `SELECT id, restaurant_id, role, is_active
       FROM users
      WHERE cognito_sub = $1`,
    [sub],
  );
  const user = rows[0];

  if (!user || !user.is_active || !isRole(user.role)) {
    throw new HttpError(403, "FORBIDDEN", "El usuario no tiene acceso al sistema");
  }

  return {
    userId: user.id,
    restaurantId: user.restaurant_id,
    role: user.role,
  };
}
