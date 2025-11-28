#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Colores para output en consola
const colors = {
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    magenta: '\x1b[35m',
    reset: '\x1b[0m'
};

function log(color, message) {
    console.log(color + message + colors.reset);
}

function checkEnvironment() {
    log(colors.blue, '=== Verificando entorno de ejecucion ===\n');
    
    // Verificar version de Node.js
    const nodeVersion = process.version;
    const majorVersion = parseInt(nodeVersion.split('.')[0].substring(1));
    
    if (majorVersion < 16) {
        log(colors.red, `❌ Error: Node.js version ${nodeVersion} no es compatible`);
        log(colors.yellow, '   Requiere Node.js >= 16.0.0');
        process.exit(1);
    }
    
    log(colors.green, `✓ Node.js version ${nodeVersion} - Compatible`);
    
    // Verificar archivo .env
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) {
        log(colors.red, '❌ Error: Archivo .env no encontrado');
        log(colors.yellow, '   Ejecuta: cp .env.example .env');
        log(colors.yellow, '   Luego edita el archivo .env con tus credenciales');
        process.exit(1);
    }
    
    log(colors.green, '✓ Archivo .env encontrado');
    
    // Cargar y verificar variables de entorno
    require('dotenv').config();
    
    const requiredVars = [
        'FORTIGATE_HOST',
        'FORTIGATE_USERNAME', 
        'FORTIGATE_PASSWORD',
        'GOOGLE_CLIENT_ID',
        'GOOGLE_CLIENT_SECRET',
        'SESSION_SECRET'
    ];
    
    const missingVars = requiredVars.filter(varName => !process.env[varName]);
    
    if (missingVars.length > 0) {
        log(colors.red, '❌ Error: Variables de entorno faltantes:');
        missingVars.forEach(varName => {
            log(colors.yellow, `   ${varName}`);
        });
        log(colors.yellow, '\n   Edita el archivo .env con las credenciales correctas');
        
        // Mostrar ayuda especifica para OAuth
        if (missingVars.includes('GOOGLE_CLIENT_ID') || missingVars.includes('GOOGLE_CLIENT_SECRET')) {
            log(colors.cyan, '\n📋 Para configurar Google OAuth:');
            log(colors.cyan, '   1. Ve a Google Cloud Console (console.cloud.google.com)');
            log(colors.cyan, '   2. Crea/selecciona un proyecto');
            log(colors.cyan, '   3. Habilita la API de Google+');
            log(colors.cyan, '   4. Crea credenciales OAuth 2.0');
            log(colors.cyan, '   5. Configura URI de redireccion: http://localhost:3000/auth/google/callback');
            log(colors.cyan, '   6. Copia Client ID y Client Secret al .env');
        }
        
        process.exit(1);
    }
    
    log(colors.green, '✓ Variables de entorno configuradas');
    
    // Verificar variables de OAuth especificamente
    checkOAuthConfiguration();
    
    // Verificar estructura de directorios
    const requiredDirs = ['lib', 'public', 'routes'];
    const missingDirs = requiredDirs.filter(dir => !fs.existsSync(path.join(__dirname, dir)));
    
    if (missingDirs.length > 0) {
        // Crear directorios faltantes
        missingDirs.forEach(dir => {
            const dirPath = path.join(__dirname, dir);
            fs.mkdirSync(dirPath, { recursive: true });
            log(colors.green, `✓ Directorio creado: ${dir}/`);
        });
    }
    
    log(colors.green, '✓ Estructura de directorios correcta');
    
    // Verificar archivos principales
    const requiredFiles = [
        'server.js',
        'lib/FortiGateManager.js',
        'lib/auth.js',
        'routes/auth.js',
        'public/index.html',
        'public/app.js',
        'public/styles.css'
    ];
    
    const missingFiles = requiredFiles.filter(file => !fs.existsSync(path.join(__dirname, file)));
    
    if (missingFiles.length > 0) {
        log(colors.red, '❌ Error: Archivos faltantes:');
        missingFiles.forEach(file => {
            log(colors.yellow, `   ${file}`);
        });
        log(colors.yellow, '\n   Asegurate de tener todos los archivos necesarios');
        process.exit(1);
    }
    
    log(colors.green, '✓ Archivos principales encontrados');
    
    // Verificar dependencias
    try {
        require('express');
        require('node-ssh');
        require('socket.io');
        require('passport');
        require('passport-google-oauth20');
        require('express-session');
        log(colors.green, '✓ Dependencias principales instaladas');
    } catch (error) {
        log(colors.red, '❌ Error: Dependencias faltantes');
        log(colors.yellow, '   Ejecuta: npm install');
        process.exit(1);
    }
    
    log(colors.green, '\n✓ Todas las verificaciones pasaron correctamente\n');
}

function checkOAuthConfiguration() {
    log(colors.cyan, '=== Verificando configuracion OAuth 2.0 ===\n');
    
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const sessionSecret = process.env.SESSION_SECRET;
    
    // Verificar formato de Client ID
    if (clientId && !clientId.includes('.apps.googleusercontent.com')) {
        log(colors.yellow, '⚠️  Advertencia: GOOGLE_CLIENT_ID parece tener formato incorrecto');
        log(colors.yellow, '   Debe terminar en .apps.googleusercontent.com');
    } else {
        log(colors.green, '✓ Formato de GOOGLE_CLIENT_ID correcto');
    }
    
    // Verificar longitud de Client Secret
    if (clientSecret && clientSecret.length < 20) {
        log(colors.yellow, '⚠️  Advertencia: GOOGLE_CLIENT_SECRET parece muy corto');
    } else {
        log(colors.green, '✓ GOOGLE_CLIENT_SECRET configurado');
    }
    
    // Verificar Session Secret
    if (sessionSecret && sessionSecret.length < 32) {
        log(colors.yellow, '⚠️  Advertencia: SESSION_SECRET deberia ser mas largo (>= 32 chars)');
        log(colors.cyan, '   Genera uno seguro: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    } else {
        log(colors.green, '✓ SESSION_SECRET configurado correctamente');
    }
    
    // Verificar configuracion de dominio
    const workspaceDomain = process.env.GOOGLE_WORKSPACE_DOMAIN;
    if (workspaceDomain) {
        log(colors.green, `✓ Dominio Google Workspace: ${workspaceDomain}`);
    } else {
        log(colors.yellow, '⚠️  Sin dominio Google Workspace especificado (GOOGLE_WORKSPACE_DOMAIN)');
        log(colors.yellow, '   Recomendado para mayor seguridad');
    }
    
    // Verificar URL de callback
    const callbackUrl = process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3000/auth/google/callback';
    log(colors.green, `✓ URL de callback: ${callbackUrl}`);
    
    if (callbackUrl.includes('localhost') && process.env.NODE_ENV === 'production') {
        log(colors.yellow, '⚠️  Advertencia: URL de callback con localhost en produccion');
        log(colors.yellow, '   Cambia a tu dominio HTTPS en produccion');
    }
    
    console.log(); // Linea en blanco
}

function showConfig() {
    log(colors.blue, '=== Configuracion actual ===\n');
    
    const config = {
        'Servidor': `http://${process.env.HOST || 'localhost'}:${process.env.PORT || 3000}`,
        'FortiGate Host': process.env.FORTIGATE_HOST,
        'FortiGate Usuario': process.env.FORTIGATE_USERNAME,
        'FortiGate Puerto': process.env.FORTIGATE_PORT || '22',
        'Timeout': `${process.env.FORTIGATE_TIMEOUT || 20000}ms`,
        'Entorno': process.env.NODE_ENV || 'development'
    };
    
    Object.entries(config).forEach(([key, value]) => {
        log(colors.green, `${key.padEnd(20)}: ${value}`);
    });
    
    // Mostrar configuracion OAuth (sin valores sensibles)
    log(colors.magenta, '\n=== Configuracion OAuth ===');
    
    const oauthConfig = {
        'Google Client ID': process.env.GOOGLE_CLIENT_ID ? 
            `${process.env.GOOGLE_CLIENT_ID.substring(0, 20)}...` : 'No configurado',
        'Client Secret': process.env.GOOGLE_CLIENT_SECRET ? 'Configurado ✓' : 'No configurado',
        'Session Secret': process.env.SESSION_SECRET ? 'Configurado ✓' : 'No configurado',
        'Workspace Domain': process.env.GOOGLE_WORKSPACE_DOMAIN || 'No especificado',
        'Callback URL': process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3000/auth/google/callback'
    };
    
    Object.entries(oauthConfig).forEach(([key, value]) => {
        const color = value.includes('No configurado') ? colors.yellow : colors.green;
        log(color, `${key.padEnd(20)}: ${value}`);
    });
    
    console.log();
}

function showSecurityWarnings() {
    log(colors.magenta, '=== Advertencias de Seguridad ===\n');
    
    const warnings = [];
    
    // Verificar entorno de produccion
    if (process.env.NODE_ENV === 'production') {
        if (process.env.GOOGLE_CALLBACK_URL && process.env.GOOGLE_CALLBACK_URL.startsWith('http://')) {
            warnings.push('🔒 Usar HTTPS en produccion para OAuth callback');
        }
        
        if (process.env.SESSION_SECRET === 'fallback-secret-key-cambiar-en-produccion') {
            warnings.push('🔑 Cambiar SESSION_SECRET por defecto en produccion');
        }
    }
    
    // Verificar longitud de session secret
    if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length < 32) {
        warnings.push('🔐 SESSION_SECRET deberia ser mas largo para mayor seguridad');
    }
    
    // Verificar si no hay dominio workspace especificado
    if (!process.env.GOOGLE_WORKSPACE_DOMAIN) {
        warnings.push('🏢 Especificar GOOGLE_WORKSPACE_DOMAIN para restriccion de dominio');
    }
    
    if (warnings.length > 0) {
        warnings.forEach(warning => {
            log(colors.yellow, `⚠️  ${warning}`);
        });
    } else {
        log(colors.green, '✅ No se encontraron advertencias de seguridad');
    }
    
    console.log();
}

function showUsageInstructions() {
    log(colors.blue, '=== Instrucciones de Uso ===\n');
    
    const serverUrl = `http://${process.env.HOST || 'localhost'}:${process.env.PORT || 3000}`;
    
    log(colors.cyan, '📋 Pasos para usar la aplicacion:');
    log(colors.cyan, `   1. Abrir navegador en: ${serverUrl}`);
    log(colors.cyan, '   2. Hacer clic en "Iniciar Sesion con Google"');
    log(colors.cyan, '   3. Seleccionar cuenta autorizada del dominio');
    log(colors.cyan, '   4. Acceder al panel de administracion');
    
    log(colors.cyan, '\n🔧 Usuarios autorizados configurados en lib/auth.js:');
    
    // Intentar leer los emails autorizados del archivo
    try {
        const authFilePath = path.join(__dirname, 'lib', 'auth.js');
        if (fs.existsSync(authFilePath)) {
            const authContent = fs.readFileSync(authFilePath, 'utf8');
            const emailsMatch = authContent.match(/AUTHORIZED_EMAILS\s*=\s*\[(.*?)\]/s);
            
            if (emailsMatch) {
                const emailsStr = emailsMatch[1];
                const emails = emailsStr.match(/'([^']+)'/g);
                
                if (emails && emails.length > 0) {
                    emails.forEach(email => {
                        const cleanEmail = email.replace(/'/g, '');
                        log(colors.cyan, `   • ${cleanEmail}`);
                    });
                } else {
                    log(colors.yellow, '   ⚠️  No se encontraron emails configurados');
                }
            }
        }
    } catch (error) {
        log(colors.yellow, '   ⚠️  No se pudieron leer los emails autorizados');
    }
    
    log(colors.cyan, '\n💡 Consejos:');
    log(colors.cyan, '   • Para agregar usuarios, edita AUTHORIZED_EMAILS en lib/auth.js');
    log(colors.cyan, '   • Los logs de autenticacion aparecen en la consola del servidor');
    log(colors.cyan, '   • Usa Ctrl+C para detener el servidor');
    
    console.log();
}

function createRoutesDirIfNeeded() {
    const routesDir = path.join(__dirname, 'routes');
    if (!fs.existsSync(routesDir)) {
        fs.mkdirSync(routesDir);
        log(colors.green, '✓ Directorio routes/ creado');
    }
}

function startServer() {
    log(colors.blue, '=== Iniciando FortiGate Manager con OAuth ===\n');
    
    // Crear directorio de logs si no existe
    const logsDir = path.join(__dirname, 'logs');
    if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir);
        log(colors.green, '✓ Directorio de logs creado');
    }
    
    // Crear directorio routes si no existe
    createRoutesDirIfNeeded();
    
    // Mostrar advertencias de seguridad
    showSecurityWarnings();
    
    // Mostrar instrucciones de uso
    showUsageInstructions();
    
    // Iniciar servidor principal
    log(colors.green, '🚀 Iniciando servidor...\n');
    require('./server.js');
}

function showHelp() {
    log(colors.blue, '=== FortiGate Manager - Ayuda ===\n');
    
    log(colors.cyan, 'Comandos disponibles:');
    log(colors.cyan, '  npm start          - Iniciar con verificaciones completas');
    log(colors.cyan, '  npm run dev        - Modo desarrollo con nodemon');
    log(colors.cyan, '  npm run server     - Iniciar solo el servidor (sin verificaciones)');
    
    log(colors.cyan, '\nArchivos importantes:');
    log(colors.cyan, '  .env               - Configuracion de variables de entorno');
    log(colors.cyan, '  lib/auth.js        - Configuracion de usuarios autorizados');
    log(colors.cyan, '  routes/auth.js     - Rutas de autenticacion OAuth');
    log(colors.cyan, '  server.js          - Servidor principal con middleware de auth');
    
    log(colors.cyan, '\nPara configurar Google OAuth:');
    log(colors.cyan, '  1. Google Cloud Console → APIs & Services → Credentials');
    log(colors.cyan, '  2. Create OAuth 2.0 Client ID');
    log(colors.cyan, '  3. Add authorized redirect URI: http://localhost:3000/auth/google/callback');
    log(colors.cyan, '  4. Copy Client ID and Secret to .env file');
    
    log(colors.cyan, '\nSoporte:');
    log(colors.cyan, '  • Revisa los logs en consola para errores de OAuth');
    log(colors.cyan, '  • Verifica que los emails esten en AUTHORIZED_EMAILS');
    log(colors.cyan, '  • Confirma que el dominio Google Workspace sea correcto');
    
    console.log();
}

// Manejo de argumentos de linea de comandos
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
    showHelp();
    process.exit(0);
}

if (args.includes('--check') || args.includes('-c')) {
    checkEnvironment();
    showConfig();
    process.exit(0);
}

// Manejo de señales del sistema
process.on('SIGINT', () => {
    log(colors.yellow, '\n🛑 Cerrando FortiGate Manager...');
    log(colors.cyan, '   Cerrando conexiones activas...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    log(colors.yellow, '\n🛑 Cerrando FortiGate Manager...');
    log(colors.cyan, '   Servidor terminado por el sistema...');
    process.exit(0);
});

// Manejo de errores no capturados
process.on('uncaughtException', (err) => {
    log(colors.red, '❌ Error no capturado:');
    log(colors.red, err.stack);
    log(colors.yellow, '\n🛑 Cerrando aplicacion por error critico...');
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    log(colors.red, '❌ Promesa rechazada no manejada:');
    log(colors.red, reason);
    log(colors.yellow, '\n⚠️  Continuando ejecucion...');
});

// Ejecutar verificaciones y iniciar
try {
    log(colors.magenta, '🔐 FortiGate Manager - Sistema con Autenticacion OAuth 2.0\n');
    
    checkEnvironment();
    showConfig();
    startServer();
    
} catch (error) {
    log(colors.red, `❌ Error fatal: ${error.message}`);
    log(colors.yellow, '\nEjecuta con --help para ver las opciones disponibles');
    process.exit(1);
}