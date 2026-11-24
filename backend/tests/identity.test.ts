import { describe, expect, it, vi } from "vitest";
import { request, testApp } from "./helpers/api";
import { scriptedDb, type Handler } from "./helpers/scriptedDb";

// API Gateway valida el token de Cognito; la Lambda busca al usuario por el
// `sub` del token (Docs/api-contract.md, sección 2).
const SUB = "sub-del-mesero";
const USER_ID = "a0000000-0000-4000-8000-000000000002";
const RESTAURANT_ID = "11111111-1111-4111-8111-111111111111";

const userRow = (over: Record<string, unknown> = {}): Handler => [
  /FROM users/,
  () => [{ id: USER_ID, restaurant_id: RESTAURANT_ID, role: "waiter", is_active: true, ...over }],
];

function setup(handlers: Handler[]) {
  const fake = scriptedDb(handlers);
  return { ...fake, app: testApp({ db: fake.db, sub: SUB }) };
}

const PROTECTED = "/api/v1/orders";

describe("identidad: 403 (token válido, pero sin acceso)", () => {
  it.each([
    ["el usuario no tiene fila en users", [[/FROM users/, () => []]] as Handler[]],
    ["el usuario está inactivo", [userRow({ is_active: false })]],
    ["un rol desconocido en la base no se acepta", [userRow({ role: "superadmin" })]],
  ])("%s", async (_name, handlers) => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = setup(handlers);
    const res = await request(t.app).get(PROTECTED);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
    spy.mockRestore();
  });

  it("también en las escrituras: el mensaje se descarta sin reintento", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = setup([[/FROM users/, () => []]]);
    const res = await request(t.app).post(PROTECTED).send({ tableLabel: "M", items: [] });

    expect(res.status).toBe(403);
    expect(res.retried).toBe(false);
    spy.mockRestore();
  });
});

describe("identidad correcta", () => {
  const withOrders: Handler[] = [userRow(), [/SELECT count\(\*\)::int AS count/, () => [{ count: 0 }]]];

  it("busca al usuario por el sub del token", async () => {
    const t = setup(withOrders);
    await request(t.app).get(PROTECTED);

    expect(t.paramsOf(/FROM users/)).toEqual([SUB]);
  });

  it("restaurante y rol salen de la base: las consultas usan ese restaurante", async () => {
    const t = setup(withOrders);
    const res = await request(t.app).get(PROTECTED);

    expect(res.status).toBe(200);
    expect(t.paramsOf(/SELECT count\(\*\)/)![0]).toBe(RESTAURANT_ID);
  });

  it("el cliente no puede imponer restaurante ni rol con cabeceras o parámetros", async () => {
    const t = setup(withOrders);
    await request(t.app)
      .get(`${PROTECTED}?restaurantId=99999999-9999-4999-8999-999999999999&role=admin`)
      .set({ "x-restaurant-id": "99999999-9999-4999-8999-999999999999" });

    expect(t.paramsOf(/SELECT count\(\*\)/)![0]).toBe(RESTAURANT_ID);
  });

  it("el rol de la base se respeta: un cajero no puede crear pedidos (403)", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = setup([userRow({ role: "cashier" })]);
    const res = await request(t.app)
      .post(PROTECTED)
      .send({ tableLabel: "M", items: [{ productId: "55555555-5555-4555-8555-555555555555", quantity: 1 }] });

    expect(res.status).toBe(403);
    spy.mockRestore();
  });
});

describe("identidad: fallos internos", () => {
  it("si la base falla en una consulta, responde 500 (no se disfraza de 401 ni 403)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = setup([[/FROM users/, () => new Error("base caída")]]);
    const res = await request(t.app).get(PROTECTED);

    expect(res.status).toBe(500);
    spy.mockRestore();
  });

  it("si la base falla en una escritura, el mensaje vuelve a la cola", async () => {
    const t = setup([[/FROM users/, () => new Error("base caída")]]);
    const res = await request(t.app).post(PROTECTED).send({ tableLabel: "M", items: [] });

    expect(res.retried).toBe(true);
  });
});
