import { describe, expect, it, vi } from "vitest";
import { dispatch, errorResult, internalErrorResult } from "../src/core/dispatch";
import type { ApiRequest, Route } from "../src/core/types";
import type { Role } from "../src/types/auth";
import { HttpError } from "../src/utils/httpError";
import { asRole } from "./helpers/auth";
import { fakeDb } from "./helpers/fakeDb";

const routes: Route[] = [
  {
    method: "GET",
    resource: "/abierta",
    handle: async () => ({ status: 200, body: { ok: true } }),
  },
  {
    method: "POST",
    resource: "/solo-cocina",
    roles: ["kitchen", "admin"],
    handle: async () => ({ status: 200, body: { ok: true } }),
  },
  {
    method: "GET",
    resource: "/validacion",
    handle: async () => {
      throw new HttpError(400, "VALIDATION_ERROR", "Datos inválidos", [
        { field: "items[0].quantity", message: "Debe ser un entero entre 1 y 99" },
      ]);
    },
  },
  {
    method: "GET",
    resource: "/boom",
    handle: async () => {
      throw new Error("fallo interno con password=abc123");
    },
  },
];

function req(method: string, resource: string, role: Role = "waiter"): ApiRequest {
  return { method, resource, params: {}, query: {}, headers: {}, body: undefined, identity: asRole(role) };
}

describe("dispatch", () => {
  it("ruta inexistente: 404 NOT_FOUND", async () => {
    const res = await dispatch(fakeDb(), routes, req("GET", "/no-existe"));

    expect(res).toEqual({
      status: 404,
      body: { error: { code: "NOT_FOUND", message: "Ruta no encontrada" } },
    });
  });

  it("el método también cuenta: GET de una ruta POST da 404", async () => {
    const res = await dispatch(fakeDb(), routes, req("GET", "/solo-cocina", "kitchen"));
    expect(res.status).toBe(404);
  });

  it("rol no permitido: 403 FORBIDDEN y se registra el intento", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await dispatch(fakeDb(), routes, req("POST", "/solo-cocina", "cashier"));

    expect(res.status).toBe(403);
    expect((res.body as any).error.code).toBe("FORBIDDEN");
    expect(JSON.parse(String(spy.mock.calls[0]![0]))).toMatchObject({
      event: "ACCESS_DENIED",
      status: 403,
      path: "/solo-cocina",
    });
    spy.mockRestore();
  });

  it.each(["kitchen", "admin"] as const)("%s está permitido", async (role) => {
    const res = await dispatch(fakeDb(), routes, req("POST", "/solo-cocina", role));
    expect(res).toEqual({ status: 200, body: { ok: true } });
  });

  it("sin roles declarados, cualquier rol autenticado pasa", async () => {
    const res = await dispatch(fakeDb(), routes, req("GET", "/abierta", "cashier"));
    expect(res.status).toBe(200);
  });

  it("un error de negocio se devuelve con code, message y details", async () => {
    const res = await dispatch(fakeDb(), routes, req("GET", "/validacion"));

    expect(res).toEqual({
      status: 400,
      body: {
        error: {
          code: "VALIDATION_ERROR",
          message: "Datos inválidos",
          details: [{ field: "items[0].quantity", message: "Debe ser un entero entre 1 y 99" }],
        },
      },
    });
  });

  it("un error inesperado se lanza: quien llama decide (500 o reintento)", async () => {
    await expect(dispatch(fakeDb(), routes, req("GET", "/boom"))).rejects.toThrow("fallo interno");
  });
});

describe("errorResult e internalErrorResult", () => {
  it("sin details, la respuesta no incluye la clave", () => {
    const res = errorResult(new HttpError(409, "ORDER_ALREADY_PAID", "El pedido ya fue pagado"), {
      method: "POST",
      resource: "/x",
    });
    expect((res.body as any).error).not.toHaveProperty("details");
  });

  it("500 INTERNAL_ERROR sin filtrar el detalle interno, que va solo al log", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = internalErrorResult(new Error("fallo con password=abc123"));

    expect(res).toEqual({
      status: 500,
      body: { error: { code: "INTERNAL_ERROR", message: "Error interno del servidor" } },
    });
    expect(JSON.stringify(res.body)).not.toContain("abc123");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
