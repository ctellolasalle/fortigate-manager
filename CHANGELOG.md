# Changelog

Todas las modificaciones notables realizadas en el proyecto serán documentadas en este archivo.

El formato se basa en [Keep a Changelog](https://keepachangelog.com/es-ES/1.0.0/).

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
