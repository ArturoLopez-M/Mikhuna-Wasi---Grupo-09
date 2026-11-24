import type { WriteResult } from "../api/client";

// Conexión con API Gateway WebSocket (contrato 6.6) y respaldo por polling.
//
// RNF03: si la conexión se corta y pasan 5 segundos sin recuperarla, la
// pantalla muestra la hora de la última actualización y consulta el estado
// cada 15 segundos (por la Lambda Lectura y Configuración) hasta reconectar.

export type ConnectionState = "connecting" | "online" | "reconnecting" | "offline";

export interface ServerMessage {
  type: string;
  [key: string]: unknown;
}

export interface SocketLike {
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  close(): void;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
}

export interface ConnectionOptions {
  url: string;
  getToken: () => Promise<string>;
  createSocket: (url: string) => SocketLike;
  // Mensajes que no son write.result (order.updated, config.updated).
  onMessage: (msg: ServerMessage) => void;
  onState: (state: ConnectionState, lastUpdate: Date | null) => void;
  // Consulta de respaldo (por ejemplo, recargar la lista de pedidos).
  poll: () => Promise<void>;
  offlineAfterMs: number;
  pollEveryMs: number;
  resultTimeoutMs: number;
  timers?: Timers;
  now?: () => Date;
}

const MAX_BACKOFF_MS = 15_000;

export function createConnection(opts: ConnectionOptions) {
  const timers: Timers = opts.timers ?? {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id) => globalThis.clearTimeout(id as number),
    setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval: (id) => globalThis.clearInterval(id as number),
  };
  const now = opts.now ?? (() => new Date());

  let socket: SocketLike | null = null;
  let state: ConnectionState = "connecting";
  let lastUpdate: Date | null = null;
  let stopped = false;
  let attempts = 0;
  let reconnectTimer: unknown = null;
  let offlineTimer: unknown = null;
  let pollTimer: unknown = null;

  // Resultados de escrituras: quien espera, y los que llegaron antes de que
  // alguien los esperara (el WebSocket puede ganarle a la respuesta 202).
  const waiting = new Map<string, (r: WriteResult) => void>();
  const early = new Map<string, WriteResult>();

  const setState = (s: ConnectionState) => {
    state = s;
    opts.onState(state, lastUpdate);
  };

  const touch = () => {
    lastUpdate = now();
    opts.onState(state, lastUpdate);
  };

  const runPoll = async () => {
    try {
      await opts.poll();
      touch();
    } catch {
      // se reintenta en el siguiente ciclo
    }
  };

  const stopFallback = () => {
    if (offlineTimer !== null) timers.clearTimeout(offlineTimer);
    if (pollTimer !== null) timers.clearInterval(pollTimer);
    offlineTimer = null;
    pollTimer = null;
  };

  const startFallback = () => {
    if (offlineTimer !== null || pollTimer !== null) return;
    offlineTimer = timers.setTimeout(() => {
      offlineTimer = null;
      if (stopped || state === "online") return;
      setState("offline");
      void runPoll();
      pollTimer = timers.setInterval(() => void runPoll(), opts.pollEveryMs);
    }, opts.offlineAfterMs);
  };

  const handleMessage = (raw: unknown) => {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(String(raw)) as ServerMessage;
    } catch {
      return;
    }
    touch();
    if (msg.type === "write.result" && typeof msg.requestId === "string") {
      const result = { status: Number(msg.status), body: msg.body };
      const resolve = waiting.get(msg.requestId);
      if (resolve) {
        waiting.delete(msg.requestId);
        resolve(result);
      } else {
        early.set(msg.requestId, result);
        // No se guardan para siempre: solo unos segundos.
        timers.setTimeout(() => early.delete(msg.requestId as string), opts.resultTimeoutMs);
      }
      return;
    }
    opts.onMessage(msg);
  };

  const scheduleReconnect = () => {
    if (stopped) return;
    const delay = Math.min(1000 * 2 ** attempts, MAX_BACKOFF_MS);
    attempts += 1;
    reconnectTimer = timers.setTimeout(() => void open(), delay);
  };

  async function open(): Promise<void> {
    if (stopped) return;
    let token: string;
    try {
      token = await opts.getToken();
    } catch {
      // Sin sesión: no se puede conectar; quien maneja la sesión cerrará todo.
      setState("offline");
      return;
    }
    const s = opts.createSocket(`${opts.url}?token=${encodeURIComponent(token)}`);
    socket = s;
    s.onopen = () => {
      attempts = 0;
      stopFallback();
      setState("online");
      // Al reconectar se recarga para no perder cambios ocurridos sin conexión.
      void runPoll();
    };
    s.onmessage = (ev) => handleMessage(ev.data);
    s.onerror = () => {
      // onclose llega después y se encarga.
    };
    s.onclose = () => {
      if (socket !== s) return;
      socket = null;
      if (stopped) return;
      setState(state === "offline" ? "offline" : "reconnecting");
      startFallback();
      scheduleReconnect();
    };
  }

  return {
    start(): void {
      stopped = false;
      setState("connecting");
      startFallback();
      void open();
    },

    stop(): void {
      stopped = true;
      stopFallback();
      if (reconnectTimer !== null) timers.clearTimeout(reconnectTimer);
      socket?.close();
      socket = null;
      for (const [id, resolve] of waiting) {
        waiting.delete(id);
        resolve({ status: 0, body: null });
      }
    },

    // Devuelve el resultado o null si no llegó a tiempo.
    waitForResult(requestId: string): Promise<WriteResult | null> {
      const already = early.get(requestId);
      if (already) {
        early.delete(requestId);
        return Promise.resolve(already);
      }
      return new Promise((resolve) => {
        const timer = timers.setTimeout(() => {
          waiting.delete(requestId);
          resolve(null);
        }, opts.resultTimeoutMs);
        waiting.set(requestId, (r) => {
          timers.clearTimeout(timer);
          resolve(r);
        });
      });
    },

    getState: () => ({ state, lastUpdate }),
  };
}

export type Connection = ReturnType<typeof createConnection>;
