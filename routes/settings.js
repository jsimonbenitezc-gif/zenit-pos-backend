const express = require('express');
const router = express.Router();
const { User } = require('../models');
const { authenticate } = require('../middleware/auth');
const jwt = require('jsonwebtoken');

// ── SSE: notificaciones en tiempo real de cambios en ajustes ──────────────────
const _settingsClients = new Map(); // businessId (string) → Set<Response>

function _notificarSettings(businessId) {
    const clients = _settingsClients.get(String(businessId));
    if (!clients || clients.size === 0) return;
    const msg = `data: {}\n\n`;
    for (const res of clients) {
        try { res.write(msg); } catch { /* cliente desconectado */ }
    }
}

// GET /api/settings/events - SSE para actualizaciones de ajustes
// Auth via query param ?token=JWT (EventSource no soporta headers)
router.get('/events', (req, res) => {
    const token = req.query.token;
    if (!token) return res.status(401).end();
    let businessId;
    try {
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        businessId = payload.business_id;
    } catch {
        return res.status(401).end();
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // importante para Render.com / nginx
    res.flushHeaders();

    // Heartbeat cada 25s para evitar timeout en Render.com
    const heartbeat = setInterval(() => {
        try { res.write(': ping\n\n'); } catch { clearInterval(heartbeat); }
    }, 25000);

    const biz = String(businessId);
    if (!_settingsClients.has(biz)) _settingsClients.set(biz, new Set());
    _settingsClients.get(biz).add(res);

    req.on('close', () => {
        clearInterval(heartbeat);
        _settingsClients.get(biz)?.delete(res);
    });
});

// GET /api/settings - Obtener ajustes del negocio
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
        const ALLOWED_KEYS = [
            'business_name', 'business_phone', 'business_email', 'business_website',
            'business_rfc', 'business_instagram', 'business_city', 'business_state',
            'business_address', 'business_tipo',
            'currency_symbol', 'ticket_footer',
            'show_logo', 'show_phone', 'show_direccion', 'show_email',
            'show_website', 'show_instagram', 'show_rfc',
            'logo_base64',
            'venta_sin_turno',
            'puntos_activos', 'puntos_por_peso', 'puntos_bono_pedido', 'puntos_valor',
            'permisos_roles',
            'sucursal_id',
        ];
        const incoming = {};
        for (const key of ALLOWED_KEYS) {
            if (key in req.body) incoming[key] = req.body[key];
        }
        const updated = { ...current, ...incoming };
        await user.update({ settings: JSON.stringify(updated) });
        // Notificar a todos los dispositivos conectados del mismo negocio
        _notificarSettings(req.user.business_id);
        res.json(updated);
    } catch (error) {
        console.error('Error al guardar ajustes:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

module.exports = router;
