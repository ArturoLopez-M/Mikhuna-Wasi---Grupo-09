import type { Database } from "../db/pool";
import type { Cache } from "./cache";
import type { AuthIdentity, Role } from "../types/auth";

// Petición ya autenticada, con el mismo formato venga de API Gateway REST
// (Lambda Lectura y Configuración) o de un mensaje de SQS (Lambdas de
// escritura). `resource` es la plantilla de API Gateway, por ejemplo
// "/api/v1/orders/{id}", y `params` sus valores.
export interface ApiRequest {
  method: string;
  resource: string;
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  // Claves siempre en minúsculas.
  headers: Record<string, string | undefined>;
  body: unknown;
  identity: AuthIdentity;
  // Id de la petición en API Gateway. Es estable entre reintentos de SQS.
  requestId?: string;
}

export interface ApiResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface Route {
  method: "GET" | "POST" | "PATCH";
  resource: string;
  // Sin `roles`, la ruta es para todos los roles autenticados.
  roles?: readonly Role[];
  handle(db: Database, req: ApiRequest, deps: RouteDeps): Promise<ApiResult>;
}

// Servicios opcionales que una ruta puede usar (por ejemplo, la caché de
// lectura). Si faltan, la ruta funciona igual yendo a la base.
export interface RouteDeps {
  cache?: Cache;
}

// Convierte el `sub` de Cognito en la identidad del sistema (restaurante y rol
// salen de la base, nunca del cliente). Se inyecta para poder probar sin base.
export type ResolveIdentity = (db: Database, sub: string) => Promise<AuthIdentity>;
