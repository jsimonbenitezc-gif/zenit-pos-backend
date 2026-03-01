const express = require('express');
const router = express.Router();
const { User } = require('../models');
const { authenticate } = require('../middleware/auth');

// GET /api/settings - Obtener ajustes del negocio (PINs, permisos, etc.)
router.get('/', authenticate, async (req, res) => {
    try {
        const user = await User.findByPk(req.user.id, { attributes: ['id', 'settings'] });
        if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
        const settings = user.settings ? JSON.parse(user.settings) : {};
        res.json(settings);
    } catch (error) {
        console.error('Error al obtener ajustes:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// PUT /api/settings - Guardar ajustes del negocio
router.put('/', authenticate, async (req, res) => {
    try {
        const user = await User.findByPk(req.user.id);
        if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
        const current = user.settings ? JSON.parse(user.settings) : {};
        const updated = { ...current, ...req.body };
        await user.update({ settings: JSON.stringify(updated) });
        res.json(updated);
    } catch (error) {
        console.error('Error al guardar ajustes:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

module.exports = router;
