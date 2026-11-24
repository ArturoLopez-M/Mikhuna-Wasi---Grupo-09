import { ORDER_CACHE_TTL, orderCacheKey, tryCache } from "../../core/cache";
import type { ApiRequest, Route } from "../../core/types";
import { parseInput } from "../../utils/parseInput";
import {
  createOrderSchema,
  emptyBodySchema,
  idempotencyKeySchema,
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

const ORDERS = "/api/v1/orders";
const ORDER = `${ORDERS}/{id}`;

// Las acciones sin cuerpo aceptan vacío, pero no campos desconocidos.
function expectNoBody(req: ApiRequest): void {
  parseInput(emptyBodySchema, req.body ?? {});
}

// El id viene de la ruta. Si no es un UUID válido, el servicio responde 404.
function orderId(req: ApiRequest): string {
  return String(req.params.id);
}

// Lambda Lectura y Configuración: consultas síncronas (sin cola).
export const ordersReadRoutes: readonly Route[] = [
  {
    method: "GET",
    resource: ORDERS,
    async handle(db, req) {
      const query = parseInput(listOrdersQuerySchema, req.query, "query");
      return { status: 200, body: await listOrders(db, req.identity, query) };
    },
  },
  {
    method: "GET",
    resource: ORDER,
    // Lee primero de ElastiCache; si no está, de Aurora y lo guarda 60 s.
    // Las Lambdas de escritura borran la clave cuando el pedido cambia.
    async handle(db, req, { cache }) {
      const key = orderCacheKey(req.identity.restaurantId, orderId(req));
      if (cache) {
        const hit = await tryCache(() => cache.get(key), null);
        if (hit) return { status: 200, body: JSON.parse(hit) };
      }
      const order = await getOrder(db, req.identity, orderId(req));
      if (cache) {
        await tryCache(() => cache.set(key, JSON.stringify(order), ORDER_CACHE_TTL), false);
      }
      return { status: 200, body: order };
    },
  },
];

// Lambda Pedidos (cola de pedidos).
export const pedidosRoutes: readonly Route[] = [
  {
    method: "POST",
    resource: ORDERS,
    roles: ["admin", "waiter"],
    async handle(db, req) {
      const input = parseInput(createOrderSchema, req.body);
      const clientKey = parseInput(
        idempotencyKeySchema,
        req.headers["idempotency-key"],
        "Idempotency-Key",
      );
      // RNF01/RNF02: SQS entrega "al menos una vez". Sin clave del cliente se
      // usa el id de la petición de API Gateway, que es el mismo en cada
      // reintento de la cola, así un mensaje repetido no duplica el pedido.
      const key = clientKey ?? req.requestId;
      const { order, replayed } = await createOrder(db, req.identity, input, key);
      return {
        status: 201,
        body: order,
        ...(replayed ? { headers: { "Idempotent-Replayed": "true" } } : {}),
      };
    },
  },
  {
    method: "POST",
    resource: `${ORDER}/cancel`,
    roles: ["waiter", "admin"],
    async handle(db, req) {
      expectNoBody(req);
      return { status: 200, body: await cancelOrder(db, req.identity, orderId(req)) };
    },
  },
];

// Lambda Cocina (cola de cocina).
export const cocinaRoutes: readonly Route[] = [
  {
    method: "POST",
    resource: `${ORDER}/start-preparing`,
    roles: ["kitchen", "admin"],
    async handle(db, req) {
      expectNoBody(req);
      return { status: 200, body: await startPreparing(db, req.identity, orderId(req)) };
    },
  },
  {
    method: "POST",
    resource: `${ORDER}/mark-ready`,
    roles: ["kitchen", "admin"],
    async handle(db, req) {
      expectNoBody(req);
      return { status: 200, body: await markReady(db, req.identity, orderId(req)) };
    },
  },
];

// Lambda Registro de Pagos (cola de pagos).
export const pagosRoutes: readonly Route[] = [
  {
    method: "POST",
    resource: `${ORDER}/payment`,
    roles: ["cashier", "admin"],
    async handle(db, req) {
      const input = parseInput(paymentSchema, req.body);
      return { status: 200, body: await payOrder(db, req.identity, orderId(req), input) };
    },
  },
];
