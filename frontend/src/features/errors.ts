import { ApiError, PendingResultError } from "../api/client";

// Mensaje claro para el usuario (RNF07: la operación incompleta no se muestra
// como confirmada).
export function errorMessage(err: unknown): string {
  if (err instanceof PendingResultError) return err.message;
  if (err instanceof ApiError) {
    const detail = err.details.map((d) => d.message).join(". ");
    return detail ? `${err.message}: ${detail}` : err.message;
  }
  return "Ocurrió un error. Intenta de nuevo.";
}
