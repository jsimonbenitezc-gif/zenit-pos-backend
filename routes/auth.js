const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { User, sequelize } = require('../models');
const { authenticate } = require('../middleware/auth');
const { enviarNotificacion } = require('../utils/push');
const { enviarCorreoVerificacion, enviarCorreoReset } = require('../utils/email');

// Vigencia del token de verificación de correo
const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 horas
// Vigencia del token de reseteo de contraseña
const RESET_TTL_MS = 60 * 60 * 1000; // 1 hora

// Genera un token opaco (verificación / reseteo)
function generarTokenVerificacion() {
    return crypto.randomBytes(32).toString('hex');
}

// Hash SHA256 (para guardar el token de reseteo sin exponerlo en claro en la BD)
function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

// Protección: máximo 10 intentos de login cada 15 minutos por IP
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 10,
    message: { error: 'Demasiados intentos de inicio de sesión. Intenta de nuevo en 15 minutos.' },
    standardHeaders: true,
    legacyHeaders: false
});

// Protección: máximo 5 registros por hora por IP
const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hora
    max: 5,
    message: { error: 'Demasiados registros desde esta IP. Intenta de nuevo en una hora.' },
    standardHeaders: true,
    legacyHeaders: false
});

// Genera un refresh token opaco y lo guarda hasheado en DB
async function generateAndSaveRefreshToken(user, options = {}) {
    const refreshToken = crypto.randomBytes(64).toString('hex');
    const refreshTokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const refreshTokenExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 días
    await user.update(
        { refresh_token_hash: refreshTokenHash, refresh_token_expires: refreshTokenExpires },
        options
    );
    return refreshToken;
}

// POST /api/auth/login
router.post('/login', loginLimiter, async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'Usuario y contraseña son requeridos' });
        }

        // Buscar usuario
        const user = await User.findOne({ where: { username, active: true } });

        if (!user) {
            return res.status(401).json({ error: 'Credenciales incorrectas' });
        }

        // Verificar contraseña
        const validPassword = await user.comparePassword(password);

        if (!validPassword) {
            return res.status(401).json({ error: 'Credenciales incorrectas' });
        }

        // Crear access token (corta duración)
        const businessId = user.business_id || user.id;
        const token = jwt.sign(
            {
                id: user.id,
                username: user.username,
                role: user.role,
                business_id: businessId,
                branch_id: user.branch_id || null,
                plan: user.plan || 'free',
                plan_expires_at: user.plan_expires_at || null
            },
            process.env.JWT_SECRET,
            { expiresIn: '15m' }
        );

        // Generar refresh token (larga duración, opaco)
        const refreshToken = await generateAndSaveRefreshToken(user);

        // Push notification: nuevo acceso al sistema
        enviarNotificacion(
            businessId,
            'notif_nuevo_acceso',
            '🔓 Nuevo acceso al sistema',
            `${user.name || user.username} inició sesión en la app`
        );

        res.json({
            token,
            refreshToken,
            user: {
                id: user.id,
                username: user.username,
                name: user.name,
                role: user.role,
                business_id: businessId,
                plan: user.plan || 'free',
                plan_expires_at: user.plan_expires_at || null,
                email_verified: user.email_verified !== false
            }
        });
    } catch (error) {
        logger.error('Login error:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// POST /api/auth/register
router.post('/register', registerLimiter, async (req, res) => {
    try {
        const { name, email, password } = req.body;

        if (!name || !email || !password) {
            return res.status(400).json({ error: 'Nombre, email y contraseña son requeridos' });
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ error: 'Formato de email inválido' });
        }

        if (password.length < 8) {
            return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
        }

        const existing = await User.findOne({ where: { username: email } });
        if (existing) {
            return res.status(409).json({ error: 'Ya existe una cuenta con ese email' });
        }

        // Token de verificación de correo (política suave: NO bloquea el uso de la app)
        const verificationToken = generarTokenVerificacion();

        const user = await User.create({
            username: email,
            password,
            name,
            role: 'owner',
            email_verified: false,
            verification_token: verificationToken,
            verification_sent_at: new Date(),
        });

        // Enviar el correo de confirmación en segundo plano (no bloqueamos la
        // respuesta ni fallamos el registro si el correo no sale — la cuenta ya existe).
        enviarCorreoVerificacion(user, verificationToken).catch((err) =>
            logger.error('Error enviando correo de verificación en registro:', err.message)
        );

        const token = jwt.sign(
            { id: user.id, username: user.username, role: user.role, business_id: user.id },
            process.env.JWT_SECRET,
            { expiresIn: '15m' }
        );

        const refreshToken = await generateAndSaveRefreshToken(user);

        res.status(201).json({
            token,
            refreshToken,
            user: { id: user.id, name: user.name, email: user.username, role: user.role, email_verified: false }
        });
    } catch (error) {
        logger.error('Register error:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// POST /api/auth/change-password
router.post('/change-password', authenticate, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;

        if (!newPassword || newPassword.length < 8) {
            return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 8 caracteres' });
        }

        const user = await User.findByPk(req.user.id);
        const validPassword = await user.comparePassword(currentPassword);

        if (!validPassword) {
            return res.status(401).json({ error: 'La contraseña actual es incorrecta' });
        }

        user.password = newPassword;
        await user.save();

        res.json({ message: 'Contraseña cambiada correctamente' });
    } catch (error) {
        logger.error('Error al cambiar contraseña:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// GET /api/auth/me - Validar token actual
router.get('/me', authenticate, async (req, res) => {
    try {
        const user = await User.findByPk(req.user.id, {
            attributes: ['id', 'name', 'username', 'role', 'plan', 'plan_expires_at', 'business_id', 'email_verified']
        });
        if (!user) return res.status(401).json({ error: 'Usuario no encontrado' });

        // Si es staff, el plan pertenece al dueño (business_id)
        let plan = user.plan || 'free';
        let plan_expires_at = user.plan_expires_at || null;
        if (user.business_id) {
            const owner = await User.findByPk(user.business_id, {
                attributes: ['plan', 'plan_expires_at']
            });
            if (owner) {
                plan = owner.plan || 'free';
                plan_expires_at = owner.plan_expires_at || null;
            }
        }

        res.json({ id: user.id, name: user.name, email: user.username, role: user.role, plan, plan_expires_at, email_verified: user.email_verified !== false });
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Protección: máximo 20 intentos de refresh por minuto por IP
const refreshLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    message: { error: 'Demasiados intentos de refresh. Intenta de nuevo en un minuto.' },
    standardHeaders: true,
    legacyHeaders: false
});

// POST /api/auth/refresh — Rotar access + refresh token
router.post('/refresh', refreshLimiter, async (req, res) => {
    try {
        const { refreshToken } = req.body;

        if (!refreshToken) {
            return res.status(400).json({ error: 'refreshToken es requerido' });
        }

        // Hashear el token recibido y buscar en DB
        const hash = crypto.createHash('sha256').update(refreshToken).digest('hex');
        const user = await User.findOne({ where: { refresh_token_hash: hash, active: true } });

        if (!user) {
            return res.status(401).json({ error: 'Refresh token inválido' });
        }

        // Verificar expiración
        if (user.refresh_token_expires && new Date(user.refresh_token_expires) < new Date()) {
            await user.update({ refresh_token_hash: null, refresh_token_expires: null });
            return res.status(401).json({ error: 'Refresh token expirado. Inicia sesión de nuevo.' });
        }

        // Rotación atómica: invalidar viejo + generar nuevo en una transacción
        const resultado = await sequelize.transaction(async (t) => {
            // Invalidar el refresh token viejo inmediatamente
            await user.update(
                { refresh_token_hash: null, refresh_token_expires: null },
                { transaction: t }
            );

            // Generar nuevo access token
            const businessId = user.business_id || user.id;
            const nuevoAccessToken = jwt.sign(
                {
                    id: user.id,
                    username: user.username,
                    role: user.role,
                    business_id: businessId,
                    branch_id: user.branch_id || null,
                    plan: user.plan || 'free',
                    plan_expires_at: user.plan_expires_at || null
                },
                process.env.JWT_SECRET,
                { expiresIn: '15m' }
            );

            // Generar y guardar nuevo refresh token
            const nuevoRefreshToken = await generateAndSaveRefreshToken(user, { transaction: t });

            return { nuevoAccessToken, nuevoRefreshToken, businessId };
        });

        res.json({
            token: resultado.nuevoAccessToken,
            refreshToken: resultado.nuevoRefreshToken,
            user: {
                id: user.id,
                username: user.username,
                name: user.name,
                role: user.role,
                business_id: resultado.businessId,
                plan: user.plan || 'free',
                plan_expires_at: user.plan_expires_at || null
            }
        });
    } catch (error) {
        logger.error('Refresh token error:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Página HTML simple de resultado de la verificación (autocontenida).
function paginaResultado(titulo, mensaje, ok) {
    const color = ok ? '#16a34a' : '#dc2626';
    const bg = ok ? '#f0fdf4' : '#fef2f2';
    const icono = ok ? '✓' : '✕';
    return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${titulo}</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;text-align:center;padding:60px 24px;background:${bg};color:#374151;}
.icono{font-size:56px;color:${color};line-height:1;}
h1{color:${color};font-size:22px;margin:16px 0 8px;}p{font-size:15px;line-height:1.5;max-width:420px;margin:0 auto;}</style></head>
<body><div class="icono">${icono}</div><h1>${titulo}</h1><p>${mensaje}</p></body></html>`;
}

// GET /api/auth/verify?token=... — Confirmar correo desde el enlace del email.
// Público (el usuario llega desde su bandeja de entrada). Muestra una página HTML.
router.get('/verify', async (req, res) => {
    try {
        const { token } = req.query;

        if (!token) {
            return res.status(400).send(paginaResultado(
                'Enlace inválido',
                'El enlace de confirmación está incompleto. Vuelve a solicitarlo desde la app.',
                false
            ));
        }

        const user = await User.findOne({ where: { verification_token: token } });

        if (!user) {
            // Token no encontrado: o ya se usó (correo ya confirmado) o es inválido.
            return res.status(200).send(paginaResultado(
                'Enlace no válido',
                'Este enlace ya fue usado o no es válido. Si ya confirmaste tu correo, no necesitas hacer nada.',
                true
            ));
        }

        // ¿Expiró?
        const enviado = user.verification_sent_at ? new Date(user.verification_sent_at).getTime() : 0;
        if (!enviado || Date.now() - enviado > VERIFICATION_TTL_MS) {
            return res.status(200).send(paginaResultado(
                'El enlace venció',
                'Este enlace de confirmación ya venció. Abre Zenit POS y pulsa "Reenviar correo" para recibir uno nuevo.',
                false
            ));
        }

        // Confirmar: marcar verificado y limpiar el token (un solo uso).
        await user.update({ email_verified: true, verification_token: null });

        return res.status(200).send(paginaResultado(
            '¡Correo confirmado!',
            'Tu correo quedó confirmado. Ya puedes cerrar esta ventana y volver a Zenit POS.',
            true
        ));
    } catch (error) {
        logger.error('Verify email error:', error);
        return res.status(500).send(paginaResultado(
            'Ocurrió un error',
            'No pudimos confirmar tu correo en este momento. Intenta de nuevo más tarde.',
            false
        ));
    }
});

// Protección: máximo 3 reenvíos de verificación cada 10 minutos por IP
const resendLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 3,
    message: { error: 'Demasiados reenvíos. Espera unos minutos antes de intentar de nuevo.' },
    standardHeaders: true,
    legacyHeaders: false
});

// POST /api/auth/resend-verification — Reenviar el correo de confirmación.
// Autenticado: solo el propio usuario puede pedir que le reenvíen su correo.
router.post('/resend-verification', resendLimiter, authenticate, async (req, res) => {
    try {
        const user = await User.findByPk(req.user.id);
        if (!user) return res.status(401).json({ error: 'Usuario no encontrado' });

        if (user.email_verified) {
            return res.json({ message: 'Tu correo ya está confirmado.', email_verified: true });
        }

        // Nuevo token + timestamp (invalida el enlace anterior)
        const nuevoToken = generarTokenVerificacion();
        await user.update({ verification_token: nuevoToken, verification_sent_at: new Date() });

        const enviado = await enviarCorreoVerificacion(user, nuevoToken);
        if (!enviado) {
            return res.status(502).json({
                error: 'No pudimos enviar el correo en este momento. Intenta de nuevo más tarde.'
            });
        }

        return res.json({ message: `Te enviamos un correo de confirmación a ${user.username}.`, email_verified: false });
    } catch (error) {
        logger.error('Resend verification error:', error);
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  RECUPERACIÓN DE CONTRASEÑA ("olvidé mi contraseña")
//  Flujo 100% web (el enlace del correo abre el navegador), compatible con
//  cualquier versión del cliente (incluso builds viejos).
// ─────────────────────────────────────────────────────────────────────────────

// Protección: máximo 5 solicitudes de reseteo cada 15 min por IP
const forgotLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { error: 'Demasiadas solicitudes. Intenta de nuevo en unos minutos.' },
    standardHeaders: true,
    legacyHeaders: false
});

// POST /api/auth/forgot-password — Solicitar el correo de reseteo.
// Anti-enumeración: responde siempre igual, exista o no el correo.
router.post('/forgot-password', forgotLimiter, async (req, res) => {
    const respuestaGenerica = {
        message: 'Si existe una cuenta con ese correo, te enviamos un enlace para restablecer tu contraseña.'
    };
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: 'El correo es requerido' });

        // Solo dueños (username = email). El staff no tiene correo propio.
        const user = await User.findOne({ where: { username: email, active: true } });

        if (user) {
            const token = generarTokenVerificacion();
            await user.update({
                reset_token: hashToken(token),
                reset_token_expires: new Date(Date.now() + RESET_TTL_MS),
            });
            // Envío en segundo plano; no revelamos si falló (anti-enumeración).
            enviarCorreoReset(user, token).catch((err) =>
                logger.error('Error enviando correo de reseteo:', err.message)
            );
        }

        return res.json(respuestaGenerica);
    } catch (error) {
        logger.error('Forgot password error:', error);
        // Aun ante error interno devolvemos genérico para no filtrar información.
        return res.json(respuestaGenerica);
    }
});

// Página HTML con el formulario de nueva contraseña.
function paginaFormularioReset(token) {
    const tokenJson = JSON.stringify(token);
    return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Restablecer contraseña — Zenit POS</title>
<style>
body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#eef1f5;color:#111827;margin:0;padding:24px;}
.card{max-width:400px;margin:40px auto;background:#fff;border-radius:14px;padding:28px 24px;box-shadow:0 4px 20px rgba(0,0,0,.06);}
h1{color:#2563eb;font-size:20px;margin:0 0 6px;}
p.sub{color:#6b7280;font-size:14px;margin:0 0 20px;}
label{display:block;font-size:13px;font-weight:600;margin:14px 0 6px;}
input{width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:15px;}
button{width:100%;margin-top:20px;background:#2563eb;color:#fff;border:0;border-radius:8px;padding:12px;font-size:15px;font-weight:600;cursor:pointer;}
button:disabled{opacity:.6;cursor:default;}
.msg{margin-top:14px;font-size:14px;text-align:center;min-height:18px;}
.err{color:#dc2626;}.ok{color:#16a34a;}
</style></head>
<body><div class="card">
  <h1>Restablecer contraseña</h1>
  <p class="sub">Elige una nueva contraseña para tu cuenta de Zenit POS.</p>
  <label for="p1">Nueva contraseña</label>
  <input id="p1" type="password" autocomplete="new-password" placeholder="Mínimo 8 caracteres">
  <label for="p2">Confirmar contraseña</label>
  <input id="p2" type="password" autocomplete="new-password" placeholder="Repite la contraseña">
  <button id="btn">Guardar contraseña</button>
  <div class="msg" id="msg"></div>
</div>
<script>
  var TOKEN = ${tokenJson};
  var btn = document.getElementById('btn');
  var msg = document.getElementById('msg');
  btn.addEventListener('click', function(){
    var p1 = document.getElementById('p1').value;
    var p2 = document.getElementById('p2').value;
    msg.className = 'msg';
    if (p1.length < 8){ msg.className='msg err'; msg.textContent='La contraseña debe tener al menos 8 caracteres.'; return; }
    if (p1 !== p2){ msg.className='msg err'; msg.textContent='Las contraseñas no coinciden.'; return; }
    btn.disabled = true; btn.textContent = 'Guardando...';
    fetch('/api/auth/reset-password', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ token: TOKEN, password: p1 })
    }).then(function(r){ return r.json().then(function(d){ return { ok:r.ok, d:d }; }); })
      .then(function(res){
        if (res.ok){
          document.querySelector('.card').innerHTML =
            '<h1 style="color:#16a34a">¡Listo!</h1><p class="sub">Tu contraseña se actualizó. Ya puedes iniciar sesión en Zenit POS con tu nueva contraseña.</p>';
        } else {
          msg.className='msg err'; msg.textContent = (res.d && res.d.error) || 'No se pudo cambiar la contraseña.';
          btn.disabled=false; btn.textContent='Guardar contraseña';
        }
      })
      .catch(function(){ msg.className='msg err'; msg.textContent='Error de conexión. Intenta de nuevo.'; btn.disabled=false; btn.textContent='Guardar contraseña'; });
  });
</script>
</body></html>`;
}

// GET /api/auth/reset-password?token=... — Página web con el formulario.
// Valida el token antes de mostrar el formulario (mejor UX).
router.get('/reset-password', async (req, res) => {
    try {
        const { token } = req.query;
        if (!token) {
            return res.status(400).send(paginaResultado('Enlace inválido',
                'El enlace de recuperación está incompleto. Solicítalo de nuevo.', false));
        }

        const user = await User.findOne({ where: { reset_token: hashToken(token) } });
        if (!user || !user.reset_token_expires || new Date(user.reset_token_expires) < new Date()) {
            return res.status(200).send(paginaResultado('El enlace venció',
                'Este enlace de recuperación ya venció o no es válido. Vuelve a solicitar uno desde la app.', false));
        }

        return res.status(200).send(paginaFormularioReset(token));
    } catch (error) {
        logger.error('Reset password (GET) error:', error);
        return res.status(500).send(paginaResultado('Ocurrió un error',
            'No pudimos abrir el formulario. Intenta de nuevo más tarde.', false));
    }
});

// POST /api/auth/reset-password — Aplica la nueva contraseña.
router.post('/reset-password', async (req, res) => {
    try {
        const { token, password } = req.body;
        if (!token || !password) {
            return res.status(400).json({ error: 'Token y contraseña son requeridos' });
        }
        if (password.length < 8) {
            return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
        }

        const user = await User.findOne({ where: { reset_token: hashToken(token) } });
        if (!user || !user.reset_token_expires || new Date(user.reset_token_expires) < new Date()) {
            return res.status(400).json({ error: 'El enlace venció o no es válido. Solicita uno nuevo.' });
        }

        // Cambiar la contraseña (el hook beforeUpdate la hashea), consumir el token,
        // marcar el correo como verificado (usar el enlace prueba que es suyo) e
        // invalidar las sesiones activas (refresh tokens) por seguridad.
        await user.update({
            password,
            reset_token: null,
            reset_token_expires: null,
            email_verified: true,
            verification_token: null,
            refresh_token_hash: null,
            refresh_token_expires: null,
        });

        return res.json({ message: 'Contraseña actualizada. Inicia sesión con tu nueva contraseña.' });
    } catch (error) {
        // Log estructurado (visible en los logs de Render) para diagnosticar si reaparece.
        logger.error('Reset password (POST) error:', {
            name: error && error.name,
            message: error && error.message,
            parent: error && error.parent && error.parent.message,
            code: error && error.parent && error.parent.code,
        });
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});

module.exports = router;
