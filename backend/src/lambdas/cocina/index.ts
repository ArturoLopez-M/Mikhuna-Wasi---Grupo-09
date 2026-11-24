import { resolveIdentity } from "../../core/identity";
import { createQueueHandler } from "../../core/queue";
import { getCache, getDb, getNotifier } from "../../core/runtime";
import { cocinaRoutes } from "../../modules/orders/routes";

// Lambda Cocina: procesa los mensajes de su cola SQS. Un error técnico
// devuelve el mensaje a la cola; tras 3 intentos fallidos pasa a la DLQ.
export const routes = [...cocinaRoutes];

export const handler = createQueueHandler(routes, getDb, resolveIdentity, () => ({
  cache: getCache(),
  notifier: getNotifier(),
}));
