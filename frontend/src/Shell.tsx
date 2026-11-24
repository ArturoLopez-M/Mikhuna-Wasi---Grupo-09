import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, createApi } from "./api/client";
import type { Me, Order, ServiceMode } from "./api/types";
import type { Session } from "./auth/session";
import { StatusBar } from "./components/StatusBar";
import { config, OFFLINE_AFTER_MS, POLL_EVERY_MS, WRITE_RESULT_TIMEOUT_MS } from "./config";
import { ConfigPage } from "./features/ConfigPage";
import { NewOrderForm } from "./features/NewOrderForm";
import { OrdersBoard } from "./features/OrdersBoard";
import { defaultStatuses, type Tab, tabsFor } from "./features/permissions";
import { ProductsPage } from "./features/ProductsPage";
import { type ConnectionState, createConnection, type SocketLike } from "./realtime/connection";

const TAB_LABELS: Record<Tab, string> = {
  orders: "Pedidos",
  "new-order": "Nuevo pedido",
  products: "Productos",
  config: "Configuración",
};

interface Props {
  session: Session;
  onSignOut: (reason?: string) => Promise<void>;
}

export function Shell({ session, onSignOut }: Props) {
  const [me, setMe] = useState<Me | null>(null);
  const [orders, setOrders] = useState<Map<string, Order>>(new Map());
  const [tab, setTab] = useState<Tab>("orders");
  const [conn, setConn] = useState<{ state: ConnectionState; lastUpdate: Date | null }>({
    state: "connecting",
    lastUpdate: null,
  });
  const [fatal, setFatal] = useState<string | null>(null);
  const meRef = useRef<Me | null>(null);

  const getToken = useCallback(async () => {
    try {
      return await session.getAccessToken();
    } catch (err) {
      void onSignOut("Tu sesión venció. Vuelve a iniciar sesión.");
      throw err;
    }
  }, [session, onSignOut]);

  // La conexión y la API se crean una vez; la API espera los resultados de
  // las escrituras en el WebSocket.
  const { connection, api } = useMemo(() => {
    let loadOrders: () => Promise<void> = async () => {};
    const connection = createConnection({
      url: config.wsUrl,
      getToken,
      // El WebSocket del navegador cumple la interfaz que usa la conexión.
      createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
      onMessage: (msg) => {
        if (msg.type === "order.updated") {
          const order = msg.order as Order;
          setOrders((prev) => new Map(prev).set(order.id, order));
        }
        if (msg.type === "config.updated") {
          const mode = (msg.config as { serviceMode: ServiceMode }).serviceMode;
          setMe((prev) => (prev ? { ...prev, restaurant: { ...prev.restaurant, serviceMode: mode } } : prev));
        }
      },
      onState: (state, lastUpdate) => setConn({ state, lastUpdate }),
      poll: () => loadOrders(),
      offlineAfterMs: OFFLINE_AFTER_MS,
      pollEveryMs: POLL_EVERY_MS,
      resultTimeoutMs: WRITE_RESULT_TIMEOUT_MS,
    });
    const api = createApi({
      baseUrl: config.apiUrl,
      getToken,
      waitForResult: (id) => connection.waitForResult(id),
    });
    loadOrders = async () => {
      const current = meRef.current;
      if (!current) return;
      const statuses = defaultStatuses(current.role).join(",");
      const res = await api.get<{ data: Order[] }>(`/api/v1/orders?status=${statuses}&limit=100`);
      setOrders(new Map(res.data.map((o) => [o.id, o])));
    };
    return { connection, api };
  }, [getToken]);

  useEffect(() => {
    let cancelled = false;
    api
      .get<Me>("/api/v1/me")
      .then((profile) => {
        if (cancelled) return;
        meRef.current = profile;
        setMe(profile);
        connection.start();
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 403) setFatal("Tu usuario no tiene acceso al sistema.");
        else setFatal(err instanceof Error ? err.message : "No se pudo cargar tu perfil.");
      });
    return () => {
      cancelled = true;
      connection.stop();
    };
  }, [api, connection]);

  if (fatal) {
    return (
      <main className="center">
        <p className="error">{fatal}</p>
        <button onClick={() => void onSignOut()}>Salir</button>
      </main>
    );
  }
  if (!me) return <main className="center">Cargando...</main>;

  const tabs = tabsFor(me.role);
  const upsert = (order: Order) => setOrders((prev) => new Map(prev).set(order.id, order));

  return (
    <div className="shell">
      <header className="topbar">
        <div>
          <strong>{me.restaurant.name}</strong>
          <span className="muted"> · {me.fullName}</span>
        </div>
        <button className="link" onClick={() => void onSignOut()}>
          Salir
        </button>
      </header>
      <StatusBar state={conn.state} lastUpdate={conn.lastUpdate} />
      {tabs.length > 1 && (
        <nav className="tabs">
          {tabs.map((t) => (
            <button key={t} className={t === tab ? "active" : ""} onClick={() => setTab(t)}>
              {TAB_LABELS[t]}
            </button>
          ))}
        </nav>
      )}
      <main className="content">
        {tab === "orders" && <OrdersBoard me={me} orders={[...orders.values()]} api={api} onUpdated={upsert} />}
        {tab === "new-order" && (
          <NewOrderForm
            api={api}
            serviceMode={me.restaurant.serviceMode}
            onCreated={(o) => {
              upsert(o);
              setTab("orders");
            }}
          />
        )}
        {tab === "products" && <ProductsPage api={api} />}
        {tab === "config" && (
          <ConfigPage
            api={api}
            serviceMode={me.restaurant.serviceMode}
            onSaved={(mode) => setMe({ ...me, restaurant: { ...me.restaurant, serviceMode: mode } })}
          />
        )}
      </main>
    </div>
  );
}
