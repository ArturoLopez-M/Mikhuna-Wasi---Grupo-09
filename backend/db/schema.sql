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
    -- Necesaria para order_items y payments.
    UNIQUE (restaurant_id, id),
    -- El usuario que creo el pedido debe ser del mismo restaurante.
    FOREIGN KEY (restaurant_id, created_by) REFERENCES users (restaurant_id, id)
);

CREATE INDEX orders_restaurant_status_idx ON orders (restaurant_id, status);

CREATE TABLE order_items (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id UUID NOT NULL,
    order_id      UUID NOT NULL,
    product_id    UUID NOT NULL,
    quantity      INTEGER NOT NULL CHECK (quantity > 0),
    -- Precio copiado del producto al crear la linea (historico).
    unit_price    NUMERIC(10,2) NOT NULL CHECK (unit_price >= 0),
    notes         TEXT,
    -- Pedido y producto deben pertenecer al mismo restaurante que la linea.
    FOREIGN KEY (restaurant_id, order_id)   REFERENCES orders   (restaurant_id, id),
    FOREIGN KEY (restaurant_id, product_id) REFERENCES products (restaurant_id, id)
);

CREATE INDEX order_items_order_idx ON order_items (restaurant_id, order_id);
