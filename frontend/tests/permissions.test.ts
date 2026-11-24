import { describe, expect, it } from "vitest";
import type { Me, Order, Role } from "../src/api/types";
import { missingFeatures } from "../src/components/browserSupport";
import { availableActions, defaultStatuses, tabsFor, visibleFor } from "../src/features/permissions";

const me = (role: Role, id = "u1"): Me => ({
  id,
  fullName: "X",
  email: "x@x",
  role,
  restaurant: { id: "r1", name: "R", serviceMode: "both" },
});

const order = (over: Partial<Order> = {}): Order => ({
  id: "o1",
  serviceType: "dine_in",
  tableLabel: "Mesa 1",
  delivery: null,
  status: "pending",
  notes: null,
  createdBy: { id: "u1", fullName: "Mesero" },
  createdAt: "2026-01-01T00:00:00.000Z",
  items: [],
  total: "10.00",
  payment: null,
  ...over,
});

const delivery = (status: "pending_dispatch" | "on_the_way", assignedTo: string | null, orderStatus: Order["status"] = "ready") =>
  order({
    serviceType: "delivery",
    tableLabel: null,
    status: orderStatus,
    delivery: { address: "Calle 1", status, assignedTo: assignedTo ? { id: assignedTo, fullName: "R" } : null },
  });

describe("acciones por rol (RNF09)", () => {
  it("cocina: preparar si está pendiente, marcar listo si está en preparación", () => {
    expect(availableActions(order({ status: "pending" }), me("kitchen"))).toEqual(["start-preparing"]);
    expect(availableActions(order({ status: "preparing" }), me("kitchen"))).toEqual(["mark-ready"]);
    expect(availableActions(order({ status: "ready" }), me("kitchen"))).toEqual([]);
  });

  it("mesero: solo cancela sus propios pedidos pendientes", () => {
    expect(availableActions(order(), me("waiter", "u1"))).toEqual(["cancel"]);
    expect(availableActions(order(), me("waiter", "otro"))).toEqual([]);
    expect(availableActions(order({ status: "preparing" }), me("waiter", "u1"))).toEqual([]);
  });

  it("cajero: cobra solo pedidos listos y sin pago", () => {
    expect(availableActions(order({ status: "ready" }), me("cashier"))).toEqual(["payment"]);
    expect(availableActions(order({ status: "preparing" }), me("cashier"))).toEqual([]);
  });

  it("repartidor: despacha si está libre o es suya, y entrega solo las suyas", () => {
    expect(availableActions(delivery("pending_dispatch", null), me("delivery"))).toEqual(["dispatch"]);
    expect(availableActions(delivery("pending_dispatch", "otro"), me("delivery"))).toEqual([]);
    expect(availableActions(delivery("pending_dispatch", null, "preparing"), me("delivery"))).toEqual([]);
    expect(availableActions(delivery("on_the_way", "u1"), me("delivery"))).toEqual(["deliver", "delivery-failed"]);
    expect(availableActions(delivery("on_the_way", "otro"), me("delivery"))).toEqual([]);
  });

  it("admin: todo lo operativo, pero despacha solo con repartidor asignado", () => {
    expect(availableActions(order({ status: "pending" }), me("admin"))).toEqual(["start-preparing", "cancel"]);
    expect(availableActions(delivery("pending_dispatch", null), me("admin"))).toEqual(["cancel", "payment"]);
    expect(availableActions(delivery("pending_dispatch", "r9"), me("admin"))).toContain("dispatch");
  });

  it("el repartidor solo ve deliveries sin terminar", () => {
    expect(visibleFor(order(), me("delivery"))).toBe(false);
    expect(visibleFor(delivery("on_the_way", "u1"), me("delivery"))).toBe(true);
    expect(visibleFor(order(), me("kitchen"))).toBe(true);
  });

  it("cada rol ve sus estados y sus pestañas", () => {
    expect(defaultStatuses("kitchen")).toEqual(["pending", "preparing"]);
    expect(defaultStatuses("cashier")).toEqual(["ready"]);
    expect(tabsFor("admin")).toEqual(["orders", "new-order", "products", "config"]);
    expect(tabsFor("waiter")).toEqual(["orders", "new-order"]);
    expect(tabsFor("kitchen")).toEqual(["orders"]);
  });
});

describe("navegador compatible (RNF09)", () => {
  const modern = {
    WebSocket: function () {},
    fetch: () => {},
    crypto: { randomUUID: () => "x" },
    CSS: { supports: () => true },
    sessionStorage: {},
  };

  it("un navegador actual no tiene faltantes", () => {
    expect(missingFeatures(modern)).toEqual([]);
  });

  it("uno antiguo muestra qué le falta", () => {
    expect(missingFeatures({ ...modern, WebSocket: undefined, crypto: {}, CSS: { supports: () => false } })).toEqual([
      "WebSocket",
      "crypto.randomUUID",
      "CSS Grid",
    ]);
  });
});
