# FortiGate Manager - Aplicacion Node.js

Aplicacion web para gestionar objetos de direcciones y grupos en firewalls FortiGate mediante conexion SSH.

## Caracteristicas

- **Auto-conexion SSH** usando configuracion desde archivo `.env` al iniciar
- **Verificaciones automaticas** del entorno antes de ejecutar 
- **Gestion de objetos MAC** con prefijo ELS- automatico y validacion en tiempo real
- **Administracion del grupo ELS-APP** con interfaz de transferencia de miembros
- **Interfaz web moderna** con WebSocket para actualizaciones en tiempo real
- **Diagnostico de conexion** integrado con pruebas de DNS, ping y puerto SSH
- **Sistema de notificaciones** con diferentes tipos (exito, error, advertencia)
- **Responsive design** para dispositivos moviles
- **Estados de conexion** visuales (conectado, desconectado, conectando)

## Requisitos Previos

- Node.js >= 16.0.0
- npm o yarn
- Acceso SSH al FortiGate
- Usuario con permisos de administracion en FortiGate

## Instalacion

1. **Clonar el repositorio:**
```bash
git clone https://github.com/ctellolasalle/fortigate-manager
cd fortigate-manager
```

2. **Instalar dependencias:**
```bash
npm install
```

3. **Configurar variables de entorno:**
```bash
cp .env.example .env
```

4. **Editar el archivo `.env`** con tus credenciales:
```env
# Configuración del servidor  
PORT=3000
HOST=0.0.0.0
NODE_ENV=development

# Configuración de FortiGate
FORTIGATE_HOST=192.168.0.1
FORTIGATE_USERNAME=usuario
FORTIGATE_PASSWORD=contraseña
FORTIGATE_PORT=22
FORTIGATE_TIMEOUT=20000

# Autenticación Google OAuth 2.0
GOOGLE_CLIENT_ID=0000000000-xxxxxxxxxxxxxxxxxxxxxxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-_XXXXXXXXXXX_XXXXXXXXXXX
GOOGLE_CALLBACK_URL=https://sudominio.com/auth/google/callback
GOOGLE_WORKSPACE_DOMAIN=sudominio.com

# Seguridad de sesiones
SESSION_SECRET=genera-una-clave-aleatoria-de-64-caracteres-aqui

# CONFIGURACIÓN DE PROXY - AGREGAR ESTAS LÍNEAS
TRUST_PROXY=true
BEHIND_PROXY=true

# CONFIGURACIÓN DE SESIÓN MEJORADA - AGREGAR ESTAS LÍNEAS  
SESSION_NAME=fortigate_session
SESSION_MAX_AGE=86400000
SESSION_SECURE=false
```

## Uso

### Iniciar la aplicacion

**Metodo recomendado (con verificaciones):**
```bash
npm start
```

**Para desarrollo con auto-reinicio:**
```bash
npm run dev
```

**Ejecutar servidor directamente (sin verificaciones):**
```bash
npm run server
```

La aplicacion estara disponible en `http://localhost:3000`

## Despliegue Automático en Contenedor LXC (Proxmox)

Para una instalación rápida y automatizada en un contenedor LXC (Ubuntu/Debian), puedes usar el script `install.sh` incluido en el proyecto.

### Instrucciones

1.  **Crea un contenedor LXC** en Proxmox (se recomienda una plantilla de **Ubuntu 24.04** o **Debian 11/12**).
2.  **Transfiere la carpeta completa del proyecto** a tu contenedor LXC (por ejemplo, a `/opt/FortiGateManager`).
3.  **Navega al directorio del proyecto y ejecuta el script** con privilegios de superusuario:

    ```bash
    # Navega a la carpeta del proyecto
    cd /ruta/a/tu/FortiGateManager

    # Da permisos de ejecución al script
    chmod +x scripts/install.sh

    # Ejecuta el instalador
    sudo ./scripts/install.sh
    ```

El script se encargará del resto: instalará las dependencias del sistema, las dependencias de Node.js, te pedirá que configures las variables de entorno y finalmente configurará la aplicación como un servicio `systemd` para que se inicie automáticamente.

## Funcionalidades

### 1. Gestion de Objetos MAC

- **Crear objetos**: Interfaz intuitiva con campos MAC validados
- **Auto-formato**: Los campos MAC se formatean automaticamente (XX:XX:XX:XX:XX:XX)
- **Editar objetos**: Selecciona cualquier objeto de la tabla para editarlo
- **Eliminar objetos**: Funcion de eliminacion con confirmacion
- **Filtrado**: Filtra objetos por tipo (todos, MAC, subnet, FQDN, range)
- **Prefijo automatico**: Todos los objetos se crean con prefijo "ELS-"
- **Actualizacion en tiempo real**: Los cambios se reflejan inmediatamente via WebSocket

### 2. Gestion de Grupos

- **Grupo ELS-APP**: Administracion especifica del grupo de aplicaciones
- **Transferencia de miembros**: Mueve objetos entre disponibles y miembros actuales
- **Seleccion multiple**: Permite seleccionar varios objetos para transferir
- **Ordenamiento automatico**: Las listas se ordenan alfabeticamente
- **Sincronizacion**: Los cambios se sincronizan en tiempo real

### 3. Conexion y Diagnostico  

- **Auto-conexion**: Conecta automaticamente al iniciar usando configuracion `.env`
- **Estados visuales**: Indicador de estado (conectado/desconectado/conectando)
- **Reconexion manual**: Boton para reestablecer conexion cuando sea necesario
- **Diagnostico completo**: Prueba DNS, ping y conectividad al puerto SSH
- **Mensajes informativos**: Notificaciones detalladas sobre el estado de la conexion

### 4. Sistema de Notificaciones

- **Tipos**: Exito (verde), Error (rojo), Advertencia (amarillo), Info (azul)  
- **Auto-dismiss**: Las notificaciones se ocultan automaticamente despues de 5 segundos
- **Click to dismiss**: Haz clic en cualquier notificacion para ocultarla
- **Posicion fija**: Aparecen en la esquina superior derecha

## Estructura del Proyecto

```
fortigate-manager/
├── lib/
│   └── FortiGateManager.js    # Clase principal para conexion SSH
├── public/
│   ├── index.html             # Interfaz web principal
│   ├── app.js                 # Logica del frontend y WebSocket
│   └── styles.css             # Estilos CSS responsivos
├── scripts/
│   ├── install.sh             # Script de instalación automatizada
│   └── fortigate-manager.service # Archivo de servicio para systemd
├── start.js                   # Script de inicio con verificaciones
├── server.js                  # Servidor Express con API REST
├── package.json               # Configuracion del proyecto y dependencias
├── .env.example              # Plantilla de configuracion
└── README.md                 # Documentacion del proyecto
```

## API Endpoints

### Estado y Conexion
- `GET /api/status` - Estado actual de la conexion SSH
- `POST /api/reconnect` - Reconectar manualmente al FortiGate  
- `GET /api/diagnose` - Ejecutar diagnostico completo de conexion

### Objetos ELS
- `GET /api/els-objects` - Obtener todos los objetos ELS
- `GET /api/els-objects?type=mac` - Filtrar objetos por tipo (mac, subnet, fqdn, range)
- `POST /api/els-objects` - Crear o actualizar objeto ELS
- `DELETE /api/els-objects/:name` - Eliminar objeto especifico

**Formato para crear objeto:**
```json
{
  "name": "DISPOSITIVO_EJEMPLO",
  "type": "mac", 
  "value": "aa:bb:cc:dd:ee:ff"
}
```

### Grupos de Direcciones
- `GET /api/address-groups` - Obtener grupos (especificamente ELS-APP)
- `PUT /api/address-groups/ELS-APP` - Actualizar miembros del grupo ELS-APP

**Formato para actualizar grupo:**
```json
{
  "members": ["ELS-DISPOSITIVO1", "ELS-DISPOSITIVO2"]
}
```

## Configuracion de Seguridad

La aplicacion incluye las siguientes medidas de seguridad:

- **Helmet.js**: Headers de seguridad HTTP estandar
- **Rate limiting**: Limitacion de requests por IP 
- **CORS**: Configuracion de cross-origin requests
- **Validacion de entrada**: Validacion con express-validator para todos los endpoints
- **Variables de entorno**: Credenciales nunca hardcodeadas en el codigo
- **Middleware de autorizacion**: Verificacion de conexion SSH antes de operaciones

## WebSocket Events

La aplicacion utiliza WebSocket para actualizaciones en tiempo real:

**Eventos del servidor:**
- `connection_status` - Cambios en el estado de conexion SSH
- `object_updated` - Notifica cuando un objeto es creado o actualizado
- `object_deleted` - Notifica cuando un objeto es eliminado
- `group_updated` - Notifica cuando el grupo ELS-APP es actualizado

**Estados de conexion:**
- `connected: true/false` - Booleano del estado de conexion
- `message: string` - Mensaje descriptivo del estado actual

## Variables de Entorno Requeridas

```env
# OBLIGATORIAS
FORTIGATE_HOST=ip_del_fortigate
FORTIGATE_USERNAME=usuario_ssh
FORTIGATE_PASSWORD=password_ssh

# OPCIONALES (con valores por defecto)
PORT=3000
HOST=localhost  
FORTIGATE_PORT=22
FORTIGATE_TIMEOUT=20000
NODE_ENV=development
```

## Troubleshooting

### Error de Variables de Entorno
```
❌ Error: Variables de entorno faltantes: FORTIGATE_HOST
```
**Solucion:** Verifica que el archivo `.env` existe y contiene todas las variables requeridas.

### Error de Conexion SSH
```
❌ Error: Conexion rechazada - Verifica IP y puerto
```  
**Solucion:** 
1. Usar el diagnostico integrado (`/api/diagnose`)
2. Verificar conectividad de red al FortiGate
3. Confirmar que SSH este habilitado en el FortiGate

### Error de Autenticacion
```
❌ Error: Error de autenticacion - Usuario o contraseña incorrectos
```
**Solucion:**
1. Verificar credenciales en archivo `.env`
2. Confirmar que el usuario tiene permisos de administracion
3. Probar login manual via SSH para validar credenciales

### Error de Permisos
```
❌ Error: No hay conexion SSH activa al FortiGate
```
**Solucion:**
1. Usar boton "Reconectar" en la interfaz
2. Verificar estado de conexion en la parte superior
3. Revisar logs del servidor para mas detalles

## Comandos de Desarrollo

```bash
# Instalar dependencias
npm install

# Verificar entorno e iniciar
npm start

# Modo desarrollo con nodemon
npm run dev

# Solo servidor (sin verificaciones)
npm run server

# Verificar version de Node
node --version
```

## Tecnologias Utilizadas

- **Backend:** Node.js, Express.js, Socket.io
- **Frontend:** HTML5, CSS3 (sin frameworks), JavaScript vanilla
- **SSH:** node-ssh para conexiones seguras
- **Seguridad:** Helmet, express-rate-limit, express-validator
- **Utilidades:** dotenv, cors

## Licencia

Este proyecto esta bajo la Licencia MIT. 

## Contribucion

1. Fork el proyecto
2. Crea una rama feature (`git checkout -b feature/nueva-funcionalidad`)  
3. Commit tus cambios (`git commit -am 'Agregar nueva funcionalidad'`)
4. Push a la rama (`git push origin feature/nueva-funcionalidad`)
5. Crear un Pull Request

## Soporte

Para reportar bugs o solicitar nuevas funcionalidades:
- Crear un issue en el repositorio del proyecto
- Incluir logs relevantes y pasos para reproducir el problema
- Especificar version de Node.js y sistema operativo
