const winston = require('winston');

const logger = winston.createLogger({
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    format: process.env.NODE_ENV === 'production'
        ? winston.format.combine(
            winston.format.timestamp(),
            winston.format.json()
        )
        : winston.format.combine(
            winston.format.colorize(),
            winston.format.timestamp({ format: 'HH:mm:ss' }),
            winston.format.printf(({ timestamp, level, message }) => `${timestamp} ${level}: ${message}`)
        ),
    transports: [new winston.transports.Console()]
});

/**
 * Puente logger → Sentry (Bloque 6).
 *
 * Las rutas NO pasan sus errores a Express: los atrapan y responden 500 ellas
 * mismas (119 sitios hacen `logger.error(...)` + `res.status(500)`). Como
 * `setupExpressErrorHandler` solo ve lo que llega por `next(err)`, Sentry se
 * habría enterado únicamente de las caídas del proceso — es decir, de casi nada.
 * Enganchando el logger, todo error que hoy se escribe en los logs también viaja
 * a Sentry, sin tocar las 119 rutas.
 *
 * Se exporta aparte para poder probarlo sin un DSN real.
 */
function conectarASentry(destino, sentry) {
    const errorOriginal = destino.error.bind(destino);
    destino.error = (mensaje, meta) => {
        try {
            const err = meta instanceof Error ? meta
                      : mensaje instanceof Error ? mensaje
                      : null;
            if (err) sentry.captureException(err);
            else sentry.captureMessage(String(mensaje), { level: 'error', extra: { meta } });
        } catch (_) { /* que un fallo de Sentry jamás impida escribir el log */ }
        return errorOriginal(mensaje, meta);
    };
    return destino;
}

const { Sentry, sentryActivo } = require('../instrument');
if (sentryActivo) conectarASentry(logger, Sentry);

module.exports = logger;
module.exports.conectarASentry = conectarASentry;
