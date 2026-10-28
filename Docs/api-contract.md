# Contrato de API: Mikhuna Wasi

Contrato que siguen backend y frontend. Versión del MVP. Cualquier cambio se discute en el grupo y se actualiza aquí antes de implementarse.

## 1. Convenciones

- Prefijo `/api/v1/...`. `GET /health` es público y queda fuera del prefijo.
- Rutas en inglés, plural y en minúsculas.
- JSON en `camelCase` (el backend convierte desde `snake_case`).
- Fechas en ISO 8601 UTC: `2026-10-28T07:31:40.073Z`. Si algún día hay fechas sin hora: `YYYY-MM-DD`.
- IDs: UUID como string.
- Dinero: siempre string con dos decimales, en soles (`"35.00"`). Los cálculos usan aritmética decimal (`NUMERIC`), nunca `float`.
- El cliente nunca envía precios ni totales. Solo `productId` y `quantity`; el backend copia el precio del producto y calcula los totales.
- Sin `DELETE` en el MVP. Toda operación exitosa devuelve el recurso con `200` o `201` (no se usa `204`).
- Los campos desconocidos en un cuerpo dan `400`.

## 2. Autenticación y aislamiento

- Cabecera `Authorization: Bearer <access_token>` de Amazon Cognito (**access token**, no ID token).
- El backend valida firma, emisor, vencimiento, tipo `access` y `client_id`.
- Con el `sub` busca al usuario en `users` para obtener restaurante y rol. Si no tiene fila o está inactivo: `403`. No existe restaurante por defecto.
- El `restaurantId` **nunca** viaja en rutas, cuerpos ni parámetros. Sale de la identidad autenticada.
- El aislamiento se verifica en todas las operaciones (listas, consultas por ID, modificaciones, cancelaciones, acciones de cocina y pago). Un recurso de otro restaurante responde `404`, igual que uno inexistente.

## 3. Errores

Formato único:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Mensaje en español",
    "details": [{ "field": "items[0].quantity", "message": "..." }]
  }
}
```

`details` solo aparece en errores de validación y en `PRODUCT_UNAVAILABLE`.

| HTTP | `code` | Cuándo |
|---|---|---|
| 400 | `VALIDATION_ERROR` | JSON roto, UUID mal formado, error de Zod, campos desconocidos, parámetros inválidos |
| 401 | `UNAUTHENTICATED` | Token ausente, inválido o vencido |
| 403 | `FORBIDDEN` | Rol sin permiso, usuario inactivo o sin fila en `users`, regla de propiedad |
| 404 | `NOT_FOUND` | Ruta o recurso inexistente, o recurso de otro restaurante |
| 409 | `INVALID_ORDER_STATUS` | Transición no permitida desde el estado actual |
| 409 | `ORDER_ALREADY_PAID` | El pedido ya tiene un pago |
| 409 | `PAYMENT_AMOUNT_MISMATCH` | El monto enviado no coincide con el total |
| 409 | `PRODUCT_UNAVAILABLE` | Producto con `isAvailable: false` en un pedido |
| 409 | `PRODUCT_LIMIT_REACHED` | Se alcanzó el tope de 200 productos |
| 500 | `INTERNAL_ERROR` | Error inesperado. No filtra información interna; el detalle va solo al log, sin tokens ni datos sensibles |

## 4. Roles y permisos

Roles: `admin`, `waiter`, `kitchen`, `cashier`. El admin puede hacer todo lo operativo. Todos ven todos los pedidos del restaurante. Cada acción se autoriza por separado en el backend; el `role` que recibe el frontend sirve para mostrar pantallas, nunca como control de seguridad.

| Acción | Roles |
|---|---|
| `GET /api/v1/me`, ver productos, ver pedidos | todos |
| Crear y editar productos | admin |
| Registrar pedido | admin, waiter |
| `start-preparing`, `mark-ready` | kitchen, admin |
| `cancel` | waiter (solo sus propios pedidos en `pending`), admin (`pending`, `preparing`, `ready`) |
| `payment` (pagar y cerrar) | cashier, admin |

## 5. Estados del pedido

```
pending -> preparing -> ready -> closed
   \           \          \
    +-----------+----------+--> cancelled
```

- `closed` ocurre **solo** al registrar el pago; no tiene endpoint propio.
- `closed` y `cancelled` son estados finales.
- La base valida los valores de `status`, pero no las transiciones: las valida el backend.

## 6. Endpoints

### 6.1 Salud

`GET /health` (público). Fuera del prefijo `/api/v1`.

### 6.2 Usuario actual

`GET /api/v1/me` (todos), `200`:

```json
{
  "id": "uuid",
  "fullName": "Ana Pérez",
  "email": "ana@ejemplo.com",
  "role": "waiter",
  "restaurant": { "id": "uuid", "name": "Mikhuna Central" }
}
```

No incluye `cognitoSub`.

### 6.3 Productos

Producto:

```json
{
  "id": "uuid",
  "name": "Lomo saltado",
  "description": "Con papas fritas y arroz",
  "price": "35.00",
  "isAvailable": true,
  "createdAt": "2026-10-28T07:31:40.073Z"
}
```

| Método | Ruta | Quién | Éxito |
|---|---|---|---|
| `GET` | `/api/v1/products` | todos | 200 |
| `POST` | `/api/v1/products` | admin | 201 |
| `PATCH` | `/api/v1/products/{id}` | admin | 200 |

No existen `GET /products/{id}` ni `DELETE`. Un producto se desactiva con `isAvailable: false`.

**Listar:** respuesta `{ "data": [...] }`, sin paginación. El admin ve todos; los demás roles solo los disponibles. Filtro opcional `?available=true|false`; un no-admin con `?available=false` recibe `403`. El tope de 200 productos se aplica al crear (`409 PRODUCT_LIMIT_REACHED`), así que el listado nunca se trunca.

**Crear:** `{ name, description?, price, isAvailable? }`.

- `name`: 1 a 100 caracteres, sin espacios en los extremos.
- `description`: hasta 500 caracteres o `null`.
- `price`: string que cumple `^(0|[1-9]\d{0,4})(\.\d{1,2})?$`. Acepta `"35"`, `"35.5"` y `"35.50"`; la respuesta siempre trae dos decimales. Rechaza números JSON, negativos, tres decimales, valores >= 100000 y coma decimal (el frontend convierte antes de enviar).
- `isAvailable`: por defecto `true`.

**Editar (`PATCH`):** al menos un campo; campos desconocidos dan `400`; `null` solo se admite en `description`.

### 6.4 Pedidos

Pedido completo (misma forma en creación, detalle, lista y acciones):

```json
{
  "id": "uuid",
  "tableLabel": "Mesa 4",
  "status": "pending",
  "notes": null,
  "createdBy": { "id": "uuid", "fullName": "Ana Pérez" },
  "createdAt": "2026-10-28T07:31:40.073Z",
  "items": [
    {
      "id": "uuid",
      "productId": "uuid",
      "productName": "Lomo saltado",
      "quantity": 2,
      "unitPrice": "35.00",
      "lineTotal": "70.00",
      "notes": null
    }
  ],
  "total": "70.00",
  "payment": null
}
```

- `payment` es `null` hasta que se cobra; luego `{ "amount": "70.00", "method": "cash", "createdAt": "..." }`.
- `lineTotal` y `total` los calcula el backend con el `unitPrice` guardado en la línea. Cambiar el precio de un producto no altera pedidos existentes.
- `productName` es copia histórica tomada al crear la línea (requiere la rama `feat/order-item-product-name`).

| Método | Ruta | Quién | Éxito |
|---|---|---|---|
| `POST` | `/api/v1/orders` | admin, waiter | 201 |
| `GET` | `/api/v1/orders` | todos | 200 |
| `GET` | `/api/v1/orders/{id}` | todos | 200 |

**Crear:** `{ tableLabel, notes?, items }`.

- `tableLabel`: 1 a 30 caracteres.
- `notes`: opcional, hasta 500 caracteres o `null`.
- `items`: de 1 a 50 líneas. Cada una: `{ productId, quantity, notes? }`, con `productId` UUID, `quantity` entero de 1 a 99 y `notes` de hasta 200 caracteres.
- Un mismo producto puede repetirse en varias líneas.
- El cliente nunca envía `unitPrice`, `productName`, `status`, `createdBy` ni totales.
- Todo ocurre en una sola transacción.
- `productId` inexistente o de otro restaurante: `400`, con el mismo mensaje en ambos casos.
- Producto no disponible: `409 PRODUCT_UNAVAILABLE`, con `details` que indican la línea (por ejemplo `items[1].productId`).

**Listar:**

| Parámetro | Comportamiento |
|---|---|
| `status` | Uno o varios separados por coma: `pending`, `preparing`, `ready`, `closed`, `cancelled`. Un valor inválido, aun junto a uno válido, da `400` |
| `mine` | Solo `true` o `false`. `true` filtra por pedidos creados por el usuario autenticado; `false` equivale a omitirlo. Otro valor da `400` |
| `sort` | `createdAt` o `-createdAt` (por defecto `-createdAt`) |
| `limit` | Por defecto 50, máximo 100; un valor mayor da `400` |
| `offset` | Por defecto 0 |

Respuesta:

```json
{
  "data": [ ],
  "pagination": { "limit": 50, "offset": 0, "total": 123 }
}
```

Sin filtros por fecha en el MVP (requieren la zona horaria del restaurante).

### 6.5 Acciones sobre un pedido

Todas son `POST`, no llevan cuerpo (salvo `payment`), devuelven `200` con el pedido completo, y un cuerpo con campos desconocidos da `400`.

| Acción | Ruta | Quién | Estado requerido | Resultado |
|---|---|---|---|---|
| Empezar a preparar | `/api/v1/orders/{id}/start-preparing` | kitchen, admin | `pending` | `preparing` |
| Marcar listo | `/api/v1/orders/{id}/mark-ready` | kitchen, admin | `preparing` | `ready` |
| Cancelar | `/api/v1/orders/{id}/cancel` | waiter (propios, `pending`), admin | `pending`, `preparing`, `ready` | `cancelled` |
| Pagar y cerrar | `/api/v1/orders/{id}/payment` | cashier, admin | `ready` | `closed` |

**Orden de verificación** en todas las acciones: (1) rol de la ruta, `403`; (2) el pedido existe en el restaurante del usuario, `404`; (3) regla de propiedad si aplica, `403`; (4) estado, `409 INVALID_ORDER_STATUS`. En `payment` el orden cambia: (4) pago existente, `409 ORDER_ALREADY_PAID`; (5) estado, `409 INVALID_ORDER_STATUS`; (6) monto, `409 PAYMENT_AMOUNT_MISMATCH`.

**Cancelar:** sin motivo en el MVP (no se acepta `reason`). El mesero solo cancela sus propios pedidos en `pending`; si el pedido es de otro empleado del mismo restaurante, `403`. El admin cancela en `pending`, `preparing` o `ready`. Desde `closed` o `cancelled`: `409 INVALID_ORDER_STATUS`.

**Pagar y cerrar:** cuerpo

```json
{ "method": "cash", "amount": "70.00" }
```

- `method`: `cash`, `card` o `digital_wallet`.
- `amount`: mismo formato de dinero que los precios (acepta `"70"`, responde `"70.00"`).
- Sin pagos parciales: un único pago por el total.

Una sola transacción:

1. `SELECT ... FOR UPDATE` sobre el pedido, filtrado por restaurante.
2. Si el pedido ya tiene un pago, `409 ORDER_ALREADY_PAID`. Se comprueba **antes** que el estado: un pedido pagado está `closed`, y si se validara primero el estado, este error nunca se devolvería. Una solicitud concurrente que espera el bloqueo ve el pago ya registrado y recibe este mismo código. El error `23505` del `UNIQUE (restaurant_id, order_id)` también se traduce a `ORDER_ALREADY_PAID` como red de seguridad.
3. Verificar estado `ready` (`409 INVALID_ORDER_STATUS` si no; por ejemplo, un pedido `cancelled` o que aún no está listo).
4. Comparar `amount` con el total calculado; si difiere, `409 PAYMENT_AMOUNT_MISMATCH`.
5. Insertar el pago (con `received_by` = usuario autenticado) y pasar el pedido a `closed`.

El MVP registra el pago informado por el cajero; no procesa cobros reales.

## 7. Limitaciones conocidas del MVP

- **Sin gestión de usuarios ni restaurantes:** dar de alta empleados o restaurantes es manual (Cognito + `insert` en `users`).
- **Sin historial de cambios de estado:** `orders` no guarda cuándo cambia de estado, así que no se pueden reconstruir las transiciones ni medir tiempos de cocina. Si el grupo lo exige, se agrega una tabla `order_status_history` en una rama de esquema, sin cambiar este contrato.
- **Sin idempotencia:** un reintento tras perder la conexión puede duplicar un pedido. Mejora futura: cabecera opcional `Idempotency-Key`.
- **Sin motivo de cancelación.**
- **Sin pagos parciales ni pasarela de pagos real.**
- **Sin filtros por fecha** en la lista de pedidos.
- **Aislamiento por backend:** la base rechaza mezclar datos de distintos restaurantes al escribir (claves foráneas compuestas), pero no protege las lecturas; eso lo hace el backend (RLS queda para más adelante).

## 8. Notas para la implementación

- Ampliar `HttpError` y `errorHandler` para llevar `code` (hoy solo devuelven `{ error: { message } }`).
- Crear pedido: leer los productos dentro de la misma transacción con `SELECT ... FOR SHARE` (o equivalente) para evitar que la disponibilidad cambie a mitad de la operación.
- `pg` devuelve los `NUMERIC` como texto; usar aritmética decimal en el servidor, nunca `float`.
- Cada rama de implementación debe probar el aislamiento (recurso ajeno da `404`) y al menos una prueba por categoría de error.
- Mini-rama previa: `feat/order-item-product-name` (columna `product_name` en `order_items`; toca `schema.sql`, `seed.sql` y `db/README.md`), antes de las ramas de implementación.
