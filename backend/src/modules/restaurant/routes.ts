import { z } from "zod";
import { tryCache } from "../../core/cache";
import { notifyRestaurant } from "../../core/realtime";
import type { Route } from "../../core/types";
import type { Database } from "../../db/pool";
import { HttpError } from "../../utils/httpError";
import { parseInput } from "../../utils/parseInput";

// Contrato 6.2: perfil del usuario autenticado, con su restaurante.
// Contrato 6.8: modalidad de atención del restaurante (RNF08).

const SERVICE_MODES = ["dine_in", "delivery", "both"] as const;
const configSchema = z.strictObject({ serviceMode: z.enum(SERVICE_MODES) });

const CONFIG_TTL = 60;
const configKey = (restaurantId: string) => `config:${restaurantId}`;

interface ProfileRow {
  id: string;
  full_name: string;
  email: string;
  role: string;
  restaurant_id: string;
  restaurant_name: string;
  service_mode: string;
}

async function readConfig(db: Database, restaurantId: string) {
  const { rows } = await db.query<{ service_mode: string }>(
    `SELECT service_mode FROM restaurants WHERE id = $1`,
    [restaurantId],
  );
  if (rows.length === 0) throw new HttpError(404, "NOT_FOUND", "Recurso no encontrado");
  return { serviceMode: rows[0]!.service_mode };
}

export const profileRoutes: readonly Route[] = [
  {
    method: "GET",
    resource: "/api/v1/me",
    async handle(db, req) {
      const { rows } = await db.query<ProfileRow>(
        `SELECT u.id, u.full_name, u.email, u.role,
                r.id AS restaurant_id, r.name AS restaurant_name, r.service_mode
           FROM users u
           JOIN restaurants r ON r.id = u.restaurant_id
          WHERE u.restaurant_id = $1 AND u.id = $2`,
        [req.identity.restaurantId, req.identity.userId],
      );
      const me = rows[0];
      if (!me) throw new HttpError(404, "NOT_FOUND", "Recurso no encontrado");
      return {
        status: 200,
        // No incluye cognitoSub (contrato 6.2).
        body: {
          id: me.id,
          fullName: me.full_name,
          email: me.email,
          role: me.role,
          restaurant: {
            id: me.restaurant_id,
            name: me.restaurant_name,
            serviceMode: me.service_mode,
          },
        },
      };
    },
  },
];

export const restaurantRoutes: readonly Route[] = [
  {
    method: "GET",
    resource: "/api/v1/restaurant/config",
    // Lee de ElastiCache o de la instancia de lectura.
    async handle(db, req, { cache }) {
      const key = configKey(req.identity.restaurantId);
      if (cache) {
        const hit = await tryCache(() => cache.get(key), null);
        if (hit) return { status: 200, body: JSON.parse(hit) };
      }
      const config = await readConfig(db, req.identity.restaurantId);
      if (cache) await tryCache(() => cache.set(key, JSON.stringify(config), CONFIG_TTL), false);
      return { status: 200, body: config };
    },
  },
  {
    method: "PATCH",
    resource: "/api/v1/restaurant/config",
    roles: ["admin"],
    write: true,
    // Guarda en la instancia de escritura, solo para este restaurante. Si el
    // UPDATE falla, la configuración anterior queda intacta y el usuario recibe
    // el error. La caché se actualiza con el valor nuevo (no se borra, para no
    // volver a llenarla con una lectura atrasada de la réplica) y se avisa a
    // las pantallas del restaurante para que se ajusten en menos de 2 s.
    async handle(db, req, { cache, notifier }) {
      const input = parseInput(configSchema, req.body);
      const { rows } = await db.query<{ service_mode: string }>(
        `UPDATE restaurants SET service_mode = $2 WHERE id = $1 RETURNING service_mode`,
        [req.identity.restaurantId, input.serviceMode],
      );
      if (rows.length === 0) throw new HttpError(404, "NOT_FOUND", "Recurso no encontrado");
      const config = { serviceMode: rows[0]!.service_mode };

      if (cache) {
        const key = configKey(req.identity.restaurantId);
        await tryCache(() => cache.set(key, JSON.stringify(config), CONFIG_TTL), false);
        if (notifier) {
          try {
            await notifyRestaurant(cache, notifier, req.identity.restaurantId, {
              type: "config.updated",
              config,
            });
          } catch (err) {
            console.error("No se pudo avisar el cambio de configuración:", err);
          }
        }
      }
      return { status: 200, body: config };
    },
  },
];
