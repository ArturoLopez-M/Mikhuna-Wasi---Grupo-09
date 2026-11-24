import type { APIGatewayProxyEvent, SQSEvent } from "aws-lambda";
import { describe, expect, it, vi } from "vitest";
import { createQueueHandler, processMessage } from "../src/core/queue";
import { handleRestEvent, toProxyResult } from "../src/core/rest";
import type { ResolveIdentity } from "../src/core/types";
import { routes as cocinaRoutes } from "../src/lambdas/cocina/index";
import { routes as lecturaRoutes } from "../src/lambdas/lectura-config/index";
import { routes as pagosRoutes } from "../src/lambdas/pagos/index";
import { routes as pedidosRoutes } from "../src/lambdas/pedidos/index";
import { asRole } from "./helpers/auth";
import { ORDER, scriptedDb } from "./helpers/scriptedDb";

const resolve: ResolveIdentity = async () => asRole("kitchen");

const message = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    method: "POST",
    resource: "/api/v1/orders/{id}/start-preparing",
    pathParameters: { id: ORDER },
    body: null,
    sub: "sub-cocina",
    requestId: "req-1",
    ...over,
  });

const sqsEvent = (...bodies: string[]): SQSEvent =>
  ({ Records: bodies.map((body, i) => ({ messageId: `m${i}`, body })) }) as unknown as SQSEvent;

describe("cada Lambda atiende solo las rutas de su módulo (diagrama)", () => {
  const resources = (rs: readonly { method: string; resource: string }[]) =>
    rs.map((r) => `${r.method} ${r.resource}`).sort();

  it("Lectura y Configuración: solo consultas", () => {
    expect(resources(lecturaRoutes)).toEqual(["GET /api/v1/orders", "GET /api/v1/orders/{id}"]);
  });

  it("Pedidos: crear y cancelar", () => {
    expect(resources(pedidosRoutes)).toEqual(["POST /api/v1/orders", "POST /api/v1/orders/{id}/cancel"]);
  });

  it("Cocina: preparar y marcar listo", () => {
    expect(resources(cocinaRoutes)).toEqual([
      "POST /api/v1/orders/{id}/mark-ready",
      "POST /api/v1/orders/{id}/start-preparing",
    ]);
  });

  it("Registro de Pagos: pagar", () => {
    expect(resources(pagosRoutes)).toEqual(["POST /api/v1/orders/{id}/payment"]);
  });

  it("un mensaje que llega a la cola equivocada no se procesa (404, sin reintento)", async () => {
    const t = scriptedDb();
    const out = await processMessage(t.db, pagosRoutes, message(), resolve);

    expect(out).toMatchObject({ kind: "done", result: { status: 404 } });
    expect(t.calls).toHaveLength(0);
  });
});

describe("consumidor SQS", () => {
  it("un mensaje mal formado se descarta (no se arregla reintentando)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await processMessage(scriptedDb().db, cocinaRoutes, "{no es json", resolve);

    expect(out).toMatchObject({ kind: "done", result: { status: 400 } });
    spy.mockRestore();
  });

  it("un mensaje sin sub se descarta: el sub solo lo pone el autorizador", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await processMessage(scriptedDb().db, cocinaRoutes, message({ sub: "" }), resolve);

    expect(out).toMatchObject({ kind: "done", result: { status: 400 } });
    spy.mockRestore();
  });

  it("un cuerpo con JSON inválido es un 400 VALIDATION_ERROR", async () => {
    const out = await processMessage(scriptedDb().db, cocinaRoutes, message({ body: "{malo" }), resolve);

    expect(out).toMatchObject({
      kind: "done",
      result: { status: 400, body: { error: { code: "VALIDATION_ERROR", message: "Solicitud inválida" } } },
    });
  });

  it("ReportBatchItemFailures: solo vuelve a la cola el mensaje con error técnico", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    // m0: la base falla (técnico). m1: pedido inexistente (negocio, 404).
    const t = scriptedDb([
      [/FOR UPDATE/, (p) => (p[1] === ORDER ? new Error("conexión perdida") : [])],
    ]);
    const handler = createQueueHandler(cocinaRoutes, () => t.db, resolve);
    const other = "99999999-9999-4999-8999-999999999999";

    const res = await handler(sqsEvent(message(), message({ pathParameters: { id: other } })));

    expect(res.batchItemFailures).toEqual([{ itemIdentifier: "m0" }]);
    // El resultado del mensaje procesado queda registrado (fase 2: WebSocket).
    const result = JSON.parse(String(logs.mock.calls[0]![0]));
    expect(result).toMatchObject({ event: "WRITE_RESULT", requestId: "req-1", status: 404 });
    logs.mockRestore();
    errors.mockRestore();
  });
});

describe("Lambda Lectura y Configuración (API Gateway REST)", () => {
  const event = (over: Partial<APIGatewayProxyEvent> = {}) =>
    ({
      httpMethod: "GET",
      resource: "/api/v1/orders",
      pathParameters: null,
      queryStringParameters: null,
      headers: {},
      body: null,
      isBase64Encoded: false,
      requestContext: { requestId: "r", authorizer: { claims: { sub: "s" } } },
      ...over,
    }) as unknown as APIGatewayProxyEvent;

  it("sin claims del autorizador responde 401 (falla cerrado)", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await handleRestEvent(
      scriptedDb().db,
      lecturaRoutes,
      event({ requestContext: { requestId: "r" } } as never),
      resolve,
    );

    expect(res.status).toBe(401);
    spy.mockRestore();
  });

  it("un error inesperado es 500 sin filtrar el detalle", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = scriptedDb([[/count/, () => new Error("password=abc123")]]);
    const res = await handleRestEvent(t.db, lecturaRoutes, event(), resolve);

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("abc123");
    spy.mockRestore();
  });

  it("toProxyResult serializa a JSON con Content-Type", () => {
    const out = toProxyResult({ status: 201, body: { a: 1 }, headers: { "Idempotent-Replayed": "true" } });

    expect(out).toEqual({
      statusCode: 201,
      headers: { "Content-Type": "application/json", "Idempotent-Replayed": "true" },
      body: '{"a":1}',
    });
  });
});
