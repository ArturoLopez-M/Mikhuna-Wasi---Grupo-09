import type { Database } from "../../src/db/pool";

type FakeQuery = (text: string, params?: unknown[]) => Promise<unknown>;

// Base de datos falsa para pruebas que no necesitan PostgreSQL real.
export function fakeDb(
  query: FakeQuery = async () => ({ rows: [] }),
): Database {
  return { query, close: async () => {} } as unknown as Database;
}