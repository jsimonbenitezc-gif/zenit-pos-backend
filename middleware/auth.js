const jwt = require('jsonwebtoken');
const { User } = require('../models');

const authenticate = (req, res, next) => {
    try {
        const token = req.headers.authorization?.split(' ')[1]; // "Bearer TOKEN"
        
        if (!token) {
            return res.status(401).json({ error: 'Token no proporcionado' });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;

        // owners: business_id = su propio id | staff: business_id = id del dueño al que pertenecen
        // Se recalcula desde DB para soportar tokens antiguos emitidos con business_id incorrecto.
        User.findByPk(decoded.id, { attributes: ['id', 'business_id'] })
            .then((dbUser) => {
                if (dbUser) {
                    req.user.business_id = dbUser.business_id || dbUser.id;
                } else {
                    req.user.business_id = decoded.business_id || decoded.id;
                }
                next();
            })
            .catch(() => {
                req.user.business_id = decoded.business_id || decoded.id;
                next();
            });
    } catch (error) {
        return res.status(401).json({ error: 'Token inválido' });
    }
};

const isOwner = (req, res, next) => {
    if (req.user.role !== 'owner') {
        return res.status(403).json({ error: 'Acceso denegado. Solo para administradores.' });
    }
    next();
};

module.exports = { authenticate, isOwner };
