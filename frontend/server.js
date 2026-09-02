/**
 * server.js — FortiGate DHCP V170 Manager
 * Frontend Express: OAuth2 Google + Proxy hacia FastAPI Python en :8000
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const passport = require('passport');
const flash = require('connect-flash');
const { createProxyMiddleware, fixRequestBody } = require('http-proxy-middleware');
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');
require('dotenv').config();

const AuthManager = require('./lib/auth');
const authRoutes = require('./routes/auth');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: process.env.NODE_ENV === 'production'
      ? 'https://itadm.lasalleflorida.edu.ar'
      : ['http://localhost:3000', 'http://127.0.0.1:3000'],
    methods: ['GET', 'POST'],
  },
});

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || 'localhost';
const PYTHON_API = process.env.PYTHON_API_URL || 'http://127.0.0.1:8000';

// ─── Validar OAuth ─────────────────────────────────────────────────────────────
if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
  console.error('❌ ERROR: Variables de entorno de Google OAuth no configuradas');
  process.exit(1);
}

// ─── Trust proxy (producción) ──────────────────────────────────────────────────
if (process.env.TRUST_PROXY === 'true' || process.env.NODE_ENV === 'production') {
  app.set('trust proxy', true);
}

// ─── Inicializar auth ──────────────────────────────────────────────────────────
const authManager = new AuthManager();
app.locals.authManager = authManager;

// ─── Helmet (CSP adaptada para la SPA) ────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://accounts.google.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      connectSrc: [
        "'self'",
        "wss:", "ws:",
        `wss://${process.env.HOST || 'localhost'}:${PORT}`,
        `ws://${process.env.HOST || 'localhost'}:${PORT}`,
        "https://accounts.google.com",
      ],
      frameSrc: ["https://accounts.google.com"],
      objectSrc: ["'none'"],
    },
  },
}));

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Sesiones ─────────────────────────────────────────────────────────────────
app.use(session({
  name: process.env.SESSION_NAME || 'fortigate_session',
  secret: process.env.SESSION_SECRET || 'fallback-secret-key-cambiar-en-produccion',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    secure: process.env.SESSION_SECURE === 'true',
    httpOnly: true,
    maxAge: parseInt(process.env.SESSION_MAX_AGE) || 24 * 60 * 60 * 1000,
    sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax',
  },
  proxy: process.env.TRUST_PROXY === 'true',
}));

app.use(passport.initialize());
app.use(passport.session());
app.use(flash());

// ─── Rate limiting ─────────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip || 'unknown',
});

app.use('/auth/google', authLimiter);
app.use('/auth/google/callback', authLimiter);

// ─── Rutas de autenticación ────────────────────────────────────────────────────
app.use('/auth', authRoutes);

// ─── Proxy /api/* → Python FastAPI ────────────────────────────────────────────
// Solo accesible si el usuario está autenticado
app.use(
  '/api',
  (req, res, next) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({
        success: false,
        message: 'Sesión requerida. Inicia sesión primero.',
        requiresAuth: true,
      });
    }
    next();
  },
  createProxyMiddleware({
    target: PYTHON_API,
    changeOrigin: true,
    // El proxy mantiene la ruta completa: /api/dhcp/reservations → /dhcp/reservations
    pathRewrite: { '^/api': '' },
    on: {
      proxyReq: fixRequestBody,
      error: (err, req, res) => {
        console.error('[Proxy Error]', err.message);
        res.status(502).json({
          success: false,
          message: 'El servicio de API no está disponible. ¿Está corriendo el backend Python?',
          detail: err.message,
        });
      },
    },
  })
);

// ─── Página de login (pública) ────────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.isAuthenticated()) return res.redirect('/');

  const error = req.query.error;
  let errorMsg = '';
  if (error === 'access_denied') errorMsg = 'Acceso denegado. Solo usuarios autorizados pueden acceder.';
  else if (error === 'session_required') errorMsg = 'Tu sesión expiró. Inicia sesión nuevamente.';

  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ELS WiFi — Iniciar Sesión</title>
  <link rel="icon" type="image/png" href="/resources/logo.png">
  <link rel="shortcut icon" href="/favicon.ico" type="image/x-icon">
  <link rel="apple-touch-icon" href="/resources/logo.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #f8fafc;
      --surface: #ffffff;
      --border: #e2e8f0;
      --primary: #1e3a8a;
      --secondary: #f59e0b;
      --text: #1e293b;
      --muted: #64748b;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background-image: radial-gradient(ellipse at 20% 50%, rgba(30,58,138,0.06) 0%, transparent 60%),
                        radial-gradient(ellipse at 80% 20%, rgba(245,158,11,0.06) 0%, transparent 60%);
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 3rem 2.5rem;
      width: min(440px, 92vw);
      text-align: center;
      box-shadow: 0 10px 30px -5px rgba(0,0,0,0.08), 0 4px 6px -2px rgba(0,0,0,0.04);
    }
    .logo-icon {
      width: 68px; height: 68px;
      background: linear-gradient(135deg, var(--primary), #1e40af);
      border-radius: 16px;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 2.2rem; margin-bottom: 1.5rem;
      box-shadow: 0 8px 20px rgba(30,58,138,0.25);
    }
    h1 { font-size: 1.5rem; font-weight: 700; margin-bottom: .4rem; color: var(--text); }
    .subtitle { color: var(--muted); font-size: .95rem; margin-bottom: 2.2rem; }
    .error-box {
      background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.25);
      color: #dc2626; border-radius: 8px; padding: 0.9rem; margin-bottom: 1.5rem;
      font-size: .88rem; text-align: left;
    }
    .google-btn {
      display: inline-flex; align-items: center; gap: 12px;
      background: #ffffff; color: #1e293b;
      border: 1px solid #cbd5e1; border-radius: 10px;
      padding: 13px 26px; font-size: 1rem; font-weight: 600;
      cursor: pointer; text-decoration: none;
      transition: all .2s ease;
      box-shadow: 0 2px 5px rgba(0,0,0,0.06);
      width: 100%; justify-content: center;
    }
    .google-btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 16px rgba(0,0,0,0.1);
      border-color: #94a3b8;
    }
    .google-btn svg { flex-shrink: 0; }
    .info {
      margin-top: 2rem; padding: 0.85rem; border-radius: 8px;
      background: rgba(30,58,138,0.05); border: 1px solid rgba(30,58,138,0.12);
      color: var(--muted); font-size: .82rem;
    }
  </style>
</head>
<body>
  <div class="card">
    <img src="/resources/logo.png" alt="ELS Logo" class="logo-icon" style="object-fit:contain;background:#ffffff;padding:8px;border:1px solid #e2e8f0;box-shadow:0 4px 12px rgba(0,0,0,0.06);">
    <h1>ELS WiFi Manager</h1>
    <p class="subtitle">Gestión de arrendamientos DHCP V170</p>
    ${errorMsg ? `<div class="error-box">❌ ${errorMsg}</div>` : ''}
    <a href="/auth/google" class="google-btn">
      <svg width="20" height="20" viewBox="0 0 24 24">
        <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
        <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
        <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
        <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
      </svg>
      Iniciar Sesión con Google
    </a>
    <div class="info">
      Solo usuarios autorizados de <strong>${process.env.GOOGLE_WORKSPACE_DOMAIN || 'la organización'}</strong> pueden acceder.
    </div>
  </div>
</body>
</html>`);
});

// ─── Dashboard → redirige al index.html protegido ─────────────────────────────
app.get('/dashboard', authManager.requireAuth, (req, res) => res.redirect('/'));

// ─── Archivos estáticos (protegidos: primero verificamos auth en la ruta raíz) ─
app.get('/', authManager.requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── API de estado del servidor (para el frontend) ────────────────────────────
app.get('/auth/me', authManager.requireAuth, (req, res) => {
  res.json({
    success: true,
    user: {
      email: req.user.email,
      name: req.user.name,
      photo: req.user.photo,
      isAdmin: authManager.isAdmin(req.user.email),
    },
  });
});

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use('*', (req, res) => {
  if (req.originalUrl.startsWith('/api/')) {
    return res.status(404).json({ success: false, message: 'Endpoint no encontrado' });
  }
  res.redirect('/login');
});

// ─── Error global ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[Error global]', err);
  res.status(500).json({ success: false, message: 'Error interno del servidor' });
});

// ─── WebSocket ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Cliente WebSocket conectado');
  socket.on('disconnect', () => console.log('Cliente WebSocket desconectado'));
});

// ─── Iniciar ──────────────────────────────────────────────────────────────────
server.listen(PORT, HOST, () => {
  const url = process.env.NODE_ENV === 'production'
    ? 'https://itadm.lasalleflorida.edu.ar'
    : `http://${HOST}:${PORT}`;

  console.log(`\n✅ FortiGate DHCP Manager iniciado`);
  console.log(`   Frontend:  ${url}`);
  console.log(`   API proxy: /api/* → ${PYTHON_API}`);
  console.log(`   OAuth:     ${process.env.GOOGLE_WORKSPACE_DOMAIN || 'sin dominio'}`);
  console.log(`   Callback:  ${process.env.GOOGLE_CALLBACK_URL}\n`);
});

module.exports = { app, io };