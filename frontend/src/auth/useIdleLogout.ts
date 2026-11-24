import { useEffect } from "react";

const EVENTS = ["mousemove", "mousedown", "keydown", "touchstart", "scroll"] as const;

// Cierra la sesión si no hay actividad durante `ms` (10 min según el informe).
export function useIdleLogout(onIdle: () => void, ms: number, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    let timer = window.setTimeout(onIdle, ms);
    const reset = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(onIdle, ms);
    };
    for (const e of EVENTS) window.addEventListener(e, reset, { passive: true });
    return () => {
      window.clearTimeout(timer);
      for (const e of EVENTS) window.removeEventListener(e, reset);
    };
  }, [onIdle, ms, active]);
}
