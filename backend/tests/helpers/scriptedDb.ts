import type { Database } from "../../src/db/pool";

// Base de datos falsa "con guion": cada manejador asocia un patrón del SQL con
// las filas que devuelve. Registra todas las consultas y los BEGIN/COMMIT/ROLLBACK
// para poder comprobar QUÉ se ejecutó (y qué NO) sin necesitar PostgreSQL.
export type Handler = [RegExp, (params: unknown[]) => unknown[] | Error];

interface Call {
  text: string;
  params: unknown[];
}

export function scriptedDb(handlers: Handler[] = []) {
  const calls: Call[] = [];
  const events: string[] = [];

  const query = async (text: string, params: unknown[] = []) => {
    calls.push({ text, params });
    for (const [pattern, respond] of handlers) {
      if (pattern.test(text)) {
        const out = respond(params);
        if (out instanceof Error) throw out;
        return { rows: out };
      }
    }
    return { rows: [] };
  };

  const db = {
    query,
    async transaction<T>(fn: (tx: { query: typeof query }) => Promise<T>) {
      events.push("BEGIN");
      try {
        const result = await fn({ query });
        events.push("COMMIT");
        return result;
      } catch (err) {
        events.push("ROLLBACK");
        throw err;
      }
    },
    close: async () => {},
  } as unknown as Database;

  return {
    db,
    calls,
    events,
    ran: (pattern: RegExp) => calls.some((c) => pattern.test(c.text)),
    paramsOf: (pattern: RegExp) =>
      calls.find((c) => pattern.test(c.text))?.params,
  };
}

// Aislamiento entre restaurantes: TODA consulta debe recibir el restaurante de
// la identidad como primer parámetro y filtrar (o insertar) por restaurant_id.
export function isolated(calls: Call[]): boolean {
  return (
    calls.length > 0 &&
    calls.every(
      (c) =>
        c.params[0] === RESTAURANT &&
        (/restaurant_id\s*=\s*\$1/.test(c.text) ||
          /INSERT INTO \w+\s*\(\s*restaurant_id/.test(c.text)),
    )
  );
}

// --- Datos de ejemplo compartidos (UUID con forma válida) -------------------

// Coinciden con los valores por defecto de asRole() en helpers/auth.ts.
export const RESTAURANT = "11111111-1111-4111-8111-111111111111";
export const USER = "22222222-2222-4222-8222-222222222222";

export const ORDER = "33333333-3333-4333-8333-333333333333";
export const OTHER_USER = "44444444-4444-4444-8444-444444444444";
export const P1 = "55555555-5555-4555-8555-555555555555";
export const P2 = "66666666-6666-4666-8666-666666666666";

// Lo que devuelve queryOrders (conteo + pedidos + líneas) para un pedido.
export function orderView(
  opts: { status?: string; found?: boolean; total?: number } = {},
): Handler[] {
  const { status = "pending", found = true, total = found ? 1 : 0 } = opts;
  return [
    [/SELECT count\(\*\)::int AS count/, () => [{ count: total }]],
    [
      /JOIN users u/,
      () =>
        found
          ? [
              {
                id: ORDER,
                table_label: "Mesa 4",
                status,
                notes: null,
                created_at: new Date("2026-01-01T00:00:00.000Z"),
                created_by: USER,
                full_name: "Ana Pérez",
                total: "70.00",
                pay_amount: null,
                pay_method: null,
                pay_created_at: null,
              },
            ]
          : [],
    ],
    [
      /order_id = ANY/,
      () => [
        {
          id: "77777777-7777-4777-8777-777777777777",
          order_id: ORDER,
          product_id: P1,
          product_name: "Lomo saltado",
          quantity: 2,
          unit_price: "35.00",
          line_total: "70.00",
          notes: null,
        },
      ],
    ],
  ];
}
