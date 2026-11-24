import { createCognitoVerifier, type VerifyToken } from "../auth/cognito";
import { type Env, loadEnv } from "../config/env";
import { createDatabase, type Database } from "../db/pool";
import { type Cache, createRedisCache } from "./cache";
import { createWebSocketNotifier, type Notifier } from "./realtime";

// Clientes creados una vez por contenedor de Lambda y reutilizados entre
// invocaciones. RDS Proxy reparte y reutiliza las conexiones hacia Aurora.
let env: Env | undefined;
let db: Database | undefined;
let readDb: Database | undefined;
let cache: Cache | undefined;
let notifier: Notifier | undefined;
let verifier: VerifyToken | undefined;

function getEnv(): Env {
  return (env ??= loadEnv());
}

// Instancia de escritura (Pedidos, Cocina, Pagos y configuración).
export function getDb(): Database {
  return (db ??= createDatabase(getEnv().DATABASE_URL));
}

// Instancia de lectura (consultas de Lectura y Configuración).
export function getReadDb(): Database {
  const { DATABASE_READ_URL } = getEnv();
  if (!DATABASE_READ_URL) return getDb();
  return (readDb ??= createDatabase(DATABASE_READ_URL));
}

export function getCache(): Cache | undefined {
  const { REDIS_URL } = getEnv();
  if (!REDIS_URL) return undefined;
  return (cache ??= createRedisCache(REDIS_URL));
}

export function getNotifier(): Notifier | undefined {
  const { WEBSOCKET_ENDPOINT } = getEnv();
  if (!WEBSOCKET_ENDPOINT) return undefined;
  return (notifier ??= createWebSocketNotifier(WEBSOCKET_ENDPOINT));
}

// Sin configuración de Cognito no se acepta ninguna conexión WebSocket.
export function getVerifier(): VerifyToken | undefined {
  const { COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID } = getEnv();
  if (!COGNITO_USER_POOL_ID || !COGNITO_CLIENT_ID) return undefined;
  return (verifier ??= createCognitoVerifier({
    userPoolId: COGNITO_USER_POOL_ID,
    clientId: COGNITO_CLIENT_ID,
  }));
}
