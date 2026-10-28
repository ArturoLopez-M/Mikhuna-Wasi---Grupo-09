# Mikhuna Wasi

Sistema web SaaS para la gestión de operaciones de restaurantes. Permite centralizar la administración de productos, pedidos, preparación y pagos en una plataforma accesible desde un navegador web.

La solución está orientada a múltiples restaurantes que utilizan una misma plataforma, manteniendo aislada la información correspondiente a cada establecimiento.

## Objetivo del proyecto

Desarrollar un sistema web que permita digitalizar el flujo de atención de un restaurante, desde el registro de un pedido hasta su preparación y pago, facilitando el control de las operaciones y reduciendo la dependencia de procesos manuales.

## Arquitectura del sistema

La arquitectura propuesta utiliza servicios de Amazon Web Services (AWS) para alojar la interfaz web, procesar las solicitudes, gestionar la autenticación y almacenar la información del sistema.

## Alcance del MVP

El Producto Mínimo Viable (MVP) comprende las funcionalidades esenciales para disponer de una primera versión funcional y desplegable del sistema.

### Funcionalidades principales

- **Autenticación:** inicio de sesión de los usuarios.
- **Gestión de productos:** registro, consulta y actualización de productos.
- **Gestión de pedidos:** registro y consulta de pedidos realizados por los meseros.
- **Gestión de cocina:** visualización de pedidos y actualización de su estado de preparación.
- **Gestión de pagos:** registro de pagos y cierre de pedidos.
- **Control de acceso:** acceso a las funciones según el rol del usuario.
- **Aislamiento de restaurantes:** separación de los datos de cada restaurante para evitar accesos no autorizados.
- **Interfaz web adaptable:** acceso desde computadoras, tabletas y celulares mediante un navegador.

### Flujo principal

1. El usuario inicia sesión.
2. El mesero consulta los productos y registra un pedido.
3. Cocina visualiza el pedido y actualiza su estado de preparación.
4. Caja registra el pago y cierra el pedido.
5. El sistema conserva la información de las operaciones realizadas.

### Funcionalidades fuera del alcance inicial

Para mantener reducido el alcance del MVP, no se contempla inicialmente:

- Aplicación móvil nativa para Android o iOS.
- Seguimiento GPS de repartidores.
- Integración con plataformas externas de delivery.
- Pasarelas de pago en línea.
- Analítica avanzada y predicciones.
- Gestión avanzada de proveedores e inventarios.

Estas funcionalidades podrán evaluarse en futuras versiones.

## Tecnologías y servicios AWS

La solución está prevista para desplegarse en Amazon Web Services (AWS), utilizando los siguientes servicios:

| Servicio | Función |
|---|---|
| Amazon S3 | Alojamiento de los archivos del frontend web. |
| Amazon CloudFront | Distribución del frontend mediante HTTPS. |
| Amazon API Gateway | Exposición de los endpoints de la API. |
| AWS Lambda | Ejecución de la lógica de negocio. |
| Amazon Cognito | Autenticación de usuarios. |
| Amazon Aurora PostgreSQL Serverless v2 | Almacenamiento persistente de los datos. |
| Amazon CloudWatch | Registro y supervisión de la ejecución. |

La configuración definitiva de estos servicios se realizará de acuerdo con los requisitos de integración, seguridad y despliegue.

## Modelo de datos

La base de datos utilizará PostgreSQL mediante Amazon Aurora PostgreSQL Serverless v2.

El modelo inicial contempla las siguientes entidades:

- **Restaurantes:** información básica de los establecimientos registrados.
- **Usuarios:** información de los usuarios del sistema.
- **Usuario-restaurante:** relación entre usuarios y restaurantes.
- **Productos:** productos disponibles en cada restaurante.
- **Pedidos:** información general de los pedidos.
- **Detalle de pedido:** productos, cantidades y precios correspondientes a cada pedido.
- **Pagos:** información de los pagos registrados.
- **Historial de operaciones:** registro de las operaciones relevantes del sistema.

El modelo definitivo incluirá las relaciones, restricciones y validaciones necesarias para mantener la integridad de los datos y el aislamiento entre restaurantes.

## Seguridad y control de acceso

El sistema contempla los siguientes principios:

- Autenticación de usuarios mediante Amazon Cognito.
- Autorización de operaciones según el rol del usuario.
- Validación de permisos en el backend.
- Aislamiento de la información de cada restaurante.
- Protección de credenciales y variables de configuración.
- Conservación del historial de las operaciones relevantes.

El aislamiento entre restaurantes deberá aplicarse en el backend y en las consultas a la base de datos, no únicamente en la interfaz web.

## Despliegue

El despliegue está previsto en AWS y contempla los siguientes pasos generales:

1. Publicar el frontend web en Amazon S3.
2. Configurar Amazon CloudFront para distribuir la interfaz.
3. Configurar las rutas HTTP en Amazon API Gateway.
4. Desplegar la lógica de negocio en AWS Lambda.
5. Configurar la autenticación mediante Amazon Cognito.
6. Conectar el backend con Amazon Aurora PostgreSQL Serverless v2.
7. Consultar los registros y errores mediante Amazon CloudWatch.

La configuración de red, permisos y conectividad se realizará según los requisitos de cada servicio.

Los procedimientos detallados de configuración y despliegue se documentarán conforme avance la implementación.