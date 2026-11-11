import type { Queryable } from "../../db/pool";

export interface OrderFilter {
  id?: string;
  statuses?: string[];
  createdBy?: string;
}

export interface OrderPage {
  direction: "ASC" | "DESC";
  limit: number;
  offset: number;
}

interface OrderRow {
  id: string;
  table_label: string;
  status: string;
  notes: string | null;
  created_at: Date;
  created_by: string;
  full_name: string;
  total: string;
  pay_amount: string | null;
  pay_method: string | null;
  pay_created_at: Date | null;
}

interface ItemRow {
  id: string;
  order_id: string;
  product_id: string;
  product_name: string;
  quantity: number;
  unit_price: string;
  line_total: string;
  notes: string | null;
}

// El restaurante SIEMPRE es la primera condición: aísla los datos entre
// locales. Los valores van como parámetros ($n), nunca concatenados.
function buildWhere(restaurantId: string, filter: OrderFilter) {
  const conditions = ["o.restaurant_id = $1"];
  const params: unknown[] = [restaurantId];

  if (filter.id) {
    params.push(filter.id);
    conditions.push(`o.id = $${params.length}`);
  }
  if (filter.statuses) {
    params.push(filter.statuses);
    conditions.push(`o.status = ANY($${params.length}::text[])`);
  }
  if (filter.createdBy) {
    params.push(filter.createdBy);
    conditions.push(`o.created_by = $${params.length}`);
  }
  return { where: conditions.join(" AND "), params };
}

export async function queryOrders(
  db: Queryable,
  restaurantId: string,
  filter: OrderFilter,
  page: OrderPage,
) {
  const { where, params } = buildWhere(restaurantId, filter);

  const { rows: countRows } = await db.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM orders o WHERE ${where}`,
    params,
  );

  // page.direction solo puede ser "ASC" o "DESC" (lo fija el servicio).
  const { rows } = await db.query<OrderRow>(
    `SELECT o.id, o.table_label, o.status, o.notes, o.created_at, o.created_by,
            u.full_name,
            COALESCE((SELECT SUM(oi.quantity * oi.unit_price)
                        FROM order_items oi
                       WHERE oi.restaurant_id = o.restaurant_id
                         AND oi.order_id = o.id), 0)::text AS total,
            p.amount::text AS pay_amount,
            p.method       AS pay_method,
            p.created_at   AS pay_created_at
       FROM orders o
       JOIN users u
         ON u.restaurant_id = o.restaurant_id AND u.id = o.created_by
       LEFT JOIN payments p
         ON p.restaurant_id = o.restaurant_id AND p.order_id = o.id
      WHERE ${where}
      ORDER BY o.created_at ${page.direction}, o.id ${page.direction}
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, page.limit, page.offset],
  );

  // Las líneas de todos los pedidos de la página, en una sola consulta.
  const itemsByOrder = new Map<string, ItemRow[]>();
  if (rows.length > 0) {
    const { rows: itemRows } = await db.query<ItemRow>(
      `SELECT id, order_id, product_id, product_name, quantity,
              unit_price::text AS unit_price,
              (quantity * unit_price)::text AS line_total,
              notes
         FROM order_items
        WHERE restaurant_id = $1 AND order_id = ANY($2::uuid[])
        ORDER BY product_name, id`,
      [restaurantId, rows.map((r) => r.id)],
    );
    for (const item of itemRows) {
      const list = itemsByOrder.get(item.order_id) ?? [];
      list.push(item);
      itemsByOrder.set(item.order_id, list);
    }
  }

  const orders = rows.map((r) => ({
    id: r.id,
    tableLabel: r.table_label,
    status: r.status,
    notes: r.notes,
    createdBy: { id: r.created_by, fullName: r.full_name },
    createdAt: r.created_at,
    items: (itemsByOrder.get(r.id) ?? []).map((i) => ({
      id: i.id,
      productId: i.product_id,
      productName: i.product_name,
      quantity: i.quantity,
      unitPrice: i.unit_price,
      lineTotal: i.line_total,
      notes: i.notes,
    })),
    total: r.total,
    payment:
      r.pay_amount === null
        ? null
        : {
            amount: r.pay_amount,
            method: r.pay_method,
            createdAt: r.pay_created_at,
          },
  }));

  return { orders, total: countRows[0]!.count };
}