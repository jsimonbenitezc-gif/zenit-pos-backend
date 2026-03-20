const express = require('express');
const router = express.Router();
const { User } = require('../models');
const { authenticate } = require('../middleware/auth');

// POST /api/push/token — registrar push token del dispositivo
router.post('/token', authenticate, async (req, res) => {
    try {
        const { token } = req.body;
        if (!token || typeof token !== 'string' || !token.startsWith('ExponentPushToken')) {
            return res.status(400).json({ error: 'Token Expo válido requerido' });
        }

        // Guardar en el owner del negocio (business_id = id del owner)
        const ownerId = req.user.business_id;
        const owner = await User.findByPk(ownerId, { attributes: ['id', 'push_tokens'] });
        if (!owner) return res.status(404).json({ error: 'Usuario no encontrado' });

        let tokens = [];
        try { tokens = JSON.parse(owner.push_tokens || '[]'); } catch {}

        if (!tokens.includes(token)) {
            tokens.push(token);
            // Máximo 10 tokens por negocio para evitar acumulación infinita
            if (tokens.length > 10) tokens = tokens.slice(-10);
            await owner.update({ push_tokens: JSON.stringify(tokens) });
        }

        res.json({ ok: true });
    } catch (error) {
        console.error('Error registrando push token:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// DELETE /api/push/token — eliminar push token al cerrar sesión
router.delete('/token', authenticate, async (req, res) => {
    try {
        const { token } = req.body;
        if (!token) return res.json({ ok: true });

        const ownerId = req.user.business_id;
        const owner = await User.findByPk(ownerId, { attributes: ['id', 'push_tokens'] });
        if (!owner) return res.json({ ok: true });

        let tokens = [];
        try { tokens = JSON.parse(owner.push_tokens || '[]'); } catch {}

        tokens = tokens.filter(t => t !== token);
        await owner.update({ push_tokens: JSON.stringify(tokens) });

        res.json({ ok: true });
    } catch (error) {
        console.error('Error eliminando push token:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

module.exports = router;
