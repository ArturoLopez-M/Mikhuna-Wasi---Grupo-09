import type { APIGatewayProxyEvent } from "aws-lambda";
import { errorResult } from "../../src/core/dispatch";
import { resolveIdentity } from "../../src/core/identity";
import { processMessage } from "../../src/core/queue";
import { handleRestEvent } from "../../src/core/rest";
import type { ApiResult, ResolveIdentity, Route } from "../../src/core/types";
import type { Database } from "../../src/db/pool";
import { routes as lecturaRoutes } from "../../src/lambdas/lectura-config/index";
import { routes as pedidosRoutes } from "../../src/lambdas/pedidos/index";
import { routes as cocinaRoutes } from "../../src/lambdas/cocina/index";
import { routes as pagosRoutes } from "../../src/lambdas/pagos/index";
import { routes as deliveryRoutes } from "../../src/lambdas/delivery/index";
import type { Cache } from "../../src/core/cache";
import type { AuthIdentity } from "../../src/types/auth";
import { HttpError } from "../../src/utils/httpError";

// Emula lo que hace API Gateway delante de las Lambdas, para probar la lógica
// con la misma interfaz que supertest:
//   - Consultas, perfil y configuración (incluye POST/PATCH de productos y
//     modalidad) -> evento REST proxy -> Lambda Lectura y Configuración.
//   - Escrituras de pedidos -> mensaje en la cola -> Lambda Pedidos, Cocina,
//     Registro de Pagos o Delivery.
// `identity` simula un usuario ya resuelto; `sub` hace que la identidad se
// busque en la base de verdad (resolveIdentity). Sin ninguno, API Gateway
// rechazaría la petición con 401.
export interface TestApp {
  db: Database;
  identity?: AuthIdentity;
  sub?: string;
  // Id de petición de API Gateway (solo si la prueba lo necesita).
  requestId?: string;
  // ElastiCache simulado para Lectura y Configuración (opcional).
  cache?: Cache;
}

// Id de petición por defecto: API Gateway siempre envía uno.
export const REQUEST_ID = "req-00000000-0000-4000-8000-000000000001";

export function testApp(app: TestApp): TestApp {
  return app;
}

const writeRoutes: readonly Route[] = [
  ...pedidosRoutes,
  ...cocinaRoutes,
  ...pagosRoutes,
  ...deliveryRoutes,
];

type Method = "GET" | "POST" | "PATCH";

export interface TestResponse {
  status: number;
  body: any;
  headers: Record<string, string>;
  // true si la Lambda devolvió el mensaje a la cola (error técnico).
  retried: boolean;
}

// "/api/v1/orders/{id}/cancel" contra una ruta concreta.
function matchTemplate(template: string, path: string): Record<string, string> | null {
  const names: string[] = [];
  const pattern = template.replace(/\{(\w+)\}/g, (_m, name: string) => {
    names.push(name);
    return "([^/]+)";
  });
  const m = new RegExp(`^${pattern}$`).exec(path);
  if (!m) return null;
  return Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1]!)]));
}

function findTemplate(routes: readonly Route[], method: string, path: string) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const params = matchTemplate(r.resource, path);
    if (params) return { resource: r.resource, params };
  }
  return null;
}

class Call implements PromiseLike<TestResponse> {
  private readonly headers: Record<string, string> = {};
  private body: string | null = null;

  constructor(
    private readonly app: TestApp,
    private readonly method: Method,
    private readonly url: string,
  ) {}

  set(key: string | Record<string, string>, value?: string): this {
    if (typeof key === "string") this.headers[key] = value!;
    else Object.assign(this.headers, key);
    return this;
  }

  send(body: unknown): this {
    this.body = typeof body === "string" ? body : JSON.stringify(body);
    return this;
  }

  then<A = TestResponse, B = never>(
    ok?: ((v: TestResponse) => A | PromiseLike<A>) | null,
    fail?: ((e: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return this.run().then(ok, fail);
  }

  private async run(): Promise<TestResponse> {
    const [path, qs = ""] = this.url.split("?");
    // Como en API Gateway: cada ruta va a su Lambda (directa o por cola).
    const rest = findTemplate(lecturaRoutes, this.method, path!);
    const routes = rest ? lecturaRoutes : writeRoutes;
    const match = rest ?? findTemplate(writeRoutes, this.method, path!);

    // API Gateway: ruta inexistente o sin token válido.
    if (!match) return response(errorResult(new HttpError(404, "NOT_FOUND", "Ruta no encontrada"), { method: this.method, resource: path! }));
    if (!this.app.identity && !this.app.sub) {
      return response(errorResult(new HttpError(401, "UNAUTHENTICATED", "Autenticación requerida"), { method: this.method, resource: match.resource }));
    }

    const sub = this.app.sub ?? "sub-de-prueba";
    const resolve: ResolveIdentity = this.app.identity
      ? async () => this.app.identity!
      : resolveIdentity;

    if (rest) {
      const query = Object.fromEntries(new URLSearchParams(qs));
      const event = {
        httpMethod: this.method,
        resource: match.resource,
        pathParameters: match.params,
        queryStringParameters: Object.keys(query).length ? query : null,
        headers: this.headers,
        body: this.body,
        isBase64Encoded: false,
        requestContext: { requestId: this.app.requestId, authorizer: { claims: { sub } } },
      } as unknown as APIGatewayProxyEvent;
      return response(
        await handleRestEvent(this.app.db, routes, event, resolve, {
          cache: this.app.cache,
          writeDb: this.app.db,
        }),
      );
    }

    const message = {
      method: "POST",
      resource: match.resource,
      pathParameters: match.params,
      headers: this.headers,
      body: this.body,
      sub,
      requestId: this.app.requestId ?? REQUEST_ID,
    };
    const outcome = await processMessage(
      this.app.db,
      routes,
      JSON.stringify(message),
      resolve,
    );
    if (outcome.kind === "retry") {
      return {
        status: 500,
        body: { error: { code: "INTERNAL_ERROR", message: "Error interno del servidor" } },
        headers: {},
        retried: true,
      };
    }
    return response(outcome.result);
  }
}

function response(result: ApiResult): TestResponse {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(result.headers ?? {})) headers[k.toLowerCase()] = v;
  // Como en API Gateway y WebSocket, el cuerpo viaja como JSON (fechas a ISO).
  const body = result.body === undefined ? undefined : JSON.parse(JSON.stringify(result.body));
  return { status: result.status, body, headers, retried: false };
}

export function request(app: TestApp) {
  return {
    get: (url: string) => new Call(app, "GET", url),
    post: (url: string) => new Call(app, "POST", url),
    patch: (url: string) => new Call(app, "PATCH", url),
  };
}
