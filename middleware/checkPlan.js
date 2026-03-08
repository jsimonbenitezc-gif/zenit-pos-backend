const { User } = require('../models');

async function getPlanOwnerForRequest(userId) {
    const actor = await User.findByPk(userId, {
        attributes: ['id', 'business_id']
    });
    if (!actor) return null;
    const ownerId = actor.business_id || actor.id;
    return await User.findByPk(ownerId, {
        attributes: ['id', 'plan', 'plan_expires_at']
    });
}

// Verifica que el usuario tenga plan premium o trial activo.
// Se usa en rutas de funciones premium: inventario, ofertas, sucursales, fidelidad.
const requirePremium = async (req, res, next) => {
    try {
        const owner = await getPlanOwnerForRequest(req.user.id);
        if (!owner) return res.status(401).json({ error: 'Usuario no encontrado' });

        const now = new Date();
        const expiresAt = owner.plan_expires_at ? new Date(owner.plan_expires_at) : null;
        const isPremium = (owner.plan === 'premium' || owner.plan === 'trial') && expiresAt && expiresAt > now;

        if (!isPremium) {
            return res.status(403).json({
                error: 'plan_required',
                message: 'Esta función requiere un plan Premium. Actualiza tu cuenta para continuar.',
                plan: owner.plan,
                expires_at: expiresAt
            });
        }

        // Inyectar plan en req para que las rutas puedan usarlo si necesitan
        req.userPlan = { plan: owner.plan, expires_at: expiresAt };
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
        const owner = await getPlanOwnerForRequest(req.user.id);
        if (owner) {
            const now = new Date();
            const expiresAt = owner.plan_expires_at ? new Date(owner.plan_expires_at) : null;
            req.isPremium = (owner.plan === 'premium' || owner.plan === 'trial') && expiresAt && expiresAt > now;
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
