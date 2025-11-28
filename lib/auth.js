const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;

// Lista de emails autorizados - PERSONALIZA ESTOS EMAILS CON TUS CUENTAS REALES
const AUTHORIZED_EMAILS = [
  'ctello@lasalle.edu.ar',
  'mpereiras@lasalle.edu.ar',
  'lbassani@lasalle.edu.ar', 
  'lsassone@lasalle.edu.ar',
  'frevello@lasalle.edu.ar',
  'sistemas@lasalleflorida.edu.ar',
  'minveraldi@lasalle.edu.ar'
];

class AuthManager {
  constructor() {
    this.setupPassport();
    this.userSessions = new Map(); // Cache temporal de usuarios para la sesion
  }

  setupPassport() {
    console.log('Configurando estrategia Google OAuth 2.0...');
    
    // Configurar estrategia de Google OAuth
    passport.use(new GoogleStrategy({
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: process.env.GOOGLE_CALLBACK_URL || "/auth/google/callback"
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const user = {
          id: profile.id,
          email: profile.emails[0].value,
          name: profile.displayName,
          photo: profile.photos[0].value,
          domain: profile._json.hd, // Dominio de Google Workspace
          provider: 'google',
          accessToken: accessToken
        };

        console.log(`Intento de login: ${user.email} (dominio: ${user.domain})`);

        // Verificar si el email esta en la lista autorizada
        if (!this.isAuthorizedEmail(user.email)) {
          console.log(`❌ Acceso denegado para: ${user.email} - No autorizado`);
          return done(null, false, { 
            message: `Acceso denegado. El email ${user.email} no esta autorizado para acceder a esta aplicacion.` 
          });
        }

        // Verificar que pertenezca al dominio correcto (opcional pero recomendado)
        const expectedDomain = process.env.GOOGLE_WORKSPACE_DOMAIN;
        if (expectedDomain && user.domain !== expectedDomain) {
          console.log(`❌ Acceso denegado para: ${user.email} - Dominio incorrecto (${user.domain} vs ${expectedDomain})`);
          return done(null, false, { 
            message: `Acceso denegado. Solo usuarios del dominio ${expectedDomain} pueden acceder.` 
          });
        }

        // Guardar usuario en cache temporal
        this.userSessions.set(user.id, user);

        console.log(`✓ Acceso autorizado para: ${user.email}`);
        return done(null, user);

      } catch (error) {
        console.error('Error en autenticacion Google:', error);
        return done(error, null);
      }
    }));

    // Serializar usuario para la sesion (solo guardar el ID)
    passport.serializeUser((user, done) => {
      console.log(`Serializando usuario: ${user.email}`);
      done(null, user.id);
    });

    // Deserializar usuario de la sesion
    passport.deserializeUser((id, done) => {
      const user = this.userSessions.get(id);
      if (user) {
        done(null, user);
      } else {
        console.log(`Usuario no encontrado en sesion: ${id}`);
        done(null, false);
      }
    });
  }

  isAuthorizedEmail(email) {
    return AUTHORIZED_EMAILS.includes(email.toLowerCase());
  }

  getAuthorizedEmails() {
    return [...AUTHORIZED_EMAILS];
  }

  // Verificar si usuario tiene permisos de admin
  isAdmin(email) {
    // Personaliza esta lista con emails que deben tener permisos de admin
    const adminEmails = ['minveraldi@lasalle.edu.ar', 'ctello@lasalle.edu.ar'];
    return adminEmails.includes(email.toLowerCase());
  }

  // Middleware para proteger rutas - REQUIERE AUTENTICACION
  requireAuth(req, res, next) {
    if (req.isAuthenticated()) {
      return next();
    }
    
    console.log(`❌ Acceso no autorizado a: ${req.originalUrl}`);
    
    // Si es una peticion AJAX o API, devolver JSON
    if (req.xhr || req.headers.accept.indexOf('json') > -1) {
      return res.status(401).json({ 
        success: false, 
        message: 'Sesion requerida. Inicia sesion primero.',
        requiresAuth: true 
      });
    }
    
    // Si es navegador, redirigir al login
    res.redirect('/login?error=session_required');
  }

  // Middleware opcional para rutas que requieren admin
  requireAdminAuth(req, res, next) {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ 
        success: false, 
        message: 'Sesion de administrador requerida.',
        requiresAuth: true 
      });
    }

    const userEmail = req.user.email;
    if (this.isAdmin(userEmail)) {
      return next();
    } else {
      console.log(`❌ Acceso admin denegado para: ${userEmail}`);
      return res.status(403).json({ 
        success: false, 
        message: 'Permisos de administrador requeridos.' 
      });
    }
  }

  // Limpiar sesion de usuario
  clearUserSession(userId) {
    this.userSessions.delete(userId);
  }

  // Obtener estadisticas de sesiones activas
  getSessionStats() {
    return {
      activeSessions: this.userSessions.size,
      authorizedEmails: AUTHORIZED_EMAILS.length,
      users: Array.from(this.userSessions.values()).map(user => ({
        email: user.email,
        name: user.name,
        domain: user.domain
      }))
    };
  }
}

module.exports = AuthManager;