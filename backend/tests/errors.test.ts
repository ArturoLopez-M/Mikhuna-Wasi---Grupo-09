import request from "supertest";
import { describe, expect, it } from "vitest";
import { app } from "../src/app";

describe("manejo de errores", () => {
  it("responde 404 en JSON para una ruta inexistente", async () => {
    const res = await request(app).get("/ruta-que-no-existe");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { message: "Ruta no encontrada" } });
  });

  it("responde 400 en JSON cuando el cuerpo es un JSON inválido", async () => {
    const res = await request(app)
      .post("/health")
      .set("Content-Type", "application/json")
      .send("{malo");

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: "Solicitud inválida" } });
  });
});
