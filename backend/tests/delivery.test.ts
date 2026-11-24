import { afterEach, describe, expect, it, vi } from "vitest";
import type { Role } from "../src/types/auth";
import { request, testApp } from "./helpers/api";
import { asRole } from "./helpers/auth";
import {
  ORDER,
  OTHER_USER,
  RESTAURANT,
  USER,
  isolated,
  orderView,
  scriptedDb,
  type Handler,
} from "./helpers/scriptedDb";

afterEach(() => vi.restoreAllMocks());

const URL = `/api/v1/orders/${ORDER}`;

function setup(role: Role, handlers: Handler[] = []) {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const fake = scriptedDb(handlers);
  return { ...fake, app: testApp({ db: fake.db, identity: asRole(role) }) };
}

// Pedido bloqueado con FOR UPDATE. Por defecto: delivery, listo en cocina,
// esperando despacho y sin repartidor.
const locked = (over: Record<string, unknown> = {}): Handler => [
  /FOR UPDATE/,
  () => [
    {
      id: ORDER,
      status: "ready",
      created_by: OTHER_USER,
      service_type: "delivery",
      delivery_status: "pending_dispatch",
      assigned_to: null,
      ...over,
    },
  ],
];

const update = /UPDATE orders\s+SET delivery_status/;
const history = /INSERT INTO order_status_history/;

describe("permisos de la Lambda Delivery", () => {
  it.each(["waiter", "kitchen", "cashier"] as const)("%s no puede despachar (403, sin tocar la base)", async (role) => {
    const t = setup(role);
    const res = await request(t.app).post(`${URL}/dispatch`);

    expect(res.status).toBe(403);
    expect(t.calls).toHaveLength(0);
  });

  it("solo el admin asigna repartidor", async () => {
    const t = setup("delivery");
    const res = await request(t.app).post(`${URL}/assign`).send({ userId: OTHER_USER });

    expect(res.status).toBe(403);
    expect(t.calls).toHaveLength(0);
  });
});

describe("POST /orders/:id/dispatch", () => {
  it("el repartidor despacha un pedido listo y queda asignado a él", async () => {
    const t = setup("delivery", [locked(), ...orderView({ status: "ready" })]);
    const res = await request(t.app).post(`${URL}/dispatch`);

    expect(res.status).toBe(200);
    expect(t.paramsOf(update)).toEqual([RESTAURANT, ORDER, "on_the_way", USER]);
    expect(t.paramsOf(history)).toEqual([
      RESTAURANT, ORDER, "pending_dispatch", "on_the_way", USER, "delivery_status",
    ]);
    expect(t.events).toEqual(["BEGIN", "COMMIT"]);
    expect(isolated(t.calls)).toBe(true);
  });

  it("también se puede despachar un pedido ya pagado (closed)", async () => {
    const t = setup("delivery", [locked({ status: "closed" }), ...orderView()]);
    const res = await request(t.app).post(`${URL}/dispatch`);
    expect(res.status).toBe(200);
  });

  it.each(["pending", "preparing"])("con el pedido en %s todavía no sale (409)", async (status) => {
    const t = setup("delivery", [locked({ status })]);
    const res = await request(t.app).post(`${URL}/dispatch`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("INVALID_DELIVERY_STATUS");
    expect(t.ran(update)).toBe(false);
    expect(t.events).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it("un pedido para consumir en el local no se despacha (409)", async () => {
    const t = setup("delivery", [locked({ service_type: "dine_in", delivery_status: null })]);
    const res = await request(t.app).post(`${URL}/dispatch`);

    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe("El pedido no es de delivery");
  });

  it("si está asignado a otro repartidor, 403", async () => {
    const t = setup("delivery", [locked({ assigned_to: OTHER_USER })]);
    const res = await request(t.app).post(`${URL}/dispatch`);

    expect(res.status).toBe(403);
    expect(t.ran(update)).toBe(false);
  });

  it("el admin solo despacha si ya hay repartidor asignado", async () => {
    const sin = setup("admin", [locked()]);
    expect((await request(sin.app).post(`${URL}/dispatch`)).status).toBe(409);

    const con = setup("admin", [locked({ assigned_to: OTHER_USER }), ...orderView()]);
    const res = await request(con.app).post(`${URL}/dispatch`);
    expect(res.status).toBe(200);
    // No cambia el repartidor: COALESCE(null, assigned_to).
    expect(con.paramsOf(update)).toEqual([RESTAURANT, ORDER, "on_the_way", null]);
  });

  it("pedido inexistente o de otro restaurante: 404", async () => {
    const t = setup("delivery", [[/FOR UPDATE/, () => []]]);
    const res = await request(t.app).post(`${URL}/dispatch`);
    expect(res.status).toBe(404);
  });
});

describe.each([
  { action: "deliver", to: "delivered" },
  { action: "delivery-failed", to: "failed" },
])("POST /orders/:id/$action", ({ action, to }) => {
  const onTheWay = (assigned = USER) => locked({ delivery_status: "on_the_way", assigned_to: assigned });

  it(`el repartidor asignado pasa la entrega a ${to}`, async () => {
    const t = setup("delivery", [onTheWay(), ...orderView()]);
    const res = await request(t.app).post(`${URL}/${action}`);

    expect(res.status).toBe(200);
    expect(t.paramsOf(update)).toEqual([RESTAURANT, ORDER, to, null]);
    expect(t.paramsOf(history)).toEqual([RESTAURANT, ORDER, "on_the_way", to, USER, "delivery_status"]);
  });

  it("otro repartidor no puede (403)", async () => {
    const t = setup("delivery", [onTheWay(OTHER_USER)]);
    const res = await request(t.app).post(`${URL}/${action}`);
    expect(res.status).toBe(403);
  });

  it("el admin sí puede aunque no sea el asignado", async () => {
    const t = setup("admin", [onTheWay(OTHER_USER), ...orderView()]);
    const res = await request(t.app).post(`${URL}/${action}`);
    expect(res.status).toBe(200);
  });

  it("si todavía no salió, 409", async () => {
    const t = setup("delivery", [locked({ assigned_to: USER })]);
    const res = await request(t.app).post(`${URL}/${action}`);
    expect(res.status).toBe(409);
  });

  it("no acepta cuerpo con campos", async () => {
    const t = setup("delivery");
    const res = await request(t.app).post(`${URL}/${action}`).send({ motivo: "x" });
    expect(res.status).toBe(400);
    expect(t.calls).toHaveLength(0);
  });
});

describe("POST /orders/:id/assign", () => {
  const courier: Handler = [/role = 'delivery'/, () => [{ "?column?": 1 }]];

  it("el admin asigna un repartidor del mismo restaurante", async () => {
    const t = setup("admin", [locked(), courier, ...orderView()]);
    const res = await request(t.app).post(`${URL}/assign`).send({ userId: OTHER_USER });

    expect(res.status).toBe(200);
    expect(t.paramsOf(/role = 'delivery'/)).toEqual([RESTAURANT, OTHER_USER]);
    expect(t.paramsOf(/SET assigned_to/)).toEqual([RESTAURANT, ORDER, OTHER_USER]);
    expect(isolated(t.calls)).toBe(true);
  });

  it("un usuario que no es repartidor activo del restaurante: 400", async () => {
    const t = setup("admin", [locked(), [/role = 'delivery'/, () => []]]);
    const res = await request(t.app).post(`${URL}/assign`).send({ userId: OTHER_USER });

    expect(res.status).toBe(400);
    expect(res.body.error.details[0].field).toBe("userId");
    expect(t.ran(/SET assigned_to/)).toBe(false);
  });

  it("una entrega terminada ya no se reasigna (409)", async () => {
    const t = setup("admin", [locked({ delivery_status: "delivered" })]);
    const res = await request(t.app).post(`${URL}/assign`).send({ userId: OTHER_USER });
    expect(res.status).toBe(409);
  });

  it.each([
    ["sin userId", {}],
    ["userId que no es UUID", { userId: "x" }],
    ["campo extra", { userId: OTHER_USER, otro: 1 }],
  ])("%s: 400 sin tocar la base", async (_n, body) => {
    const t = setup("admin");
    const res = await request(t.app).post(`${URL}/assign`).send(body);

    expect(res.status).toBe(400);
    expect(t.calls).toHaveLength(0);
  });
});
