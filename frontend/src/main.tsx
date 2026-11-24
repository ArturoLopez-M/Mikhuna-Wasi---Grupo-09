import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { missingFeatures } from "./components/browserSupport";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);
const missing = missingFeatures(window as never);

// RNF09: navegador no compatible -> aviso claro en vez de una pantalla rota.
root.render(
  <StrictMode>
    {missing.length > 0 ? (
      <main className="unsupported">
        <h1>Navegador no compatible</h1>
        <p>
          Mikhuna Wasi funciona en versiones actuales de Chrome, Edge, Firefox y Safari, en
          computadora, tablet o celular. Actualiza tu navegador para continuar.
        </p>
        <p className="muted">Falta: {missing.join(", ")}</p>
      </main>
    ) : (
      <App />
    )}
  </StrictMode>,
);
