import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../src/middleware/errorHandler";
import { requireRole } from "../src/middleware/requireRole";
import { asRole } from "./helpers/auth";

const ok = (_req: express.Request, res: express.Response) => {
  res.json({ ok: true });
};

const testApp = express();
testApp.get("/sin-identidad", requireRole("admin"), ok);
testApp.get("/solo-admin", asRole("waiter"), requireRole("admin"), ok);
testApp.get("/admin-ok", asRole("admin"), requireRole("admin"), ok);
testApp.get("/cocina-o-admin", asRole("kitchen"), requireRole("kitchen", "admin"), ok);
testApp.get("/cocina-cajero", asRole("cashier"), requireRole("kitchen", "admin"), ok);
testApp.use(errorHandler);

describe("requireRole", () => {
  it("responde 401 UNAUTHENTICATED si no hay identidad", async () => {
    const res = await request(testApp).get("/sin-identidad");

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("responde 403 FORBIDDEN si el rol no está permitido", async () => {
    const res = await request(testApp).get("/solo-admin");

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("deja pasar al rol permitido", async () => {
    const res = await request(testApp).get("/admin-ok");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("acepta varios roles, pero rechaza el que no está en la lista", async () => {
    const permitido = await request(testApp).get("/cocina-o-admin");
    const rechazado = await request(testApp).get("/cocina-cajero");

    expect(permitido.status).toBe(200);
    expect(rechazado.status).toBe(403);
  });
});