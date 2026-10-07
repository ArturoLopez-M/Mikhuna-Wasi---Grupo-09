# Mikhuna Wasi - SaaS de Gestión Gastronómica

Mikhuna Wasi es una plataforma Software as a Service (SaaS) multitenant (arquitectura multiinquilino) diseñada para centralizar y optimizar las operaciones de restaurantes.

## Alcance del Proyecto
El sistema está diseñado para soportar una carga operativa de alto rendimiento:
* **Capacidad:** +60 restaurantes afiliados.
* **Usuarios:** +900 usuarios registrados con roles específicos.
* **Concurrencia:** Soporte para picos de hasta 200 usuarios concurrentes.

## Arquitectura Cloud (AWS)
La infraestructura ha sido diseñada bajo un enfoque **100% Serverless** para garantizar escalabilidad automática, optimización de costos y tolerancia a fallos.

<img src="Diagrama AWS - Mikhuna Wasi.drawio.png" alt="Diagrama AWS" width="850">

### Contexto y Problemática del Negocio
El sector gastronómico enfrenta constantes desafíos al momento de la sincronización entre sus distintas áreas, generando cuellos de botella durante los picos de demanda. **Mikhuna Wasi** se plantea como una solución SaaS para digitalizar y unificar este flujo, eliminando la dependencia de procesos manuales y optimizando los tiempos de servicio para múltiples restaurantes de manera simultánea.

### Requerimientos No Funcionales (NFRs):
- **Disponibilidad del 99.9%**: Arquitectura distribuida Multi-AZ que garantiza un máximo de 10 minutos de inactividad mensual en horario de producción (9:00 a.m. a 1:00 a.m.).
- **Consistencia Transaccional (ACID)**: Uso de Amazon RDS PostgreSQL en configuración Primaria/En espera.
- **Seguridad**: Redes aisladas en subredes privadas (VPC) y control de acceso vía Amazon Cognito.

## Objetivos del Diseño Arquitectónico
Junto con el diagrama, se han establecido los objetivos a cumplir:

1. **Fiabilidad (Reliability):** Diseño preparado para tolerar fallos a nivel de centro de datos (estrategia Multi-AZ), asegurando que el sistema de comandas no se interrumpa en horarios críticos.
2. **Seguridad (Security):** Aislamiento estricto de la capa de persistencia de datos y segmentación de redes para proteger la información financiera y operativa de cada restaurante afiliado.
3. **Eficiencia en el Rendimiento (Performance):** Capacidad de poder adaptarse en los momentos de alto trafico de datos para evitar fallos en el sistema.


