import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Role } from "../src/types/auth";
import { asRole } from "./helpers/auth";
import {
  ORDER,
  P1,
  P2,
  RESTAURANT,
  USER,
  isolated,
  scriptedDb,
  type Handler,
} from "./helpers/scriptedDb";

const URL = "/api/v1/orders";
const valid = { tableLabel: "Mesa 4", items: [{ productId: P1, quantity: 2 }] };

function setup(role: Role, handlers: Handler[] = []) {
  const fake = scriptedDb(handlers);
  const app = createApp({ db: fake.db, authenticate: asRole(role) });
  return { ...fake, app };
}

// Catálogo del restaurante: P1 disponible, P2 configurable.
const products = (p2Available = true): Handler => [
  /FROM products/,
  () => [
    { id: P1, name: "Lomo saltado", price: "35.00", is_available: true },
    { id: P2, name: "Chicha morada", price: "8.00", is_available: p2Available },
  ],
];

const happyPath: Handler[] = [
  products(),
  [
    /INSERT INTO orders/,
    () => [
      {
        id: ORDER,
        table_label: "Mesa 4",
        status: "pending",
        notes: null,
        created_at: new Date("2026-01-01T00:00:00.000Z"),
      },
    ],
  ],
  [
    /INSERT INTO order_items/,
    (p) => [
      {
        id: "77777777-7777-4777-8777-777777777777",
        line_total: (Number(p[4]) * Number(p[5])).toFixed(2),
      },
    ],
  ],
  [/AS total/, () => [{ total: "78.00" }]],
  [/SELECT full_name/, () => [{ full_name: "Ana Pérez" }]],
];

describe("POST /orders: permisos", () => {
  it.each(["kitchen", "cashier"] as const)("%s no puede crear (403)", async (role) => {
    const t = setup(role);
    const res = await request(t.app).post(URL).send(valid);

    expect(res.status).toBe(403);
    expect(t.calls).toHaveLength(0);
  });

  it.each(["waiter", "admin"] as const)("%s puede crear (201)", async (role) => {
    const t = setup(role, happyPath);
    const res = await request(t.app).post(URL).send(valid);

    expect(res.status).toBe(201);
  });
});

describe("POST /orders: validación del cuerpo (400, sin tocar la base)", () => {
  const cases: Array<[string, unknown, string]> = [
    ["sin tableLabel", { items: valid.items }, "tableLabel"],
    ["tableLabel solo espacios", { ...valid, tableLabel: "   " }, "tableLabel"],
    ["tableLabel de 31 caracteres", { ...valid, tableLabel: "x".repeat(31) }, "tableLabel"],
    ["notes de 501 caracteres", { ...valid, notes: "x".repeat(501) }, "notes"],
    ["sin items", { tableLabel: "M" }, "items"],
    ["items vacío", { tableLabel: "M", items: [] }, "items"],
    [
      "51 líneas",
      { tableLabel: "M", items: Array.from({ length: 51 }, () => ({ productId: P1, quantity: 1 })) },
      "items",
    ],
    ["productId no es UUID", { tableLabel: "M", items: [{ productId: "x", quantity: 1 }] }, "items[0].productId"],
    ["quantity 0", { tableLabel: "M", items: [{ productId: P1, quantity: 0 }] }, "items[0].quantity"],
    ["quantity 100", { tableLabel: "M", items: [{ productId: P1, quantity: 100 }] }, "items[0].quantity"],
    ["quantity decimal", { tableLabel: "M", items: [{ productId: P1, quantity: 1.5 }] }, "items[0].quantity"],
    ["notes de línea de 201", { tableLabel: "M", items: [{ productId: P1, quantity: 1, notes: "x".repeat(201) }] }, "items[0].notes"],
    ["unitPrice enviado por el cliente", { tableLabel: "M", items: [{ productId: P1, quantity: 1, unitPrice: "0.01" }] }, "items[0].unitPrice"],
    ["status enviado por el cliente", { ...valid, status: "ready" }, "status"],
    ["createdBy enviado por el cliente", { ...valid, createdBy: USER }, "createdBy"],
    ["total enviado por el cliente", { ...valid, total: "1.00" }, "total"],
    ["restaurantId enviado por el cliente", { ...valid, restaurantId: RESTAURANT }, "restaurantId"],
  ];

  it.each(cases)("%s", async (_name, body, field) => {
    const t = setup("waiter");
    const res = await request(t.app).post(URL).send(body as object);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.details.map((d: { field: string }) => d.field)).toContain(field);
    expect(t.calls).toHaveLength(0);
  });
});

describe("POST /orders: reglas de negocio", () => {
  it("crea el pedido copiando nombre y precio desde la base, no desde el cliente", async () => {
    const t = setup("waiter", happyPath);
    const res = await request(t.app)
      .post(URL)
      .send({
        tableLabel: "  Mesa 4  ",
        items: [
          { productId: P1, quantity: 2 },
          { productId: P2, quantity: 1, notes: "sin hielo" },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.items[0]).toMatchObject({
      productName: "Lomo saltado",
      unitPrice: "35.00",
      lineTotal: "70.00",
    });
    expect(res.body.items[1]).toMatchObject({
      productName: "Chicha morada",
      unitPrice: "8.00",
      notes: "sin hielo",
    });
    expect(res.body.total).toBe("78.00");
    expect(res.body.status).toBe("pending");
    expect(res.body.payment).toBeNull();
    expect(res.body.createdBy).toEqual({ id: USER, fullName: "Ana Pérez" });
    expect(t.events).toEqual(["BEGIN", "COMMIT"]);
  });

  it("restaurante y creador salen de la identidad, y el tableLabel llega recortado", async () => {
    const t = setup("waiter", happyPath);
    await request(t.app).post(URL).send({ ...valid, tableLabel: "  Mesa 4  " });

    expect(t.paramsOf(/FROM products/)![0]).toBe(RESTAURANT);
    expect(t.paramsOf(/INSERT INTO orders/)).toEqual([RESTAURANT, "Mesa 4", null, USER]);
    expect(t.paramsOf(/INSERT INTO order_items/)).toEqual([
      RESTAURANT, ORDER, P1, "Lomo saltado", 2, "35.00", null,
    ]);
  });

  it("aislamiento: todas las consultas van acotadas al restaurante", async () => {
    const t = setup("waiter", happyPath);
    await request(t.app).post(URL).send(valid);

    expect(isolated(t.calls)).toBe(true);
  });

  it("un mismo producto puede repetirse: se consulta una vez y se insertan dos líneas", async () => {
    const t = setup("waiter", happyPath);
    const res = await request(t.app)
      .post(URL)
      .send({ tableLabel: "M", items: [{ productId: P1, quantity: 1 }, { productId: P1, quantity: 3 }] });

    expect(res.status).toBe(201);
    expect(t.paramsOf(/FROM products/)![1]).toEqual([P1]);
    expect(t.calls.filter((c) => /INSERT INTO order_items/.test(c.text))).toHaveLength(2);
  });

  it("producto inexistente o de otro restaurante: 400 sin escribir nada", async () => {
    // El catálogo del restaurante solo conoce P1: P2 "no existe" para él.
    const t = setup("waiter", [
      [/FROM products/, () => [{ id: P1, name: "Lomo saltado", price: "35.00", is_available: true }]],
    ]);
    const res = await request(t.app)
      .post(URL)
      .send({ tableLabel: "M", items: [{ productId: P1, quantity: 1 }, { productId: P2, quantity: 1 }] });

    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual([
      { field: "items[1].productId", message: "Producto no válido" },
    ]);
    expect(t.ran(/INSERT/)).toBe(false);
    expect(t.events).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it("producto no disponible: 409 PRODUCT_UNAVAILABLE indicando la línea, sin escribir nada", async () => {
    const t = setup("waiter", [products(false)]);
    const res = await request(t.app)
      .post(URL)
      .send({ tableLabel: "M", items: [{ productId: P1, quantity: 1 }, { productId: P2, quantity: 1 }] });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PRODUCT_UNAVAILABLE");
    expect(res.body.error.details[0].field).toBe("items[1].productId");
    expect(t.ran(/INSERT/)).toBe(false);
    expect(t.events).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it("si falla el INSERT de una línea, se hace ROLLBACK y responde 500", async () => {
    const t = setup("waiter", [
      ...happyPath.filter(([re]) => !/order_items/.test(re.source)),
      [/INSERT INTO order_items/, () => new Error("fallo simulado")],
    ]);
    const res = await request(t.app).post(URL).send(valid);

    expect(res.status).toBe(500);
    expect(t.events).toEqual(["BEGIN", "ROLLBACK"]);
  });
});
