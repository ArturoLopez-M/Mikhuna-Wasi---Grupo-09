import { loadEnv } from "../config/env";
import { createDatabase, type Database } from "../db/pool";

// Una conexión por contenedor de Lambda, reutilizada entre invocaciones.
// RDS Proxy reparte y reutiliza las conexiones hacia Aurora.
let db: Database | undefined;

export function getDb(): Database {
  if (!db) {
    const env = loadEnv();
    db = createDatabase(env.DATABASE_URL);
  }
  return db;
}
