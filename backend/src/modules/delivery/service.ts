import type { Database } from "../../db/pool";
import type { AuthIdentity } from "../../types/auth";
import { HttpError } from "../../utils/httpError";
import { type LockedOrder, loadOrder, lockOrder, recordStatus } from "../orders/service";

// Estados de la entrega (aparte del estado de cocina del pedido):
//   pending_dispatch -> on_the_way -> delivered
//                            \-------> failed
type DeliveryStatus = "pending_dispatch" | "on_the_way" | "delivered" | "failed";

function invalidDelivery(message: string): HttpError {
  return new HttpError(409, "INVALID_DELIVERY_STATUS", message);
}

function forbidden(message: string): HttpError {
  return new HttpError(403, "FORBIDDEN", message);
}

// El pedido debe ser de delivery y estar en uno de los estados permitidos.
function requireDelivery(order: LockedOrder, allowed: DeliveryStatus[]): void {
  if (order.service_type !== "delivery") {
    throw invalidDelivery("El pedido no es de delivery");
  }
  if (!allowed.includes(order.delivery_status as DeliveryStatus)) {
    throw invalidDelivery("La entrega no está en un estado válido para esta acción");
  }
}

// Un repartidor solo puede tocar las entregas que lleva él; el admin, todas.
function requireCourier(order: LockedOrder, identity: AuthIdentity): void {
  if (identity.role === "delivery" && order.assigned_to !== identity.userId) {
    throw forbidden("Esta entrega está asignada a otro repartidor");
  }
}

async function changeDelivery(
  db: Database,
  identity: AuthIdentity,
  id: string,
  check: (order: LockedOrder) => void,
  to: DeliveryStatus,
  assignTo?: string,
) {
  const { restaurantId } = identity;
  return db.transaction(async (tx) => {
    const order = await lockOrder(tx, restaurantId, id);
    check(order);

    await tx.query(
      `UPDATE orders
          SET delivery_status = $3,
              assigned_to = COALESCE($4, assigned_to)
        WHERE restaurant_id = $1 AND id = $2`,
      [restaurantId, id, to, assignTo ?? null],
    );
    await recordStatus(tx, identity, id, order.delivery_status ?? null, to, "delivery_status");
    return loadOrder(tx, restaurantId, id);
  });
}

// Despachar: la comida ya salió de cocina (ready, o closed si se pagó antes)
// y el pedido se va con el repartidor. Si lo despacha un repartidor, queda
// asignado a él; el admin solo puede despachar si ya hay uno asignado.
export function dispatchOrder(db: Database, identity: AuthIdentity, id: string) {
  const isCourier = identity.role === "delivery";
  return changeDelivery(
    db,
    identity,
    id,
    (order) => {
      requireDelivery(order, ["pending_dispatch"]);
      if (order.status !== "ready" && order.status !== "closed") {
        throw invalidDelivery("El pedido todavía no está listo en cocina");
      }
      if (isCourier && order.assigned_to && order.assigned_to !== identity.userId) {
        throw forbidden("Esta entrega está asignada a otro repartidor");
      }
      if (!isCourier && !order.assigned_to) {
        throw invalidDelivery("Primero asigna un repartidor");
      }
    },
    "on_the_way",
    isCourier ? identity.userId : undefined,
  );
}

export function deliverOrder(db: Database, identity: AuthIdentity, id: string) {
  return changeDelivery(
    db,
    identity,
    id,
    (order) => {
      requireDelivery(order, ["on_the_way"]);
      requireCourier(order, identity);
    },
    "delivered",
  );
}

export function failDelivery(db: Database, identity: AuthIdentity, id: string) {
  return changeDelivery(
    db,
    identity,
    id,
    (order) => {
      requireDelivery(order, ["on_the_way"]);
      requireCourier(order, identity);
    },
    "failed",
  );
}

// Solo el admin asigna o reasigna, mientras la entrega no haya terminado. El
// repartidor debe ser un usuario activo, con rol delivery, del mismo restaurante.
export async function assignCourier(
  db: Database,
  identity: AuthIdentity,
  id: string,
  courierId: string,
) {
  const { restaurantId } = identity;
  return db.transaction(async (tx) => {
    const order = await lockOrder(tx, restaurantId, id);
    requireDelivery(order, ["pending_dispatch", "on_the_way"]);

    const { rows } = await tx.query(
      `SELECT 1 FROM users
        WHERE restaurant_id = $1 AND id = $2 AND role = 'delivery' AND is_active`,
      [restaurantId, courierId],
    );
    if (rows.length === 0) {
      throw new HttpError(400, "VALIDATION_ERROR", "Datos inválidos", [
        { field: "userId", message: "Repartidor no válido" },
      ]);
    }

    await tx.query(
      `UPDATE orders SET assigned_to = $3 WHERE restaurant_id = $1 AND id = $2`,
      [restaurantId, id, courierId],
    );
    return loadOrder(tx, restaurantId, id);
  });
}
