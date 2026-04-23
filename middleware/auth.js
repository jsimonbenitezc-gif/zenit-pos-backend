const jwt = require('jsonwebtoken');
const { User } = require('../models');

const authenticate = async (req, res, next) => {
    try {
        const token = req.headers.authorization?.split(' ')[1]; // "Bearer TOKEN"

        if (!token) {
            return res.status(401).json({ error: 'Token no proporcionado' });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;

        // owners: business_id = su propio id | staff: business_id = id del dueño al que pertenecen
        // Se recalcula desde DB para soportar tokens antiguos emitidos con business_id incorrecto.
        try {
            const dbUser = await User.findByPk(decoded.id, { attributes: ['id', 'business_id', 'active'] });
            if (dbUser) {
                if (dbUser.active === false) {
                    return res.status(401).json({ error: 'Cuenta desactivada' });
                }
                req.user.business_id = dbUser.business_id || dbUser.id;
            } else {
                req.user.business_id = decoded.business_id || decoded.id;
            }
        } catch {
            req.user.business_id = decoded.business_id || decoded.id;
        }
        next();
    } catch (error) {
        return res.status(401).json({ error: 'Token inválido' });
    }
};

const isOwner = async (req, res, next) => {
    try {
        const dbUser = await User.findByPk(req.user.id, { attributes: ['role'] });
        if (!dbUser || dbUser.role !== 'owner') {
            return res.status(403).json({ error: 'Acceso denegado. Solo para administradores.' });
        }
        next();
    } catch {
        return res.status(500).json({ error: 'Error al verificar permisos' });
    }
};

module.exports = { authenticate, isOwner };
