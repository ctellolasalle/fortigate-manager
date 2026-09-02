/**
 * frontend/lib/auditNotifier.js
 * Envia notificaciones de eventos de autenticacion (LOGIN, LOGOUT, LOGIN_FAILED) al backend FastAPI.
 */

const http = require('http');

const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://127.0.0.1:8000';

function notifyAuditEvent({
  eventType,
  userEmail,
  userName = '',
  actionStatus = 'SUCCESS',
  description = '',
  details = null,
  clientIp = '',
}) {
  try {
    const url = new URL('/audit/event', PYTHON_API_URL);
    const payload = JSON.stringify({
      event_type: eventType,
      user_email: userEmail,
      user_name: userName,
      action_status: actionStatus,
      description: description,
      details: details,
      client_ip: clientIp,
    });

    const req = http.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 3000,
      },
      (res) => {
        // Consumir datos para liberar socket
        res.resume();
      }
    );

    req.on('error', (err) => {
      // Falla silenciosa sin afectar el login/logout
      console.warn('[AuditNotifier] No se pudo enviar evento de auditoría:', err.message);
    });

    req.write(payload);
    req.end();
  } catch (err) {
    console.warn('[AuditNotifier] Error preparando evento:', err.message);
  }
}

module.exports = { notifyAuditEvent };
