import { resolveIdentity } from "../../core/identity";
import { createQueueHandler } from "../../core/queue";
import { getCache, getDb, getNotifier } from "../../core/runtime";
import { pagosRoutes } from "../../modules/orders/routes";

// Lambda Registro de Pagos: procesa los mensajes de su cola SQS. Un error técnico
// devuelve el mensaje a la cola; tras 3 intentos fallidos pasa a la DLQ.
export const routes = [...pagosRoutes];

export const handler = createQueueHandler(routes, getDb, resolveIdentity, () => ({
  cache: getCache(),
  notifier: getNotifier(),
}));
