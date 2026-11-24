# Base de datos

PostgreSQL. Esta carpeta tiene el esquema y los datos de ejemplo para desarrollo local.

- `schema.sql`: crea las 7 tablas (`restaurants`, `users`, `products`, `orders`, `order_items`, `payments`, `order_status_history`), los índices y los triggers de solo agregar. Está pensado para ejecutarse sobre una base **vacía**: no hay migraciones, así que una base creada con una versión anterior debe recrearse (ver "reiniciar la base" abajo).
- `seed.sql`: datos de ejemplo **solo para desarrollo**. Los `cognito_sub` son ficticios: al integrar Cognito hay que reemplazarlos por los `sub` reales de usuarios de prueba.

## Decisiones de diseño

- **Multi-tenancy tipo pool:** todas las tablas de negocio comparten estructura y llevan `restaurant_id` obligatorio.
- **Claves foráneas compuestas** `(restaurant_id, id)`: la base rechaza mezclar datos de restaurantes distintos (por ejemplo, un producto de otro restaurante dentro de un pedido). Esto no reemplaza la verificación en el backend, que siempre debe obtener el restaurante desde la identidad autenticada y nunca desde el frontend.
- **Identificadores UUID** generados por PostgreSQL (`gen_random_uuid()`).
- **Usuarios y Cognito:** Cognito autentica; `users` guarda `cognito_sub`, `restaurant_id` y el rol. No hay contraseñas en la base.
- **Dinero:** `NUMERIC(10,2)` en soles. Cada línea de pedido guarda su `unit_price` copiado del producto al crearla.
- **Total del pedido:** no se almacena, se calcula sumando `quantity * unit_price`.
- **Estados del pedido:** `pending` → `preparing` → `ready` → `closed`, más `cancelled`. Son `TEXT` con `CHECK`. La base valida los valores permitidos, pero **no las transiciones**: eso lo controla el backend, según el rol.
- **Roles:** `admin`, `waiter`, `kitchen`, `cashier`, `delivery` (repartidor).
- **Modalidad (RNF08):** `restaurants.service_mode` es `dine_in`, `delivery` o `both`.
- **Delivery:** `orders.service_type` es `dine_in` (con `table_label`) o `delivery` (con `delivery_address`, `delivery_status` y, al despachar, `assigned_to`). Un `CHECK` impide mezclar los dos casos. El estado de la entrega va aparte del estado de cocina.
- **Pagos:** un pago por pedido (MVP). El monto contra el total lo valida el backend.
- **Idempotencia (RNF01/RNF02):** `orders.idempotency_key` guarda la cabecera `Idempotency-Key`. El índice único parcial `(restaurant_id, created_by, idempotency_key)` garantiza que dos reintentos simultáneos no creen dos pedidos.
- **Historial (RNF12):** `order_status_history` registra cada cambio de estado (anterior, nuevo, usuario, fecha), incluida la creación (`from_status` NULL). `field` indica si cambió el estado del pedido (`status`) o el de la entrega (`delivery_status`). Junto con `payments`, es de **solo agregar**: un trigger rechaza `UPDATE`, `DELETE` y `TRUNCATE`. Las correcciones se hacen con las acciones autorizadas (por ejemplo, cancelar).

## Probar localmente con Docker

Requiere Docker Desktop abierto. Ejecutar desde `backend/`.

```powershell
# 1. Crear el contenedor (solo la primera vez)
docker run --name mikhuna-db -e POSTGRES_PASSWORD=dev_password -e POSTGRES_DB=mikhuna -p 5432:5432 -d postgres:16

# 2. Aplicar esquema y datos de ejemplo
docker cp db/schema.sql mikhuna-db:/tmp/schema.sql
docker cp db/seed.sql mikhuna-db:/tmp/seed.sql
docker exec mikhuna-db psql -U postgres -d mikhuna -v ON_ERROR_STOP=1 -f /tmp/schema.sql
docker exec mikhuna-db psql -U postgres -d mikhuna -v ON_ERROR_STOP=1 -f /tmp/seed.sql
```

Para reiniciar la base desde cero (**borra todos los datos**, usar solo en desarrollo):

```powershell
docker exec mikhuna-db psql -U postgres -d mikhuna -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
```

y repetir el paso 2. Para apagar o volver a encender el contenedor: `docker stop mikhuna-db` y `docker start mikhuna-db`.

`dev_password` es una contraseña ficticia solo para este contenedor local.
