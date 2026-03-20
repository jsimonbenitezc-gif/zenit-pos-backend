/**
 * utils/push.js
 * Helper para enviar notificaciones push via Expo Push API.
 * Node 18+ tiene fetch nativo, no se necesita ninguna librería extra.
 */
const { User } = require('../models');

/**
 * Obtiene tokens y preferencias del dueño del negocio.
 * businessId es siempre el ID del owner (= business_id en el JWT).
 */
async function _getOwnerData(businessId) {
    try {
        const owner = await User.findByPk(businessId, {
            attributes: ['push_tokens', 'settings'],
        });
        if (!owner) return { tokens: [], prefs: {} };

        let tokens = [];
        try { tokens = JSON.parse(owner.push_tokens || '[]'); } catch {}

        let prefs = {};
        try { prefs = JSON.parse(owner.settings || '{}'); } catch {}

        return { tokens, prefs };
    } catch {
        return { tokens: [], prefs: {} };
    }
}

/**
 * Envía una notificación push al dueño del negocio.
 *
 * @param {number} businessId  ID del negocio (= ID del owner)
 * @param {string} prefKey     Clave en settings para verificar preferencia (e.g. 'notif_turno_abierto')
 *                             Pasar null para enviar siempre sin verificar preferencia.
 * @param {string} title       Título de la notificación
 * @param {string} body        Cuerpo del mensaje
 * @param {object} [data]      Datos extra opcionales
 */
async function enviarNotificacion(businessId, prefKey, title, body, data = {}) {
    try {
        const { tokens, prefs } = await _getOwnerData(businessId);

        // Si la preferencia está explícitamente en false, no enviar
        if (prefKey && prefs[prefKey] === false) return;

        if (!tokens.length) return;

        const messages = tokens
            .filter(t => typeof t === 'string' && t.startsWith('ExponentPushToken'))
            .map(token => ({
                to: token,
                title,
                body,
                data,
                sound: 'default',
                priority: 'high',
            }));

        if (!messages.length) return;

        // Expo acepta hasta 100 mensajes por request
        for (let i = 0; i < messages.length; i += 100) {
            const chunk = messages.slice(i, i + 100);
            fetch('https://exp.host/--/api/v2/push/send', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'Accept-Encoding': 'gzip, deflate',
                },
                body: JSON.stringify(chunk),
            }).catch(err => console.error('[Push] Error enviando notificación:', err.message));
        }
    } catch (err) {
        console.error('[Push] Error en enviarNotificacion:', err.message);
    }
}

/**
 * Obtiene las preferencias del dueño del negocio directamente.
 * Útil para leer umbrales configurables (como el monto de venta grande).
 */
async function getPrefs(businessId) {
    const { prefs } = await _getOwnerData(businessId);
    return prefs;
}

module.exports = { enviarNotificacion, getPrefs };
