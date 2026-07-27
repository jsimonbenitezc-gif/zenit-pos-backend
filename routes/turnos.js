const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { Op } = require('sequelize');
const { Turno, Order, sequelize } = require('../models');
const { authenticate } = require('../middleware/auth');
const { filtroVentaContable } = require('../utils/ordersFilter');
const { resolverBranchId, filtroSucursalTurno, BranchError } = require('../utils/branch');
const { configurarSSE } = require('../utils/sse');
const { enviarNotificacion, getPrefs } = require('../utils/push');

// ── SSE: notificaciones en tiempo real de cambios de turno ───────────────────
const _turnoClients = new Map(); // businessId (string) → Set<Response>

function _notificarTurno(businessId) {
    const clients = _turnoClients.get(String(businessId));
    if (!clients || clients.size === 0) return;
    const msg = `data: {}\n\n`;
    for (const res of clients) {
        if (res.writableEnded) { clients.delete(res); continue; }
        try { res.write(msg); } catch { clients.delete(res); }
    }
}

router.get('/events', (req, res) => {
    configurarSSE(_turnoClients, req, res);
});

// GET /api/turnos/activo — Turno activo del negocio (o sucursal si se indica)
router.get('/activo', authenticate, async (req, res) => {
    try {
        const where = { business_id: req.user.business_id, estado: 'abierto' };
        // Un empleado asignado a una sucursal solo ve el turno de la suya: así no puede
        // cerrar por error la caja de otra sucursal.
        if (req.user.branch_id) where.branch_id = req.user.branch_id;
        else if (req.query.branch_id) where.branch_id = req.query.branch_id;

        const turno = await Turno.findOne({ where, order: [['apertura', 'DESC']] });
        if (!turno) return res.json(null);
        res.json(turno);
    } catch (error) {
        logger.error('Error al obtener turno activo:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// GET /api/turnos/historial — Turnos cerrados (paginado, últimos 50)
router.get('/historial', authenticate, async (req, res) => {
    try {
        const where = { business_id: req.user.business_id, estado: 'cerrado' };
        if (req.user.branch_id) where.branch_id = req.user.branch_id;
        else if (req.query.branch_id) where.branch_id = req.query.branch_id;

        const turnos = await Turno.findAll({
            where,
            order: [['cierre', 'DESC']],
            limit: 50
        });
        res.json(turnos);
    } catch (error) {
        logger.error('Error al obtener historial de turnos:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// POST /api/turnos — Abrir un nuevo turno
router.post('/', authenticate, async (req, res) => {
    const t = await sequelize.transaction();
    try {
        const { cajero_nombre, rol, fondo_inicial, branch_id } = req.body;

        if (parseFloat(fondo_inicial) < 0) {
            await t.rollback();
            return res.status(400).json({ error: 'El fondo inicial no puede ser negativo' });
        }

        // Sucursal del turno (BLOQUE 4): un turno sin sucursal hacía que el cierre
        // sumara los pedidos de TODAS las sucursales. Ver utils/branch.js.
        let branchIdFinal;
        try {
            branchIdFinal = await resolverBranchId({ user: req.user, branchId: branch_id, transaction: t });
        } catch (branchErr) {
            if (branchErr instanceof BranchError) {
                await t.rollback();
                return res.status(branchErr.status).json({ error: branchErr.message });
            }
            throw branchErr;
        }

        // Solo puede haber un turno abierto por sucursal.
        // El FOR UPDATE bloquea la fila si existe; el índice parcial único en BD
        // rechaza la creación si dos requests llegan al mismo tiempo.
        const existing = await Turno.findOne({
            where: {
                business_id: req.user.business_id,
                estado: 'abierto',
                branch_id: branchIdFinal
            },
            lock: t.LOCK.UPDATE,
            transaction: t
        });
        if (existing) {
            await t.rollback();
            return res.status(400).json({ error: 'Ya hay un turno abierto' });
        }

        const turno = await Turno.create({
            business_id: req.user.business_id,
            branch_id:   branchIdFinal,
            cajero_nombre: cajero_nombre || 'Sin nombre',
            rol:         rol          || null,
            fondo_inicial: parseFloat(fondo_inicial) || 0,
            apertura:    new Date(),
            estado:      'abierto'
        }, { transaction: t });

        await t.commit();

        _notificarTurno(req.user.business_id);

        // Push notification: turno abierto
        enviarNotificacion(
            req.user.business_id,
            'notif_turno_abierto',
            '🟢 Turno abierto',
            `${cajero_nombre || 'Sin nombre'} abrió caja con fondo de $${parseFloat(fondo_inicial || 0).toFixed(2)}`
        );

        res.status(201).json(turno);
    } catch (error) {
        await t.rollback();
        if (error.name === 'SequelizeUniqueConstraintError') {
            return res.status(400).json({ error: 'Ya hay un turno abierto' });
        }
        logger.error('Error al abrir turno:', error);
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
                ...filtroVentaContable(),
                createdAt: { [Op.gte]: turno.apertura },
                ...(await filtroSucursalTurno(turno))
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
        logger.error('Error calculando totales de turno:', error);
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
                ...filtroVentaContable(),
                createdAt: { [Op.between]: [turno.apertura, ahora] },
                ...(await filtroSucursalTurno(turno))
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

        // Push notification: turno cerrado
        const biz = req.user.business_id;
        const difAbs = Math.abs(parseFloat(diferencia.toFixed(2)));
        const prefs = await getPrefs(biz);
        const umbral = parseFloat(prefs.notif_diferencia_caja_umbral ?? 50);

        enviarNotificacion(
            biz,
            'notif_turno_cerrado',
            '🔴 Turno cerrado',
            `${turno.cajero_nombre} cerró caja · ${pedidos.length} pedidos · $${parseFloat(totalVentas.toFixed(2))} en ventas`
        );

        // Notificación extra si la diferencia de caja supera el umbral configurado
        if (prefs.notif_diferencia_caja !== false && difAbs >= umbral) {
            const signo = diferencia > 0 ? '+' : '-';
            enviarNotificacion(
                biz,
                null, // ya validamos la pref arriba
                '⚠️ Diferencia de caja',
                `${turno.cajero_nombre} cerró con diferencia de ${signo}$${difAbs.toFixed(2)}`
            );
        }

        res.json(turno);
    } catch (error) {
        logger.error('Error al cerrar turno:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

module.exports = router;
module.exports._notificarTurno = _notificarTurno;
