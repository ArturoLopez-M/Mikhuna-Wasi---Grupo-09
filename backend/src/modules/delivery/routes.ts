import { z } from "zod";
import type { ApiRequest, Route } from "../../core/types";
import { parseInput } from "../../utils/parseInput";
import { emptyBodySchema } from "../orders/schemas";
import { assignCourier, deliverOrder, dispatchOrder, failDelivery } from "./service";

const ORDER = "/api/v1/orders/{id}";

const assignSchema = z.strictObject({ userId: z.guid() });

function orderId(req: ApiRequest): string {
  return String(req.params.id);
}

function expectNoBody(req: ApiRequest): void {
  parseInput(emptyBodySchema, req.body ?? {});
}

// Lambda Delivery (cola de delivery).
export const deliveryRoutes: readonly Route[] = [
  {
    method: "POST",
    resource: `${ORDER}/dispatch`,
    roles: ["delivery", "admin"],
    async handle(db, req) {
      expectNoBody(req);
      return { status: 200, body: await dispatchOrder(db, req.identity, orderId(req)) };
    },
  },
  {
    method: "POST",
    resource: `${ORDER}/deliver`,
    roles: ["delivery", "admin"],
    async handle(db, req) {
      expectNoBody(req);
      return { status: 200, body: await deliverOrder(db, req.identity, orderId(req)) };
    },
  },
  {
    method: "POST",
    resource: `${ORDER}/delivery-failed`,
    roles: ["delivery", "admin"],
    async handle(db, req) {
      expectNoBody(req);
      return { status: 200, body: await failDelivery(db, req.identity, orderId(req)) };
    },
  },
  {
    method: "POST",
    resource: `${ORDER}/assign`,
    roles: ["admin"],
    async handle(db, req) {
      const { userId } = parseInput(assignSchema, req.body);
      return { status: 200, body: await assignCourier(db, req.identity, orderId(req), userId) };
    },
  },
];
