const express = require('express');
const router = express.Router();
const { Op } = require('sequelize');
const { Turno, Order } = require('../models');
const { authenticate } = require('../middleware/auth');
const jwt = require('jsonwebtoken');

// ── SSE: notificaciones en tiempo real de cambios de turno ───────────────────
const _turnoClients = new Map(); // businessId (string) → Set<Response>

function _notificarTurno(businessId) {
    const clients = _turnoClients.get(String(businessId));
    if (!clients || clients.size === 0) return;
    const msg = `data: {}\n\n`;
    for (const res of clients) {
        try { res.write(msg); } catch { /* cliente desconectado */ }
    }
}

// GET /api/turnos/events — SSE para actualizaciones de turno en tiempo real
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
    if (!_turnoClients.has(biz)) _turnoClients.set(biz, new Set());
    _turnoClients.get(biz).add(res);

    req.on('close', () => {
        clearInterval(heartbeat);
        _turnoClients.get(biz)?.delete(res);
    });
});

// GET /api/turnos/activo — Turno activo del negocio (o sucursal si se indica)
router.get('/activo', authenticate, async (req, res) => {
    try {
        const where = { business_id: req.user.business_id, estado: 'abierto' };
        if (req.query.branch_id) where.branch_id = req.query.branch_id;

        const turno = await Turno.findOne({ where, order: [['apertura', 'DESC']] });
        if (!turno) return res.json(null);
        res.json(turno);
    } catch (error) {
        console.error('Error al obtener turno activo:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// GET /api/turnos/historial — Turnos cerrados (paginado, últimos 50)
router.get('/historial', authenticate, async (req, res) => {
    try {
        const where = { business_id: req.user.business_id, estado: 'cerrado' };
        if (req.query.branch_id) where.branch_id = req.query.branch_id;

        const turnos = await Turno.findAll({
            where,
            order: [['cierre', 'DESC']],
            limit: 50
        });
        res.json(turnos);
    } catch (error) {
        console.error('Error al obtener historial de turnos:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// POST /api/turnos — Abrir un nuevo turno
router.post('/', authenticate, async (req, res) => {
    try {
        const { cajero_nombre, rol, fondo_inicial, branch_id } = req.body;

        // Solo puede haber un turno abierto por sucursal
        const existing = await Turno.findOne({
            where: {
                business_id: req.user.business_id,
                estado: 'abierto',
                ...(branch_id ? { branch_id } : {})
            }
        });
        if (existing) {
            return res.status(400).json({ error: 'Ya hay un turno abierto' });
        }

        const turno = await Turno.create({
            business_id: req.user.business_id,
            branch_id:   branch_id   || null,
            cajero_nombre: cajero_nombre || 'Sin nombre',
            rol:         rol          || null,
            fondo_inicial: parseFloat(fondo_inicial) || 0,
            apertura:    new Date(),
            estado:      'abierto'
        });

        _notificarTurno(req.user.business_id);
        res.status(201).json(turno);
    } catch (error) {
        console.error('Error al abrir turno:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// GET /api/turnos/:id/totales — Totales en tiempo real para un turno abierto
router.get('/:id/totales', authenticate, async (req, res) => {
    try {
        const turno = await Turno.findOne({
            where: { id: req.params.id, business_id: req.user.business_id }
        });
        if (!turno) return res.status(404).json({ error: 'Turno no encontrado' });

        const pedidos = await Order.findAll({
            where: {
                business_id: req.user.business_id,
                status: 'completado',
                createdAt: { [Op.gte]: turno.apertura },
                ...(turno.branch_id ? { branch_id: turno.branch_id } : {})
            },
            attributes: ['id', 'total', 'payment_method']
        });

        let totalVentas = 0, totalEfectivo = 0, totalTarjeta = 0, totalTransferencia = 0;
        for (const p of pedidos) {
            const t = parseFloat(p.total) || 0;
            totalVentas += t;
            const metodo = (p.payment_method || '').toLowerCase();
            if (metodo === 'tarjeta' || metodo === 'card') {
                totalTarjeta += t;
            } else if (metodo === 'transferencia') {
                totalTransferencia += t;
            } else {
                totalEfectivo += t;
            }
        }

        res.json({
            total_pedidos:       pedidos.length,
            total_ventas:        parseFloat(totalVentas.toFixed(2)),
            total_efectivo:      parseFloat(totalEfectivo.toFixed(2)),
            total_tarjeta:       parseFloat(totalTarjeta.toFixed(2)),
            total_transferencia: parseFloat(totalTransferencia.toFixed(2))
        });
    } catch (error) {
        console.error('Error calculando totales de turno:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// PUT /api/turnos/:id/cerrar — Cerrar turno y calcular totales
router.put('/:id/cerrar', authenticate, async (req, res) => {
    try {
        const turno = await Turno.findOne({
            where: { id: req.params.id, business_id: req.user.business_id, estado: 'abierto' }
        });
        if (!turno) return res.status(404).json({ error: 'Turno no encontrado o ya cerrado' });

        const { efectivo_contado, notas } = req.body;
        const efectivo = parseFloat(efectivo_contado) || 0;
        const ahora    = new Date();

        // Calcular totales desde los pedidos creados durante el turno
        const pedidos = await Order.findAll({
            where: {
                business_id: req.user.business_id,
                status: 'completado',
                createdAt: { [Op.between]: [turno.apertura, ahora] },
                ...(turno.branch_id ? { branch_id: turno.branch_id } : {})
            },
            attributes: ['id', 'total', 'payment_method']
        });

        let totalVentas = 0;
        let totalEfectivo = 0;
        let totalTarjeta = 0;
        let totalTransferencia = 0;

        for (const p of pedidos) {
            const t = parseFloat(p.total) || 0;
            totalVentas += t;
            const metodo = (p.payment_method || '').toLowerCase();
            if (metodo === 'tarjeta' || metodo === 'card') {
                totalTarjeta += t;
            } else if (metodo === 'transferencia') {
                totalTransferencia += t;
            } else {
                totalEfectivo += t;
            }
        }

        const diferencia = efectivo - parseFloat(turno.fondo_inicial || 0) - totalEfectivo;

        await turno.update({
            estado:             'cerrado',
            cierre:             ahora,
            efectivo_contado:   efectivo,
            diferencia:         parseFloat(diferencia.toFixed(2)),
            total_pedidos:      pedidos.length,
            total_ventas:       parseFloat(totalVentas.toFixed(2)),
            total_efectivo:     parseFloat(totalEfectivo.toFixed(2)),
            total_tarjeta:      parseFloat(totalTarjeta.toFixed(2)),
            total_transferencia: parseFloat(totalTransferencia.toFixed(2)),
            notas:              notas || null
        });

        _notificarTurno(req.user.business_id);
        res.json(turno);
    } catch (error) {
        console.error('Error al cerrar turno:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

module.exports = router;
module.exports._notificarTurno = _notificarTurno;
