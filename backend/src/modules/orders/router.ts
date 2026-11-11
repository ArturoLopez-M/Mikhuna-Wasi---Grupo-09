import { Router } from "express";
import type { ApiDependencies } from "../../routes";
import { requireRole } from "../../middleware/requireRole";
import { parseInput } from "../../utils/parseInput";
import { createOrderSchema, listOrdersQuerySchema } from "./schemas";
import { createOrder, getOrder, listOrders } from "./service";

export function createOrdersRouter({ db }: ApiDependencies): Router {
  const router = Router();

  router.post("/", requireRole("admin", "waiter"), async (req, res) => {
    const input = parseInput(createOrderSchema, req.body);
    const order = await createOrder(db, req.identity!, input);
    res.status(201).json(order);
  });

  router.get("/", async (req, res) => {
    const query = parseInput(listOrdersQuerySchema, req.query, "query");
    res.json(await listOrders(db, req.identity!, query));
  });

  router.get("/:id", async (req, res) => {
    res.json(await getOrder(db, req.identity!, req.params.id));
  });

  return router;
}