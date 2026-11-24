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
backend/     API REST en Node.js + Express + TypeScript (módulo de pedidos)
  db/        schema.sql y seed.sql de PostgreSQL
  src/       app, middlewares, módulos (src/modules/<nombre>/)
  tests/     pruebas con Vitest + Supertest (sin base real)
terraform/   infraestructura de dev (S3, Lambda de salud, API Gateway HTTP)
.github/     workflows de GitHub Actions
Docs/        documentación funcional y contrato de API
```

## Levantar el backend en local

Requisitos: Node.js 22 o superior, npm y Docker Desktop (para PostgreSQL).

```powershell
cd backend
npm ci
Copy-Item .env.example .env
```

Base de datos (detalle en [`backend/db/README.md`](backend/db/README.md)):

```powershell
docker run --name mikhuna-db -e POSTGRES_PASSWORD=dev_password -e POSTGRES_DB=mikhuna -p 5432:5432 -d postgres:16
docker cp db/schema.sql mikhuna-db:/tmp/schema.sql
docker cp db/seed.sql mikhuna-db:/tmp/seed.sql
docker exec mikhuna-db psql -U postgres -d mikhuna -v ON_ERROR_STOP=1 -f /tmp/schema.sql
docker exec mikhuna-db psql -U postgres -d mikhuna -v ON_ERROR_STOP=1 -f /tmp/seed.sql
```

Servidor y pruebas:

```powershell
npm run dev      # http://localhost:3000/health
npm test         # pruebas (no necesitan la base)
npm run build    # compila a dist/
```

> **Autenticación:** el backend verifica el access token de Cognito si en `.env` se definen `COGNITO_USER_POOL_ID` y `COGNITO_CLIENT_ID`. Sin ellas, todo `/api/v1/*` responde `401` por diseño (falla cerrado) y solo `/health` es accesible. Las pruebas simulan usuarios con `tests/helpers/auth.ts`.

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
| Autenticación con Cognito (RNF05) | 🟡 | `middleware/authenticate.ts`, `auth/cognito.ts`; el User Pool no está en Terraform |
| Registro de accesos rechazados (RNF05) | 🟡 | `middleware/errorHandler.ts` (log JSON); falta alarma CloudWatch/SNS |
| Idempotencia de escrituras (RNF01/RNF02) | 🟡 | `Idempotency-Key` en `POST /orders`; ElastiCache no implementado |
| Historial auditable de pedidos y pagos (RNF12) | 🟡 | `order_status_history` + triggers de solo agregar; sin endpoint ni retención de 12 meses automatizada |
| Productos, `/me`, configuración por restaurante (RNF08) | ❌ | descritos en el contrato o el informe, sin código |
| Delivery y rol repartidor | ❌ | sin código ni esquema |
| Cola SQS + DLQ por módulo, Lambda por módulo (RNF01/RNF07) | ❌ | el backend es un único Express síncrono |
| WebSocket y polling de respaldo (RNF02/RNF03) | ❌ | |
| Aurora Serverless v2 multi-AZ, RDS Proxy, VPC (RNF04/RNF06) | ❌ | Terraform no los define |
| ElastiCache, WAF, CloudFront, Route 53 | ❌ | |
| AWS Backup diario/semanal/PITR (RNF11) | ❌ | |
| Alarmas CloudWatch + SNS (RNF10) | ❌ | solo existe un log group |
| Frontend web adaptable (RNF09) | ❌ | S3 contiene un `index.html` de prueba |
