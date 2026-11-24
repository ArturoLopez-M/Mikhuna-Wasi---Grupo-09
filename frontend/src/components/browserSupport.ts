// RNF09: la web funciona en versiones actuales de Chrome, Edge, Firefox y
// Safari. En vez de adivinar por el nombre del navegador, se revisa que tenga
// lo que la app necesita; si falta algo, se muestra un aviso.
export interface BrowserLike {
  WebSocket?: unknown;
  fetch?: unknown;
  crypto?: { randomUUID?: unknown };
  CSS?: { supports?: (prop: string, value: string) => boolean };
  sessionStorage?: unknown;
}

export function missingFeatures(win: BrowserLike): string[] {
  const missing: string[] = [];
  if (typeof win.WebSocket !== "function") missing.push("WebSocket");
  if (typeof win.fetch !== "function") missing.push("fetch");
  if (typeof win.crypto?.randomUUID !== "function") missing.push("crypto.randomUUID");
  if (!win.CSS?.supports?.("display", "grid")) missing.push("CSS Grid");
  if (win.sessionStorage === undefined) missing.push("sessionStorage");
  return missing;
}
