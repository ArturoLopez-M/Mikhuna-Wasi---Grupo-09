import { z } from "zod";
import type { Database, Queryable } from "../../db/pool";
import type { AuthIdentity } from "../../types/auth";
import { HttpError, type ErrorDetail } from "../../utils/httpError";
import { queryOrders } from "./repository";
import type {
  CreateOrderInput,
  ListOrdersQuery,
  PaymentInput,
} from "./schemas";

interface ProductRow {
  id: string;
  name: string;
  price: string;
  is_available: boolean;
}

// Registra un cambio de estado en el historial de solo agregar (RNF12).
// `field` dice qué estado cambió: el del pedido o el de la entrega.
export async function recordStatus(
  tx: Queryable,
  identity: AuthIdentity,
  orderId: string,
  from: string | null,
  to: string,
  field: "status" | "delivery_status" = "status",
): Promise<void> {
  await tx.query(
    `INSERT INTO order_status_history
       (restaurant_id, order_id, from_status, to_status, changed_by, field)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [identity.restaurantId, orderId, from, to, identity.userId, field],
  );
}

// RNF08: el restaurante solo acepta los pedidos de su modalidad. FOR SHARE:
// la modalidad no puede cambiar a mitad de la creación del pedido.
async function checkServiceMode(
  tx: Queryable,
  restaurantId: string,
  serviceType: "dine_in" | "delivery",
): Promise<void> {
  const { rows } = await tx.query<{ service_mode: string }>(
    `SELECT service_mode FROM restaurants WHERE id = $1 FOR SHARE`,
    [restaurantId],
  );
  const mode = rows[0]?.service_mode;
  if (mode !== "both" && mode !== serviceType) {
    throw new HttpError(
      409,
      "SERVICE_MODE_NOT_ALLOWED",
      serviceType === "delivery"
        ? "Este restaurante no atiende delivery"
        : "Este restaurante no atiende en el local",
    );
  }
}

// Pedido ya creado por ESTE usuario con la misma Idempotency-Key.
async function findByIdempotencyKey(
  db: Queryable,
  identity: AuthIdentity,
  idempotencyKey: string,
) {
  const { orders } = await queryOrders(
    db,
    identity.restaurantId,
    { createdBy: identity.userId, idempotencyKey },
    { direction: "DESC", limit: 1, offset: 0 },
  );
  return orders[0];
}

function isIdempotencyConflict(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string };
  return e.code === "23505" && e.constraint === "orders_idempotency_key_idx";
}

// RNF01/RNF02: con Idempotency-Key, un reintento (por ejemplo tras perder la
// conexión) devuelve el pedido original en vez de crear otro. `replayed`
// indica si la respuesta corresponde a un pedido ya existente.
export async function createOrder(
  db: Database,
  identity: AuthIdentity,
  input: CreateOrderInput,
  idempotencyKey?: string,
) {
  if (idempotencyKey) {
    const existing = await findByIdempotencyKey(db, identity, idempotencyKey);
    if (existing) return { order: existing, replayed: true };
  }

  try {
    const order = await insertOrder(db, identity, input, idempotencyKey);
    return { order, replayed: false };
  } catch (err) {
    // Dos reintentos simultáneos: el índice único deja pasar solo uno; el otro
    // devuelve el pedido que ganó.
    if (idempotencyKey && isIdempotencyConflict(err)) {
      const existing = await findByIdempotencyKey(db, identity, idempotencyKey);
      if (existing) return { order: existing, replayed: true };
    }
    throw err;
  }
}

async function insertOrder(
  db: Database,
  identity: AuthIdentity,
  input: CreateOrderInput,
  idempotencyKey?: string,
) {
  const { restaurantId, userId } = identity;

  return db.transaction(async (tx) => {
    // 0. La modalidad del restaurante permite este tipo de pedido.
    await checkServiceMode(tx, restaurantId, input.serviceType);

    // 1. Productos de ESTE restaurante. Uno de otro restaurante no aparece.
    // FOR SHARE: la disponibilidad no puede cambiar a mitad de la operación
    // (contrato, sección 8).
    const ids = [...new Set(input.items.map((i) => i.productId))];
    const { rows: products } = await tx.query<ProductRow>(
      `SELECT id, name, price, is_available
         FROM products
        WHERE restaurant_id = $1 AND id = ANY($2::uuid[])
          FOR SHARE`,
      [restaurantId, ids],
    );
    const byId = new Map(products.map((p) => [p.id, p]));

    // 2. Inexistente u otro restaurante: mismo 400 y mismo mensaje.
    const missing: ErrorDetail[] = [];
    input.items.forEach((item, i) => {
      if (!byId.has(item.productId)) {
        missing.push({
          field: `items[${i}].productId`,
          message: "Producto no válido",
        });
      }
    });
    if (missing.length > 0) {
      throw new HttpError(400, "VALIDATION_ERROR", "Datos inválidos", missing);
    }

    // 3. Producto existente pero no disponible: 409.
    const unavailable: ErrorDetail[] = [];
    input.items.forEach((item, i) => {
      if (!byId.get(item.productId)!.is_available) {
        unavailable.push({
          field: `items[${i}].productId`,
          message: "Producto no disponible",
        });
      }
    });
    if (unavailable.length > 0) {
      throw new HttpError(
        409,
        "PRODUCT_UNAVAILABLE",
        "Hay productos no disponibles",
        unavailable,
      );
    }

    // 4. Cabecera del pedido (status 'pending' por defecto en la base).
    const isDelivery = input.serviceType === "delivery";
    const { rows: orderRows } = await tx.query<{
      id: string;
      table_label: string | null;
      status: string;
      notes: string | null;
      created_at: Date;
    }>(
      `INSERT INTO orders (restaurant_id, table_label, notes, created_by, idempotency_key,
                           service_type, delivery_address, delivery_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, table_label, status, notes, created_at`,
      [
        restaurantId,
        input.tableLabel ?? null,
        input.notes ?? null,
        userId,
        idempotencyKey ?? null,
        input.serviceType,
        input.deliveryAddress ?? null,
        isDelivery ? "pending_dispatch" : null,
      ],
    );
    const order = orderRows[0]!;
    await recordStatus(tx, identity, order.id, null, order.status);
    if (isDelivery) {
      await recordStatus(tx, identity, order.id, null, "pending_dispatch", "delivery_status");
    }

    // 5. Líneas: el precio y el nombre se COPIAN del producto, no del cliente.
    const items = [];
    for (const item of input.items) {
      const product = byId.get(item.productId)!;
      const { rows } = await tx.query<{ id: string; line_total: string }>(
        `INSERT INTO order_items
           (restaurant_id, order_id, product_id, product_name, quantity, unit_price, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, (quantity * unit_price)::text AS line_total`,
        [
          restaurantId,
          order.id,
          product.id,
          product.name,
          item.quantity,
          product.price,
          item.notes ?? null,
        ],
      );
      items.push({
        id: rows[0]!.id,
        productId: product.id,
        productName: product.name,
        quantity: item.quantity,
        unitPrice: product.price,
        lineTotal: rows[0]!.line_total,
        notes: item.notes ?? null,
      });
    }

    // 6. Total y nombre del creador, calculados con NUMERIC en la base (sin float).
    const { rows: totalRows } = await tx.query<{ total: string }>(
      `SELECT COALESCE(SUM(quantity * unit_price), 0)::text AS total
         FROM order_items
        WHERE restaurant_id = $1 AND order_id = $2`,
      [restaurantId, order.id],
    );
    const { rows: userRows } = await tx.query<{ full_name: string }>(
      `SELECT full_name FROM users WHERE restaurant_id = $1 AND id = $2`,
      [restaurantId, userId],
    );

    return {
      id: order.id,
      serviceType: input.serviceType,
      tableLabel: order.table_label,
      delivery: isDelivery
        ? { address: input.deliveryAddress!, status: "pending_dispatch", assignedTo: null }
        : null,
      status: order.status,
      notes: order.notes,
      createdBy: { id: userId, fullName: userRows[0]!.full_name },
      createdAt: order.created_at,
      items,
      total: totalRows[0]!.total,
      payment: null,
    };
  });
}
export async function listOrders(
  db: Database,
  identity: AuthIdentity,
  query: ListOrdersQuery,
) {
  const { orders, total } = await queryOrders(
    db,
    identity.restaurantId,
    {
      statuses: query.status,
      createdBy: query.mine ? identity.userId : undefined,
    },
    {
      direction: query.sort === "createdAt" ? "ASC" : "DESC",
      limit: query.limit,
      offset: query.offset,
    },
  );

  return {
    data: orders,
    pagination: { limit: query.limit, offset: query.offset, total },
  };
}

export async function getOrder(
  db: Database,
  identity: AuthIdentity,
  id: string,
) {
  // Un id mal formado se trata igual que uno inexistente: 404.
  if (!z.guid().safeParse(id).success) {
    throw new HttpError(404, "NOT_FOUND", "Recurso no encontrado");
  }

  const { orders } = await queryOrders(
    db,
    identity.restaurantId,
    { id },
    { direction: "DESC", limit: 1, offset: 0 },
  );

  // Un pedido de otro restaurante tampoco aparece: mismo 404.
  if (orders.length === 0) {
    throw new HttpError(404, "NOT_FOUND", "Recurso no encontrado");
  }
  return orders[0]!;
}
// ---------------------------------------------------------------------------
// Acciones sobre un pedido (contrato, sección 6.5)
// ---------------------------------------------------------------------------

export interface LockedOrder {
  id: string;
  status: string;
  created_by: string;
  service_type?: string;
  delivery_status?: string | null;
  assigned_to?: string | null;
}

function notFound(): HttpError {
  return new HttpError(404, "NOT_FOUND", "Recurso no encontrado");
}

function invalidStatus(): HttpError {
  return new HttpError(
    409,
    "INVALID_ORDER_STATUS",
    "El pedido no está en un estado válido para esta acción",
  );
}

function alreadyPaid(): HttpError {
  return new HttpError(409, "ORDER_ALREADY_PAID", "El pedido ya fue pagado");
}

// Verificación (2): el pedido existe en el restaurante del usuario. Lo bloquea
// con FOR UPDATE: dos acciones simultáneas sobre el mismo pedido se turnan.
export async function lockOrder(
  tx: Queryable,
  restaurantId: string,
  id: string,
): Promise<LockedOrder> {
  if (!z.guid().safeParse(id).success) throw notFound();

  const { rows } = await tx.query<LockedOrder>(
    `SELECT id, status, created_by, service_type, delivery_status, assigned_to
       FROM orders
      WHERE restaurant_id = $1 AND id = $2
        FOR UPDATE`,
    [restaurantId, id],
  );
  if (rows.length === 0) throw notFound();
  return rows[0]!;
}

export async function loadOrder(tx: Queryable, restaurantId: string, id: string) {
  const { orders } = await queryOrders(
    tx,
    restaurantId,
    { id },
    { direction: "DESC", limit: 1, offset: 0 },
  );
  return orders[0]!;
}

// Cambio de estado genérico. `check` es la verificación (3), de propiedad;
// `allowedFrom` es la verificación (4), de estado.
async function changeStatus(
  db: Database,
  identity: AuthIdentity,
  id: string,
  allowedFrom: string[],
  to: string,
  check?: (order: LockedOrder) => void,
) {
  const { restaurantId } = identity;

  return db.transaction(async (tx) => {
    const order = await lockOrder(tx, restaurantId, id);
    check?.(order);
    if (!allowedFrom.includes(order.status)) throw invalidStatus();

    await tx.query(
      `UPDATE orders SET status = $3 WHERE restaurant_id = $1 AND id = $2`,
      [restaurantId, id, to],
    );
    await recordStatus(tx, identity, id, order.status, to);
    return loadOrder(tx, restaurantId, id);
  });
}

export function startPreparing(
  db: Database,
  identity: AuthIdentity,
  id: string,
) {
  return changeStatus(db, identity, id, ["pending"], "preparing");
}

export function markReady(db: Database, identity: AuthIdentity, id: string) {
  return changeStatus(db, identity, id, ["preparing"], "ready");
}

export function cancelOrder(db: Database, identity: AuthIdentity, id: string) {
  const isAdmin = identity.role === "admin";

  return changeStatus(
    db,
    identity,
    id,
    // El admin cancela en cualquier estado activo; el mesero, solo en pending.
    isAdmin ? ["pending", "preparing", "ready"] : ["pending"],
    "cancelled",
    (order) => {
      // El mesero solo cancela sus propios pedidos.
      if (!isAdmin && order.created_by !== identity.userId) {
        throw new HttpError(
          403,
          "FORBIDDEN",
          "Solo puedes cancelar tus propios pedidos",
        );
      }
    },
  );
}

export async function payOrder(
  db: Database,
  identity: AuthIdentity,
  id: string,
  input: PaymentInput,
) {
  const { restaurantId, userId } = identity;

  return db.transaction(async (tx) => {
    await lockOrder(tx, restaurantId, id);

    // (4) ¿Ya tiene pago? Va ANTES que el estado: un pedido pagado está
    // 'closed' y, si se mirara el estado primero, este error nunca saldría.
    const { rows: paid } = await tx.query(
      `SELECT 1 FROM payments WHERE restaurant_id = $1 AND order_id = $2`,
      [restaurantId, id],
    );
    if (paid.length > 0) throw alreadyPaid();

    // (5) Estado.
    const { rows: current } = await tx.query<{ status: string }>(
      `SELECT status FROM orders WHERE restaurant_id = $1 AND id = $2`,
      [restaurantId, id],
    );
    if (current[0]!.status !== "ready") throw invalidStatus();

    // (6) Monto: se compara en la base con NUMERIC, nunca con float.
    const { rows: match } = await tx.query<{ ok: boolean }>(
      `SELECT COALESCE(SUM(quantity * unit_price), 0) = $3::numeric AS ok
         FROM order_items
        WHERE restaurant_id = $1 AND order_id = $2`,
      [restaurantId, id, input.amount],
    );
    if (!match[0]!.ok) {
      throw new HttpError(
        409,
        "PAYMENT_AMOUNT_MISMATCH",
        "El monto no coincide con el total del pedido",
      );
    }

    try {
      await tx.query(
        `INSERT INTO payments (restaurant_id, order_id, amount, method, received_by)
         VALUES ($1, $2, $3::numeric, $4, $5)`,
        [restaurantId, id, input.amount, input.method, userId],
      );
    } catch (err) {
      // Red de seguridad: el UNIQUE (restaurant_id, order_id) de la base.
      if ((err as { code?: string }).code === "23505") throw alreadyPaid();
      throw err;
    }

    await tx.query(
      `UPDATE orders SET status = 'closed' WHERE restaurant_id = $1 AND id = $2`,
      [restaurantId, id],
    );
    await recordStatus(tx, identity, id, "ready", "closed");
    return loadOrder(tx, restaurantId, id);
  });
}