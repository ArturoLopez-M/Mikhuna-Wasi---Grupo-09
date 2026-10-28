import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { fakeDb } from "./helpers/fakeDb";

const app = createApp({ db: fakeDb() });

describe("manejo de errores", () => {
  it("responde 404 NOT_FOUND en JSON para una ruta inexistente", async () => {
    const res = await request(app).get("/ruta-que-no-existe");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { code: "NOT_FOUND", message: "Ruta no encontrada" },
    });
  });

  it("responde 400 VALIDATION_ERROR cuando el cuerpo es un JSON inválido", async () => {
    const res = await request(app)
      .post("/health")
      .set("Content-Type", "application/json")
      .send("{malo");

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: { code: "VALIDATION_ERROR", message: "Solicitud inválida" },
    });
  });
});