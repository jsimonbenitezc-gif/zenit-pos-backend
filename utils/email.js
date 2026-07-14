/**
 * utils/email.js
 * Helper para enviar correos transaccionales via la API REST de Resend.
 * Se usa fetch nativo (Node 18+), sin SDK, igual que utils/push.js con Expo.
 *
 * Variables de entorno:
 *   RESEND_API_KEY  — API key de Resend (si falta, el envío se omite silenciosamente).
 *   EMAIL_FROM      — Remitente. Sin dominio propio verificado, Resend solo permite
 *                     'onboarding@resend.dev' y SOLO entrega a tu propio correo de cuenta.
 *                     Con dominio verificado, usar algo como 'Zenit POS <no-reply@tudominio.com>'.
 *   APP_URL         — Base pública del backend (para armar el enlace de verificación).
 */
const logger = require('./logger');

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/**
 * Envía un correo. No lanza: ante cualquier fallo lo loguea y devuelve false,
 * para que el flujo que lo llama (ej. registro) nunca se rompa por el email.
 *
 * @param {string} to       Destinatario
 * @param {string} subject  Asunto
 * @param {string} html     Cuerpo HTML
 * @returns {Promise<boolean>} true si Resend aceptó el envío
 */
async function enviarCorreo(to, subject, html) {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.EMAIL_FROM || 'Zenit POS <onboarding@resend.dev>';

    if (!apiKey) {
        // Sin API key configurada: no es un error fatal (la app funciona igual con
        // la política suave). Solo dejamos rastro para saber por qué no llegó.
        logger.warn('[Email] RESEND_API_KEY no configurada; se omite el envío de correo.');
        return false;
    }

    try {
        const resp = await fetch(RESEND_ENDPOINT, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ from, to, subject, html }),
        });

        if (!resp.ok) {
            const detalle = await resp.text().catch(() => '');
            logger.error(`[Email] Resend respondió ${resp.status}: ${detalle}`);
            return false;
        }
        return true;
    } catch (err) {
        logger.error('[Email] Error enviando correo:', err.message);
        return false;
    }
}

/**
 * Base pública del backend (para armar enlaces de correo).
 */
function baseUrl() {
    return (process.env.APP_URL || 'https://zenit-pos-backend.onrender.com').replace(/\/$/, '');
}

/**
 * Construye el enlace de verificación para un token dado.
 */
function urlVerificacion(token) {
    return `${baseUrl()}/api/auth/verify?token=${encodeURIComponent(token)}`;
}

/**
 * Construye el enlace de reseteo de contraseña (abre la página web con el formulario).
 */
function urlReset(token) {
    return `${baseUrl()}/api/auth/reset-password?token=${encodeURIComponent(token)}`;
}

/**
 * Plantilla HTML del correo de confirmación de cuenta.
 */
function plantillaVerificacion(nombre, enlace) {
    const saludo = nombre ? `Hola ${nombre},` : 'Hola,';
    return `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111827;">
      <h1 style="color:#2563eb;font-size:22px;margin:0 0 16px;">Confirma tu correo</h1>
      <p style="font-size:15px;line-height:1.5;">${saludo}</p>
      <p style="font-size:15px;line-height:1.5;">
        Gracias por crear tu cuenta en <strong>Zenit POS</strong>. Confirma tu correo
        para habilitar la recuperación de contraseña y asegurar tu cuenta.
      </p>
      <p style="text-align:center;margin:28px 0;">
        <a href="${enlace}" style="background:#2563eb;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-size:15px;font-weight:600;display:inline-block;">
          Confirmar mi correo
        </a>
      </p>
      <p style="font-size:13px;color:#6b7280;line-height:1.5;">
        Si el botón no funciona, copia y pega este enlace en tu navegador:<br>
        <span style="word-break:break-all;color:#2563eb;">${enlace}</span>
      </p>
      <p style="font-size:13px;color:#6b7280;line-height:1.5;margin-top:20px;">
        El enlace vence en 24 horas. Si tú no creaste esta cuenta, puedes ignorar este correo.
      </p>
    </div>`;
}

/**
 * Envía el correo de verificación a un usuario recién registrado (o en un reenvío).
 * @param {{name?: string, username: string}} user  El usuario (username = su email)
 * @param {string} token  Token de verificación ya guardado en la BD
 * @returns {Promise<boolean>}
 */
async function enviarCorreoVerificacion(user, token) {
    const enlace = urlVerificacion(token);
    const html = plantillaVerificacion(user.name, enlace);
    return enviarCorreo(user.username, 'Confirma tu correo — Zenit POS', html);
}

/**
 * Plantilla HTML del correo de recuperación de contraseña.
 */
function plantillaReset(nombre, enlace) {
    const saludo = nombre ? `Hola ${nombre},` : 'Hola,';
    return `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111827;">
      <h1 style="color:#2563eb;font-size:22px;margin:0 0 16px;">Restablecer contraseña</h1>
      <p style="font-size:15px;line-height:1.5;">${saludo}</p>
      <p style="font-size:15px;line-height:1.5;">
        Recibimos una solicitud para restablecer la contraseña de tu cuenta de
        <strong>Zenit POS</strong>. Pulsa el botón para elegir una nueva.
      </p>
      <p style="text-align:center;margin:28px 0;">
        <a href="${enlace}" style="background:#2563eb;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-size:15px;font-weight:600;display:inline-block;">
          Restablecer mi contraseña
        </a>
      </p>
      <p style="font-size:13px;color:#6b7280;line-height:1.5;">
        Si el botón no funciona, copia y pega este enlace en tu navegador:<br>
        <span style="word-break:break-all;color:#2563eb;">${enlace}</span>
      </p>
      <p style="font-size:13px;color:#6b7280;line-height:1.5;margin-top:20px;">
        El enlace vence en 1 hora y solo puede usarse una vez. Si tú no solicitaste esto,
        ignora este correo: tu contraseña no cambiará.
      </p>
    </div>`;
}

/**
 * Envía el correo de recuperación de contraseña.
 * @param {{name?: string, username: string}} user  El usuario (username = su email)
 * @param {string} token  Token de reseteo en claro (ya guardado hasheado en la BD)
 * @returns {Promise<boolean>}
 */
async function enviarCorreoReset(user, token) {
    const enlace = urlReset(token);
    const html = plantillaReset(user.name, enlace);
    return enviarCorreo(user.username, 'Restablecer tu contraseña — Zenit POS', html);
}

module.exports = { enviarCorreo, enviarCorreoVerificacion, enviarCorreoReset, urlVerificacion, urlReset };
