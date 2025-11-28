#!/bin/bash

# Script para automatizar la instalación de FortiGate Manager en un sistema Debian/Ubuntu.
# Se asume que este script se ejecuta desde el directorio raíz del proyecto que ya ha sido copiado al sistema.

# Salir inmediatamente si un comando falla.
set -e

# --- Configuración ---
# Obtenemos el directorio real del script, sin importar desde dónde se llame
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
# El directorio de la aplicación es el directorio padre del directorio del script
APP_DIR="$(dirname "$SCRIPT_DIR")"
SERVICE_NAME="fortigate-manager"

# --- Funciones ---
log() {
    local color_code="$1"
    local message="$2"
    echo -e "\e[${color_code}m${message}\e[0m"
}

# --- Ejecución Principal ---

# 1. Verificar privilegios de root
if [ "$(id -u)" -ne 0 ]; then
    log "31" "❌ Error: Este script debe ejecutarse con privilegios de superusuario (root)."
    log "33" "   Prueba con: sudo bash $0"
    exit 1
fi

# 2. Verificar la ubicación del script
if [ ! -f "${APP_DIR}/package.json" ]; then
    log "31" "❌ Error: No se encontró 'package.json'."
    log "33" "   Asegúrate de que el script está en el subdirectorio 'scripts' del proyecto."
    exit 1
fi

log "34" "================================================="
log "34" "  Instalador Automático - FortiGate Manager  "
log "34" "================================================="
log "32" "Directorio de la aplicación detectado: ${APP_DIR}"

# 3. Instalar dependencias del sistema
log "36" "\n[PASO 1/4] Actualizando sistema e instalando dependencias (Node.js, npm)..."
apt-get update > /dev/null
apt-get upgrade -y > /dev/null
# git ya no es estrictamente necesario para el script, pero se deja por ser una utilidad común.
apt-get install -y nodejs npm git > /dev/null
log "32" "✓ Dependencias del sistema instaladas."

# 4. Instalar dependencias de Node.js
log "36" "\n[PASO 2/4] Instalando dependencias de Node.js (npm install)..."
# --unsafe-perm se usa para evitar errores de fchown en entornos de contenedores
(cd "${APP_DIR}" && npm install --omit=dev --unsafe-perm)
log "32" "✓ Dependencias de Node.js instaladas."

# 5. Configurar el archivo .env
log "36" "\n[PASO 3/4] Configurando el archivo .env..."
if [ ! -f "${APP_DIR}/.env.example" ]; then
    log "31" "❌ Error: No se encontró el archivo .env.example."
    exit 1
fi
# Solo copiar si .env no existe para no sobrescribir una configuración existente.
if [ ! -f "${APP_DIR}/.env" ]; then
    cp "${APP_DIR}/.env.example" "${APP_DIR}/.env"
fi

log "33" "------------------------------------------------------------------"
log "33" "  ACCIÓN REQUERIDA: Se abrirá el editor 'nano' para que puedas"
log "33" "  verificar o configurar tus variables de entorno en el archivo .env."
log "33" "  Guarda los cambios con Ctrl+O, Enter, y sal con Ctrl+X."
log "33" "------------------------------------------------------------------"
read -p "Presiona [Enter] para continuar y abrir nano..."

nano "${APP_DIR}/.env"

log "32" "✓ Archivo .env configurado."

# 6. Crear y habilitar el servicio systemd
log "36" "\n[PASO 4/4] Creando y habilitando el servicio systemd..."

cat > /etc/systemd/system/${SERVICE_NAME}.service << EOF
[Unit]
Description=FortiGate Manager Web App
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env

ExecStart=/usr/bin/npm start

Restart=on-failure
RestartSec=5

StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable ${SERVICE_NAME}.service
systemctl start ${SERVICE_NAME}.service

log "32" "✓ Servicio systemd creado y habilitado."

log "32" "\n================================================="
log "32" "  🎉 ¡Instalación completada con éxito! 🎉"
log "32" "================================================="
log "34" "La aplicación se está ejecutando como un servicio en segundo plano."
log "34" "Puedes verificar su estado con el comando:"
log "36" "   sudo systemctl status ${SERVICE_NAME}"
log "34" "Para ver los logs en tiempo real, usa:"
log "36" "   sudo journalctl -u ${SERVICE_NAME} -f"

exit 0
