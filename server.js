const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const passport = require('passport');
const flash = require('connect-flash');
const { body, validationResult } = require('express-validator');
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');
require('dotenv').config();

const FortiGateManager = require('./lib/FortiGateManager');
const AuthManager = require('./lib/auth');
const authRoutes = require('./routes/auth');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { 
  cors: { 
    origin: process.env.NODE_ENV === 'production' 
      ? "https://itadm.lasalleflorida.edu.ar" 
      : ["http://localhost:3000", "http://127.0.0.1:3000"],
    methods: ["GET", "POST"] 
  } 
});

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || 'localhost';

// Verificar variables de entorno para OAuth
if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
  console.error('❌ ERROR: Variables de entorno de Google OAuth no configuradas');
  console.error('   Configura GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en el archivo .env');
  process.exit(1);
}

// Configurar Express para confiar en proxies
if (process.env.TRUST_PROXY === 'true' || process.env.NODE_ENV === 'production') {
  app.set('trust proxy', true);
  console.log('✓ Express configurado para confiar en proxies');
}

// Inicializar managers
const fortiManager = new FortiGateManager();
const authManager = new AuthManager();

// Hacer authManager disponible globalmente para las rutas
app.locals.authManager = authManager;

// Middlewares de seguridad
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: [
        "'self'", 
        "'unsafe-inline'",  // Permitir scripts inline
        "https://accounts.google.com",
        "https://cdnjs.cloudflare.com"  // Para Socket.IO y otras librerías
      ],
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      connectSrc: [
        "'self'", 
        "wss:", 
        "ws:", 
        "https://accounts.google.com",
        `wss://${process.env.HOST || 'localhost'}:${process.env.PORT || 3000}`,  // Para WebSocket
        `ws://${process.env.HOST || 'localhost'}:${process.env.PORT || 3000}`
      ],
      frameSrc: ["https://accounts.google.com"],
      fontSrc: ["'self'", "https:", "data:"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      workerSrc: ["'self'", "blob:"]
    }
  }
}));

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Configuración de sesiones mejorada
app.use(session({
  name: process.env.SESSION_NAME || 'fortigate_session',
  secret: process.env.SESSION_SECRET || 'fallback-secret-key-cambiar-en-produccion',
  resave: false,
  saveUninitialized: false,
  rolling: true, // Renovar la sesión en cada request
  cookie: { 
    secure: process.env.SESSION_SECURE === 'true', // Solo HTTPS en producción
    httpOnly: true,
    maxAge: parseInt(process.env.SESSION_MAX_AGE) || 24 * 60 * 60 * 1000, // 24 horas
    sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax'
  },
  // Configuración adicional para debugging
  proxy: process.env.TRUST_PROXY === 'true'
}));

// Inicializar Passport
app.use(passport.initialize());
app.use(passport.session());
app.use(flash());

// Middleware para hacer usuario disponible en todas las rutas
app.use((req, res, next) => {
  res.locals.user = req.user || null;
  next();
});

// Debug de sesiones (solo en desarrollo)
if (process.env.NODE_ENV !== 'production') {
  app.use((req, res, next) => {
    if (req.session && req.user) {
      console.log(`🔐 Sesión activa para: ${req.user.email}`);
    }
    next();
  });
}

// Rate limiting SOLO para intentos fallidos de login, NO para rutas de callback
const authFailureLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 5, // Reducido a 5 intentos fallidos
  message: { error: 'Demasiados intentos de autenticacion fallidos. Intenta de nuevo en 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
  // Solo aplicar rate limiting en intentos FALLIDOS
  skip: (req, res) => {
    // No aplicar rate limiting a callbacks exitosos o rutas de estado
    if (req.originalUrl.includes('/callback') || req.originalUrl.includes('/status')) {
      return true;
    }
    return false;
  },
  keyGenerator: (req) => {
    // Usar la IP real del usuario
    return req.ip || req.connection.remoteAddress || 'unknown';
  },
  handler: (req, res, next, options) => {
    console.log(`⚠️ Rate limit alcanzado para IP: ${req.ip} en ruta: ${req.originalUrl}`);
    res.status(options.statusCode).send(options.message);
  }
});

// Rate limiting MUY permisivo para rutas de autenticación exitosas
const authSuccessLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minuto
  max: 20, // 20 requests por minuto
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip || 'unknown'
});

// Aplicar rate limiting selectivo
app.use('/auth/google', authSuccessLimiter); // Permisivo para inicio de OAuth
app.use('/auth/google/callback', authSuccessLimiter); // Permisivo para callback
app.use('/auth/logout', authSuccessLimiter); // Permisivo para logout
app.use('/auth/status', authSuccessLimiter); // Permisivo para verificación de estado

// Rate limiting más estricto solo para otras rutas de auth
app.use('/auth', (req, res, next) => {
  // Solo aplicar rate limiting estricto si NO es una ruta permitida
  const allowedRoutes = ['/google', '/google/callback', '/logout', '/status', '/test'];
  const isAllowedRoute = allowedRoutes.some(route => req.path.endsWith(route));
  
  if (!isAllowedRoute) {
    return authFailureLimiter(req, res, next);
  }
  
  next();
});

// Middleware de debugging para desarrollo
if (process.env.NODE_ENV !== 'production') {
  app.use('/auth', (req, res, next) => {
    console.log(`🔍 [DEBUG] Ruta de auth: ${req.method} ${req.originalUrl}`);
    console.log(`🔍 [DEBUG] IP del usuario: ${req.ip}`);
    console.log(`🔍 [DEBUG] Headers: X-Forwarded-For: ${req.get('X-Forwarded-For')}`);
    console.log(`🔍 [DEBUG] Session ID: ${req.sessionID || 'NO SESSION'}`);
    console.log(`🔍 [DEBUG] Autenticado: ${req.isAuthenticated()}`);
    
    if (req.user) {
      console.log(`🔍 [DEBUG] Usuario: ${req.user.email}`);
    }
    
    next();
  });
}

// Middleware para limpiar rate limiting durante desarrollo
if (process.env.NODE_ENV !== 'production') {
  app.get('/debug/clear-rate-limit', (req, res) => {
    // Esto ayuda durante desarrollo
    res.json({ 
      message: 'Rate limiting info',
      ip: req.ip,
      headers: req.headers,
      session: req.sessionID
    });
  });
}

// Rutas de autenticacion
app.use('/auth', authRoutes);

// Ruta de login (pagina publica)
app.get('/login', (req, res) => {
  // Si ya esta autenticado, redirigir al dashboard
  if (req.isAuthenticated()) {
    return res.redirect('/dashboard');
  }

  const error = req.query.error;
  let errorMessage = null;
  
  if (error === 'access_denied') {
    errorMessage = 'Acceso denegado. Solo usuarios autorizados pueden acceder a esta aplicacion.';
  } else if (error === 'session_required') {
    errorMessage = 'Tu sesion ha expirado. Por favor, inicia sesion nuevamente.';
  }
  
  res.send(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Iniciar Sesion - FortiGate Manager</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: linear-gradient(135deg, #1e3a8a 0%, #1e40af 100%);
          display: flex; 
          justify-content: center; 
          align-items: center; 
          height: 100vh; 
          color: #333;
        }
        .login-container { 
          background: white; 
          padding: 3rem 2rem; 
          border-radius: 12px; 
          box-shadow: 0 10px 25px rgba(0,0,0,0.2); 
          text-align: center; 
          max-width: 400px;
          width: 90%;
        }
        .logo { 
          font-size: 2rem; 
          font-weight: bold; 
          color: #1e3a8a; 
          margin-bottom: 0.5rem; 
        }
        .subtitle { 
          color: #64748b; 
          margin-bottom: 2rem; 
          font-size: 0.95rem; 
        }
        .google-btn { 
          background: #4285f4; 
          color: white; 
          border: none; 
          padding: 14px 28px; 
          border-radius: 8px; 
          cursor: pointer; 
          font-size: 16px; 
          display: inline-flex; 
          align-items: center; 
          gap: 10px;
          transition: all 0.2s ease;
          text-decoration: none;
          font-weight: 500;
        }
        .google-btn:hover { 
          background: #3367d6; 
          transform: translateY(-1px);
        }
        .error { 
          color: #dc2626; 
          background: #fef2f2; 
          border: 1px solid #fecaca; 
          padding: 1rem; 
          border-radius: 6px; 
          margin-bottom: 1.5rem; 
          font-size: 0.9rem; 
        }
        .info {
          color: #1e40af;
          background: #eff6ff;
          border: 1px solid #bfdbfe;
          padding: 1rem;
          border-radius: 6px;
          margin-top: 1.5rem;
          font-size: 0.85rem;
          text-align: left;
        }
        .info strong { color: #1e3a8a; }
      </style>
    </head>
    <body>
      <div class="login-container">
        <div class="logo">FortiGate Manager</div>
        <p class="subtitle">Inicia sesion con tu cuenta de Google Workspace</p>
        
        ${errorMessage ? `<div class="error">❌ ${errorMessage}</div>` : ''}
        
        <a href="/auth/google" class="google-btn">
          <svg width="20" height="20" viewBox="0 0 24 24">
            <path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
            <path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
            <path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
            <path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
          </svg>
          Iniciar Sesion con Google
        </a>

        <div class="info">
          <strong>Nota:</strong> Solo usuarios autorizados de ${process.env.GOOGLE_WORKSPACE_DOMAIN || 'tu organizacion'} pueden acceder a esta aplicacion.
        </div>
      </div>
    </body>
    </html>
  `);
});

// Ruta de dashboard (redirige al inicio si esta autenticado)
app.get('/dashboard', authManager.requireAuth, (req, res) => {
  res.redirect('/');
});

// Middleware para proteger rutas estaticas
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, path) => {
    // Solo permitir acceso a archivos estaticos si esta autenticado
    // Nota: Este middleware se ejecuta despues de la verificacion de auth en las rutas principales
  }
}));

// Middleware requerido para conexion FortiGate
const requireConnection = (req, res, next) => {
  if (!fortiManager.isConnected()) {
    return res.status(503).json({ 
      success: false, 
      message: 'No hay conexion SSH activa al FortiGate' 
    });
  }
  next();
};

// RUTAS PROTEGIDAS POR AUTENTICACION

// Ruta principal protegida
app.get('/', authManager.requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API protegida - Estado del FortiGate
app.get('/api/status', authManager.requireAuth, (req, res) => {
  const connectionState = fortiManager.getConnectionState();
  const connectionInfo = fortiManager.getConnectionInfo();
  
  let message = 'No conectado al FortiGate';
  if (connectionState === 'CONNECTED') message = 'Conectado al FortiGate exitosamente';
  if (connectionState === 'CONNECTING') message = 'Conectando al FortiGate...';

  const safeConfig = connectionInfo ? { 
    hostname: connectionInfo.hostname, 
    username: connectionInfo.username, 
    port: connectionInfo.port 
  } : {};
  
  res.json({
    success: true,
    connected: connectionState === 'CONNECTED',
    message: message,
    config: safeConfig,
    user: {
      email: req.user.email,
      name: req.user.name,
      isAdmin: authManager.isAdmin(req.user.email)
    }
  });
});

// API protegida - Reconectar FortiGate
app.post('/api/reconnect', authManager.requireAuth, async (req, res) => {
  console.log(`Usuario ${req.user.email} solicito reconexion a FortiGate`);
  const result = await fortiManager.connect();
  io.emit('connection_status', { connected: result.success, message: result.message });
  res.json({ success: result.success, message: result.message });
});

// API protegida - Diagnostico de FortiGate
app.get('/api/diagnose', authManager.requireAuth, async (req, res) => {
  try {
    console.log(`Usuario ${req.user.email} ejecuto diagnostico`);
    const result = await fortiManager.diagnoseConnection();
    res.json({ 
      success: result.success, 
      data: { results: result.results } 
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: 'Error al ejecutar diagnostico', 
      error: error.message 
    });
  }
});

// API protegida - Objetos ELS
app.get('/api/els-objects', [authManager.requireAuth, requireConnection], async (req, res) => {
  try {
    const { type } = req.query;
    const filter = (type && type !== 'all') ? type : null;
    const objects = await fortiManager.getElsObjectsByType(filter);
    
    console.log(`Usuario ${req.user.email} consulto objetos ELS (filtro: ${filter || 'ninguno'})`);
    
    res.json({
      success: true,
      data: objects,
      count: Object.keys(objects).length
    });
  } catch (error) {
    console.error(`Error en /api/els-objects para ${req.user.email}:`, error);
    res.status(500).json({ 
      success: false, 
      message: 'Error al obtener objetos ELS', 
      error: error.message 
    });
  }
});

// API protegida - Crear/actualizar objeto ELS
app.post('/api/els-objects', [
  authManager.requireAuth,
  body('name').isLength({ min: 1 }).withMessage('Nombre es requerido'),
  body('type').isIn(['mac', 'subnet', 'fqdn', 'range']).withMessage('Tipo no valido'),
  body('value').isLength({ min: 1 }).withMessage('Valor es requerido'),
  requireConnection
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        success: false, 
        message: 'Datos invalidos', 
        errors: errors.array() 
      });
    }

    const { name, type, value } = req.body;
    const fullName = name.startsWith('ELS-') ? name : `ELS-${name}`;
    
    await fortiManager.createUpdateAddressObject(fullName, type, value);
    
    console.log(`Usuario ${req.user.email} creo/actualizo objeto: ${fullName}`);
    io.emit('object_updated', { name: fullName, type, value, user: req.user.email });
    
    res.json({ 
      success: true, 
      message: `Objeto '${fullName}' guardado correctamente` 
    });
  } catch (error) {
    console.error(`Error creando objeto para ${req.user.email}:`, error);
    res.status(500).json({ 
      success: false, 
      message: 'Error al guardar objeto', 
      error: error.message 
    });
  }
});

// API protegida - Eliminar objeto ELS
app.delete('/api/els-objects/:name', [authManager.requireAuth, requireConnection], async (req, res) => {
  try {
    const { name } = req.params;
    await fortiManager.deleteAddressObject(name);
    
    console.log(`Usuario ${req.user.email} elimino objeto: ${name}`);
    io.emit('object_deleted', { name, user: req.user.email });
    
    res.json({ 
      success: true, 
      message: `Objeto '${name}' eliminado correctamente` 
    });
  } catch (error) {
    console.error(`Error eliminando objeto para ${req.user.email}:`, error);
    res.status(500).json({ 
      success: false, 
      message: 'Error al eliminar objeto', 
      error: error.message 
    });
  }
});

// API protegida - Grupos de direcciones
app.get('/api/address-groups', [authManager.requireAuth, requireConnection], async (req, res) => {
  try {
    const groups = await fortiManager.getAddressGroups();
    console.log(`Usuario ${req.user.email} consulto grupos de direcciones`);
    res.json({ success: true, data: groups });
  } catch (error) {
    console.error(`Error obteniendo grupos para ${req.user.email}:`, error);
    res.status(500).json({ 
      success: false, 
      message: 'Error al obtener grupos', 
      error: error.message 
    });
  }
});

// API protegida - Actualizar grupo ELS-APP
app.put('/api/address-groups/ELS-APP', [
  authManager.requireAuth,
  body('members').isArray().withMessage('Members debe ser un array'),
  requireConnection
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        success: false, 
        message: 'Datos invalidos', 
        errors: errors.array() 
      });
    }

    const { members } = req.body;
    await fortiManager.createUpdateGroup('ELS-APP', members);
    
    console.log(`Usuario ${req.user.email} actualizo grupo ELS-APP con ${members.length} miembros`);
    io.emit('group_updated', { name: 'ELS-APP', members, user: req.user.email });
    
    res.json({ 
      success: true, 
      message: 'Grupo ELS-APP actualizado correctamente' 
    });
  } catch (error) {
    console.error(`Error actualizando grupo para ${req.user.email}:`, error);
    res.status(500).json({ 
      success: false, 
      message: 'Error al actualizar grupo', 
      error: error.message 
    });
  }
});

// Manejo de errores 404
app.use('*', (req, res) => {
  if (req.originalUrl.startsWith('/api/')) {
    res.status(404).json({ 
      success: false, 
      message: 'Endpoint no encontrado' 
    });
  } else {
    res.redirect('/login');
  }
});

// Manejo de errores globales
app.use((err, req, res, next) => {
  console.error('Error global:', err);
  res.status(500).json({ 
    success: false, 
    message: 'Error interno del servidor' 
  });
});

// Eventos de WebSocket
io.on('connection', (socket) => {
  // Verificar autenticacion del socket (opcional)
  console.log('Cliente WebSocket conectado');
  
  // Enviar estado inicial de FortiGate
  const state = fortiManager.getConnectionState();
  let message = 'No conectado al FortiGate';
  if (state === 'CONNECTED') message = 'Conectado al FortiGate exitosamente';
  if (state === 'CONNECTING') message = 'Conectando al FortiGate...';
  
  socket.emit('connection_status', { 
    connected: state === 'CONNECTED', 
    message 
  });

  socket.on('disconnect', () => {
    console.log('Cliente WebSocket desconectado');
  });
});

// Iniciar servidor
server.listen(PORT, HOST, () => {
  const serverUrl = process.env.NODE_ENV === 'production' 
    ? `https://itadm.lasalleflorida.edu.ar`
    : `http://${HOST}:${PORT}`;
    
  console.log(`✓ Servidor ejecutandose en ${serverUrl}`);
  console.log(`✓ OAuth configurado para dominio: ${process.env.GOOGLE_WORKSPACE_DOMAIN || 'NO CONFIGURADO'}`);
  console.log(`✓ Emails autorizados: ${authManager.getAuthorizedEmails().length}`);
  console.log(`✓ Callback URL: ${process.env.GOOGLE_CALLBACK_URL}`);
  console.log(`✓ Trust proxy: ${process.env.TRUST_PROXY || 'false'}`);
  
  // Auto-conectar a FortiGate
  fortiManager.autoConnect().then(result => {
    io.emit('connection_status', { 
      connected: result.success, 
      message: result.message 
    });
  });
});