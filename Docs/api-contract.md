# Contrato de API: Mikhuna Wasi

Contrato que siguen backend y frontend. Versión del MVP. Cualquier cambio se discute en el grupo y se actualiza aquí antes de implementarse.

## 1. Convenciones

- Prefijo `/api/v1/...`. Todo exige autenticación.
- Rutas en inglés, plural y en minúsculas.
- JSON en `camelCase` (el backend convierte desde `snake_case`).
- Fechas en ISO 8601 UTC: `2026-10-28T07:31:40.073Z`. Si algún día hay fechas sin hora: `YYYY-MM-DD`.
- IDs: UUID como string.
- Dinero: siempre string con dos decimales, en soles (`"35.00"`). Los cálculos usan aritmética decimal (`NUMERIC`), nunca `float`.
- El cliente nunca envía precios ni totales. Solo `productId` y `quantity`; el backend copia el precio del producto y calcula los totales.
- Sin `DELETE` en el MVP. Toda operación exitosa produce el recurso con `200` o `201` (no se usa `204`).
- Los campos desconocidos en un cuerpo dan `400`.

### 1.1 Lecturas y escrituras

El camino de cada petición sigue el diagrama de arquitectura:

- **Consultas, perfil y configuración**: API Gateway REST → Lambda **Lectura y Configuración**, sin cola, porque el usuario espera la respuesta en pantalla. Son los `GET`, más guardar la modalidad del restaurante y el menú (`PATCH /restaurant/config`, `POST /products`, `PATCH /products/{id}`). La respuesta HTTP es la descrita en cada endpoint.
- **Escrituras de pedidos (`POST /orders...`)**: API Gateway REST deja la petición en la cola SQS del módulo y responde enseguida **`202 Accepted`** con `{ "requestId": "..." }`. La Lambda del módulo la procesa:

| Ruta | Cola y Lambda |
|---|---|
| `POST /orders`, `POST /orders/{id}/cancel` | Pedidos |
| `POST /orders/{id}/start-preparing`, `POST /orders/{id}/mark-ready` | Cocina |
| `POST /orders/{id}/payment` | Registro de Pagos |
| `POST /orders/{id}/dispatch`, `/deliver`, `/delivery-failed`, `/assign` | Delivery |

- El **resultado** de una escritura tiene el mismo `status` y cuerpo que describe cada endpoint (por ejemplo `201` con el pedido, o `409 INVALID_ORDER_STATUS`). Llega por WebSocket como `{ "type": "write.result", "requestId", "status", "body" }` (sección 6.6) y también queda en CloudWatch Logs como `WRITE_RESULT`.
- Los errores de negocio (`400`, `403`, `404`, `409`) no se reintentan. Un error técnico (base caída, por ejemplo) devuelve el mensaje a la cola; tras **3 intentos** fallidos pasa a la **DLQ** y se dispara una alarma.

## 2. Autenticación y aislamiento

- Cabecera `Authorization: Bearer <access_token>` de Amazon Cognito (**access token**, no ID token).
- El autorizador de Cognito de API Gateway valida firma, emisor y vencimiento, y rechaza con `401` antes de llegar a la cola o a la Lambda.
- Con el `sub` del token, la Lambda busca al usuario en `users` para obtener restaurante y rol. Si no tiene fila o está inactivo: `403`. No existe restaurante por defecto.
- El `restaurantId` **nunca** viaja en rutas, cuerpos ni parámetros. Sale de la identidad autenticada.
- El aislamiento se verifica en todas las operaciones (listas, consultas por ID, modificaciones, cancelaciones, acciones de cocina y pago). Un recurso de otro restaurante responde `404`, igual que uno inexistente.
- Todo rechazo `401`/`403` se registra en el log como una línea JSON `{"event":"ACCESS_DENIED", status, code, userId, restaurantId, method, path, at}` (RNF05). Nunca incluye el token ni el cuerpo.

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
| 409 | `SERVICE_MODE_NOT_ALLOWED` | El restaurante no atiende ese tipo de pedido (por ejemplo, delivery en un restaurante solo en local) |
| 409 | `INVALID_DELIVERY_STATUS` | El pedido no es de delivery o la entrega no está en un estado válido para la acción |
| 500 | `INTERNAL_ERROR` | Error inesperado. No filtra información interna; el detalle va solo al log, sin tokens ni datos sensibles |

## 4. Roles y permisos

Roles: `admin`, `waiter`, `kitchen`, `cashier`, `delivery` (repartidor). El admin puede hacer todo lo operativo. Todos ven todos los pedidos del restaurante. Cada acción se autoriza por separado en el backend; el `role` que recibe el frontend sirve para mostrar pantallas, nunca como control de seguridad.

| Acción | Roles |
|---|---|
| `GET /api/v1/me`, ver productos, ver pedidos | todos |
| Crear y editar productos | admin |
| Registrar pedido | admin, waiter |
| `start-preparing`, `mark-ready` | kitchen, admin |
| `cancel` | waiter (solo sus propios pedidos en `pending`), admin (`pending`, `preparing`, `ready`) |
| `payment` (pagar y cerrar) | cashier, admin |
| `dispatch`, `deliver`, `delivery-failed` | delivery (solo sus entregas), admin |
| `assign` (asignar repartidor) | admin |
| Ver la modalidad del restaurante | todos |
| Cambiar la modalidad del restaurante | admin |

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

No hay endpoint de salud: no forma parte del diagrama. La salud del sistema se observa con las métricas y alarmas de CloudWatch.

### 6.2 Usuario actual

`GET /api/v1/me` (todos), `200`:

```json
{
  "id": "uuid",
  "fullName": "Ana Pérez",
  "email": "ana@ejemplo.com",
  "role": "waiter",
  "restaurant": { "id": "uuid", "name": "Mikhuna Central", "serviceMode": "both" }
}
```

No incluye `cognitoSub`. `serviceMode` sirve para que el frontend muestre solo lo que el restaurante atiende (sección 6.9).

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
  "serviceType": "dine_in",
  "tableLabel": "Mesa 4",
  "delivery": null,
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

- `serviceType`: `dine_in` (en el local, con `tableLabel`) o `delivery`. En un delivery, `tableLabel` es `null` y `delivery` es `{ "address": "...", "status": "pending_dispatch", "assignedTo": null | { "id", "fullName" } }` (sección 6.8). En local, `delivery` es `null`.
- `payment` es `null` hasta que se cobra; luego `{ "amount": "70.00", "method": "cash", "createdAt": "..." }`.
- `lineTotal` y `total` los calcula el backend con el `unitPrice` guardado en la línea. Cambiar el precio de un producto no altera pedidos existentes.
- `productName` es copia histórica tomada al crear la línea (columna `order_items.product_name`).

| Método | Ruta | Quién | Éxito |
|---|---|---|---|
| `POST` | `/api/v1/orders` | admin, waiter | 201 |
| `GET` | `/api/v1/orders` | todos | 200 |
| `GET` | `/api/v1/orders/{id}` | todos | 200 |

**Crear:** `{ serviceType?, tableLabel?, deliveryAddress?, notes?, items }`.

- `serviceType`: `dine_in` (por defecto) o `delivery`.
- `tableLabel`: 1 a 30 caracteres. Obligatorio en `dine_in`; no se envía en `delivery`.
- `deliveryAddress`: 1 a 300 caracteres. Obligatoria en `delivery`; no se envía en `dine_in`.
- Si el restaurante no atiende ese tipo de pedido (sección 6.9): `409 SERVICE_MODE_NOT_ALLOWED`.
- `notes`: opcional, hasta 500 caracteres o `null`.
- `items`: de 1 a 50 líneas. Cada una: `{ productId, quantity, notes? }`, con `productId` UUID, `quantity` entero de 1 a 99 y `notes` de hasta 200 caracteres.
- Un mismo producto puede repetirse en varias líneas.
- El cliente nunca envía `unitPrice`, `productName`, `status`, `createdBy` ni totales.
- Todo ocurre en una sola transacción.
- Cabecera opcional `Idempotency-Key` (RNF01/RNF02): de 1 a 100 caracteres ASCII visibles; se recomienda un UUID que el frontend genera **una vez por pedido** y reutiliza en cada reintento. Si el mismo usuario ya creó un pedido con esa clave, se devuelve ese pedido con `201` y la cabecera `Idempotent-Replayed: true`, sin crear otro (también ante dos reintentos simultáneos). Sin cabecera, se usa el `requestId` de API Gateway como clave, así una reentrega de SQS tampoco duplica el pedido. La clave es única por usuario y restaurante. Una clave inválida da `400 VALIDATION_ERROR` con `field: "Idempotency-Key"`. El cuerpo del reintento no se compara con el original: reutilizar una clave para otro pedido devuelve el pedido anterior.
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

Todas son `POST`, no llevan cuerpo (salvo `payment`), su resultado es `200` con el pedido completo (sección 1.1), y un cuerpo con campos desconocidos da `400`.

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

### 6.6 Tiempo real (WebSocket)

Conexión: `wss://<api-websocket>/<etapa>?token=<access_token>`. El navegador no puede enviar cabeceras al abrir un WebSocket, por eso el **access token** de Cognito va en `token`. Al conectar (`$connect`), la Lambda **Lectura y Configuración** valida el token igual que en REST, busca al usuario en `users` y registra la conexión en ElastiCache por restaurante y por usuario. Sin token o con token inválido la conexión se rechaza (`401`); usuario sin acceso, `403`; si ElastiCache no está disponible, `503` y la pantalla usa el polling.

Mensajes que envía el servidor (el cliente no envía nada; las acciones van por REST):

| `type` | A quién | Contenido |
|---|---|---|
| `write.result` | Solo al usuario que hizo la escritura (todas sus pantallas) | `{ requestId, status, body }`, con el mismo `status` y cuerpo de la sección 6.4 o 6.5, también si es un error |
| `order.updated` | Todo el restaurante | `{ order }`, el pedido completo. Solo si la escritura tuvo éxito |

Respaldo (RNF03): si no llega ningún mensaje durante 5 segundos con la conexión caída, el frontend muestra la hora de la última actualización y consulta `GET /api/v1/orders` cada 15 segundos hasta reconectar.

### 6.7 ElastiCache

- **Duplicados (RNF02):** antes de procesar un mensaje de la cola, la Lambda revisa si su `requestId` ya se procesó (`dedup:done:<id>`, 24 h) o si otra Lambda lo está procesando (`dedup:lock:<id>`, 30 s). Si ya se procesó, se descarta sin tocar la base; si está en proceso, vuelve a la cola. La idempotencia en la base (sección 6.4) sigue siendo la red de seguridad.
- **Caché de lectura:** `GET /api/v1/orders/{id}` se guarda 60 s con el restaurante en la clave. Las Lambdas de escritura la borran cuando el pedido cambia.
- **Sin ElastiCache el sistema sigue funcionando (RNF07):** se procesa sin la revisión de duplicados (la base los evita), se lee directo de Aurora y no hay avisos en tiempo real.

### 6.8 Delivery

Estados de la entrega, aparte del estado de cocina del pedido:

```
pending_dispatch -> on_the_way -> delivered
                          \-----> failed
```

Todas van por la cola de **Delivery**; su resultado es `200` con el pedido completo. El orden de verificación es el de la sección 6.5: rol, pedido del restaurante (`404`), regla de repartidor (`403`) y estado (`409 INVALID_DELIVERY_STATUS`).

| Acción | Ruta | Quién | Requiere | Resultado |
|---|---|---|---|---|
| Despachar | `/api/v1/orders/{id}/dispatch` | delivery, admin | pedido `ready` o `closed`, entrega `pending_dispatch` | `on_the_way` |
| Entregar | `/api/v1/orders/{id}/deliver` | delivery (asignado), admin | `on_the_way` | `delivered` |
| Marcar fallido | `/api/v1/orders/{id}/delivery-failed` | delivery (asignado), admin | `on_the_way` | `failed` |
| Asignar repartidor | `/api/v1/orders/{id}/assign` | admin | `pending_dispatch` o `on_the_way` | cambia `assignedTo` |

- Al despachar, si lo hace un repartidor, la entrega queda asignada a él; si ya estaba asignada a otro, `403`. El admin solo despacha si ya hay repartidor asignado (si no, `409`).
- `assign` recibe `{ "userId": "uuid" }`; debe ser un usuario activo con rol `delivery` del mismo restaurante (si no, `400` con `field: "userId"`).
- Las acciones sin cuerpo no aceptan campos (`400`). Cada cambio de estado queda en el historial con `field: "delivery_status"`.

### 6.9 Configuración del restaurante

| Método | Ruta | Quién | Éxito |
|---|---|---|---|
| `GET` | `/api/v1/restaurant/config` | todos | 200 |
| `PATCH` | `/api/v1/restaurant/config` | admin | 200 |

Cuerpo y respuesta: `{ "serviceMode": "dine_in" | "delivery" | "both" }` (RNF08).

- Solo cambia el restaurante del admin autenticado. Se guarda en la instancia de escritura; si falla, la configuración anterior queda intacta y el admin recibe el error.
- Al guardar, todas las pantallas del restaurante reciben por WebSocket `{ "type": "config.updated", "config": { "serviceMode": ... } }`.
- Los pedidos se validan contra la modalidad dentro de la misma transacción en que se crean.

## 7. Limitaciones conocidas del MVP

- **Sin gestión de usuarios ni restaurantes:** dar de alta empleados o restaurantes es manual (Cognito + `insert` en `users`).
- **Historial de estados sin endpoint:** cada creación, acción y pago agrega una fila a `order_status_history` (estado anterior, nuevo, usuario y fecha), en la misma transacción. La base impide modificar o borrar ese historial y los pagos. Todavía no hay endpoint para consultarlo.
- **Idempotencia solo en crear pedido:** las acciones y el pago ya son seguros ante reintentos por su verificación de estado (un reintento recibe `409 INVALID_ORDER_STATUS` u `ORDER_ALREADY_PAID`, nunca un duplicado); el frontend debe tratar esos `409` tras un reintento como "ya aplicado" y recargar el pedido.
- **Sin motivo de cancelación.**
- **Sin pagos parciales ni pasarela de pagos real.**
- **Sin filtros por fecha** en la lista de pedidos.
- **Aislamiento por backend:** la base rechaza mezclar datos de distintos restaurantes al escribir (claves foráneas compuestas), pero no protege las lecturas; eso lo hace el backend (RLS queda para más adelante).

## 8. Notas para la implementación

- Ampliar `HttpError` y `errorHandler` para llevar `code` (hoy solo devuelven `{ error: { message } }`).
- Crear pedido: leer los productos dentro de la misma transacción con `SELECT ... FOR SHARE` (o equivalente) para evitar que la disponibilidad cambie a mitad de la operación.
- `pg` devuelve los `NUMERIC` como texto; usar aritmética decimal en el servidor, nunca `float`.
- Cada rama de implementación debe probar el aislamiento (recurso ajeno da `404`) y al menos una prueba por categoría de error.
- La columna `order_items.product_name` ya está en `schema.sql` (la mini-rama `feat/order-item-product-name` quedó integrada).
