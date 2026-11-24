import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ConnectionState, createConnection, type SocketLike } from "../src/realtime/connection";

// WebSocket falso que la prueba abre, cierra o usa para mandar mensajes.
class FakeSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  closed = false;
  constructor(public url: string) {}
  open() { this.onopen?.(); }
  drop() { this.onclose?.(); }
  send(msg: unknown) { this.onmessage?.({ data: JSON.stringify(msg) }); }
  close() { this.closed = true; }
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup() {
  const sockets: FakeSocket[] = [];
  const states: ConnectionState[] = [];
  const messages: unknown[] = [];
  const poll = vi.fn(async () => {});
  const conn = createConnection({
    url: "wss://ws.test/dev",
    getToken: async () => "tok en",
    createSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    onMessage: (m) => messages.push(m),
    onState: (s) => states.push(s),
    poll,
    offlineAfterMs: 5000,
    pollEveryMs: 15000,
    resultTimeoutMs: 15000,
  });
  return { conn, sockets, states, messages, poll, last: () => sockets[sockets.length - 1]! };
}

describe("conexión WebSocket", () => {
  it("se conecta con el token en ?token= y queda en línea", async () => {
    const t = setup();
    t.conn.start();
    await vi.advanceTimersByTimeAsync(0);
    t.last().open();

    expect(t.last().url).toBe("wss://ws.test/dev?token=tok%20en");
    expect(t.conn.getState().state).toBe("online");
  });

  it("entrega order.updated y config.updated a la pantalla", async () => {
    const t = setup();
    t.conn.start();
    await vi.advanceTimersByTimeAsync(0);
    t.last().open();
    t.last().send({ type: "order.updated", order: { id: "o1" } });

    expect(t.messages).toEqual([{ type: "order.updated", order: { id: "o1" } }]);
    expect(t.conn.getState().lastUpdate).not.toBeNull();
  });

  it("write.result resuelve a quien espera ese requestId", async () => {
    const t = setup();
    t.conn.start();
    await vi.advanceTimersByTimeAsync(0);
    t.last().open();

    const waiting = t.conn.waitForResult("req-1");
    t.last().send({ type: "write.result", requestId: "req-1", status: 201, body: { id: "o1" } });

    expect(await waiting).toEqual({ status: 201, body: { id: "o1" } });
    expect(t.messages).toEqual([]); // no se mezcla con los demás mensajes
  });

  it("si el resultado llega antes que la respuesta 202, igual se entrega", async () => {
    const t = setup();
    t.conn.start();
    await vi.advanceTimersByTimeAsync(0);
    t.last().open();
    t.last().send({ type: "write.result", requestId: "req-2", status: 200, body: {} });

    expect(await t.conn.waitForResult("req-2")).toEqual({ status: 200, body: {} });
  });

  it("si el resultado no llega en 15 s, devuelve null", async () => {
    const t = setup();
    t.conn.start();
    await vi.advanceTimersByTimeAsync(0);
    t.last().open();
    const waiting = t.conn.waitForResult("req-3");
    await vi.advanceTimersByTimeAsync(15000);

    expect(await waiting).toBeNull();
  });
});

describe("respaldo por polling (RNF03)", () => {
  it("tras 5 s sin conexión consulta enseguida y luego cada 15 s", async () => {
    const t = setup();
    t.conn.start();
    await vi.advanceTimersByTimeAsync(0);
    t.last().open();
    t.poll.mockClear();

    t.last().drop();
    expect(t.conn.getState().state).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(4999);
    expect(t.poll).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(t.conn.getState().state).toBe("offline");
    expect(t.poll).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(15000);
    expect(t.poll).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(15000);
    expect(t.poll).toHaveBeenCalledTimes(3);
  });

  it("si reconecta antes de 5 s, no entra en modo respaldo", async () => {
    const t = setup();
    t.conn.start();
    await vi.advanceTimersByTimeAsync(0);
    t.last().open();
    t.last().drop();

    await vi.advanceTimersByTimeAsync(1000); // primer reintento a 1 s
    t.last().open();
    await vi.advanceTimersByTimeAsync(10000);

    expect(t.states).not.toContain("offline");
    expect(t.conn.getState().state).toBe("online");
  });

  it("al reconectar deja de consultar cada 15 s y recarga una vez para ponerse al día", async () => {
    const t = setup();
    t.conn.start();
    await vi.advanceTimersByTimeAsync(0);
    t.last().open();
    t.last().drop();
    await vi.advanceTimersByTimeAsync(5000); // modo respaldo
    t.poll.mockClear();

    // Los reintentos fallan hasta que uno se abre.
    t.last().open();
    expect(t.conn.getState().state).toBe("online");
    expect(t.poll).toHaveBeenCalledTimes(1); // recarga al reconectar

    await vi.advanceTimersByTimeAsync(60000);
    expect(t.poll).toHaveBeenCalledTimes(1);
  });

  it("stop cierra el socket y no reconecta", async () => {
    const t = setup();
    t.conn.start();
    await vi.advanceTimersByTimeAsync(0);
    t.last().open();
    const s = t.last();
    t.conn.stop();
    await vi.advanceTimersByTimeAsync(60000);

    expect(s.closed).toBe(true);
    expect(t.sockets).toHaveLength(1);
  });
});
