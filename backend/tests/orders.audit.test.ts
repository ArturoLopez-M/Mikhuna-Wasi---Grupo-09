import { request, testApp } from "./helpers/api";
import { describe, expect, it, vi } from "vitest";
import type { Role } from "../src/types/auth";
import { asRole } from "./helpers/auth";
import {
  ORDER,
  P1,
  RESTAURANT,
  USER,
  isolated,
  noPriorOrder,
  orderView,
  scriptedDb,
  type Handler,
} from "./helpers/scriptedDb";

// Pruebas de los hallazgos de la auditoría: idempotencia (RNF01/RNF02),
// historial de estados (RNF12) y registro de accesos rechazados (RNF05).

const URL = "/api/v1/orders";
const valid = { tableLabel: "Mesa 4", items: [{ productId: P1, quantity: 2 }] };
const KEY = "9f1c2d3e-0000-4000-8000-000000000001";

function setup(role: Role, handlers: Handler[] = []) {
  const fake = scriptedDb([...handlers, ...noPriorOrder]);
  const app = testApp({ db: fake.db, identity: asRole(role) });
  return { ...fake, app };
}

const createHandlers: Handler[] = [
  [/FROM products/, () => [{ id: P1, name: "Lomo saltado", price: "35.00", is_available: true }]],
  [
    /INSERT INTO orders/,
    () => [{ id: ORDER, table_label: "Mesa 4", status: "pending", notes: null, created_at: new Date("2026-01-01T00:00:00.000Z") }],
  ],
  [/INSERT INTO order_items/, () => [{ id: "77777777-7777-4777-8777-777777777777", line_total: "70.00" }]],
  [/SELECT COALESCE\(SUM/, () => [{ total: "70.00" }]],
  [/SELECT full_name/, () => [{ full_name: "Ana Pérez" }]],
];

const history = /INSERT INTO order_status_history/;

describe("POST /orders con Idempotency-Key", () => {
  it("un reintento con la misma clave devuelve el pedido original sin crear otro", async () => {
    const t = setup("waiter", orderView());
    const res = await request(t.app).post(URL).set("Idempotency-Key", KEY).send(valid);

    expect(res.status).toBe(201);
    expect(res.headers["idempotent-replayed"]).toBe("true");
    expect(res.body.id).toBe(ORDER);
    expect(t.ran(/INSERT INTO orders/)).toBe(false);
    expect(t.events).toEqual([]);
    // La búsqueda va acotada al restaurante, al usuario y a la clave.
    expect(t.paramsOf(/JOIN users u/)!.slice(0, 3)).toEqual([RESTAURANT, USER, KEY]);
    expect(isolated(t.calls)).toBe(true);
  });

  it("la primera vez crea el pedido y guarda la clave", async () => {
    const t = setup("waiter", [
      // La clave aún no existe.
      [/SELECT count\(\*\)::int AS count/, () => [{ count: 0 }]],
      [/JOIN users u/, () => []],
      ...createHandlers,
    ]);
    const res = await request(t.app).post(URL).set("Idempotency-Key", KEY).send(valid);

    expect(res.status).toBe(201);
    expect(res.headers["idempotent-replayed"]).toBeUndefined();
    expect(t.paramsOf(/INSERT INTO orders/)).toEqual([RESTAURANT, "Mesa 4", null, USER, KEY]);
    expect(t.events).toEqual(["BEGIN", "COMMIT"]);
  });

  it("dos reintentos simultáneos: el que pierde el índice único devuelve el pedido ganador", async () => {
    let lookups = 0;
    const conflict = Object.assign(new Error("duplicate key"), {
      code: "23505",
      constraint: "orders_idempotency_key_idx",
    });
    const view = orderView();
    const t = setup("waiter", [
      // 1.ª búsqueda: aún no existe; 2.ª (tras el conflicto): ya existe.
      [/SELECT count\(\*\)::int AS count/, () => [{ count: lookups > 0 ? 1 : 0 }]],
      [/JOIN users u/, (p) => (lookups++ === 0 ? [] : (view[1]![1](p) as unknown[]))],
      view[2]!,
      [/INSERT INTO orders/, () => conflict],
      ...createHandlers,
    ]);
    const res = await request(t.app).post(URL).set("Idempotency-Key", KEY).send(valid);

    expect(res.status).toBe(201);
    expect(res.headers["idempotent-replayed"]).toBe("true");
    expect(res.body.id).toBe(ORDER);
    expect(t.events).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it.each([
    ["vacía", ""],
    ["más de 100 caracteres", "x".repeat(101)],
    ["con espacios", "clave con espacios"],
  ])("clave %s: 400 sin tocar la base", async (_name, key) => {
    const t = setup("waiter");
    const res = await request(t.app).post(URL).set("Idempotency-Key", key).send(valid);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.details[0].field).toBe("Idempotency-Key");
    expect(t.calls).toHaveLength(0);
  });
});

describe("Historial de estados (RNF12)", () => {
  it("crear un pedido registra null → pending con el usuario autenticado", async () => {
    const t = setup("waiter", createHandlers);
    await request(t.app).post(URL).send(valid);

    expect(t.paramsOf(history)).toEqual([RESTAURANT, ORDER, null, "pending", USER]);
    expect(isolated(t.calls)).toBe(true);
  });

  it("una acción registra el estado anterior y el nuevo dentro de la transacción", async () => {
    const t = setup("kitchen", [
      [/FOR UPDATE/, () => [{ id: ORDER, status: "pending", created_by: USER }]],
      ...orderView({ status: "preparing" }),
    ]);
    const res = await request(t.app).post(`${URL}/${ORDER}/start-preparing`);

    expect(res.status).toBe(200);
    expect(t.paramsOf(history)).toEqual([RESTAURANT, ORDER, "pending", "preparing", USER]);
    expect(t.events).toEqual(["BEGIN", "COMMIT"]);
  });

  it("el pago registra ready → closed", async () => {
    const t = setup("cashier", [
      [/FOR UPDATE/, () => [{ id: ORDER, status: "ready", created_by: USER }]],
      [/SELECT 1 FROM payments/, () => []],
      [/SELECT status FROM orders/, () => [{ status: "ready" }]],
      [/AS ok/, () => [{ ok: true }]],
      ...orderView({ status: "closed" }),
    ]);
    const res = await request(t.app)
      .post(`${URL}/${ORDER}/payment`)
      .send({ method: "cash", amount: "70.00" });

    expect(res.status).toBe(200);
    expect(t.paramsOf(history)).toEqual([RESTAURANT, ORDER, "ready", "closed", USER]);
  });

  it("si el historial falla, el cambio se revierte y el mensaje vuelve a la cola", async () => {
    const t = setup("kitchen", [
      [/FOR UPDATE/, () => [{ id: ORDER, status: "pending", created_by: USER }]],
      [history, () => new Error("fallo al escribir historial")],
    ]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await request(t.app).post(`${URL}/${ORDER}/start-preparing`);

    expect(res.status).toBe(500);
    expect(res.retried).toBe(true);
    expect(t.events).toEqual(["BEGIN", "ROLLBACK"]);
    vi.restoreAllMocks();
  });
});

describe("Registro de accesos rechazados (RNF05)", () => {
  it("un 403 por rol se registra con usuario, restaurante, ruta y fecha", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = setup("kitchen");
    await request(t.app)
      .post(URL)
      .set("Authorization", "Bearer token-secreto")
      .send(valid);

    expect(spy).toHaveBeenCalledTimes(1);
    const line = String(spy.mock.calls[0]![0]);
    const entry = JSON.parse(line);
    expect(entry).toMatchObject({
      event: "ACCESS_DENIED",
      status: 403,
      code: "FORBIDDEN",
      userId: USER,
      restaurantId: RESTAURANT,
      method: "POST",
      path: URL,
    });
    expect(Number.isNaN(Date.parse(entry.at))).toBe(false);
    expect(line).not.toContain("token-secreto");
    spy.mockRestore();
  });

  it("un 401 sin identidad se registra con usuario y restaurante nulos", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const app = testApp({ db: scriptedDb().db });
    await request(app).get(`${URL}?status=pending`);

    const entry = JSON.parse(String(spy.mock.calls[0]![0]));
    expect(entry).toMatchObject({ status: 401, userId: null, restaurantId: null, path: URL });
    spy.mockRestore();
  });
});
