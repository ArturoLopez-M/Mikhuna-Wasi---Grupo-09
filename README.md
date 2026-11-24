# Mikhuna Wasi

SaaS multi-restaurante (modelo *Pool*) para centralizar pedidos, cocina, pagos y delivery. El diseño completo está en el *Informe de Primera Unidad* (arquitectura AWS, 12 requisitos no funcionales) y en [`Docs/`](Docs/README.md).

| Documento | Contenido |
|---|---|
| [`Docs/README.md`](Docs/README.md) | Objetivo, alcance del MVP y servicios AWS previstos |
| [`Docs/api-contract.md`](Docs/api-contract.md) | Contrato de la API REST (fuente de verdad para backend y frontend) |
| [`backend/db/README.md`](backend/db/README.md) | Modelo de datos y base local con Docker |
| `Docs/Diagrama AWS.png` | Diagrama de arquitectura |

## Estructura

```
backend/     Lambdas en Node.js + TypeScript (una por módulo del diagrama)
  db/        schema.sql y seed.sql de PostgreSQL
  src/
    lambdas/ lectura-config (REST), pedidos, cocina, pagos (consumidores SQS)
    core/    despacho de rutas, identidad, adaptadores REST y SQS
    modules/ lógica de negocio por módulo (src/modules/<nombre>/)
  scripts/   build.mjs: empaqueta cada Lambda en dist/<nombre>/index.js
  tests/     pruebas con Vitest (sin base real ni AWS)
terraform/   infraestructura de dev (S3, Lambda de salud, API Gateway HTTP)
.github/     workflows de GitHub Actions
Docs/        documentación funcional y contrato de API
```

## Levantar el backend en local

Requisitos: Node.js 22 o superior, npm y Docker Desktop (para PostgreSQL).

El backend son Lambdas, no un servidor: en local se ejecutan las pruebas, que invocan los handlers con eventos de API Gateway y mensajes de SQS simulados.

```powershell
cd backend
npm ci
```

Las variables de entorno de las Lambdas están documentadas en [`backend/.env.example`](backend/.env.example).

Base de datos (detalle en [`backend/db/README.md`](backend/db/README.md)):

```powershell
docker run --name mikhuna-db -e POSTGRES_PASSWORD=dev_password -e POSTGRES_DB=mikhuna -p 5432:5432 -d postgres:16
docker cp db/schema.sql mikhuna-db:/tmp/schema.sql
docker cp db/seed.sql mikhuna-db:/tmp/seed.sql
docker exec mikhuna-db psql -U postgres -d mikhuna -v ON_ERROR_STOP=1 -f /tmp/schema.sql
docker exec mikhuna-db psql -U postgres -d mikhuna -v ON_ERROR_STOP=1 -f /tmp/seed.sql
```

Pruebas y empaquetado:

```powershell
npm test         # pruebas (no necesitan la base)
npm run build    # verifica tipos y genera dist/<lambda>/index.js
```

> **Autenticación:** el token de Cognito lo valida el autorizador de API Gateway; cada Lambda busca al usuario por el `sub` del token en la tabla `users`. Las pruebas simulan usuarios con `tests/helpers/auth.ts` y emulan API Gateway con `tests/helpers/api.ts`.

## Infraestructura (Terraform)

`terraform/` despliega un entorno de **prueba** en `us-east-2`: bucket S3 del frontend, una Lambda `GET /health` detrás de API Gateway HTTP y su log group cifrado con KMS. El estado remoto está en S3 (`backend.tf`).

- El workflow `terraform.yml` hace `plan`, `apply` y luego `destroy` en cada push a `development`. Es intencional para el entorno académico: valida que la infraestructura se crea correctamente y la elimina para no generar costos. En un despliegue real se debe quitar el paso `destroy`.
- Requiere las variables de entorno `AWS_ROLE_ARN` y `AWS_REGION` en el environment `dev` de GitHub (OIDC).

## Estado de implementación

Comparación del repositorio con el informe de diseño. Leyenda: ✅ implementado · 🟡 parcial · ❌ ausente.

| Requisito / componente | Estado | Dónde |
|---|---|---|
| Pedidos: crear, listar, ver, preparar, listo, cancelar, pagar | ✅ | `backend/src/modules/orders/` |
| Aislamiento por restaurante en cada consulta (RNF05) | ✅ | `repository.ts`, `service.ts`, claves foráneas compuestas en `schema.sql` |
| Autorización por rol (RNF05) | ✅ | `middleware/requireRole.ts` |
| Autenticación con Cognito (RNF05) | 🟡 | `core/identity.ts`; el autorizador y el User Pool no están en Terraform |
| Registro de accesos rechazados (RNF05) | 🟡 | `core/dispatch.ts` (log JSON); falta alarma CloudWatch/SNS |
| Idempotencia y duplicados (RNF01/RNF02) | ✅ | `Idempotency-Key` o `requestId` en la base; revisión en ElastiCache en `core/queue.ts` |
| Historial auditable de pedidos y pagos (RNF12) | 🟡 | `order_status_history` + triggers de solo agregar; sin endpoint ni retención de 12 meses automatizada |
| Productos, `/me`, configuración por restaurante (RNF08) | ❌ | descritos en el contrato o el informe, sin código |
| Delivery y rol repartidor | ❌ | sin código ni esquema |
| Lambda por módulo con SQS + DLQ (RNF01/RNF07) | 🟡 | `src/lambdas/` (4 de 5; Delivery pendiente); colas y DLQ no están en Terraform |
| WebSocket y avisos en tiempo real (RNF02/RNF03) | 🟡 | `core/websocket.ts`, `core/realtime.ts`; el polling de respaldo va en el frontend |
| Aurora Serverless v2 multi-AZ, RDS Proxy, VPC (RNF04/RNF06) | ❌ | Terraform no los define |
| ElastiCache (duplicados, conexiones, caché de lectura) | 🟡 | `core/cache.ts`; el clúster no está en Terraform |
| WAF, CloudFront, Route 53 | ❌ | |
| AWS Backup diario/semanal/PITR (RNF11) | ❌ | |
| Alarmas CloudWatch + SNS (RNF10) | ❌ | solo existe un log group |
| Frontend web adaptable (RNF09) | ❌ | S3 contiene un `index.html` de prueba |
