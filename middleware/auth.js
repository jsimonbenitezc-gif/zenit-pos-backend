const jwt = require('jsonwebtoken');

const authenticate = (req, res, next) => {
    try {
        const token = req.headers.authorization?.split(' ')[1]; // "Bearer TOKEN"
        
        if (!token) {
            return res.status(401).json({ error: 'No token provided' });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
        req.user.business_id = decoded.business_id || decoded.id; // owners: business_id = su propio id
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