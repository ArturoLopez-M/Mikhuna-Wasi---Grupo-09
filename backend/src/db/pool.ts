import { Pool, type QueryResultRow } from "pg";

// Interfaz mínima que usa el resto de la app. Así los servicios y las pruebas
// no dependen de pg directamente.
export interface Database {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
  close(): Promise<void>;
}

export function createDatabase(connectionString: string): Database {
  const pool = new Pool({
    connectionString,
    // Evita que /health se cuelgue si la base no responde.
    connectionTimeoutMillis: 3000,
  });

  // Sin este listener, un error en una conexión inactiva tumbaría el proceso.
  pool.on("error", (err) => {
    console.error("Error en una conexión inactiva del pool:", err.message);
  });

  return {
    async query<T extends QueryResultRow = QueryResultRow>(
      text: string,
      params?: unknown[],
    ) {
      const result = await pool.query<T>(text, params);
      return { rows: result.rows };
    },
    close: () => pool.end(),
  };
}