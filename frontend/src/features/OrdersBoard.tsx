import { useRef, useState } from "react";
import type { Api } from "../api/client";
import type { Me, Order } from "../api/types";
import { errorMessage } from "./errors";
import { ACTION_LABELS, availableActions, defaultStatuses, type OrderAction, visibleFor } from "./permissions";

const STATUS_LABELS: Record<Order["status"], string> = {
  pending: "Pendiente",
  preparing: "En preparación",
  ready: "Listo",
  closed: "Cerrado",
  cancelled: "Cancelado",
};

const DELIVERY_LABELS = {
  pending_dispatch: "Por despachar",
  on_the_way: "En camino",
  delivered: "Entregado",
  failed: "No entregado",
} as const;

interface Props {
  me: Me;
  orders: Order[];
  api: Api;
  onUpdated: (order: Order) => void;
}

export function OrdersBoard({ me, orders, api, onUpdated }: Props) {
  const statuses = defaultStatuses(me.role);
  const visible = orders
    .filter((o) => statuses.includes(o.status) && visibleFor(o, me))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  if (visible.length === 0) return <p className="muted">No hay pedidos por ahora.</p>;

  return (
    <div className="grid">
      {visible.map((o) => (
        <OrderCard key={o.id} order={o} me={me} api={api} onUpdated={onUpdated} />
      ))}
    </div>
  );
}

function OrderCard({ order, me, api, onUpdated }: { order: Order; me: Me; api: Api; onUpdated: (o: Order) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [method, setMethod] = useState("cash");
  // Una clave por acción: si el usuario reintenta, se reutiliza (RNF01).
  const keys = useRef(new Map<OrderAction, string>());

  async function run(action: OrderAction) {
    if (action === "cancel" && !window.confirm("¿Cancelar este pedido?")) return;
    setBusy(true);
    setError(null);
    const key = keys.current.get(action) ?? crypto.randomUUID();
    keys.current.set(action, key);
    try {
      const body = action === "payment" ? { method, amount: order.total } : undefined;
      const updated = await api.write<Order>(`/api/v1/orders/${order.id}/${action}`, body, key);
      keys.current.delete(action);
      onUpdated(updated);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const actions = availableActions(order, me);

  return (
    <article className="card order">
      <header>
        <strong>{order.serviceType === "delivery" ? "Delivery" : order.tableLabel}</strong>
        <span className={`badge badge-${order.status}`}>{STATUS_LABELS[order.status]}</span>
      </header>
      {order.delivery && (
        <p className="delivery">
          {order.delivery.address} · <em>{DELIVERY_LABELS[order.delivery.status]}</em>
          {order.delivery.assignedTo && <> · {order.delivery.assignedTo.fullName}</>}
        </p>
      )}
      <ul className="items">
        {order.items.map((i) => (
          <li key={i.id}>
            {i.quantity} × {i.productName}
            {i.notes && <span className="muted"> ({i.notes})</span>}
          </li>
        ))}
      </ul>
      {order.notes && <p className="muted">Nota: {order.notes}</p>}
      <footer>
        <span>Total S/ {order.total}</span>
        <span className="muted">{new Date(order.createdAt).toLocaleTimeString("es-PE")}</span>
      </footer>
      {actions.includes("payment") && (
        <label className="inline">
          Método
          <select value={method} onChange={(e) => setMethod(e.target.value)}>
            <option value="cash">Efectivo</option>
            <option value="card">Tarjeta</option>
            <option value="digital_wallet">Billetera digital</option>
          </select>
        </label>
      )}
      {actions.length > 0 && (
        <div className="actions">
          {actions.map((a) => (
            <button key={a} disabled={busy} className={a === "cancel" || a === "delivery-failed" ? "danger" : ""} onClick={() => void run(a)}>
              {ACTION_LABELS[a]}
            </button>
          ))}
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </article>
  );
}
