# Base de datos

PostgreSQL. Esta carpeta tiene el esquema y los datos de ejemplo para desarrollo local.

- `schema.sql`: crea las 6 tablas (`restaurants`, `users`, `products`, `orders`, `order_items`, `payments`). Está pensado para ejecutarse sobre una base **vacía**.
- `seed.sql`: datos de ejemplo **solo para desarrollo**. Los `cognito_sub` son ficticios: al integrar Cognito hay que reemplazarlos por los `sub` reales de usuarios de prueba.

## Decisiones de diseño

- **Multi-tenancy tipo pool:** todas las tablas de negocio comparten estructura y llevan `restaurant_id` obligatorio.
- **Claves foráneas compuestas** `(restaurant_id, id)`: la base rechaza mezclar datos de restaurantes distintos (por ejemplo, un producto de otro restaurante dentro de un pedido). Esto no reemplaza la verificación en el backend, que siempre debe obtener el restaurante desde la identidad autenticada y nunca desde el frontend.
- **Identificadores UUID** generados por PostgreSQL (`gen_random_uuid()`).
- **Usuarios y Cognito:** Cognito autentica; `users` guarda `cognito_sub`, `restaurant_id` y el rol. No hay contraseñas en la base.
- **Dinero:** `NUMERIC(10,2)` en soles. Cada línea de pedido guarda su `unit_price` copiado del producto al crearla.
- **Total del pedido:** no se almacena, se calcula sumando `quantity * unit_price`.
- **Estados del pedido:** `pending` → `preparing` → `ready` → `closed`, más `cancelled`. Son `TEXT` con `CHECK`. La base valida los valores permitidos, pero **no las transiciones**: eso lo controla el backend, según el rol.
- **Roles:** `admin`, `waiter`, `kitchen`, `cashier`.
- **Pagos:** un pago por pedido (MVP). El monto contra el total lo valida el backend.

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
