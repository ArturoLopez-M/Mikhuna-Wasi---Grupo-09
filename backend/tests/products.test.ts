import { afterEach, describe, expect, it, vi } from "vitest";
import type { Role } from "../src/types/auth";
import { request, testApp } from "./helpers/api";
import { asRole } from "./helpers/auth";
import { P1, RESTAURANT, isolated, scriptedDb, type Handler } from "./helpers/scriptedDb";

afterEach(() => vi.restoreAllMocks());

const URL = "/api/v1/products";

function setup(role: Role, handlers: Handler[] = []) {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const fake = scriptedDb(handlers);
  return { ...fake, app: testApp({ db: fake.db, identity: asRole(role) }) };
}

const row = (over: Record<string, unknown> = {}) => ({
  id: P1,
  name: "Lomo saltado",
  description: null,
  price: "35.00",
  is_available: true,
  created_at: new Date("2026-01-01T00:00:00.000Z"),
  ...over,
});

describe("GET /products", () => {
  it("el admin ve todos, con la forma del contrato", async () => {
    const t = setup("admin", [[/FROM products/, () => [row()]]]);
    const res = await request(t.app).get(URL);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: [
        {
          id: P1,
          name: "Lomo saltado",
          description: null,
          price: "35.00",
          isAvailable: true,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    expect(t.paramsOf(/FROM products/)).toEqual([RESTAURANT]);
    expect(isolated(t.calls)).toBe(true);
  });

  it("los demás roles solo ven los disponibles", async () => {
    const t = setup("waiter", [[/FROM products/, () => []]]);
    await request(t.app).get(URL);
    expect(t.paramsOf(/FROM products/)).toEqual([RESTAURANT, true]);
  });

  it("el admin puede filtrar los no disponibles", async () => {
    const t = setup("admin", [[/FROM products/, () => []]]);
    await request(t.app).get(`${URL}?available=false`);
    expect(t.paramsOf(/FROM products/)).toEqual([RESTAURANT, false]);
  });

  it("un no-admin con available=false recibe 403", async () => {
    const t = setup("kitchen");
    const res = await request(t.app).get(`${URL}?available=false`);

    expect(res.status).toBe(403);
    expect(t.calls).toHaveLength(0);
  });

  it("available con otro valor: 400", async () => {
    const t = setup("admin");
    const res = await request(t.app).get(`${URL}?available=si`);
    expect(res.status).toBe(400);
  });
});

describe("POST /products", () => {
  const valid = { name: "Ceviche", price: "35.5" };
  const creates: Handler[] = [
    [/count\(\*\)::int AS count FROM products/, () => [{ count: 3 }]],
    [/INSERT INTO products/, () => [row({ name: "Ceviche", price: "35.50" })]],
  ];

  it("el admin crea un producto (201) con el precio en dos decimales", async () => {
    const t = setup("admin", creates);
    const res = await request(t.app).post(URL).send(valid);

    expect(res.status).toBe(201);
    expect(res.body.price).toBe("35.50");
    expect(t.paramsOf(/INSERT INTO products/)).toEqual([RESTAURANT, "Ceviche", null, "35.5", true]);
    // Bloquea el restaurante antes de contar: dos creaciones no pasan el tope a la vez.
    expect(t.ran(/FROM restaurants WHERE id = \$1 FOR UPDATE/)).toBe(true);
    expect(t.events).toEqual(["BEGIN", "COMMIT"]);
    expect(isolated(t.calls)).toBe(true);
  });

  it("con 200 productos responde 409 PRODUCT_LIMIT_REACHED y no inserta", async () => {
    const t = setup("admin", [[/count\(\*\)::int AS count FROM products/, () => [{ count: 200 }]]]);
    const res = await request(t.app).post(URL).send(valid);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PRODUCT_LIMIT_REACHED");
    expect(t.ran(/INSERT INTO products/)).toBe(false);
  });

  it.each(["waiter", "kitchen", "cashier", "delivery"] as const)("%s no puede crear (403)", async (role) => {
    const t = setup(role);
    const res = await request(t.app).post(URL).send(valid);

    expect(res.status).toBe(403);
    expect(t.calls).toHaveLength(0);
  });

  it.each([
    ["precio como número", { name: "A", price: 35 }, "price"],
    ["precio con tres decimales", { name: "A", price: "35.555" }, "price"],
    ["precio negativo", { name: "A", price: "-1" }, "price"],
    ["precio con coma", { name: "A", price: "35,50" }, "price"],
    ["precio de 100000", { name: "A", price: "100000" }, "price"],
    ["nombre con espacios en los extremos", { name: " A ", price: "1" }, "name"],
    ["nombre de 101 caracteres", { name: "x".repeat(101), price: "1" }, "name"],
    ["descripción de 501 caracteres", { name: "A", price: "1", description: "x".repeat(501) }, "description"],
    ["campo desconocido", { name: "A", price: "1", stock: 3 }, "stock"],
  ])("%s: 400 sin tocar la base", async (_n, body, field) => {
    const t = setup("admin");
    const res = await request(t.app).post(URL).send(body);

    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d: { field: string }) => d.field)).toContain(field);
    expect(t.calls).toHaveLength(0);
  });
});

describe("PATCH /products/:id", () => {
  it("actualiza solo los campos enviados, dentro de su restaurante", async () => {
    const t = setup("admin", [[/UPDATE products/, () => [row({ is_available: false })]]]);
    const res = await request(t.app).patch(`${URL}/${P1}`).send({ isAvailable: false, description: null });

    expect(res.status).toBe(200);
    expect(res.body.isAvailable).toBe(false);
    const update = t.calls.find((c) => /UPDATE products/.test(c.text))!;
    // Los campos van en el orden del esquema, no en el que llegan.
    expect(update.text).toMatch(/SET description = \$3, is_available = \$4/);
    expect(update.params).toEqual([RESTAURANT, P1, null, false]);
    expect(isolated(t.calls)).toBe(true);
  });

  it("producto inexistente o de otro restaurante: 404", async () => {
    const t = setup("admin", [[/UPDATE products/, () => []]]);
    const res = await request(t.app).patch(`${URL}/${P1}`).send({ price: "10" });
    expect(res.status).toBe(404);
  });

  it("un id que no es UUID: 404 sin tocar la base", async () => {
    const t = setup("admin");
    const res = await request(t.app).patch(`${URL}/abc`).send({ price: "10" });

    expect(res.status).toBe(404);
    expect(t.calls).toHaveLength(0);
  });

  it.each([
    ["cuerpo vacío", {}],
    ["null en name", { name: null }],
    ["null en price", { price: null }],
  ])("%s: 400", async (_n, body) => {
    const t = setup("admin");
    const res = await request(t.app).patch(`${URL}/${P1}`).send(body);

    expect(res.status).toBe(400);
    expect(t.calls).toHaveLength(0);
  });

  it("un no-admin no puede editar (403)", async () => {
    const t = setup("waiter");
    const res = await request(t.app).patch(`${URL}/${P1}`).send({ price: "10" });
    expect(res.status).toBe(403);
  });
});
