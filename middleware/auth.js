const jwt = require('jsonwebtoken');

const authenticate = (req, res, next) => {
    try {
        const token = req.headers.authorization?.split(' ')[1]; // "Bearer TOKEN"
        
        if (!token) {
            return res.status(401).json({ error: 'No token provided' });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded; // Guardar info del usuario en la request
        next();
    } catch (error) {
        return res.status(401).json({ error: 'Invalid token' });
    }
};

const isOwner = (req, res, next) => {
    if (req.user.role !== 'owner') {
        return res.status(403).json({ error: 'Access denied. Owner only.' });
    }
    next();
};

module.exports = { authenticate, isOwner };