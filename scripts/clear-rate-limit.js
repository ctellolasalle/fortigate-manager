#!/usr/bin/env node

// Script para limpiar rate limiting durante desarrollo
const fs = require('fs');
const path = require('path');

console.log('🧹 Limpiando rate limiting...');

// En desarrollo, el rate limiting de express-rate-limit usa memoria
// Reiniciar el servidor es la forma más efectiva de limpiar

console.log('📋 Para limpiar rate limiting:');
console.log('   1. Detener servidor (Ctrl+C)');
console.log('   2. Esperar 5 segundos');
console.log('   3. Reiniciar con: npm start');

console.log('\n🔧 Configuración de rate limiting actualizada:');
console.log('   • OAuth routes: 20 requests/minuto');
console.log('   • Otras auth routes: 5 intentos fallidos/15 minutos');
console.log('   • Callbacks y status: Sin límites restrictivos');

console.log('\n💡 Tips para evitar rate limiting:');
console.log('   • No refrescar /auth/google manualmente');
console.log('   • Usar las rutas de la aplicación normal');
console.log('   • El rate limiting solo afecta intentos fallidos');

// Crear archivo de configuración temporal para desarrollo
const devConfig = {
  rateLimit: {
    disabled: process.env.NODE_ENV !== 'production',
    oauth: { windowMs: 60000, max: 20 },
    auth: { windowMs: 900000, max: 5 },
    development: true
  },
  session: {
    secure: false,
    maxAge: 86400000,
    debug: true
  }
};

const configPath = path.join(__dirname, '..', 'temp-dev-config.json');
fs.writeFileSync(configPath, JSON.stringify(devConfig, null, 2));

console.log(`\n✅ Configuración de desarrollo guardada en: ${configPath}`);
console.log('🚀 Reinicia el servidor para aplicar cambios');

module.exports = { devConfig };