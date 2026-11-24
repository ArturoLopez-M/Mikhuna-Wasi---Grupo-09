import type { ConnectionState } from "../realtime/connection";

const LABELS: Record<ConnectionState, string> = {
  connecting: "Conectando...",
  online: "En línea",
  reconnecting: "Reconectando...",
  offline: "Sin conexión en tiempo real",
};

// RNF03: sin conexión, se muestra la hora de la última actualización.
export function StatusBar({ state, lastUpdate }: { state: ConnectionState; lastUpdate: Date | null }) {
  return (
    <div className={`status status-${state}`} role="status">
      <span>{LABELS[state]}</span>
      {state === "offline" && (
        <span>
          {" "}
          · Última actualización: {lastUpdate ? lastUpdate.toLocaleString("es-PE") : "—"} · consultando cada 15 s
        </span>
      )}
    </div>
  );
}
