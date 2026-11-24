import { describe, expect, it, vi } from "vitest";
import { ApiError, createApi, PendingResultError, type WriteResult } from "../src/api/client";

const json = (status: number, body?: unknown) =>
  Promise.resolve(new Response(body === undefined ? null : JSON.stringify(body), { status }));

function api(fetchImpl: (url: string, init: RequestInit) => Promise<Response>, result: WriteResult | null = null) {
  const waitForResult = vi.fn(async () => result);
  return {
    waitForResult,
    api: createApi({
      baseUrl: "https://api.test",
      getToken: async () => "token-1",
      waitForResult,
      fetch: fetchImpl as typeof fetch,
    }),
  };
}

describe("consultas (Lectura y Configuración)", () => {
  it("envía el access token y devuelve el cuerpo", async () => {
    const f = vi.fn((_u: string, _i: RequestInit) => json(200, { data: [] }));
    const { api: a } = api(f);

    expect(await a.get("/api/v1/orders")).toEqual({ data: [] });
    expect(f.mock.calls[0]![0]).toBe("https://api.test/api/v1/orders");
    expect((f.mock.calls[0]![1].headers as Record<string, string>).Authorization).toBe("Bearer token-1");
  });

  it("un error del contrato se convierte en ApiError con code y details", async () => {
    const { api: a } = api(() =>
      json(400, { error: { code: "VALIDATION_ERROR", message: "Datos inválidos", details: [{ field: "price", message: "Precio inválido" }] } }),
    );
    const err = await a.post("/api/v1/products", {}).catch((e) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 400, code: "VALIDATION_ERROR", details: [{ field: "price", message: "Precio inválido" }] });
  });

  it("un 401 de API Gateway (sin cuerpo del contrato) da un mensaje claro", async () => {
    const { api: a } = api(() => json(401, { message: "Unauthorized" }));
    await expect(a.get("/api/v1/me")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("sin red da NETWORK_ERROR", async () => {
    const { api: a } = api(() => Promise.reject(new TypeError("Failed to fetch")));
    await expect(a.get("/api/v1/me")).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });
});

describe("escrituras por cola (202 + resultado por WebSocket)", () => {
  it("manda la Idempotency-Key, recibe 202 y devuelve el resultado del WebSocket", async () => {
    const f = vi.fn((_u: string, _i: RequestInit) => json(202, { requestId: "req-1" }));
    const { api: a, waitForResult } = api(f, { status: 201, body: { id: "pedido-1" } });

    const order = await a.write("/api/v1/orders", { tableLabel: "M1" }, "clave-1");

    expect(order).toEqual({ id: "pedido-1" });
    expect(waitForResult).toHaveBeenCalledWith("req-1");
    expect((f.mock.calls[0]![1].headers as Record<string, string>)["Idempotency-Key"]).toBe("clave-1");
  });

  it("un resultado de error (por ejemplo 409) se lanza como ApiError: no se muestra como confirmado", async () => {
    const { api: a } = api(() => json(202, { requestId: "req-2" }), {
      status: 409,
      body: { error: { code: "INVALID_ORDER_STATUS", message: "El pedido no está en un estado válido para esta acción" } },
    });
    await expect(a.write("/api/v1/orders/x/start-preparing")).rejects.toMatchObject({ status: 409, code: "INVALID_ORDER_STATUS" });
  });

  it("si el resultado no llega a tiempo, avisa que se está procesando", async () => {
    const { api: a } = api(() => json(202, { requestId: "req-3" }), null);
    await expect(a.write("/api/v1/orders/x/mark-ready")).rejects.toBeInstanceOf(PendingResultError);
  });

  it("si API Gateway no acepta la petición (no es 202), es un error inmediato", async () => {
    const { api: a, waitForResult } = api(() => json(403, { message: "Forbidden" }));
    await expect(a.write("/api/v1/orders")).rejects.toMatchObject({ status: 403 });
    expect(waitForResult).not.toHaveBeenCalled();
  });
});
