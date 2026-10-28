import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { fakeDb } from "./helpers/fakeDb";

describe("GET /health", () => {
  it("responde 200 con { status: 'ok' } cuando la base responde", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ "?column?": 1 }] });

    const res = await request(createApp({ db: fakeDb(query) })).get("/health");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toEqual({ status: "ok" });
    expect(query).toHaveBeenCalledWith("SELECT 1");
  });

  it("no expone la cabecera X-Powered-By", async () => {
    const res = await request(createApp({ db: fakeDb() })).get("/health");

    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("responde 503 sin filtrar el motivo cuando la base falla", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const query = vi
      .fn()
      .mockRejectedValue(new Error("conexión rechazada, password=abc123"));

    const res = await request(createApp({ db: fakeDb(query) })).get("/health");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: "error" });
    expect(JSON.stringify(res.body)).not.toContain("abc123");
    expect(spy).toHaveBeenCalled();

    spy.mockRestore();
  });
});