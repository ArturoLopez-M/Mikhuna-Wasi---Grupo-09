import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { errorHandler } from "../src/middleware/errorHandler";
import { HttpError } from "../src/utils/httpError";
import { parseInput } from "../src/utils/parseInput";

const productId = "11111111-1111-4111-8111-111111111111";

// Esquema de ejemplo con la forma del contrato para crear un pedido.
const orderSchema = z.strictObject({
  tableLabel: z.string().min(1).max(30),
  items: z
    .array(
      z.strictObject({
        productId: z.uuid(),
        quantity: z.number().int().min(1).max(99),
      }),
    )
    .min(1)
    .max(50),
});

function capture(fn: () => unknown): HttpError {
  try {
    fn();
  } catch (err) {
    if (err instanceof HttpError) return err;
    throw err;
  }
  throw new Error("Se esperaba que lanzara un HttpError");
}

describe("parseInput", () => {
  it("devuelve los datos cuando son válidos", () => {
    const input = { tableLabel: "Mesa 4", items: [{ productId, quantity: 2 }] };

    expect(parseInput(orderSchema, input)).toEqual(input);
  });

  it("reporta la ruta anidada con la notación items[0].quantity", () => {
    const err = capture(() =>
      parseInput(orderSchema, {
        tableLabel: "Mesa 4",
        items: [{ productId, quantity: 0 }],
      }),
    );

    expect(err.statusCode).toBe(400);
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.details?.map((d) => d.field)).toEqual(["items[0].quantity"]);
  });

  it("rechaza un campo desconocido con un detalle por campo", () => {
    const err = capture(() =>
      parseInput(orderSchema, {
        tableLabel: "Mesa 4",
        items: [{ productId, quantity: 1 }],
        status: "closed",
      }),
    );

    expect(err.details).toEqual([
      { field: "status", message: "Campo no permitido" },
    ]);
  });

  it("reporta todos los errores a la vez", () => {
    const err = capture(() =>
      parseInput(orderSchema, {
        tableLabel: "",
        items: [{ productId, quantity: 100 }],
      }),
    );

    const fields = err.details?.map((d) => d.field);
    expect(fields).toContain("tableLabel");
    expect(fields).toContain("items[0].quantity");
  });

  it("usa body como campo cuando el error está en la raíz", () => {
    const err = capture(() => parseInput(orderSchema, null));

    expect(err.details?.[0].field).toBe("body");
  });

  it("usa el nombre indicado en rootField, por ejemplo query", () => {
    const err = capture(() => parseInput(orderSchema, null, "query"));

    expect(err.details?.[0].field).toBe("query");
  });

  it("devuelve los mensajes de Zod en español", () => {
    const err = capture(() => parseInput(orderSchema, { tableLabel: 5 }));

    const message = err.details?.[0].message ?? "";
    expect(message).not.toBe("");
    expect(message).not.toMatch(/Invalid|Expected|Required/);
  });
});

describe("parseInput dentro de Express", () => {
  const testApp = express();
  testApp.use(express.json());
  testApp.post("/orders", (req, res) => {
    const input = parseInput(orderSchema, req.body);
    res.status(201).json(input);
  });
  testApp.use(errorHandler);

  it("responde 400 en el formato del contrato cuando el cuerpo es inválido", async () => {
    const res = await request(testApp)
      .post("/orders")
      .send({ tableLabel: "Mesa 4", items: [] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.message).toBe("Datos inválidos");
    expect(res.body.error.details[0].field).toBe("items");
  });

  it("deja pasar un cuerpo válido", async () => {
    const res = await request(testApp)
      .post("/orders")
      .send({ tableLabel: "Mesa 4", items: [{ productId, quantity: 2 }] });

    expect(res.status).toBe(201);
  });
});