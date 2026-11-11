import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Role } from "../src/types/auth";
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

const action = (name: string) => `/api/v1/orders/${ORDER}/${name}`;

function setup(role: Role, handlers: Handler[] = []) {
  const fake = scriptedDb(handlers);
  const app = createApp({ db: fake.db, authenticate: asRole(role) });
  return { ...fake, app };
}

// El pedido existe y está en `status`. `createdBy` por defecto es el usuario.
const locked = (status: string, createdBy = USER): Handler => [
  /FOR UPDATE/,
  () => [{ id: ORDER, status, created_by: createdBy }],
];

const noOrder: Handler = [/FOR UPDATE/, () => []];

const statusUpdate = /UPDATE orders SET status = \$3/;

// ---------------------------------------------------------------------------
// start-preparing y mark-ready
// ---------------------------------------------------------------------------
describe.each([
  { name: "start-preparing", from: "pending", to: "preparing", allowed: ["kitchen", "admin"], denied: ["waiter", "cashier"] },
  { name: "mark-ready", from: "preparing", to: "ready", allowed: ["kitchen", "admin"], denied: ["waiter", "cashier"] },
] as const)("POST /orders/:id/$name", ({ name, from, to, allowed, denied }) => {
  it.each(denied)("%s no tiene permiso (403, sin tocar la base)", async (role) => {
    const t = setup(role);
    const res = await request(t.app).post(action(name));

    expect(res.status).toBe(403);
    expect(t.calls).toHaveLength(0);
  });

  it.each(allowed)(`%s: ${from} → ${to} (200)`, async (role) => {
    const t = setup(role, [locked(from), ...orderView({ status: to })]);
    const res = await request(t.app).post(action(name));

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(to);
    expect(t.paramsOf(statusUpdate)).toEqual([RESTAURANT, ORDER, to]);
    expect(t.events).toEqual(["BEGIN", "COMMIT"]);
    expect(isolated(t.calls)).toBe(true);
  });

  it.each(["pending", "preparing", "ready", "closed", "cancelled"].filter((s) => s !== from))(
    "estado %s: 409 INVALID_ORDER_STATUS sin modificar nada",
    async (status) => {
      const t = setup("admin", [locked(status)]);
      const res = await request(t.app).post(action(name));

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("INVALID_ORDER_STATUS");
      expect(t.ran(statusUpdate)).toBe(false);
      expect(t.events).toEqual(["BEGIN", "ROLLBACK"]);
    },
  );

  it("pedido inexistente o de otro restaurante: 404", async () => {
    const t = setup("admin", [noOrder]);
    const res = await request(t.app).post(action(name));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
    expect(t.paramsOf(/FOR UPDATE/)).toEqual([RESTAURANT, ORDER]);
  });

  it("id mal formado: 404 sin consultar la base", async () => {
    const t = setup("admin");
    const res = await request(t.app).post(`/api/v1/orders/hola/${name}`);

    expect(res.status).toBe(404);
    expect(t.calls).toHaveLength(0);
  });

  it("cuerpo con campos desconocidos: 400", async () => {
    const t = setup("admin", [locked(from)]);
    const res = await request(t.app).post(action(name)).send({ reason: "x" });

    expect(res.status).toBe(400);
    expect(res.body.error.details[0].field).toBe("reason");
    expect(t.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------
describe("POST /orders/:id/cancel", () => {
  it.each(["kitchen", "cashier"] as const)("%s no tiene permiso (403)", async (role) => {
    const t = setup(role);
    expect((await request(t.app).post(action("cancel"))).status).toBe(403);
    expect(t.calls).toHaveLength(0);
  });

  it("mesero cancela su propio pedido en pending (200)", async () => {
    const t = setup("waiter", [locked("pending", USER), ...orderView({ status: "cancelled" })]);
    const res = await request(t.app).post(action("cancel"));

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");
    expect(t.paramsOf(statusUpdate)).toEqual([RESTAURANT, ORDER, "cancelled"]);
  });

  it("mesero no cancela el pedido de otro empleado: 403 FORBIDDEN", async () => {
    const t = setup("waiter", [locked("pending", OTHER_USER)]);
    const res = await request(t.app).post(action("cancel"));

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
    expect(t.ran(statusUpdate)).toBe(false);
  });

  it("la propiedad se revisa ANTES que el estado (ajeno y en preparing: 403, no 409)", async () => {
    const t = setup("waiter", [locked("preparing", OTHER_USER)]);
    const res = await request(t.app).post(action("cancel"));

    expect(res.status).toBe(403);
  });

  it.each(["preparing", "ready", "closed", "cancelled"])(
    "mesero con pedido propio en %s: 409",
    async (status) => {
      const t = setup("waiter", [locked(status, USER)]);
      const res = await request(t.app).post(action("cancel"));

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("INVALID_ORDER_STATUS");
    },
  );

  it.each(["pending", "preparing", "ready"])("admin cancela en %s (200)", async (status) => {
    const t = setup("admin", [locked(status, OTHER_USER), ...orderView({ status: "cancelled" })]);
    const res = await request(t.app).post(action("cancel"));

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");
  });

  it.each(["closed", "cancelled"])("admin desde %s: 409", async (status) => {
    const t = setup("admin", [locked(status)]);
    const res = await request(t.app).post(action("cancel"));

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("INVALID_ORDER_STATUS");
  });

  it("no acepta motivo (400)", async () => {
    const t = setup("admin");
    const res = await request(t.app).post(action("cancel")).send({ reason: "se fue" });

    expect(res.status).toBe(400);
  });

  it("pedido de otro restaurante: 404", async () => {
    const t = setup("admin", [noOrder]);
    expect((await request(t.app).post(action("cancel"))).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// payment
// ---------------------------------------------------------------------------
describe("POST /orders/:id/payment", () => {
  const body = { method: "cash", amount: "70.00" };

  // Pedido listo, sin pago previo y con el monto correcto.
  const payable = (over: { paid?: boolean; status?: string; amountOk?: boolean } = {}): Handler[] => {
    const { paid = false, status = "ready", amountOk = true } = over;
    return [
      locked(status),
      [/SELECT 1 FROM payments/, () => (paid ? [{ "?column?": 1 }] : [])],
      [/SELECT status FROM orders/, () => [{ status }]],
      [/AS ok/, () => [{ ok: amountOk }]],
      ...orderView({ status: "closed" }),
    ];
  };

  it.each(["waiter", "kitchen"] as const)("%s no tiene permiso (403)", async (role) => {
    const t = setup(role);
    const res = await request(t.app).post(action("payment")).send(body);

    expect(res.status).toBe(403);
    expect(t.calls).toHaveLength(0);
  });

  it.each(["cashier", "admin"] as const)("%s cobra un pedido listo (200)", async (role) => {
    const t = setup(role, payable());
    const res = await request(t.app).post(action("payment")).send(body);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("closed");
    expect(t.paramsOf(/INSERT INTO payments/)).toEqual([RESTAURANT, ORDER, "70.00", "cash", USER]);
    expect(t.ran(/UPDATE orders SET status = 'closed'/)).toBe(true);
    expect(t.events).toEqual(["BEGIN", "COMMIT"]);
    expect(isolated(t.calls)).toBe(true);
  });

  it("el monto se compara en la base, con el total calculado de las líneas", async () => {
    const t = setup("cashier", payable());
    await request(t.app).post(action("payment")).send({ method: "card", amount: "70" });

    expect(t.paramsOf(/AS ok/)).toEqual([RESTAURANT, ORDER, "70"]);
    expect(t.calls.find((c) => /AS ok/.test(c.text))!.text).toMatch(/SUM\(quantity \* unit_price\)/);
  });

  it("ya tiene pago: 409 ORDER_ALREADY_PAID, aunque el estado ya sea closed", async () => {
    const t = setup("cashier", payable({ paid: true, status: "closed" }));
    const res = await request(t.app).post(action("payment")).send(body);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ORDER_ALREADY_PAID");
    expect(t.ran(/INSERT INTO payments/)).toBe(false);
  });

  it.each(["pending", "preparing", "cancelled", "closed"])(
    "estado %s sin pago: 409 INVALID_ORDER_STATUS",
    async (status) => {
      const t = setup("cashier", payable({ status }));
      const res = await request(t.app).post(action("payment")).send(body);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("INVALID_ORDER_STATUS");
      expect(t.ran(/INSERT INTO payments/)).toBe(false);
    },
  );

  it("el estado se revisa ANTES que el monto", async () => {
    const t = setup("cashier", payable({ status: "preparing", amountOk: false }));
    const res = await request(t.app).post(action("payment")).send(body);

    expect(res.body.error.code).toBe("INVALID_ORDER_STATUS");
  });

  it("monto distinto del total: 409 PAYMENT_AMOUNT_MISMATCH sin registrar el pago", async () => {
    const t = setup("cashier", payable({ amountOk: false }));
    const res = await request(t.app).post(action("payment")).send({ method: "cash", amount: "69.99" });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PAYMENT_AMOUNT_MISMATCH");
    expect(t.ran(/INSERT INTO payments/)).toBe(false);
    expect(t.events).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it("red de seguridad: si el UNIQUE de la base salta (23505), responde ORDER_ALREADY_PAID", async () => {
    const duplicate = Object.assign(new Error("duplicate key"), { code: "23505" });
    const t = setup("cashier", [
      ...payable().filter(([re]) => !/INSERT INTO payments/.test(re.source)),
      [/INSERT INTO payments/, () => duplicate],
    ]);
    const res = await request(t.app).post(action("payment")).send(body);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ORDER_ALREADY_PAID");
    expect(t.events).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it("otro error de la base no se disfraza: 500 y ROLLBACK", async () => {
    const t = setup("cashier", [
      ...payable(),
      [/INSERT INTO payments/, () => new Error("caída de la base")],
    ]);
    const res = await request(t.app).post(action("payment")).send(body);

    expect(res.status).toBe(500);
    expect(t.events).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it("pedido de otro restaurante o inexistente: 404", async () => {
    const t = setup("cashier", [noOrder]);
    expect((await request(t.app).post(action("payment")).send(body)).status).toBe(404);
  });

  describe("validación del cuerpo (400, sin tocar la base)", () => {
    const invalid: Array<[string, unknown]> = [
      ["sin cuerpo", undefined],
      ["sin method", { amount: "10" }],
      ["sin amount", { method: "cash" }],
      ["method desconocido", { method: "bitcoin", amount: "10" }],
      ["amount negativo", { method: "cash", amount: "-5" }],
      ["amount cero", { method: "cash", amount: "0" }],
      ["amount con 3 decimales", { method: "cash", amount: "10.999" }],
      ["amount con texto", { method: "cash", amount: "10 soles" }],
      ["amount numérico (no texto)", { method: "cash", amount: 10 }],
      ["amount demasiado grande", { method: "cash", amount: "123456789" }],
      ["campo extra", { method: "cash", amount: "10", tip: "1" }],
    ];

    it.each(invalid)("%s", async (_name, payload) => {
      const t = setup("cashier");
      const req = request(t.app).post(action("payment"));
      const res = await (payload === undefined ? req : req.send(payload as object));

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      expect(t.calls).toHaveLength(0);
    });

    it.each(["cash", "card", "digital_wallet"])("method %s es válido", async (method) => {
      const t = setup("cashier", payable());
      const res = await request(t.app).post(action("payment")).send({ method, amount: "70" });

      expect(res.status).toBe(200);
    });
  });
});
