import { type FormEvent, useEffect, useState } from "react";
import type { Api } from "../api/client";
import type { Product } from "../api/types";
import { errorMessage } from "./errors";

// Menú del restaurante (solo admin). Un producto no se borra: se marca como
// no disponible (contrato 6.3).
export function ProductsPage({ api }: { api: Api }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api
      .get<{ data: Product[] }>("/api/v1/products")
      .then((r) => setProducts(r.data))
      .catch((err) => setError(errorMessage(err)));

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      // El contrato pide punto decimal: se convierte la coma antes de enviar.
      await api.post<Product>("/api/v1/products", { name: name.trim(), price: price.replace(",", ".") });
      setName("");
      setPrice("");
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function toggle(p: Product) {
    setError(null);
    try {
      const updated = await api.patch<Product>(`/api/v1/products/${p.id}`, { isAvailable: !p.isAvailable });
      setProducts((list) => list.map((x) => (x.id === p.id ? updated : x)));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <section>
      <form className="card form inline-form" onSubmit={create}>
        <input placeholder="Nombre" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required />
        <input placeholder="Precio (S/)" value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" required />
        <button type="submit">Agregar</button>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
      <ul className="list">
        {products.map((p) => (
          <li key={p.id} className={p.isAvailable ? "" : "muted"}>
            <span>
              {p.name} · S/ {p.price}
            </span>
            <button className="link" onClick={() => void toggle(p)}>
              {p.isAvailable ? "Marcar agotado" : "Marcar disponible"}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
