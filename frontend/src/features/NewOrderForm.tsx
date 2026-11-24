import { type FormEvent, useEffect, useRef, useState } from "react";
import type { Api } from "../api/client";
import type { Order, Product, ServiceMode } from "../api/types";
import { errorMessage } from "./errors";

interface Props {
  api: Api;
  serviceMode: ServiceMode;
  onCreated: (order: Order) => void;
}

// Registrar pedido (mesero y admin). Solo ofrece los tipos que el restaurante
// atiende (RNF08). El precio nunca lo manda el cliente: solo producto y
// cantidad (contrato, sección 1).
export function NewOrderForm({ api, serviceMode, onCreated }: Props) {
  const [products, setProducts] = useState<Product[]>([]);
  const [serviceType, setServiceType] = useState<"dine_in" | "delivery">(
    serviceMode === "delivery" ? "delivery" : "dine_in",
  );
  const [tableLabel, setTableLabel] = useState("");
  const [address, setAddress] = useState("");
  const [notes, setNotes] = useState("");
  const [qty, setQty] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  // Se genera una vez por pedido y se reutiliza en los reintentos (RNF01).
  const key = useRef<string>(crypto.randomUUID());

  useEffect(() => {
    api
      .get<{ data: Product[] }>("/api/v1/products")
      .then((r) => setProducts(r.data))
      .catch((err) => setMessage({ kind: "error", text: errorMessage(err) }));
  }, [api]);

  // Si el admin cambia la modalidad mientras tanto, se ajusta el tipo.
  useEffect(() => {
    if (serviceMode === "delivery") setServiceType("delivery");
    if (serviceMode === "dine_in") setServiceType("dine_in");
  }, [serviceMode]);

  const items = Object.entries(qty)
    .filter(([, q]) => q > 0)
    .map(([productId, quantity]) => ({ productId, quantity }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (items.length === 0) {
      setMessage({ kind: "error", text: "Agrega al menos un producto." });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const body = {
        serviceType,
        ...(serviceType === "dine_in" ? { tableLabel } : { deliveryAddress: address }),
        ...(notes.trim() ? { notes } : {}),
        items,
      };
      const order = await api.write<Order>("/api/v1/orders", body, key.current);
      key.current = crypto.randomUUID();
      setQty({});
      setNotes("");
      onCreated(order);
    } catch (err) {
      setMessage({ kind: "error", text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card form" onSubmit={submit}>
      {serviceMode === "both" && (
        <fieldset className="inline">
          <label>
            <input type="radio" checked={serviceType === "dine_in"} onChange={() => setServiceType("dine_in")} /> En local
          </label>
          <label>
            <input type="radio" checked={serviceType === "delivery"} onChange={() => setServiceType("delivery")} /> Delivery
          </label>
        </fieldset>
      )}
      {serviceType === "dine_in" ? (
        <label>
          Mesa
          <input value={tableLabel} onChange={(e) => setTableLabel(e.target.value)} maxLength={30} required />
        </label>
      ) : (
        <label>
          Dirección de entrega
          <input value={address} onChange={(e) => setAddress(e.target.value)} maxLength={300} required />
        </label>
      )}
      <div className="products">
        {products.map((p) => (
          <label key={p.id} className="product-row">
            <span>
              {p.name} <span className="muted">S/ {p.price}</span>
            </span>
            <input
              type="number"
              min={0}
              max={99}
              value={qty[p.id] ?? 0}
              onChange={(e) => setQty({ ...qty, [p.id]: Math.max(0, Math.min(99, Number(e.target.value))) })}
            />
          </label>
        ))}
      </div>
      <label>
        Nota (opcional)
        <input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
      </label>
      {message && <p className={message.kind} role="alert">{message.text}</p>}
      <button type="submit" disabled={busy}>
        {busy ? "Enviando..." : "Registrar pedido"}
      </button>
    </form>
  );
}
