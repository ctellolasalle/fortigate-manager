#!/usr/bin/env bash
# =============================================================================
#  install.sh — FortiGate DHCP V170 Manager
#  Instalador automatizado para Ubuntu 22.04 / 24.04 / Debian 11 / 12 (LXC)
#  Uso: sudo bash scripts/install.sh
# =============================================================================

set -euo pipefail

# ─── Colores ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

ok()   { echo -e "${GREEN}✔ $*${RESET}"; }
info() { echo -e "${CYAN}▸ $*${RESET}"; }
warn() { echo -e "${YELLOW}⚠ $*${RESET}"; }
err()  { echo -e "${RED}✘ $*${RESET}"; exit 1; }
hdr()  { echo -e "\n${BOLD}${CYAN}══ $* ══${RESET}\n"; }

# ─── Variables ────────────────────────────────────────────────────────────────
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_USER="${SUDO_USER:-www-data}"
NODE_REQUIRED="18"
PYTHON_REQUIRED="3.10"
SERVICE_NAME="fortigate-manager"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
FRONTEND_ENV="${APP_DIR}/frontend/.env"
BACKEND_ENV="${APP_DIR}/backend/.env"

# ─── Root check ───────────────────────────────────────────────────────────────
[[ $EUID -ne 0 ]] && err "Ejecuta este script con sudo: sudo bash scripts/install.sh"

hdr "FortiGate DHCP V170 Manager — Instalador"
info "Directorio del proyecto: ${APP_DIR}"
info "Usuario de servicio: ${SERVICE_USER}"

# ─── 1. Actualizar sistema ────────────────────────────────────────────────────
hdr "1. Actualizando sistema"
apt-get update -qq
apt-get install -y -qq curl wget git ca-certificates gnupg lsb-release software-properties-common
ok "Sistema actualizado"

# ─── 2. Instalar Python 3.10+ ────────────────────────────────────────────────
hdr "2. Instalando Python"
PYTHON_VERSION=$(python3 --version 2>/dev/null | awk '{print $2}' || echo "0")
PYTHON_MAJOR=$(echo "$PYTHON_VERSION" | cut -d. -f1)
PYTHON_MINOR=$(echo "$PYTHON_VERSION" | cut -d. -f2)

if [[ "$PYTHON_MAJOR" -ge 3 && "$PYTHON_MINOR" -ge 10 ]]; then
    ok "Python $PYTHON_VERSION ya instalado"
else
    info "Instalando Python 3.11..."
    add-apt-repository -y ppa:deadsnakes/ppa 2>/dev/null || true
    apt-get update -qq
    apt-get install -y -qq python3.11 python3.11-venv python3.11-dev python3-pip
    update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.11 1
    ok "Python 3.11 instalado"
fi

# Instalar pip si falta
if ! command -v pip3 &>/dev/null; then
    apt-get install -y -qq python3-pip
fi
ok "pip disponible: $(pip3 --version | awk '{print $2}')"

# ─── 3. Instalar Node.js LTS ──────────────────────────────────────────────────
hdr "3. Instalando Node.js"
NODE_CURRENT=$(node --version 2>/dev/null | tr -d 'v' | cut -d. -f1 || echo "0")

if [[ "$NODE_CURRENT" -ge "$NODE_REQUIRED" ]]; then
    ok "Node.js $(node --version) ya instalado"
else
    info "Instalando Node.js LTS via NodeSource..."
    curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - 2>/dev/null
    apt-get install -y -qq nodejs
    ok "Node.js $(node --version) instalado"
fi

# ─── 4. Dependencias Python (backend) ────────────────────────────────────────
hdr "4. Instalando dependencias Python"
pip3 install -q -r "${APP_DIR}/backend/requirements.txt"
ok "Dependencias Python instaladas"

# ─── 5. Dependencias Node.js (frontend) ──────────────────────────────────────
hdr "5. Instalando dependencias Node.js"
cd "${APP_DIR}/frontend"
npm install --omit=dev --silent
ok "Dependencias Node.js instaladas"
cd "${APP_DIR}"

# ─── 6. Configurar backend/.env ───────────────────────────────────────────────
hdr "6. Configurando backend"
if [[ ! -f "$BACKEND_ENV" ]]; then
    cat > "$BACKEND_ENV" <<EOF
# FortiGate REST API
FGT_HOST=192.168.99.99
FGT_PORT=8443
FGT_TOKEN=INGRESA_TU_TOKEN_API_AQUI

# DHCP — Interfaz V170
DHCP_SERVER_ID=24
V170_START_IP=192.168.171.1
V170_END_IP=192.168.171.254
EOF
    warn "Archivo backend/.env creado con valores de ejemplo."
    warn "Edita ${BACKEND_ENV} con tu token real del FortiGate antes de iniciar."
else
    ok "backend/.env ya existe, no se sobreescribe"
fi

# ─── 7. Configurar frontend/.env ─────────────────────────────────────────────
hdr "7. Configurando frontend"
if [[ ! -f "$FRONTEND_ENV" ]]; then
    # Generar SESSION_SECRET aleatorio
    SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

    cat > "$FRONTEND_ENV" <<EOF
# Servidor
PORT=3000
HOST=0.0.0.0
NODE_ENV=production

# Google OAuth 2.0
GOOGLE_CLIENT_ID=INGRESA_TU_CLIENT_ID.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=INGRESA_TU_CLIENT_SECRET
GOOGLE_CALLBACK_URL=https://TU_DOMINIO/auth/google/callback
GOOGLE_WORKSPACE_DOMAIN=lasalle.edu.ar

# Sesiones (generado automáticamente)
SESSION_SECRET=${SESSION_SECRET}
SESSION_NAME=fortigate_session
SESSION_MAX_AGE=86400000
SESSION_SECURE=true

# Proxy (Nginx/Caddy en producción)
TRUST_PROXY=true
BEHIND_PROXY=true

# Backend Python
PYTHON_API_URL=http://127.0.0.1:8000

# Usuarios autorizados (separados por coma)
AUTHORIZED_EMAILS=usuario@dominio.com
ADMIN_EMAILS=admin@dominio.com
EOF
    warn "Archivo frontend/.env creado."
    warn "Edita ${FRONTEND_ENV} con tus credenciales de Google OAuth y lista de usuarios."
else
    ok "frontend/.env ya existe, no se sobreescribe"
fi

# ─── 8. Permisos ──────────────────────────────────────────────────────────────
hdr "8. Ajustando permisos"
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${APP_DIR}" 2>/dev/null || \
    warn "No se pudieron cambiar permisos para ${SERVICE_USER} — continuando..."
chmod 600 "${BACKEND_ENV}" "${FRONTEND_ENV}" 2>/dev/null || true
ok "Permisos configurados"

# ─── 9. Systemd service ───────────────────────────────────────────────────────
hdr "9. Configurando servicio systemd"

PYTHON_BIN=$(command -v python3)
NODE_BIN=$(command -v node)
UVICORN_BIN=$(command -v uvicorn || pip3 show uvicorn 2>/dev/null | grep Location | awk '{print $2"/uvicorn"}')
UVICORN_BIN=$(command -v uvicorn 2>/dev/null || echo "/usr/local/bin/uvicorn")

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=FortiGate DHCP V170 Manager
Documentation=https://github.com/ctellolasalle/fortigate-manager
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Backend Python (FastAPI)
ExecStartPre=${UVICORN_BIN} backend.main:app --host 127.0.0.1 --port 8000 --daemon || true

# Iniciar ambos con concurrently
ExecStart=${NODE_BIN} frontend/start.js
ExecReload=/bin/kill -HUP \$MAINPID

Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

# Seguridad
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

# Uvicorn no soporta --daemon, usar dos units separadas
cat > "/etc/systemd/system/${SERVICE_NAME}-api.service" <<EOF
[Unit]
Description=FortiGate DHCP V170 Manager — Python API
After=network.target
Before=${SERVICE_NAME}.service

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${BACKEND_ENV}
ExecStart=${UVICORN_BIN} backend.main:app --host 127.0.0.1 --port 8000

Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}-api

NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

cat > "/etc/systemd/system/${SERVICE_NAME}-web.service" <<EOF
[Unit]
Description=FortiGate DHCP V170 Manager — Node.js Web
After=network.target ${SERVICE_NAME}-api.service
Requires=${SERVICE_NAME}-api.service

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${APP_DIR}/frontend
EnvironmentFile=${FRONTEND_ENV}
ExecStart=${NODE_BIN} start.js

Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}-web

NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

# Eliminar el service genérico anterior si existe, usar los dos específicos
rm -f "$SERVICE_FILE"

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}-api.service" "${SERVICE_NAME}-web.service"
ok "Servicios systemd registrados y habilitados"

# ─── 10. Resumen final ────────────────────────────────────────────────────────
hdr "Instalación completada"

echo -e "${BOLD}Próximos pasos:${RESET}"
echo ""
echo -e "  ${YELLOW}1.${RESET} Edita las credenciales del FortiGate:"
echo -e "     ${CYAN}nano ${BACKEND_ENV}${RESET}"
echo ""
echo -e "  ${YELLOW}2.${RESET} Edita las credenciales de Google OAuth y usuarios:"
echo -e "     ${CYAN}nano ${FRONTEND_ENV}${RESET}"
echo ""
echo -e "  ${YELLOW}3.${RESET} Inicia los servicios:"
echo -e "     ${CYAN}systemctl start ${SERVICE_NAME}-api ${SERVICE_NAME}-web${RESET}"
echo ""
echo -e "  ${YELLOW}4.${RESET} Verifica los logs:"
echo -e "     ${CYAN}journalctl -u ${SERVICE_NAME}-api -u ${SERVICE_NAME}-web -f${RESET}"
echo ""
echo -e "  ${YELLOW}5.${RESET} (Opcional) Configurar Nginx como reverse proxy → puerto 3000"
echo ""
warn "Recuerda: los archivos .env contienen credenciales sensibles."
warn "NO los incluyas en git. Están en .gitignore por defecto."
echo ""
ok "¡Instalación lista! La app escuchará en el puerto 3000 una vez configurada."
