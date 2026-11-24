import type { Me, Order, OrderStatus, Role } from "../api/types";

// Qué ve y qué puede hacer cada rol (RNF09). Es solo para mostrar la
// interfaz: el backend vuelve a autorizar cada acción (contrato, sección 4).

export type OrderAction =
  | "start-preparing"
  | "mark-ready"
  | "cancel"
  | "payment"
  | "dispatch"
  | "deliver"
  | "delivery-failed";

export const ACTION_LABELS: Record<OrderAction, string> = {
  "start-preparing": "Empezar a preparar",
  "mark-ready": "Marcar listo",
  cancel: "Cancelar",
  payment: "Cobrar",
  dispatch: "Despachar",
  deliver: "Entregado",
  "delivery-failed": "No se pudo entregar",
};

export function availableActions(order: Order, me: Me): OrderAction[] {
  const { role, id: userId } = me;
  const isAdmin = role === "admin";
  const actions: OrderAction[] = [];

  if (role === "kitchen" || isAdmin) {
    if (order.status === "pending") actions.push("start-preparing");
    if (order.status === "preparing") actions.push("mark-ready");
  }

  if (isAdmin && ["pending", "preparing", "ready"].includes(order.status)) {
    actions.push("cancel");
  } else if (role === "waiter" && order.status === "pending" && order.createdBy.id === userId) {
    actions.push("cancel");
  }

  if ((role === "cashier" || isAdmin) && order.status === "ready" && !order.payment) {
    actions.push("payment");
  }

  const d = order.delivery;
  if (d && (role === "delivery" || isAdmin)) {
    const foodReady = order.status === "ready" || order.status === "closed";
    const mine = d.assignedTo?.id === userId;
    if (d.status === "pending_dispatch" && foodReady) {
      // El repartidor toma la entrega si está libre o es suya; el admin solo
      // despacha si ya hay alguien asignado.
      if (role === "delivery" ? !d.assignedTo || mine : Boolean(d.assignedTo)) {
        actions.push("dispatch");
      }
    }
    if (d.status === "on_the_way" && (mine || isAdmin)) {
      actions.push("deliver", "delivery-failed");
    }
  }

  return actions;
}

// Estados que cada rol ve por defecto en su tablero.
export function defaultStatuses(role: Role): OrderStatus[] {
  switch (role) {
    case "kitchen":
      return ["pending", "preparing"];
    case "cashier":
      return ["ready"];
    case "delivery":
      // Un delivery ya pagado (closed) puede seguir esperando al repartidor.
      return ["ready", "closed"];
    default:
      return ["pending", "preparing", "ready"];
  }
}

// El repartidor solo ve deliveries que todavía no terminaron.
export function visibleFor(order: Order, me: Me): boolean {
  if (me.role !== "delivery") return true;
  const d = order.delivery;
  return Boolean(d && (d.status === "pending_dispatch" || d.status === "on_the_way"));
}

export type Tab = "orders" | "new-order" | "products" | "config";

export function tabsFor(role: Role): Tab[] {
  if (role === "admin") return ["orders", "new-order", "products", "config"];
  if (role === "waiter") return ["orders", "new-order"];
  return ["orders"];
}
