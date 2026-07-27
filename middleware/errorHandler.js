/**
 * middleware/errorHandler.js — manejador global de errores (Bloque 3 del PLAN_ARREGLOS_V5).
 *
 * Vive aparte de `server.js` para que los tests puedan montarlo sobre la app ligera
 * de `tests/setup.js` y verificar el mensaje de "imagen demasiado grande".
 */
const logger = require('../utils/logger');

// Límite del body. Las fotos de productos/categorías son data-URIs base64 en
// columnas TEXT (CLAUDE.md §19.5): base64 infla ~33%, así que 2mb admite una
// imagen de ~1.5MB. El default de Express (100kb) rechazaba fotos normales de
// celular con un 500 genérico.
const LIMITE_BODY = process.env.BODY_LIMIT || '2mb';

// Campos que nunca deben quedar escritos en los logs
const camposSensibles = ['password', 'pin', 'currentPassword', 'newPassword', 'refreshToken'];

function sanitizarParaLog(body) {
    if (!body || typeof body !== 'object') return body;
    const copia = { ...body };
    for (const campo of camposSensibles) {
        if (campo in copia) copia[campo] = '[REDACTADO]';
    }
    return copia;
}

/** ¿Es el error que lanza body-parser cuando el body supera el límite? */
function esPayloadDemasiadoGrande(err) {
    return err?.type === 'entity.too.large' || err?.status === 413 || err?.statusCode === 413;
}

const manejadorDeErrores = (err, req, res, next) => {
    // Body demasiado grande: caso frecuente y con causa entendible por el usuario
    // (subió una foto pesada). Se responde con un mensaje accionable en vez del
    // "Error interno del servidor" genérico, y se loguea corto (el body no sirve).
    if (esPayloadDemasiadoGrande(err)) {
        logger.warn(`${req.method} ${req.path} → body demasiado grande (límite ${LIMITE_BODY})`);
        return res.status(413).json({
            error: `El contenido es demasiado grande (máximo ${LIMITE_BODY}). Si es una imagen, usa una más liviana.`
        });
    }

    logger.error(`${req.method} ${req.path} → ${err.message}`, {
        stack: err.stack,
        status: err.status,
        body: req.body ? JSON.stringify(sanitizarParaLog(req.body)).substring(0, 500) : undefined,
    });
    res.status(err.status || 500).json({ error: 'Error interno del servidor' });
};

module.exports = { manejadorDeErrores, sanitizarParaLog, esPayloadDemasiadoGrande, LIMITE_BODY };
