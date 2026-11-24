import { resolveIdentity } from "../../core/identity";
import { createQueueHandler } from "../../core/queue";
import { getCache, getDb, getNotifier } from "../../core/runtime";
import { deliveryRoutes } from "../../modules/delivery/routes";

// Lambda Delivery: procesa los mensajes de su cola SQS (despachar, entregar,
// marcar fallido y asignar repartidor). Un error técnico devuelve el mensaje
// a la cola; tras 3 intentos fallidos pasa a la DLQ.
export const routes = [...deliveryRoutes];

export const handler = createQueueHandler(routes, getDb, resolveIdentity, () => ({
  cache: getCache(),
  notifier: getNotifier(),
}));
