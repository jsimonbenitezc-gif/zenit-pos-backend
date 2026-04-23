const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { User, sequelize } = require('../models');
const { authenticate } = require('../middleware/auth');
const { enviarNotificacion } = require('../utils/push');

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
                plan_expires_at: user.plan_expires_at || null
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

        const user = await User.create({ username: email, password, name, role: 'owner' });

        const token = jwt.sign(
            { id: user.id, username: user.username, role: user.role, business_id: user.id },
            process.env.JWT_SECRET,
            { expiresIn: '15m' }
        );

        const refreshToken = await generateAndSaveRefreshToken(user);

        res.status(201).json({
            token,
            refreshToken,
            user: { id: user.id, name: user.name, email: user.username, role: user.role }
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
            attributes: ['id', 'name', 'username', 'role', 'plan', 'plan_expires_at', 'business_id']
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

        res.json({ id: user.id, name: user.name, email: user.username, role: user.role, plan, plan_expires_at });
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

module.exports = router;
