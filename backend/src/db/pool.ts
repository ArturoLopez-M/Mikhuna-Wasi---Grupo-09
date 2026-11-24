import { Pool, type QueryResultRow } from "pg";

export interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export interface Database extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function createDatabase(connectionString: string): Database {
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 3000 });

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

    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      // Si el ROLLBACK falla, la conexión quedó en un estado desconocido: se
      // descarta (release(err)) en vez de devolverla al pool, y se conserva el
      // error original, que es el que explica la falla.
      let broken: Error | undefined;
      try {
        await client.query("BEGIN");
        const result = await fn({
          async query<R extends QueryResultRow = QueryResultRow>(
            text: string,
            params?: unknown[],
          ) {
            const r = await client.query<R>(text, params);
            return { rows: r.rows };
          },
        });
        await client.query("COMMIT");
        return result;
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackErr) {
          broken =
            rollbackErr instanceof Error
              ? rollbackErr
              : new Error(String(rollbackErr));
        }
        throw err;
      } finally {
        client.release(broken);
      }
    },

    close: () => pool.end(),
  };
}