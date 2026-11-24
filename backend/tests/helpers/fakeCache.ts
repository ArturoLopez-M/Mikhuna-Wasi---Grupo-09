import type { Cache } from "../../src/core/cache";
import type { Notifier } from "../../src/core/realtime";

// ElastiCache en memoria. `down = true` simula que no responde.
export function fakeCache() {
  const values = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const state = { down: false };

  const guard = () => {
    if (state.down) throw new Error("ElastiCache no responde");
  };

  const cache: Cache = {
    async get(key) {
      guard();
      return values.get(key) ?? null;
    },
    async set(key, value, _ttl, onlyIfAbsent = false) {
      guard();
      if (onlyIfAbsent && values.has(key)) return false;
      values.set(key, value);
      return true;
    },
    async del(key) {
      guard();
      values.delete(key);
    },
    async addToSet(key, member) {
      guard();
      if (!sets.has(key)) sets.set(key, new Set());
      sets.get(key)!.add(member);
    },
    async removeFromSet(key, member) {
      guard();
      sets.get(key)?.delete(member);
    },
    async members(key) {
      guard();
      return [...(sets.get(key) ?? [])];
    },
  };

  return { cache, values, sets, state };
}

// WebSocket simulado: guarda lo enviado a cada conexión. Las conexiones en
// `gone` ya se cerraron; las de `broken` fallan con un error.
export function fakeNotifier(gone: string[] = [], broken: string[] = []) {
  const sent: Array<{ connectionId: string; payload: any }> = [];
  const notifier: Notifier = {
    async send(connectionId, payload) {
      if (broken.includes(connectionId)) throw new Error("fallo de red");
      if (gone.includes(connectionId)) return "gone";
      sent.push({ connectionId, payload: JSON.parse(JSON.stringify(payload)) });
      return "ok";
    },
  };
  return { notifier, sent };
}
