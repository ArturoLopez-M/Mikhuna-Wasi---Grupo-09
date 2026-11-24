import type { ApiErrorBody } from "./types";

// Error con el formato del contrato (sección 3).
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: { field: string; message: string }[] = [],
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// La escritura se encoló pero su resultado no llegó a tiempo por WebSocket.
// No es un error: el pedido se verá actualizado con el polling o al recargar.
export class PendingResultError extends Error {
  constructor(public readonly requestId: string) {
    super("La operación se está procesando. Revisa en un momento.");
    this.name = "PendingResultError";
  }
}

export interface WriteResult {
  status: number;
  body: unknown;
}

export interface ApiOptions {
  baseUrl: string;
  getToken: () => Promise<string>;
  // Espera el mensaje write.result del WebSocket para ese requestId.
  waitForResult: (requestId: string) => Promise<WriteResult | null>;
  fetch?: typeof fetch;
}

function toApiError(status: number, body: unknown): ApiError {
  const e = (body as ApiErrorBody | undefined)?.error;
  if (e) return new ApiError(status, e.code, e.message, e.details ?? []);
  if (status === 401) return new ApiError(401, "UNAUTHENTICATED", "Tu sesión venció. Vuelve a iniciar sesión.");
  if (status === 403) return new ApiError(403, "FORBIDDEN", "No tienes permiso para esta acción.");
  return new ApiError(status, "INTERNAL_ERROR", "Ocurrió un error. Intenta de nuevo.");
}

export function createApi(opts: ApiOptions) {
  const doFetch = opts.fetch ?? fetch.bind(globalThis);

  async function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    let res: Response;
    try {
      res = await doFetch(`${opts.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${await opts.getToken()}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(0, "NETWORK_ERROR", "Sin conexión. Revisa tu internet e intenta de nuevo.");
    }
    const data = await res.json().catch(() => undefined);
    return { status: res.status, data };
  }

  // Consultas y configuración: Lambda Lectura y Configuración responde directo.
  async function sync<T>(method: string, path: string, body?: unknown): Promise<T> {
    const { status, data } = await request(method, path, body);
    if (status < 200 || status >= 300) throw toApiError(status, data);
    return data as T;
  }

  return {
    get: <T>(path: string) => sync<T>("GET", path),
    post: <T>(path: string, body: unknown) => sync<T>("POST", path, body),
    patch: <T>(path: string, body: unknown) => sync<T>("PATCH", path, body),

    // Escrituras de pedidos (contrato 1.1): API Gateway las deja en la cola y
    // responde 202 { requestId }. El resultado real llega por WebSocket.
    // `idempotencyKey` se genera una vez por operación y se reutiliza si el
    // usuario reintenta, así un reintento nunca duplica el pedido (RNF01).
    async write<T>(path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
      const headers: Record<string, string> = idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {};
      const { status, data } = await request("POST", path, body ?? {}, headers);
      if (status !== 202) throw toApiError(status, data);

      const requestId = (data as { requestId?: string } | undefined)?.requestId;
      if (!requestId) throw new ApiError(500, "INTERNAL_ERROR", "Respuesta inesperada del servidor.");

      const result = await opts.waitForResult(requestId);
      if (!result) throw new PendingResultError(requestId);
      if (result.status < 200 || result.status >= 300) throw toApiError(result.status, result.body);
      return result.body as T;
    },
  };
}

export type Api = ReturnType<typeof createApi>;
