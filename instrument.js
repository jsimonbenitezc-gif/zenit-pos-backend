/**
 * instrument.js — inicialización de Sentry (Bloque 6 del PLAN_ARREGLOS_V5).
 *
 * ⚠️ DEBE cargarse ANTES que Express, `pg` y las rutas: `require('./instrument')`
 * es la primera línea de `server.js`. El SDK v8+ instrumenta esos módulos con
 * OpenTelemetry parcheándolos al cargarse; si se inicializa después, el parche
 * llega tarde y los reportes salen sin contexto de la petición.
 *
 * ⚠️ La API vieja (`Sentry.Handlers.requestHandler()` / `.errorHandler()`)
 * DESAPARECIÓ en el SDK v8. Con `@sentry/node` 10.x, `Sentry.Handlers` es
 * `undefined`: `server.js` la usaba, así que poner `SENTRY_DSN` en Render habría
 * tumbado el backend en el arranque. Hoy el handler se registra con
 * `Sentry.setupExpressErrorHandler(app)` después de las rutas.
 *
 * Sin `SENTRY_DSN` no se inicializa nada y el backend funciona igual (Sentry es
 * opcional a propósito).
 */
require('dotenv').config();

const Sentry = require('@sentry/node');

const DSN = process.env.SENTRY_DSN || '';
const sentryActivo = Boolean(DSN);

// Campos que nunca deben salir del servidor dentro de un reporte de error.
// Mismo criterio que el saneado de logs (middleware/errorHandler.js), pero aquí
// importa más: un evento de Sentry viaja a un tercero.
const camposSensibles = [
    'password', 'pin', 'currentPassword', 'newPassword',
    'refreshToken', 'refresh_token', 'token', 'accessToken', 'kdsToken',
    // BLOQUE 13: el secreto de una pantalla de cocina ES su credencial, y no
    // caduca nunca. Un error al registrar un dispositivo lleva el secreto en el
    // body: sin esto, saldría íntegro hacia Sentry.
    'device_secret',
];

function sanitizarObjeto(valor) {
    if (!valor || typeof valor !== 'object') return valor;
    if (Array.isArray(valor)) return valor.map(sanitizarObjeto);
    const copia = {};
    for (const [clave, v] of Object.entries(valor)) {
        copia[clave] = camposSensibles.includes(clave) ? '[REDACTADO]' : sanitizarObjeto(v);
    }
    return copia;
}

/**
 * Limpia el evento antes de enviarlo. El body puede llegar como objeto o como
 * string: si es un string que no es JSON no hay forma de saber qué trae, así que
 * se omite entero (perder un body raro es mejor que filtrar una contraseña).
 */
function sanitizarEventoSentry(event) {
    if (!event || !event.request) return event;
    const data = event.request.data;
    if (data && typeof data === 'object') {
        event.request.data = sanitizarObjeto(data);
    } else if (typeof data === 'string') {
        try {
            event.request.data = JSON.stringify(sanitizarObjeto(JSON.parse(data)));
        } catch {
            event.request.data = '[OMITIDO]';
        }
    }
    // La query string lleva credenciales: el `?token=` legacy del SSE y el
    // `?pair=` del KDS (que no da acceso por sí solo, pero permite pedirlo).
    if (typeof event.request.query_string === 'string') {
        event.request.query_string = event.request.query_string
            .replace(/((?:^|&)(?:token|ticket|kdsToken|pair)=)[^&]*/gi, '$1[REDACTADO]');
    }
    if (typeof event.request.url === 'string') {
        event.request.url = event.request.url
            .replace(/([?&](?:token|ticket|kdsToken|pair)=)[^&]*/gi, '$1[REDACTADO]');
    }
    return event;
}

if (sentryActivo) {
    Sentry.init({
        dsn: DSN,
        environment: process.env.NODE_ENV || 'development',
        // Trazas de rendimiento APAGADAS por defecto: en el proyecto de Sentry solo
        // se activó "Error monitoring", así que los spans se enviarían para nada — y
        // el instrumental de OpenTelemetry cuesta CPU y memoria, que en el plan free
        // de Render son escasas. Para encenderlas: SENTRY_TRACES_SAMPLE_RATE=0.1
        tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
        // No adjuntar IP, cookies ni headers del usuario.
        sendDefaultPii: false,
        beforeSend: sanitizarEventoSentry,
    });
}

module.exports = { Sentry, sentryActivo, sanitizarEventoSentry };
