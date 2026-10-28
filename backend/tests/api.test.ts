import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { asRole } from "./helpers/auth";
import { fakeDb } from "./helpers/fakeDb";

describe("/api/v1", () => {
  it("rechaza con 401 si la autenticación no está configurada", async () => {
    const app = createApp({ db: fakeDb() });

    const res = await request(app).get("/api/v1/cualquier-cosa");

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("deja /health público, fuera del prefijo", async () => {
    const app = createApp({ db: fakeDb() });

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
  });

  it("con un usuario autenticado, una ruta inexistente da 404 NOT_FOUND", async () => {
    const app = createApp({ db: fakeDb(), authenticate: asRole("admin") });

    const res = await request(app).get("/api/v1/cualquier-cosa");

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});