import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { asRole } from "./helpers/auth";
import { fakeDb } from "./helpers/fakeDb";

const valid = {
  tableLabel: "Mesa 4",
  items: [{ productId: "33333333-3333-4333-8333-333333333333", quantity: 2 }],
};

describe("POST /api/v1/orders", () => {
  it("cocina no puede crear pedidos (403)", async () => {
    const app = createApp({ db: fakeDb(), authenticate: asRole("kitchen") });
    const res = await request(app).post("/api/v1/orders").send(valid);
    expect(res.status).toBe(403);
  });

  it("rechaza unitPrice enviado por el cliente (400)", async () => {
    const app = createApp({ db: fakeDb(), authenticate: asRole("waiter") });
    const res = await request(app)
      .post("/api/v1/orders")
      .send({
        ...valid,
        items: [{ ...valid.items[0], unitPrice: "0.01" }],
      });
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].field).toBe("items[0].unitPrice");
  });
});