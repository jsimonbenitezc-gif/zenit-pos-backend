const { User } = require('../models');

// Verifica que el usuario tenga plan premium o trial activo.
// Se usa en rutas de funciones premium: inventario, ofertas, sucursales, fidelidad.
const requirePremium = async (req, res, next) => {
    try {
        const user = await User.findByPk(req.user.id, {
            attributes: ['id', 'plan', 'plan_expires_at']
        });
        if (!user) return res.status(401).json({ error: 'Usuario no encontrado' });

        const now = new Date();
        const expiresAt = user.plan_expires_at ? new Date(user.plan_expires_at) : null;
        const isPremium = (user.plan === 'premium' || user.plan === 'trial') && expiresAt && expiresAt > now;

        if (!isPremium) {
            return res.status(403).json({
                error: 'plan_required',
                message: 'Esta función requiere un plan Premium. Actualiza tu cuenta para continuar.',
                plan: user.plan,
                expires_at: expiresAt
            });
        }

        // Inyectar plan en req para que las rutas puedan usarlo si necesitan
        req.userPlan = { plan: user.plan, expires_at: expiresAt };
        next();
    } catch (err) {
        console.error('checkPlan error:', err);
        res.status(500).json({ error: 'Error verificando plan' });
    }
};

// Middleware ligero para límites del plan free (no requiere DB, usa el JWT).
// Llama a next() siempre — las rutas deciden qué hacer con req.isPremium.
const injectPlan = async (req, res, next) => {
    try {
        const user = await User.findByPk(req.user.id, {
            attributes: ['id', 'plan', 'plan_expires_at']
        });
        if (user) {
            const now = new Date();
            const expiresAt = user.plan_expires_at ? new Date(user.plan_expires_at) : null;
            req.isPremium = (user.plan === 'premium' || user.plan === 'trial') && expiresAt && expiresAt > now;
        } else {
            req.isPremium = false;
        }
        next();
    } catch (err) {
        req.isPremium = false;
        next();
    }
};

module.exports = { requirePremium, injectPlan };
