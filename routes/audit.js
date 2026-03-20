const express = require('express');
const router = express.Router();
const { PrivilegedActionLog, Branch } = require('../models');
const { authenticate, isOwner } = require('../middleware/auth');
const jwt = require('jsonwebtoken');
const { enviarNotificacion } = require('../utils/push');

// ── SSE: notificaciones en tiempo real de nuevas acciones privilegiadas ────
const _auditClients = new Map(); // businessId (string) → Set<Response>

function _notificarAudit(businessId) {
    const clients = _auditClients.get(String(businessId));
    if (!clients || clients.size === 0) return;
    const msg = `data: {}\n\n`;
    for (const res of clients) {
        try { res.write(msg); } catch { /* cliente desconectado */ }
    }
}

// GET /api/audit/events — SSE stream para el dashboard del dueño
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
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const heartbeat = setInterval(() => {
        try { res.write(': ping\n\n'); } catch { clearInterval(heartbeat); }
    }, 25000);

    const biz = String(businessId);
    if (!_auditClients.has(biz)) _auditClients.set(biz, new Set());
    _auditClients.get(biz).add(res);

    req.on('close', () => {
        clearInterval(heartbeat);
        _auditClients.get(biz)?.delete(res);
    });
});

// GET /api/audit — Listar registros de acciones privilegiadas (solo dueño)
// Query params opcionales: action_type, limit (max 100), page
router.get('/', authenticate, isOwner, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const limitNum = Math.min(parseInt(req.query.limit) || 50, 100);
        const pageNum  = Math.max(parseInt(req.query.page)  || 1, 1);
        const offset   = (pageNum - 1) * limitNum;

        const where = { business_id: biz };
        if (req.query.action_type) where.action_type = req.query.action_type;
        if (req.query.branch_id)   where.branch_id   = parseInt(req.query.branch_id);

        const { count, rows } = await PrivilegedActionLog.findAndCountAll({
            where,
            include: [{ model: Branch, as: 'branch', attributes: ['id', 'name'], required: false }],
            order: [['createdAt', 'DESC']],
            limit: limitNum,
            offset
        });

        res.json({
            data: rows,
            pagination: {
                total: count,
                page: pageNum,
                limit: limitNum,
                pages: Math.ceil(count / limitNum)
            }
        });
    } catch (error) {
        console.error('Error al obtener logs de auditoría:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// POST /api/audit — Registrar una acción privilegiada desde el frontend
// Usado para descuentos que requieren PIN (validado localmente en el frontend)
router.post('/', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const { employee_id, employee_name, action_type, target_description, before_data, after_data, branch_id } = req.body;

        if (!employee_name || !action_type) {
            return res.status(400).json({ error: 'employee_name y action_type son requeridos' });
        }

        const log = await PrivilegedActionLog.create({
            business_id: biz,
            branch_id: branch_id || null,
            employee_id: employee_id || req.user.id,
            employee_name,
            action_type,
            target_description: target_description || null,
            before_data: before_data ? JSON.stringify(before_data) : null,
            after_data: after_data ? JSON.stringify(after_data) : null
        });

        _notificarAudit(biz);

        // Push notification: descuento con PIN aplicado
        if (action_type === 'apply_discount') {
            enviarNotificacion(
                biz,
                'notif_descuento_pin',
                '🔑 Descuento con PIN aplicado',
                `${employee_name} aplicó: ${target_description || 'descuento'}`
            );
        }

        res.status(201).json(log);
    } catch (error) {
        console.error('Error al registrar acción de auditoría:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

router.notificarAudit = _notificarAudit;
module.exports = router;
