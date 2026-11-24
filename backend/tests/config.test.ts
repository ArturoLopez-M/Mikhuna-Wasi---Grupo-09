import type { APIGatewayProxyEvent } from "aws-lambda";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerConnection } from "../src/core/realtime";
import { handleRestEvent } from "../src/core/rest";
import { routes as lecturaRoutes } from "../src/lambdas/lectura-config/index";
import type { Role } from "../src/types/auth";
import { REQUEST_ID, request, testApp } from "./helpers/api";
import { asRole } from "./helpers/auth";
import { fakeCache, fakeNotifier } from "./helpers/fakeCache";
import {
  ORDER,
  P1,
  RESTAURANT,
  USER,
  createDefaults,
  isolated,
  scriptedDb,
  type Handler,
} from "./helpers/scriptedDb";

afterEach(() => vi.restoreAllMocks());
const quiet = () => vi.spyOn(console, "warn").mockImplementation(() => {});

function setup(role: Role, handlers: Handler[] = [], cache = fakeCache()) {
  const fake = scriptedDb(handlers);
  return { ...fake, cache, app: testApp({ db: fake.db, identity: asRole(role), cache: cache.cache }) };
}

const CONFIG = "/api/v1/restaurant/config";

describe("GET /api/v1/me", () => {
  it("devuelve el perfil con su restaurante y la modalidad, sin cognitoSub", async () => {
    const t = setup("waiter", [
      [
        /FROM users u/,
        () => [
          {
            id: USER,
            full_name: "Ana Pérez",
            email: "ana@ejemplo.com",
            role: "waiter",
            restaurant_id: RESTAURANT,
            restaurant_name: "Mikhuna Central",
            service_mode: "both",
          },
        ],
      ],
    ]);
    const res = await request(t.app).get("/api/v1/me");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: USER,
      fullName: "Ana Pérez",
      email: "ana@ejemplo.com",
      role: "waiter",
      restaurant: { id: RESTAURANT, name: "Mikhuna Central", serviceMode: "both" },
    });
    expect(t.paramsOf(/FROM users u/)).toEqual([RESTAURANT, USER]);
    expect(isolated(t.calls)).toBe(true);
  });
});

describe("modalidad del restaurante (RNF08)", () => {
  it("GET la lee de la base y la guarda en caché", async () => {
    const t = setup("kitchen", [[/SELECT service_mode/, () => [{ service_mode: "dine_in" }]]]);
    const res = await request(t.app).get(CONFIG);

    expect(res.body).toEqual({ serviceMode: "dine_in" });
    expect(t.cache.values.get(`config:${RESTAURANT}`)).toBe('{"serviceMode":"dine_in"}');
  });

  it("GET desde la caché no va a la base", async () => {
    const c = fakeCache();
    c.values.set(`config:${RESTAURANT}`, '{"serviceMode":"delivery"}');
    const t = setup("kitchen", [], c);
    const res = await request(t.app).get(CONFIG);

    expect(res.body).toEqual({ serviceMode: "delivery" });
    expect(t.calls).toHaveLength(0);
  });

  it("PATCH (admin) guarda solo en su restaurante y actualiza la caché con el valor nuevo", async () => {
    const t = setup("admin", [[/UPDATE restaurants/, () => [{ service_mode: "delivery" }]]]);
    const res = await request(t.app).patch(CONFIG).send({ serviceMode: "delivery" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ serviceMode: "delivery" });
    expect(t.paramsOf(/UPDATE restaurants/)).toEqual([RESTAURANT, "delivery"]);
    expect(t.cache.values.get(`config:${RESTAURANT}`)).toBe('{"serviceMode":"delivery"}');
    expect(isolated(t.calls)).toBe(true);
  });

  it("PATCH avisa por WebSocket a todas las pantallas del restaurante", async () => {
    const c = fakeCache();
    await registerConnection(c.cache, "pantalla-cocina", asRole("kitchen"));
    const n = fakeNotifier();
    const t = scriptedDb([[/UPDATE restaurants/, () => [{ service_mode: "dine_in" }]]]);

    await handleRestEvent(
      t.db,
      lecturaRoutes,
      {
        httpMethod: "PATCH",
        resource: CONFIG,
        pathParameters: null,
        queryStringParameters: null,
        headers: {},
        body: '{"serviceMode":"dine_in"}',
        isBase64Encoded: false,
        requestContext: { requestId: "r", authorizer: { claims: { sub: "s" } } },
      } as unknown as APIGatewayProxyEvent,
      async () => asRole("admin"),
      { cache: c.cache, writeDb: t.db, notifier: n.notifier },
    );

    expect(n.sent).toEqual([
      { connectionId: "pantalla-cocina", payload: { type: "config.updated", config: { serviceMode: "dine_in" } } },
    ]);
  });

  it("si el guardado falla, no se toca la caché y el usuario recibe el error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const c = fakeCache();
    c.values.set(`config:${RESTAURANT}`, '{"serviceMode":"both"}');
    const t = setup("admin", [[/UPDATE restaurants/, () => new Error("base caída")]], c);
    const res = await request(t.app).patch(CONFIG).send({ serviceMode: "delivery" });

    expect(res.status).toBe(500);
    expect(c.values.get(`config:${RESTAURANT}`)).toBe('{"serviceMode":"both"}');
  });

  it.each(["waiter", "kitchen", "cashier", "delivery"] as const)("%s no puede cambiarla (403)", async (role) => {
    quiet();
    const t = setup(role);
    const res = await request(t.app).patch(CONFIG).send({ serviceMode: "delivery" });

    expect(res.status).toBe(403);
    expect(t.calls).toHaveLength(0);
  });

  it.each([
    ["valor desconocido", { serviceMode: "takeaway" }],
    ["sin serviceMode", {}],
    ["campo extra", { serviceMode: "both", restaurantId: RESTAURANT }],
  ])("%s: 400", async (_n, body) => {
    const t = setup("admin");
    const res = await request(t.app).patch(CONFIG).send(body);

    expect(res.status).toBe(400);
    expect(t.calls).toHaveLength(0);
  });
});

describe("crear pedido según la modalidad", () => {
  const products: Handler = [
    /FROM products/,
    () => [{ id: P1, name: "Lomo saltado", price: "35.00", is_available: true }],
  ];
  const created: Handler[] = [
    products,
    [/INSERT INTO orders/, () => [{ id: ORDER, table_label: null, status: "pending", notes: null, created_at: new Date() }]],
    [/INSERT INTO order_items/, () => [{ id: "77777777-7777-4777-8777-777777777777", line_total: "35.00" }]],
    [/SELECT COALESCE\(SUM/, () => [{ total: "35.00" }]],
    [/SELECT full_name/, () => [{ full_name: "Ana Pérez" }]],
  ];
  const mode = (m: string): Handler => [/SELECT service_mode FROM restaurants/, () => [{ service_mode: m }]];
  const delivery = {
    serviceType: "delivery",
    deliveryAddress: "  Av. Larco 123  ",
    items: [{ productId: P1, quantity: 1 }],
  };

  function create(handlers: Handler[]) {
    const fake = scriptedDb([...handlers, ...createDefaults]);
    return { ...fake, app: testApp({ db: fake.db, identity: asRole("waiter") }) };
  }

  it("un delivery guarda la dirección y registra los dos estados iniciales", async () => {
    const t = create([mode("both"), ...created]);
    const res = await request(t.app).post("/api/v1/orders").send(delivery);

    expect(res.status).toBe(201);
    expect(res.body.serviceType).toBe("delivery");
    expect(res.body.delivery).toEqual({ address: "Av. Larco 123", status: "pending_dispatch", assignedTo: null });
    expect(t.paramsOf(/INSERT INTO orders/)).toEqual([
      RESTAURANT, null, null, USER, REQUEST_ID, "delivery", "Av. Larco 123", "pending_dispatch",
    ]);
    const states = t.calls
      .filter((c) => /INSERT INTO order_status_history/.test(c.text))
      .map((c) => [c.params[3], c.params[5]]);
    expect(states).toEqual([
      ["pending", "status"],
      ["pending_dispatch", "delivery_status"],
    ]);
    expect(isolated(t.calls)).toBe(true);
  });

  it("restaurante solo en local: un delivery da 409 y no se escribe nada", async () => {
    const t = create([mode("dine_in"), ...created]);
    const res = await request(t.app).post("/api/v1/orders").send(delivery);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("SERVICE_MODE_NOT_ALLOWED");
    expect(t.ran(/INSERT INTO orders/)).toBe(false);
    expect(t.events).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it("restaurante solo delivery: un pedido en mesa da 409", async () => {
    const t = create([mode("delivery"), ...created]);
    const res = await request(t.app)
      .post("/api/v1/orders")
      .send({ tableLabel: "Mesa 1", items: [{ productId: P1, quantity: 1 }] });

    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe("Este restaurante no atiende en el local");
  });

  it.each([
    ["delivery sin dirección", { serviceType: "delivery", items: delivery.items }, "deliveryAddress"],
    ["delivery con mesa", { ...delivery, tableLabel: "Mesa 1" }, "tableLabel"],
    ["en local con dirección", { tableLabel: "Mesa 1", deliveryAddress: "x", items: delivery.items }, "deliveryAddress"],
    ["tipo desconocido", { ...delivery, serviceType: "takeaway" }, "serviceType"],
  ])("%s: 400 sin tocar la base", async (_n, body, field) => {
    const t = create([]);
    const res = await request(t.app).post("/api/v1/orders").send(body);

    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d: { field: string }) => d.field)).toContain(field);
    expect(t.calls).toHaveLength(0);
  });
});
