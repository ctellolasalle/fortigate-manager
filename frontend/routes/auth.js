const express = require('express');
const passport = require('passport');
const router = express.Router();
const { notifyAuditEvent } = require('../lib/auditNotifier');

// Ruta para iniciar autenticacion con Google
router.get('/google',
  passport.authenticate('google', { 
    scope: ['profile', 'email'],
    hd: process.env.GOOGLE_WORKSPACE_DOMAIN, // Forzar dominio especifico
    prompt: 'select_account' // Permitir seleccionar cuenta
  })
);

// Callback de Google OAuth - Aqui llega Google despues de la autenticacion
router.get('/google/callback',
  passport.authenticate('google', { 
    failureRedirect: '/login?error=access_denied',
    failureFlash: true 
  }),
  (req, res) => {
    // Autenticacion exitosa
    const user = req.user;
    console.log(`✓ Usuario autenticado exitosamente: ${user.email}`);

    // Registrar en auditoría
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip || '';
    notifyAuditEvent({
      eventType: 'LOGIN',
      userEmail: user.email,
      userName: user.name,
      actionStatus: 'SUCCESS',
      description: 'Inicio de sesión exitoso con Google Workspace',
      clientIp: clientIp,
    });
    
    // Redirigir al dashboard principal
    res.redirect('/dashboard');
  }
);

// Ruta de logout
router.post('/logout', (req, res) => {
  const userEmail = req.user?.email || 'Usuario desconocido';
  const userName = req.user?.name || '';
  const userId = req.user?.id;
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip || '';
  
  req.logout((err) => {
    if (err) {
      console.error('Error en logout:', err);
      return res.status(500).json({ 
        success: false, 
        message: 'Error al cerrar sesion' 
      });
    }
    
    // Limpiar sesion del servidor
    req.session.destroy((err) => {
      if (err) {
        console.error('Error destruyendo sesion:', err);
      }
      
      // Limpiar cache de usuario si esta disponible
      if (userId && req.app.locals.authManager) {
        req.app.locals.authManager.clearUserSession(userId);
      }

      // Registrar en auditoría
      notifyAuditEvent({
        eventType: 'LOGOUT',
        userEmail: userEmail,
        userName: userName,
        actionStatus: 'SUCCESS',
        description: 'Cierre de sesión manual del usuario',
        clientIp: clientIp,
      });
      
      console.log(`✓ Sesion cerrada para: ${userEmail}`);
      res.json({ 
        success: true, 
        message: 'Sesion cerrada exitosamente' 
      });
    });
  });
});

// Ruta para verificar estado de autenticacion (usada por el frontend)
router.get('/status', (req, res) => {
  if (req.isAuthenticated()) {
    const user = req.user;
    res.json({
      authenticated: true,
      user: {
        email: user.email,
        name: user.name,
        photo: user.photo,
        domain: user.domain,
        isAdmin: req.app.locals.authManager?.isAdmin(user.email) || false
      }
    });
  } else {
    res.json({ 
      authenticated: false 
    });
  }
});

// Ruta para obtener informacion de usuarios autorizados (solo admins)
router.get('/authorized-users', (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ 
      success: false, 
      message: 'Autenticacion requerida' 
    });
  }

  const authManager = req.app.locals.authManager;
  if (!authManager.isAdmin(req.user.email)) {
    return res.status(403).json({ 
      success: false, 
      message: 'Permisos de administrador requeridos' 
    });
  }

  res.json({
    success: true,
    data: {
      authorizedEmails: authManager.getAuthorizedEmails(),
      sessionStats: authManager.getSessionStats()
    }
  });
});

// Ruta de prueba para verificar que las rutas de auth funcionan
router.get('/test', (req, res) => {
  res.json({
    message: 'Rutas de autenticacion funcionando correctamente',
    authenticated: req.isAuthenticated(),
    timestamp: new Date().toISOString()
  });
});

module.exports = router;