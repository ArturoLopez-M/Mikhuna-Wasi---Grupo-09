-- Mikhuna Wasi: esquema de base de datos (PostgreSQL)
-- Multi-tenancy: tablas compartidas, cada fila de negocio lleva restaurant_id.

CREATE TABLE restaurants (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL CHECK (btrim(name) <> ''),
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id UUID NOT NULL REFERENCES restaurants (id),
    cognito_sub   TEXT NOT NULL UNIQUE,
    email         TEXT NOT NULL,
    full_name     TEXT NOT NULL CHECK (btrim(full_name) <> ''),
    role          TEXT NOT NULL CHECK (role IN ('admin', 'waiter', 'kitchen', 'cashier')),
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Necesaria para claves foraneas compuestas (restaurant_id, user_id).
    UNIQUE (restaurant_id, id)
);

CREATE TABLE products (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id UUID NOT NULL REFERENCES restaurants (id),
    name          TEXT NOT NULL CHECK (btrim(name) <> ''),
    description   TEXT,
    price         NUMERIC(10,2) NOT NULL CHECK (price >= 0),
    is_available  BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Necesaria para que order_items apunte a (restaurant_id, product_id).
    UNIQUE (restaurant_id, id)
);

CREATE TABLE orders (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id UUID NOT NULL REFERENCES restaurants (id),
    table_label   TEXT NOT NULL CHECK (btrim(table_label) <> ''),
    status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'preparing', 'ready', 'closed', 'cancelled')),
    notes         TEXT,
    created_by    UUID NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Clave opcional enviada en la cabecera Idempotency-Key (RNF01/RNF02):
    -- un reintento con la misma clave devuelve el pedido ya creado.
    idempotency_key TEXT CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 100),
    -- Necesaria para order_items y payments.
    UNIQUE (restaurant_id, id),
    -- El usuario que creo el pedido debe ser del mismo restaurante.
    FOREIGN KEY (restaurant_id, created_by) REFERENCES users (restaurant_id, id)
);

CREATE INDEX orders_restaurant_status_idx ON orders (restaurant_id, status);

-- La clave es única por usuario dentro del restaurante. Ante dos reintentos
-- simultáneos, la base deja pasar solo uno (el otro recibe 23505).
CREATE UNIQUE INDEX orders_idempotency_key_idx
    ON orders (restaurant_id, created_by, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

CREATE TABLE order_items (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id UUID NOT NULL,
    order_id      UUID NOT NULL,
    product_id    UUID NOT NULL,
    product_name  TEXT NOT NULL CHECK (btrim(product_name) <> ''),
    quantity      INTEGER NOT NULL CHECK (quantity > 0),
    -- Precio copiado del producto al crear la linea (historico).
    unit_price    NUMERIC(10,2) NOT NULL CHECK (unit_price >= 0),
    notes         TEXT,
    -- Pedido y producto deben pertenecer al mismo restaurante que la linea.
    FOREIGN KEY (restaurant_id, order_id)   REFERENCES orders   (restaurant_id, id),
    FOREIGN KEY (restaurant_id, product_id) REFERENCES products (restaurant_id, id)
);

CREATE INDEX order_items_order_idx ON order_items (restaurant_id, order_id);

CREATE TABLE payments (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id UUID NOT NULL,
    order_id      UUID NOT NULL,
    amount        NUMERIC(10,2) NOT NULL CHECK (amount > 0),
    method        TEXT NOT NULL CHECK (method IN ('cash', 'card', 'digital_wallet')),
    received_by   UUID NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Un solo pago por pedido (MVP). Tambien sirve de indice por pedido.
    UNIQUE (restaurant_id, order_id),
    FOREIGN KEY (restaurant_id, order_id)    REFERENCES orders (restaurant_id, id),
    FOREIGN KEY (restaurant_id, received_by) REFERENCES users  (restaurant_id, id)
);

-- Historial de cambios de estado (RNF12): quién, cuándo, valor anterior y nuevo.
-- La creación del pedido se registra con from_status NULL.
CREATE TABLE order_status_history (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id UUID NOT NULL,
    order_id      UUID NOT NULL,
    from_status   TEXT CHECK (from_status IN ('pending', 'preparing', 'ready', 'closed', 'cancelled')),
    to_status     TEXT NOT NULL CHECK (to_status IN ('pending', 'preparing', 'ready', 'closed', 'cancelled')),
    changed_by    UUID NOT NULL,
    changed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (restaurant_id, order_id)   REFERENCES orders (restaurant_id, id),
    FOREIGN KEY (restaurant_id, changed_by) REFERENCES users  (restaurant_id, id)
);

CREATE INDEX order_status_history_order_idx
    ON order_status_history (restaurant_id, order_id, changed_at);

-- Registros históricos de solo agregar (RNF12): la base rechaza UPDATE, DELETE
-- y TRUNCATE sobre pagos e historial, incluso si el backend tuviera un error.
-- Las correcciones se hacen con las acciones autorizadas (por ejemplo, cancelar).
CREATE FUNCTION reject_history_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'La tabla % es de solo agregar: % no permitido', TG_TABLE_NAME, TG_OP
        USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER payments_append_only
    BEFORE UPDATE OR DELETE ON payments
    FOR EACH ROW EXECUTE FUNCTION reject_history_change();
CREATE TRIGGER payments_no_truncate
    BEFORE TRUNCATE ON payments
    FOR EACH STATEMENT EXECUTE FUNCTION reject_history_change();

CREATE TRIGGER order_status_history_append_only
    BEFORE UPDATE OR DELETE ON order_status_history
    FOR EACH ROW EXECUTE FUNCTION reject_history_change();
CREATE TRIGGER order_status_history_no_truncate
    BEFORE TRUNCATE ON order_status_history
    FOR EACH STATEMENT EXECUTE FUNCTION reject_history_change();
