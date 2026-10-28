import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../src/middleware/errorHandler";
import { HttpError } from "../src/utils/httpError";

// App mínima solo para probar el errorHandler con errores lanzados a propósito.
const testApp = express();

testApp.get("/forbidden", () => {
  throw new HttpError(403, "FORBIDDEN", "No tienes permiso para esta acción");
});

testApp.get("/validation", () => {
  throw new HttpError(400, "VALIDATION_ERROR", "Datos inválidos", [
    { field: "items[0].quantity", message: "Debe ser un entero entre 1 y 99" },
  ]);
});

testApp.get("/boom", () => {
  throw new Error("fallo interno con password=abc123");
});

testApp.use(errorHandler);

describe("errorHandler", () => {
  it("devuelve code y message, sin details cuando no hay", async () => {
    const res = await request(testApp).get("/forbidden");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: {
        code: "FORBIDDEN",
        message: "No tienes permiso para esta acción",
      },
    });
    expect(res.body.error).not.toHaveProperty("details");
  });

  it("incluye details en errores de validación", async () => {
    const res = await request(testApp).get("/validation");

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "Datos inválidos",
        details: [
          {
            field: "items[0].quantity",
            message: "Debe ser un entero entre 1 y 99",
          },
        ],
      },
    });
  });

  it("responde 500 INTERNAL_ERROR sin filtrar el detalle interno", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(testApp).get("/boom");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "Error interno del servidor",
      },
    });
    expect(JSON.stringify(res.body)).not.toContain("abc123");
    expect(spy).toHaveBeenCalled();

    spy.mockRestore();
  });
});