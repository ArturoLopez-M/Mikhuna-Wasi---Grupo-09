import type { APIGatewayProxyEvent, SQSEvent } from "aws-lambda";
import { afterEach, describe, expect, it, vi } from "vitest";
import { orderCacheKey } from "../src/core/cache";
import { createQueueHandler } from "../src/core/queue";
import { registerConnection } from "../src/core/realtime";
import { handleRestEvent } from "../src/core/rest";
import type { ResolveIdentity } from "../src/core/types";
import { handleWebSocketEvent } from "../src/core/websocket";
import { routes as cocinaRoutes } from "../src/lambdas/cocina/index";
import { routes as lecturaRoutes } from "../src/lambdas/lectura-config/index";
import { HttpError } from "../src/utils/httpError";
import { asRole } from "./helpers/auth";
import { fakeCache, fakeNotifier } from "./helpers/fakeCache";
import { ORDER, RESTAURANT, USER, orderView, scriptedDb, type Handler } from "./helpers/scriptedDb";

afterEach(() => vi.restoreAllMocks());
const quiet = () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
};

const kitchen = asRole("kitchen");
const resolveKitchen: ResolveIdentity = async () => kitchen;

// ---------------------------------------------------------------------------
// WebSocket: $connect y $disconnect (Lambda Lectura y Configuración)
// ---------------------------------------------------------------------------
describe("WebSocket $connect", () => {
  const event = (token?: string) => ({
    requestContext: { routeKey: "$connect", connectionId: "c1" },
    queryStringParameters: token ? { token } : null,
  });
  const verifyToken = async (t: string) => {
    if (t !== "token-valido") throw new Error("firma inválida");
    return { sub: "sub-cocina" };
  };

  it("con token válido registra la conexión por restaurante y por usuario", async () => {
    const c = fakeCache();
    const res = await handleWebSocketEvent(scriptedDb().db, event("token-valido"), {
      cache: c.cache,
      verifyToken,
      resolve: resolveKitchen,
    });

    expect(res.statusCode).toBe(200);
    expect([...c.sets.get(`ws:restaurant:${RESTAURANT}`)!]).toEqual(["c1"]);
    expect([...c.sets.get(`ws:user:${USER}`)!]).toEqual(["c1"]);
    expect(JSON.parse(c.values.get("ws:conn:c1")!)).toEqual(kitchen);
  });

  it.each([
    ["sin token", undefined],
    ["con token inválido", "token-falso"],
  ])("%s: 401 y no se registra", async (_n, token) => {
    quiet();
    const c = fakeCache();
    const res = await handleWebSocketEvent(scriptedDb().db, event(token), {
      cache: c.cache,
      verifyToken,
      resolve: resolveKitchen,
    });

    expect(res.statusCode).toBe(401);
    expect(c.sets.size).toBe(0);
  });

  it("sin Cognito configurado no se acepta ninguna conexión (falla cerrado)", async () => {
    quiet();
    const res = await handleWebSocketEvent(scriptedDb().db, event("token-valido"), {
      cache: fakeCache().cache,
      resolve: resolveKitchen,
    });
    expect(res.statusCode).toBe(401);
  });

  it("usuario sin acceso en la base: 403", async () => {
    quiet();
    const res = await handleWebSocketEvent(scriptedDb().db, event("token-valido"), {
      cache: fakeCache().cache,
      verifyToken,
      resolve: async () => {
        throw new HttpError(403, "FORBIDDEN", "El usuario no tiene acceso al sistema");
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it("sin ElastiCache se rechaza con 503: la pantalla usa el polling", async () => {
    const res = await handleWebSocketEvent(scriptedDb().db, event("token-valido"), {
      verifyToken,
      resolve: resolveKitchen,
    });
    expect(res.statusCode).toBe(503);
  });
});

describe("WebSocket $disconnect", () => {
  it("borra la conexión de todos los registros", async () => {
    const c = fakeCache();
    await registerConnection(c.cache, "c1", kitchen);

    const res = await handleWebSocketEvent(
      scriptedDb().db,
      { requestContext: { routeKey: "$disconnect", connectionId: "c1" } },
      { cache: c.cache, resolve: resolveKitchen },
    );

    expect(res.statusCode).toBe(200);
    expect(c.sets.get(`ws:restaurant:${RESTAURANT}`)!.size).toBe(0);
    expect(c.sets.get(`ws:user:${USER}`)!.size).toBe(0);
    expect(c.values.has("ws:conn:c1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Consumidor SQS: duplicados (RNF02) y avisos por WebSocket (RNF03)
// ---------------------------------------------------------------------------
const message = (requestId = "req-1") =>
  JSON.stringify({
    method: "POST",
    resource: "/api/v1/orders/{id}/start-preparing",
    pathParameters: { id: ORDER },
    body: null,
    sub: "sub-cocina",
    requestId,
  });
const sqs = (...bodies: string[]): SQSEvent =>
  ({ Records: bodies.map((body, i) => ({ messageId: `m${i}`, body })) }) as unknown as SQSEvent;

const preparable: Handler[] = [
  [/FOR UPDATE/, () => [{ id: ORDER, status: "pending", created_by: USER }]],
  ...orderView({ status: "preparing" }),
];

function consumer(handlers: Handler[], c = fakeCache(), n = fakeNotifier()) {
  const t = scriptedDb(handlers);
  const handler = createQueueHandler(cocinaRoutes, () => t.db, resolveKitchen, () => ({
    cache: c.cache,
    notifier: n.notifier,
  }));
  return { handler, t, c, n };
}

describe("consumidor SQS con ElastiCache", () => {
  it("un mensaje ya procesado se descarta sin tocar la base", async () => {
    quiet();
    const { handler, t, c } = consumer(preparable);
    c.values.set("dedup:done:req-1", "200");

    const res = await handler(sqs(message()));

    expect(res.batchItemFailures).toEqual([]);
    expect(t.calls).toHaveLength(0);
  });

  it("si otra Lambda lo está procesando, vuelve a la cola sin tocar la base", async () => {
    quiet();
    const { handler, t, c } = consumer(preparable);
    c.values.set("dedup:lock:req-1", "1");

    const res = await handler(sqs(message()));

    expect(res.batchItemFailures).toEqual([{ itemIdentifier: "m0" }]);
    expect(t.calls).toHaveLength(0);
  });

  it("al terminar marca el mensaje como hecho, libera el lock e invalida la caché del pedido", async () => {
    quiet();
    const { handler, c } = consumer(preparable);
    const key = orderCacheKey(RESTAURANT, ORDER);
    c.values.set(key, "{}");

    await handler(sqs(message()));

    expect(c.values.get("dedup:done:req-1")).toBe("200");
    expect(c.values.has("dedup:lock:req-1")).toBe(false);
    expect(c.values.has(key)).toBe(false);
  });

  it("el mismo mensaje dos veces solo se procesa una vez", async () => {
    quiet();
    const { handler, t } = consumer(preparable);

    await handler(sqs(message()));
    const after = t.calls.length;
    await handler(sqs(message()));

    expect(t.calls.length).toBe(after);
  });

  it("con error técnico libera el lock y no lo marca como hecho (se reintenta)", async () => {
    quiet();
    const { handler, c } = consumer([[/FOR UPDATE/, () => new Error("conexión perdida")]]);

    const res = await handler(sqs(message()));

    expect(res.batchItemFailures).toEqual([{ itemIdentifier: "m0" }]);
    expect(c.values.has("dedup:lock:req-1")).toBe(false);
    expect(c.values.has("dedup:done:req-1")).toBe(false);
  });

  it("si ElastiCache no responde, el mensaje se procesa igual (RNF07)", async () => {
    quiet();
    const c = fakeCache();
    c.state.down = true;
    const { handler, t } = consumer(preparable, c);

    const res = await handler(sqs(message()));

    expect(res.batchItemFailures).toEqual([]);
    expect(t.ran(/UPDATE orders SET status/)).toBe(true);
  });
});

describe("avisos por WebSocket tras una escritura", () => {
  async function withConnections() {
    const c = fakeCache();
    await registerConnection(c.cache, "mia", kitchen);
    await registerConnection(c.cache, "mesero", { ...asRole("waiter"), userId: "otro-usuario" });
    return c;
  }

  it("éxito: el autor recibe write.result y todo el restaurante order.updated", async () => {
    quiet();
    const c = await withConnections();
    const n = fakeNotifier();
    const { handler } = consumer(preparable, c, n);

    await handler(sqs(message()));

    const mine = n.sent.filter((s) => s.connectionId === "mia").map((s) => s.payload.type);
    const waiter = n.sent.filter((s) => s.connectionId === "mesero").map((s) => s.payload.type);
    expect(mine).toEqual(["write.result", "order.updated"]);
    expect(waiter).toEqual(["order.updated"]);
    expect(n.sent[0]!.payload).toMatchObject({ requestId: "req-1", status: 200, body: { id: ORDER } });
  });

  it("error de negocio: solo el autor recibe el resultado, el pedido no cambió", async () => {
    quiet();
    const c = await withConnections();
    const n = fakeNotifier();
    const { handler } = consumer(
      [[/FOR UPDATE/, () => [{ id: ORDER, status: "ready", created_by: USER }]]],
      c,
      n,
    );

    await handler(sqs(message()));

    expect(n.sent).toEqual([
      expect.objectContaining({
        connectionId: "mia",
        payload: expect.objectContaining({ type: "write.result", status: 409 }),
      }),
    ]);
  });

  it("una conexión cerrada (Gone) se borra del registro", async () => {
    quiet();
    const c = await withConnections();
    const { handler } = consumer(preparable, c, fakeNotifier(["mesero"]));

    await handler(sqs(message()));

    expect(c.sets.get(`ws:restaurant:${RESTAURANT}`)!.has("mesero")).toBe(false);
    expect(c.values.has("ws:conn:mesero")).toBe(false);
  });

  it("si el aviso falla, la escritura no se reintenta (ya se guardó)", async () => {
    quiet();
    const c = await withConnections();
    const { handler } = consumer(preparable, c, fakeNotifier([], ["mia", "mesero"]));

    const res = await handler(sqs(message()));

    expect(res.batchItemFailures).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Caché de lectura del pedido (Lambda Lectura y Configuración)
// ---------------------------------------------------------------------------
describe("GET /orders/{id} con ElastiCache", () => {
  const event = {
    httpMethod: "GET",
    resource: "/api/v1/orders/{id}",
    pathParameters: { id: ORDER },
    queryStringParameters: null,
    headers: {},
    body: null,
    isBase64Encoded: false,
    requestContext: { requestId: "r", authorizer: { claims: { sub: "s" } } },
  } as unknown as APIGatewayProxyEvent;

  it("si está en caché, responde sin ir a la base", async () => {
    const c = fakeCache();
    c.values.set(orderCacheKey(RESTAURANT, ORDER), JSON.stringify({ id: ORDER, cached: true }));
    const t = scriptedDb(orderView());

    const res = await handleRestEvent(t.db, lecturaRoutes, event, resolveKitchen, { cache: c.cache });

    expect(res.body).toEqual({ id: ORDER, cached: true });
    expect(t.calls).toHaveLength(0);
  });

  it("si no está, lee de la base y lo guarda con la clave del restaurante", async () => {
    const c = fakeCache();
    const t = scriptedDb(orderView());

    const res = await handleRestEvent(t.db, lecturaRoutes, event, resolveKitchen, { cache: c.cache });

    expect(res.status).toBe(200);
    expect(t.calls.length).toBeGreaterThan(0);
    expect(JSON.parse(c.values.get(orderCacheKey(RESTAURANT, ORDER))!).id).toBe(ORDER);
  });

  it("un pedido de otro restaurante no se sirve desde la caché", async () => {
    const c = fakeCache();
    c.values.set(orderCacheKey("otro-restaurante", ORDER), JSON.stringify({ id: ORDER }));
    const t = scriptedDb(orderView({ found: false }));

    const res = await handleRestEvent(t.db, lecturaRoutes, event, resolveKitchen, { cache: c.cache });

    expect(res.status).toBe(404);
  });

  it("si ElastiCache no responde, lee de la base", async () => {
    quiet();
    const c = fakeCache();
    c.state.down = true;
    const res = await handleRestEvent(scriptedDb(orderView()).db, lecturaRoutes, event, resolveKitchen, {
      cache: c.cache,
    });

    expect(res.status).toBe(200);
  });
});
