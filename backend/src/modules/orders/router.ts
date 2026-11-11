import { Router, type Request } from "express";
import type { ApiDependencies } from "../../routes";
import { requireRole } from "../../middleware/requireRole";
import { parseInput } from "../../utils/parseInput";
import {
  createOrderSchema,
  emptyBodySchema,
  listOrdersQuerySchema,
  paymentSchema,
} from "./schemas";
import {
  cancelOrder,
  createOrder,
  getOrder,
  listOrders,
  markReady,
  payOrder,
  startPreparing,
} from "./service";

// Las acciones sin cuerpo aceptan vacío, pero no campos desconocidos.
function expectNoBody(req: Request): void {
  parseInput(emptyBodySchema, req.body ?? {});
}

// El id viene de la URL. Si no fuera un UUID válido, el servicio responde 404.
function orderId(req: Request): string {
  return String(req.params.id);
}

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
    res.json(await getOrder(db, req.identity!, orderId(req)));
  });

  router.post(
    "/:id/start-preparing",
    requireRole("kitchen", "admin"),
    async (req, res) => {
      expectNoBody(req);
      res.json(await startPreparing(db, req.identity!, orderId(req)));
    },
  );

  router.post(
    "/:id/mark-ready",
    requireRole("kitchen", "admin"),
    async (req, res) => {
      expectNoBody(req);
      res.json(await markReady(db, req.identity!, orderId(req)));
    },
  );

  router.post(
    "/:id/cancel",
    requireRole("waiter", "admin"),
    async (req, res) => {
      expectNoBody(req);
      res.json(await cancelOrder(db, req.identity!, orderId(req)));
    },
  );

  router.post(
    "/:id/payment",
    requireRole("cashier", "admin"),
    async (req, res) => {
      const input = parseInput(paymentSchema, req.body);
      res.json(await payOrder(db, req.identity!, orderId(req), input));
    },
  );

  return router;
}