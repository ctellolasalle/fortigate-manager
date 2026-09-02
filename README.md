# FortiGate DHCP V170 Manager

Aplicación web para gestionar **arrendamientos DHCP estáticos** (reservas MAC → IP) en la interfaz **V170** (`192.168.171.x`) del firewall FortiGate, usando la **API REST de FortiOS** con autenticación Bearer Token y login **OAuth 2.0 con Google Workspace**.

---

## Arquitectura

```
Navegador (SPA)
     │  HTTP / WebSocket
     ▼
frontend/  → Express (Node.js :3000)
     │  OAuth2 Google + Sesiones
     │  Proxy /api/* → :8000
     ▼
backend/  → FastAPI (Python :8000)
     │  Bearer Token — HTTPS verify=False
     ▼
FortiGate-200G  (192.168.99.99:8443)
     API REST FortiOS v2
```

---

## Requisitos

| Componente | Versión mínima |
|---|---|
| Node.js | >= 16.0.0 |
| Python | >= 3.10 |
| pip | >= 23.0 |

No se requiere acceso SSH al FortiGate — se usa exclusivamente la **API REST** con token.

---

## Instalación

### 1. Clonar el repositorio

```bash
git clone https://github.com/ctellolasalle/fortigate-manager
cd fortigate-manager
```

### 2. Configurar backend Python

En sistemas modernos (Ubuntu 24.04 / Debian 12) es obligatorio usar entornos virtuales:

```bash
# Crear entorno virtual
python3 -m venv .venv
source .venv/bin/activate

# Instalar dependencias
pip install -r backend/requirements.txt
```

### 3. Instalar dependencias del frontend Node.js

```bash
cd frontend && npm install
```

O desde la raíz con el script incluido:

```bash
npm run install:frontend
```

### 4. Configurar el backend

Editar `backend/.env`:

```env
# API REST del FortiGate
FGT_HOST=192.168.99.99
FGT_PORT=8443
FGT_TOKEN=tu_token_api_aqui

# DHCP — Interfaz V170
DHCP_SERVER_ID=24
V170_START_IP=192.168.171.1
V170_END_IP=192.168.171.254
```

> El token se genera en FortiGate: **System → Administrators → crear usuario API** con permisos de lectura/escritura sobre DHCP.

### 5. Configurar el frontend

Copiar la plantilla y editar `frontend/.env`:

```bash
cp frontend/.env.example frontend/.env
```

```env
# Servidor
PORT=3000
HOST=localhost
NODE_ENV=development

# Google OAuth 2.0 — console.cloud.google.com
GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxx
GOOGLE_CALLBACK_URL=http://localhost:3000/auth/google/callback
GOOGLE_WORKSPACE_DOMAIN=lasalle.edu.ar

# Sesiones (genera con: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
SESSION_SECRET=clave-aleatoria-minimo-32-caracteres

# Usuarios autorizados (separados por coma, sin espacios)
AUTHORIZED_EMAILS=usuario@dominio.com,otro@dominio.com

# Admins (subconjunto de AUTHORIZED_EMAILS)
ADMIN_EMAILS=admin@dominio.com

# URL del backend Python
PYTHON_API_URL=http://127.0.0.1:8000
```

---

## Uso

### Iniciar ambos servicios (recomendado)

Desde la **raíz del proyecto**:

```bash
# Producción
npm start

# Desarrollo con auto-reinicio
npm run dev
```

### Iniciar por separado

```bash
# Solo backend Python (FastAPI en :8000)
npm run backend

# Solo frontend Node.js (Express en :3000)
npm run frontend
```

### Desde la carpeta frontend

```bash
cd frontend

npm run dev      # ambos servicios
npm run web      # solo Node.js
npm run backend  # solo Python
npm run server   # solo server.js sin verificaciones
```

La aplicación estará disponible en `http://localhost:3000`

---

## Despliegue en Contenedor LXC (Proxmox)

Para una instalación rápida y automatizada en un contenedor LXC (Ubuntu 22.04/24.04 o Debian 11/12) en Proxmox:

### 1. Preparar el contenedor
1. Crea un contenedor LXC (plantilla Ubuntu o Debian recomendada).
2. Transfiere esta carpeta completa del proyecto al contenedor (ej. `/opt/fortigate-manager`).

### 2. Ejecutar instalador
Navega a la carpeta del proyecto y ejecuta el script con `sudo`:

```bash
cd /opt/fortigate-manager
chmod +x scripts/install.sh
sudo ./scripts/install.sh
```

**El script automáticamente:**
- Instala Node.js LTS, Python 3.10+ y `pip3`.
- Instala todas las dependencias (`npm install` y `pip install`).
- Crea las plantillas de `backend/.env` y `frontend/.env` (generando una clave segura para sesiones).
- Crea **dos servicios systemd** (`fortigate-manager-api` y `fortigate-manager-web`) para arranque automático en el boot.

### 3. Configurar credenciales y reiniciar
El instalador creará archivos `.env` genéricos. Debes editarlos antes de iniciar:

1. Editar credenciales FortiGate:
   ```bash
   nano backend/.env
   ```
2. Editar credenciales Google OAuth:
   ```bash
   nano frontend/.env
   ```
3. Iniciar los servicios:
   ```bash
   systemctl start fortigate-manager-api fortigate-manager-web
   ```
4. Ver logs si hay algún problema:
   ```bash
   journalctl -u fortigate-manager-api -u fortigate-manager-web -f
   ```

---

## Funcionalidades

### Gestión de arrendamientos DHCP (V170)

- **Listar reservas**: Tabla completa con búsqueda por MAC, IP o descripción
- **Crear reserva**: Asignar IP fija a una MAC con descripción (nombre del equipo)
- **Editar reserva**: Modificar IP o descripción de una reserva existente
- **Eliminar reserva**: Con confirmación antes de aplicar el cambio en el FortiGate
- **IPs disponibles**: Vista de las primeras IPs libres del pool con acción rápida de reserva
- **Exportar CSV**: Descargar la lista completa de reservas
- **Auto-refresh**: Los datos se actualizan automáticamente cada 60 segundos
- **Auto-formato MAC**: Los campos MAC se normalizan automáticamente a `XX:XX:XX:XX:XX:XX`

### Dashboard

- **Estado del dispositivo**: Modelo, firmware y hostname del FortiGate en tiempo real
- **Estadísticas del pool**: Total, reservadas con IP, solo MAC registrada, disponibles
- **Barra de utilización**: Porcentaje de uso del pool V170
- **Últimas reservas**: Vista rápida de las reservas recientes

### Autenticación

- **OAuth 2.0 con Google Workspace**: Login seguro sin gestionar contraseñas propias
- **Lista de emails autorizados**: Configurable desde `.env` sin tocar código
- **Sesiones persistentes**: 24 horas de duración, renovadas con cada request
- **Restricción de dominio**: Opcional, via `GOOGLE_WORKSPACE_DOMAIN`

---

## Estructura del Proyecto

```
fortigate-manager/
├── package.json              # Orquestador raíz (npm start / npm run dev)
│
├── backend/                  # API Python (FastAPI)
│   ├── main.py               # Endpoints DHCP → FortiGate REST API
│   ├── requirements.txt      # fastapi, uvicorn, httpx, python-dotenv
│   └── .env                  # Token FortiGate + config DHCP ⚠️ no commitear
│
├── frontend/                 # Servidor Node.js + SPA
│   ├── server.js             # Express: OAuth2, sesiones, proxy /api/*
│   ├── start.js              # Verificaciones de entorno + arranque
│   ├── package.json          # Dependencias Node.js
│   ├── .env                  # OAuth Google + usuarios ⚠️ no commitear
│   ├── .env.example          # Plantilla de configuración
│   ├── lib/
│   │   └── auth.js           # Passport + GoogleStrategy + middleware auth
│   ├── routes/
│   │   └── auth.js           # Rutas /auth/google, /callback, /logout, /status
│   └── public/
│       ├── index.html        # SPA — estructura HTML
│       ├── app.js            # Lógica CRUD, búsqueda, sort, modales
│       └── styles.css        # Diseño dark premium (Inter + JetBrains Mono)
│
├── scripts/
│   ├── install.sh            # Instalador automatizado para LXC
│   └── fortigate-manager.service  # Unit systemd
│
└── forti_fuck/               # Scripts Python de referencia (legado)
    ├── backup_fortigate.py   # Backup de config via API REST
    ├── fortigate_importer.py # Importador de MACs desde Excel (SSH/netmiko)
    └── reserved-els-wifi.py  # Sincronizador de reservas DHCP (SSH/netmiko)
```

---

## API Endpoints

Todos los endpoints `/api/*` requieren sesión autenticada (verificado por el proxy de Express).

### Sistema

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/health` | Estado del backend Python |
| `GET` | `/api/system/status` | Modelo, firmware, hostname del FortiGate |

### DHCP V170

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/dhcp/reservations` | Lista todas las reservas |
| `GET` | `/api/dhcp/reservations?search=X` | Filtra por MAC, IP o descripción |
| `POST` | `/api/dhcp/reservations` | Crear nueva reserva |
| `PUT` | `/api/dhcp/reservations/{id}` | Editar IP o descripción |
| `DELETE` | `/api/dhcp/reservations/{id}` | Eliminar reserva |
| `GET` | `/api/dhcp/available-ips?limit=50` | IPs libres en el pool V170 |
| `GET` | `/api/dhcp/stats` | Estadísticas del pool |

**Crear reserva — body:**
```json
{
  "mac": "AA:BB:CC:DD:EE:FF",
  "ip": "192.168.171.10",
  "description": "PC-SALA3-01"
}
```

**Editar reserva — body:**
```json
{
  "ip": "192.168.171.20",
  "description": "LAPTOP-JUAN"
}
```

### Autenticación (Express)

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/auth/google` | Iniciar flujo OAuth2 |
| `GET` | `/auth/google/callback` | Callback de Google |
| `POST` | `/auth/logout` | Cerrar sesión |
| `GET` | `/auth/status` | Estado de la sesión actual |

---

## Seguridad

- **Helmet.js**: Headers HTTP de seguridad (CSP, HSTS, etc.)
- **Rate limiting**: Límite de requests por IP en rutas de autenticación
- **Sesiones HttpOnly**: Cookie segura, no accesible desde JavaScript
- **Proxy autenticado**: Ningún endpoint `/api/*` es accesible sin sesión activa
- **SSL deshabilitado solo para FortiGate**: El certificado auto-firmado del FortiGate es esperado; la conexión es interna de red
- **Credenciales en `.env`**: Nunca hardcodeadas en el código fuente
- **AUTHORIZED_EMAILS en `.env`**: Lista de acceso gestionable sin modificar código

---

## Agregar o quitar usuarios autorizados

Solo editar `frontend/.env`, sin tocar código:

```env
# Agregar nuevo usuario: añadir al final separado por coma
AUTHORIZED_EMAILS=ctello@lasalle.edu.ar,...,nuevo@lasalle.edu.ar

# Para dar permisos de admin:
ADMIN_EMAILS=ctello@lasalle.edu.ar,nuevo@lasalle.edu.ar
```

Reiniciar el servidor frontend para que tome efecto.

---

## Troubleshooting

### Backend Python no disponible

```
❌ El servicio de API no está disponible. ¿Está corriendo el backend Python?
```

**Solución:** Iniciar uvicorn manualmente:
```bash
npm run backend
# o directamente:
uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

### Error de token FortiGate (401)

```
Error: Token de API inválido o expirado
```

**Solución:** Verificar `FGT_TOKEN` en `backend/.env`. Regenerar el token en FortiGate: **System → Administrators → [usuario API] → Regenerate**.

### DHCP Server ID incorrecto (404)

```
Error: DHCP Server ID 24 no encontrado
```

**Solución:** Verificar el ID correcto en FortiGate: **Network → DHCP Server** — el ID se muestra en la URL al editar el servidor.

### Error de OAuth — acceso denegado

```
Acceso denegado. Solo usuarios autorizados pueden acceder.
```

**Solución:** Verificar que el email de la cuenta Google esté en `AUTHORIZED_EMAILS` del `frontend/.env`.

### Variables de entorno faltantes

```
❌ Error: Variables de entorno faltantes: GOOGLE_CLIENT_ID
```

**Solución:** Revisar `frontend/.env`. Generar credenciales OAuth en [Google Cloud Console](https://console.cloud.google.com/apis/credentials).

---

## Tecnologías

| Capa | Tecnología |
|---|---|
| Backend API | Python 3.10+, FastAPI, uvicorn, httpx |
| Frontend servidor | Node.js, Express.js, Passport.js, Socket.io |
| Frontend cliente | HTML5, CSS3 vanilla, JavaScript vanilla (SPA) |
| Autenticación | OAuth 2.0 — passport-google-oauth20 |
| Comunicación FortiGate | FortiOS REST API v2, Bearer Token |
| Tipografía | Inter, JetBrains Mono (Google Fonts) |

---

## Licencia

MIT

## Soporte

Para reportar bugs o solicitar funcionalidades:
- Crear un issue en el repositorio
- Incluir logs del servidor y del backend Python
- Especificar versiones de Node.js y Python
