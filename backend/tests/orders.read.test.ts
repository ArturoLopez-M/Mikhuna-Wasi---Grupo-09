import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { asRole } from "./helpers/auth";
import {
  ORDER,
  P1,
  RESTAURANT,
  USER,
  isolated,
  orderView,
  scriptedDb,
  type Handler,
} from "./helpers/scriptedDb";

const URL = "/api/v1/orders";
const MAIN_QUERY = /JOIN users u/;

function setup(handlers: Handler[] = orderView()) {
  const fake = scriptedDb(handlers);
  const app = createApp({ db: fake.db, authenticate: asRole("kitchen") });
  return { ...fake, app };
}

describe("GET /orders: parámetros inválidos (400, sin tocar la base)", () => {
  const invalid = [
    "status=foo",
    "status=pending,foo",
    "status=",
    "status=pending,",
    "mine=yes",
    "mine=TRUE",
    "mine=",
    "sort=total",
    "sort=",
    "limit=0",
    "limit=101",
    "limit=abc",
    "limit=1.5",
    "limit=",
    "offset=-1",
    "offset=abc",
    "offset=1.5",
  ];

  it.each(invalid)("%s", async (qs) => {
    const t = setup();
    const res = await request(t.app).get(`${URL}?${qs}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(t.calls).toHaveLength(0);
  });
});

describe("GET /orders: consulta que se ejecuta", () => {
  it("por defecto: restaurante de la identidad, 50 filas, más recientes primero", async () => {
    const t = setup();
    const res = await request(t.app).get(URL);

    expect(res.status).toBe(200);
    expect(t.paramsOf(MAIN_QUERY)).toEqual([RESTAURANT, 50, 0]);
    expect(t.calls.find((c) => MAIN_QUERY.test(c.text))!.text).toMatch(/created_at DESC, o\.id DESC/);
  });

  it("aislamiento: conteo, pedidos y líneas van acotados al restaurante", async () => {
    const t = setup();
    await request(t.app).get(`${URL}?status=pending&mine=true`);

    expect(t.calls).toHaveLength(3);
    expect(isolated(t.calls)).toBe(true);
  });

  it("sort=createdAt ordena ascendente", async () => {
    const t = setup();
    await request(t.app).get(`${URL}?sort=createdAt`);

    expect(t.calls.find((c) => MAIN_QUERY.test(c.text))!.text).toMatch(/created_at ASC, o\.id ASC/);
  });

  it("limit, offset y status llegan como parámetros, no pegados al SQL", async () => {
    const t = setup();
    await request(t.app).get(`${URL}?status=pending,ready&limit=100&offset=20`);

    expect(t.paramsOf(MAIN_QUERY)).toEqual([RESTAURANT, ["pending", "ready"], 100, 20]);
    const sql = t.calls.find((c) => MAIN_QUERY.test(c.text))!.text;
    expect(sql).not.toContain("pending");
  });

  it("mine=true filtra por el usuario autenticado; mine=false equivale a omitirlo", async () => {
    const mine = setup();
    await request(mine.app).get(`${URL}?mine=true`);
    expect(mine.paramsOf(MAIN_QUERY)).toEqual([RESTAURANT, USER, 50, 0]);

    const notMine = setup();
    await request(notMine.app).get(`${URL}?mine=false`);
    expect(notMine.paramsOf(MAIN_QUERY)).toEqual([RESTAURANT, 50, 0]);
  });

  it("el conteo usa los mismos filtros que la lista", async () => {
    const t = setup();
    await request(t.app).get(`${URL}?status=ready&mine=true`);

    expect(t.paramsOf(/SELECT count\(\*\)/)).toEqual([RESTAURANT, ["ready"], USER]);
  });
});

describe("GET /orders: respuesta", () => {
  it("devuelve { data, pagination } con la forma completa del pedido", async () => {
    const t = setup(orderView({ total: 7 }));
    const res = await request(t.app).get(`${URL}?limit=1&offset=3`);

    expect(res.status).toBe(200);
    expect(res.body.pagination).toEqual({ limit: 1, offset: 3, total: 7 });
    expect(res.body.data).toEqual([
      {
        id: ORDER,
        tableLabel: "Mesa 4",
        status: "pending",
        notes: null,
        createdBy: { id: USER, fullName: "Ana Pérez" },
        createdAt: "2026-01-01T00:00:00.000Z",
        items: [
          {
            id: "77777777-7777-4777-8777-777777777777",
            productId: P1,
            productName: "Lomo saltado",
            quantity: 2,
            unitPrice: "35.00",
            lineTotal: "70.00",
            notes: null,
          },
        ],
        total: "70.00",
        payment: null,
      },
    ]);
  });

  it("sin pedidos: lista vacía y no consulta líneas", async () => {
    const t = setup(orderView({ found: false }));
    const res = await request(t.app).get(URL);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.pagination.total).toBe(0);
    expect(t.ran(/order_id = ANY/)).toBe(false);
  });

  it("un pedido pagado incluye el pago", async () => {
    const handlers = orderView({ status: "closed" }).map(([re, fn]): Handler =>
      MAIN_QUERY.test(re.source)
        ? [
            re,
            (p) =>
              (fn(p) as Array<Record<string, unknown>>).map((r) => ({
                ...r,
                pay_amount: "70.00",
                pay_method: "cash",
                pay_created_at: new Date("2026-01-01T01:00:00.000Z"),
              })),
          ]
        : [re, fn],
    );
    const res = await request(setup(handlers).app).get(URL);

    expect(res.body.data[0].payment).toEqual({
      amount: "70.00",
      method: "cash",
      createdAt: "2026-01-01T01:00:00.000Z",
    });
  });
});

describe("GET /orders/:id", () => {
  it("devuelve el pedido, filtrando por restaurante e id", async () => {
    const t = setup();
    const res = await request(t.app).get(`${URL}/${ORDER}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(ORDER);
    expect(t.paramsOf(MAIN_QUERY)).toEqual([RESTAURANT, ORDER, 1, 0]);
    expect(isolated(t.calls)).toBe(true);
  });

  it("id mal formado: 404 sin consultar la base", async () => {
    const t = setup();
    const res = await request(t.app).get(`${URL}/hola`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
    expect(t.calls).toHaveLength(0);
  });

  it("inexistente o de otro restaurante (la base no lo devuelve): 404", async () => {
    const t = setup(orderView({ found: false }));
    const res = await request(t.app).get(`${URL}/${ORDER}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});
