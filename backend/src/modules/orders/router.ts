import { Router } from "express";
import type { ApiDependencies } from "../../routes";
import { requireRole } from "../../middleware/requireRole";
import { parseInput } from "../../utils/parseInput";
import { createOrderSchema } from "./schemas";
import { createOrder } from "./service";

export function createOrdersRouter({ db }: ApiDependencies): Router {
  const router = Router();

  router.post("/", requireRole("admin", "waiter"), async (req, res) => {
    const input = parseInput(createOrderSchema, req.body);
    const order = await createOrder(db, req.identity!, input);
    res.status(201).json(order);
  });

  return router;
}