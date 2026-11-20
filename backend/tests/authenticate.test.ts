import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { VerifyToken } from "../src/auth/cognito";
import { createAuthenticate } from "../src/middleware/authenticate";
import { scriptedDb, type Handler } from "./helpers/scriptedDb";

const SUB = "sub-del-mesero";
const USER_ID = "a0000000-0000-4000-8000-000000000002";
const RESTAURANT_ID = "11111111-1111-4111-8111-111111111111";

const userRow = (over: Record<string, unknown> = {}): Handler => [
  /FROM users/,
  () => [
    { id: USER_ID, restaurant_id: RESTAURANT_ID, role: "waiter", is_active: true, ...over },
  ],
];

// Verificador falso: acepta solo "token-valido" y devuelve el sub indicado.
const verifyOk: VerifyToken = async (token) => {
  if (token !== "token-valido") throw new Error("firma inválida");
  return { sub: SUB };
};

function setup(handlers: Handler[], verifyToken: VerifyToken = verifyOk) {
  const fake = scriptedDb(handlers);
  const app = createApp({
    db: fake.db,
    authenticate: createAuthenticate({ db: fake.db, verifyToken }),
  });
  return { ...fake, app };
}

// Ruta protegida cualquiera: la lista de pedidos.
const PROTECTED = "/api/v1/orders";
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

describe("authenticate: 401 (no hay identidad confiable)", () => {
  it("sin cabecera Authorization", async () => {
    const t = setup([userRow()]);
    const res = await request(t.app).get(PROTECTED);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
    expect(t.calls).toHaveLength(0);
  });

  it.each([
    ["esquema distinto", "Basic abc"],
    ["sin token", "Bearer"],
    ["sin token y con espacio", "Bearer "],
    ["token con espacios", "Bearer dos partes"],
    ["solo el token", "token-valido"],
  ])("cabecera mal formada: %s", async (_name, header) => {
    const t = setup([userRow()]);
    const res = await request(t.app).get(PROTECTED).set("Authorization", header);

    expect(res.status).toBe(401);
    expect(t.calls).toHaveLength(0);
  });

  it("token rechazado por el verificador: 401 sin revelar el motivo", async () => {
    const t = setup([userRow()]);
    const res = await request(t.app).get(PROTECTED).set(bearer("token-falso"));

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
    expect(JSON.stringify(res.body)).not.toContain("firma");
    expect(t.calls).toHaveLength(0); // ni siquiera consulta la base
  });
});

describe("authenticate: 403 (token válido, pero sin acceso)", () => {
  it("el usuario no tiene fila en users", async () => {
    const t = setup([[/FROM users/, () => []]]);
    const res = await request(t.app).get(PROTECTED).set(bearer("token-valido"));

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("el usuario está inactivo", async () => {
    const t = setup([userRow({ is_active: false })]);
    const res = await request(t.app).get(PROTECTED).set(bearer("token-valido"));

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("un rol desconocido en la base no se acepta", async () => {
    const t = setup([userRow({ role: "superadmin" })]);
    const res = await request(t.app).get(PROTECTED).set(bearer("token-valido"));

    expect(res.status).toBe(403);
  });
});

describe("authenticate: identidad correcta", () => {
  const withOrders: Handler[] = [
    userRow(),
    [/SELECT count\(\*\)::int AS count/, () => [{ count: 0 }]],
  ];

  it("busca al usuario por el sub del token", async () => {
    const t = setup(withOrders);
    await request(t.app).get(PROTECTED).set(bearer("token-valido"));

    expect(t.paramsOf(/FROM users/)).toEqual([SUB]);
  });

  it("restaurante y rol salen de la base: las consultas de negocio usan ese restaurante", async () => {
    const t = setup(withOrders);
    const res = await request(t.app).get(PROTECTED).set(bearer("token-valido"));

    expect(res.status).toBe(200);
    expect(t.paramsOf(/SELECT count\(\*\)/)![0]).toBe(RESTAURANT_ID);
  });

  it("el cliente no puede imponer restaurante ni rol con cabeceras o parámetros", async () => {
    const t = setup(withOrders);
    await request(t.app)
      .get(`${PROTECTED}?restaurantId=99999999-9999-4999-8999-999999999999&role=admin`)
      .set({ ...bearer("token-valido"), "x-restaurant-id": "99999999-9999-4999-8999-999999999999" });

    expect(t.paramsOf(/SELECT count\(\*\)/)![0]).toBe(RESTAURANT_ID);
  });

  it("el rol de la base se respeta: un cajero no puede crear pedidos (403)", async () => {
    const t = setup([userRow({ role: "cashier" })]);
    const res = await request(t.app)
      .post(PROTECTED)
      .set(bearer("token-valido"))
      .send({ tableLabel: "M", items: [{ productId: "55555555-5555-4555-8555-555555555555", quantity: 1 }] });

    expect(res.status).toBe(403);
  });

  it("acepta 'bearer' en minúsculas (el esquema no distingue mayúsculas)", async () => {
    const t = setup(withOrders);
    const res = await request(t.app).get(PROTECTED).set("Authorization", "bearer token-valido");

    expect(res.status).toBe(200);
  });
});

describe("authenticate: fallos internos", () => {
  it("si la base falla, responde 500 (no se disfraza de 401 ni de 403)", async () => {
    const t = setup([[/FROM users/, () => new Error("base caída")]]);
    const res = await request(t.app).get(PROTECTED).set(bearer("token-valido"));

    expect(res.status).toBe(500);
  });

  it("/health no exige autenticación", async () => {
    const t = setup([]);
    const res = await request(t.app).get("/health");

    expect(res.status).toBe(200);
  });
});
