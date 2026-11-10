import type { Database } from "../../db/pool";
import type { AuthIdentity } from "../../types/auth";
import { HttpError, type ErrorDetail } from "../../utils/httpError";
import type { CreateOrderInput } from "./schemas";

interface ProductRow {
  id: string;
  name: string;
  price: string;
  is_available: boolean;
}

export async function createOrder(
  db: Database,
  identity: AuthIdentity,
  input: CreateOrderInput,
) {
  const { restaurantId, userId } = identity;

  return db.transaction(async (tx) => {
    // 1. Productos de ESTE restaurante. Uno de otro restaurante no aparece.
    const ids = [...new Set(input.items.map((i) => i.productId))];
    const { rows: products } = await tx.query<ProductRow>(
      `SELECT id, name, price, is_available
         FROM products
        WHERE restaurant_id = $1 AND id = ANY($2::uuid[])`,
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
    const { rows: orderRows } = await tx.query<{
      id: string;
      table_label: string;
      status: string;
      notes: string | null;
      created_at: Date;
    }>(
      `INSERT INTO orders (restaurant_id, table_label, notes, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, table_label, status, notes, created_at`,
      [restaurantId, input.tableLabel, input.notes ?? null, userId],
    );
    const order = orderRows[0]!;

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
      tableLabel: order.table_label,
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