import { useState } from "react";
import type { Api } from "../api/client";
import type { ServiceMode } from "../api/types";
import { errorMessage } from "./errors";

const OPTIONS: { value: ServiceMode; label: string }[] = [
  { value: "dine_in", label: "Solo consumo en local" },
  { value: "delivery", label: "Solo delivery" },
  { value: "both", label: "Local y delivery" },
];

// RNF08: el admin elige la modalidad. Si el guardado falla, se mantiene la
// última configuración válida y se avisa.
export function ConfigPage({
  api,
  serviceMode,
  onSaved,
}: {
  api: Api;
  serviceMode: ServiceMode;
  onSaved: (mode: ServiceMode) => void;
}) {
  const [value, setValue] = useState<ServiceMode>(serviceMode);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "info"; text: string } | null>(null);

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await api.patch<{ serviceMode: ServiceMode }>("/api/v1/restaurant/config", { serviceMode: value });
      onSaved(res.serviceMode);
      setMessage({ kind: "info", text: "Configuración guardada." });
    } catch (err) {
      setValue(serviceMode);
      setMessage({ kind: "error", text: `No se guardó, se mantiene la configuración anterior. ${errorMessage(err)}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card form">
      <h2>Modalidad de atención</h2>
      {OPTIONS.map((o) => (
        <label key={o.value} className="inline">
          <input type="radio" checked={value === o.value} onChange={() => setValue(o.value)} /> {o.label}
        </label>
      ))}
      {message && <p className={message.kind} role="alert">{message.text}</p>}
      <button onClick={() => void save()} disabled={busy || value === serviceMode}>
        {busy ? "Guardando..." : "Guardar"}
      </button>
    </section>
  );
}
