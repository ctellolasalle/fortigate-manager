# Changelog

Todas las modificaciones notables realizadas en el proyecto serán documentadas en este archivo.

El formato se basa en [Keep a Changelog](https://keepachangelog.com/es-ES/1.0.0/).

---

## [2.2.0] - 2026-09-30

### 🖨️ Nueva Característica: Control de Acceso a Impresoras (Firewall Policies & Address Groups)
- **Gestión por MAC Address:** Se permite registrar y administrar dispositivos (VLAN 160 y 170) para controlar su acceso a las impresoras de las distintas redes del colegio mediante reglas del firewall.
- **Integración con Address Groups en FortiOS:**
  - **Inicial (VLAN 210):** Policy ID 55 (`ACC_PRINTER_INI`) vía Address Group `CLIENT_PRINT_INI`.
  - **Primaria (VLAN 220):** Policy ID 54 (`ACC_PRINTER_PRI`) vía Address Group `CLIENT_PRINT_PRI`.
  - **Secundaria (VLAN 230):** Policy ID 53 (`ACC_PRINTER_SEC`) vía Address Group `CLIENT_PRINT_SEC`.
- **Backend FastAPI:**
  - `GET /printers/permissions`: Consulta miembros de los 3 grupos en FortiOS y construye la tabla unificada con cruce de datos DHCP (IP y descripción).
  - `POST /printers/permissions`: Crea el Address Object de tipo MAC (`MAC_AABBCCDDEEFF`) y sincroniza de forma atómica y sin duplicados su presencia en cada grupo seleccionado.
  - `DELETE /printers/permissions/{mac}`: Revoca todos los accesos del dispositivo y remueve el objeto del firewall.
  - Auditoría integrada con eventos `PRINTER_PERM` y `PRINTER_REVOKE`.
- **Frontend SPA:**
  - Nueva pestaña en la barra lateral: 🖨️ **Impresoras**.
  - Tarjetas de estado con cantidad de dispositivos autorizados por cada nivel.
  - Tabla dinámica con búsqueda instantánea, badges de estado por VLAN, modal de asignación con switches por nivel y auto-formato de dirección MAC.
  - **Buscador y Selector de Dispositivos Existentes:** En el modal de asignación se agregó un buscador interactivo con auto-completado que consulta tanto los arrendamientos DHCP (VLAN 170) como los objetos address existentes en el firewall, permitiendo seleccionar con 1 clic la MAC y descripción sin tipeo manual.
  - **Soporte de Objetos Multi-MAC:** En objetos de firewall creados con múltiples direcciones MAC, el backend desglosa e indexa cada una de las MACs asociadas individualmente para búsqueda, asignación y auditoría consistente.
  - **Modal Responsive con Footer Fijo:** Se reestructuró el layout del modal mediante Flexbox (`flex-direction: column; overflow: hidden`) asegurando que el botón *"Guardar Accesos"* permanezca siempre visible en pantalla sin necesidad de escrolear, delegando el scroll interno al cuerpo del formulario (`.modal-body`).
  - **Salida Mejorada en Auditoría:** Desglose visual de accesos autorizados (`Inicial: Sí | Primaria: No...`) y etiquetas detalladas en la columna de Recurso y Detalle para operaciones sobre impresoras (`PRINTER_PERM` y `PRINTER_REVOKE`).

---

## [2.1.0] - 2026-09-30

### 🚀 Novedades y Correcciones Principales

#### 1. Arreglo en Creación Directa de Reglas DHCP con "Assign IP" (Error CLI -8)
- **Causa:** Al crear una regla directamente con acción `Assign IP`, FortiOS recibía un `PUT` masivo sobre el servidor DHCP (`/api/v2/cmdb/system.dhcp/server/{id}`) en el cual la entrada sin IP era autocompletada por FortiOS con `ip: "0.0.0.0"`, disparando el error CLI:
  `IP address can not be 0 - node_check_object fail! for ip 0.0.0.0 (Return code -8)`.
- **Solución:** Se adaptó el endpoint `create_reservation` en [`backend/main.py`](backend/main.py) para que envíe las nuevas reglas mediante `POST` atómico directo a la subtabla `/system.dhcp/server/{id}/reserved-address`. De esta manera, FortiOS acepta la entrada dinámica de asignación por MAC sin requerir ni validar el campo `ip`.

#### 2. Normalización de IP en Bajas del Módulo de Auditoría
- **Causa:** Al eliminar una regla dinámica (`Assign IP`), FortiOS devolvía su valor interno `0.0.0.0` y el sistema de auditoría lo registraba literalmente en la columna de Recurso IP.
- **Solución:** Se implementó en el endpoint `delete_reservation` de [`backend/main.py`](backend/main.py) la sanitización para que cualquier IP vacía, con valor `0.0.0.0` o con acción `assign` se registre uniformemente como `Dinámica (Pool)`.
- **Eliminación atómica:** Se incorporó `DELETE` directo al endpoint de la subtabla `/reserved-address/{entry_id}`.

#### 3. Auditoría de Seguridad Automatizada y Mitigaciones
- **Frontend (Node.js):**
  - Se ejecutó `npm audit` y remediación vía `npm audit fix`.
  - Se actualizaron dependencias vulnerables transitivas (`brace-expansion` [High DoS], `engine.io` [High DoS], `qs` [Moderate DoS/bypass], `body-parser`, `express`).
  - Resultado: **0 vulnerabilidades** en el árbol de dependencias (`package-lock.json`).
- **Backend (Python):**
  - Escaneo con `pip-audit`: **0 vulnerabilidades conocidas** en dependencias de producción (`fastapi`, `uvicorn`, `httpx`, `python-dotenv`).
  - Escaneo con `Bandit` (SAST):
    - Se resolvió **B110** en [`backend/audit.py`](backend/audit.py) acotando el manejo de excepciones al decodificar JSON a `(json.JSONDecodeError, TypeError)` y preservando los datos originales.
    - Se parametrizó la verificación SSL (`FGT_VERIFY_SSL`) en [`backend/main.py`](backend/main.py) permitiendo configuración estricta mediante variables de entorno para resolver **B501**.
    - Se auditó y blindó la consulta SQL de auditoría con parámetros `?` seguros contra inyecciones SQL (**B608**).

#### 4. Documentación y Soporte de Despliegue en Linux
- **Permisos de entorno virtual:** Se diagnosticó y resolvió el error de systemd `status=203/EXEC` en `fortigate-manager-api.service` causado por rutas heredadas a directorios de root, estableciendo la recreación del `.venv` en `/opt/fortigate-manager` con propiedad para el usuario `www-data`.
- **Configuración de Git:** Resolución de advertencia de seguridad `dubious ownership` configurando `safe.directory`.
- **Merge a producción:** Merge exitoso de la rama `dev` a `main` y sincronización con GitHub.
