/**
 * scripts/probar-sentry.js — manda un error de prueba a Sentry.
 *
 * Uso:
 *   node scripts/probar-sentry.js
 *
 * Lee `SENTRY_DSN` del entorno (o del .env). Sirve para el punto 1 del BLOQUE 6:
 * confirmar que el DSN es correcto y que los eventos llegan al proyecto, sin
 * tener que provocar un error real en producción.
 *
 * En Render: Shell del servicio → `node scripts/probar-sentry.js` (usa el DSN
 * que ya está en las variables de entorno del servicio).
 */
const { sentryActivo, Sentry } = require('../instrument');

if (!sentryActivo) {
    console.error('❌ No hay SENTRY_DSN definido. Configúralo en .env (local) o en las variables de entorno de Render.');
    process.exit(1);
}

const marca = new Date().toISOString();
const error = new Error(`Prueba de Sentry desde Zenit POS — ${marca}`);

Sentry.captureException(error);

Sentry.flush(5000)
    .then((enviado) => {
        if (enviado) {
            console.log(`✅ Evento enviado a Sentry (${marca}). Búscalo en el proyecto: debería aparecer en segundos.`);
            process.exit(0);
        }
        console.error('❌ Sentry no confirmó el envío (timeout de 5s). Revisa el DSN y la salida a internet.');
        process.exit(1);
    })
    .catch((err) => {
        console.error('❌ Error al enviar a Sentry:', err.message);
        process.exit(1);
    });
