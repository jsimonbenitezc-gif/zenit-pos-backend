const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { Customer, Order, PrivilegedActionLog, User, sequelize } = require('../models');
const { authenticate, isOwner } = require('../middleware/auth');
const { autorizarAccionPrivilegiada } = require('../utils/verifyPin');
const { Op } = require('sequelize');
const { notificarAudit } = require('./audit');
const { enviarNotificacion } = require('../utils/push');
const rateLimit = require('express-rate-limit');
const { paginate, paginatedResponse } = require('../utils/pagination');

// Protección: máximo 30 clientes por minuto por IP
const createCustomerLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: { error: 'Demasiadas solicitudes de creación de clientes. Intenta de nuevo en un minuto.' },
    standardHeaders: true,
    legacyHeaders: false
});

// GET /api/customers
router.get('/', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const { search } = req.query;
        const { page, limit, offset } = paginate(req.query);

        const where = { active: true, business_id: biz };
        if (search) where.name = { [Op.iLike]: `%${search}%` };

        const { count, rows } = await Customer.findAndCountAll({
            where,
            order: [['name', 'ASC']],
            limit,
            offset
        });
        res.json(paginatedResponse(rows, count, page, limit));
    } catch (error) {
        logger.error('Error al obtener clientes:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// GET /api/customers/with-stats
router.get('/with-stats', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const customers = await Customer.findAll({
            where: { active: true, business_id: biz },
            include: [{
                model: Order,
                as: 'orders',
                where: { business_id: biz },
                attributes: [],
                required: false
            }],
            attributes: [
                'id', 'phone', 'name', 'address', 'notes', 'createdAt', 'loyalty_points', 'in_loyalty',
                [sequelize.fn('COUNT', sequelize.col('orders.id')), 'total_compras'],
                [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('orders.total')), 0), 'monto_total']
            ],
            group: ['Customer.id'],
            order: [[sequelize.literal('total_compras'), 'DESC']]
        });
        res.json(customers);
    } catch (error) {
        logger.error('Error al obtener clientes con stats:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// GET /api/customers/stats
router.get('/stats', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const totalClientes = await Customer.count({ where: { active: true, business_id: biz } });

        const primerDiaMes = new Date();
        primerDiaMes.setDate(1);
        primerDiaMes.setHours(0, 0, 0, 0);

        const clientesNuevos = await Customer.count({
            where: { active: true, business_id: biz, createdAt: { [Op.gte]: primerDiaMes } }
        });

        const clientesFrecuentes = await Customer.count({
            where: { active: true, business_id: biz },
            include: [{
                model: Order,
                as: 'orders',
                where: { createdAt: { [Op.gte]: primerDiaMes }, business_id: biz },
                attributes: []
            }],
            group: ['Customer.id'],
            having: sequelize.where(
                sequelize.fn('COUNT', sequelize.col('orders.id')),
                { [Op.gte]: 2 }
            )
        });

        const topClientesMes = await Customer.findAll({
            where: { active: true, business_id: biz },
            include: [{
                model: Order,
                as: 'orders',
                where: { createdAt: { [Op.gte]: primerDiaMes }, business_id: biz },
                attributes: []
            }],
            attributes: [
                'id', 'name', 'phone',
                [sequelize.fn('COUNT', sequelize.col('orders.id')), 'total_pedidos'],
                [sequelize.fn('SUM', sequelize.col('orders.total')), 'monto_total']
            ],
            group: ['Customer.id'],
            order: [[sequelize.literal('monto_total'), 'DESC']],
            limit: 3,
            raw: true
        });

        res.json({ totalClientes, clientesNuevos, clientesFrecuentes: clientesFrecuentes.length || 0, topClientesMes });
    } catch (error) {
        logger.error('Error al obtener stats de clientes:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// GET /api/customers/:id
router.get('/:id', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const customer = await Customer.findOne({
            where: { id: req.params.id, active: true, business_id: biz },
            include: [{
                model: Order,
                as: 'orders',
                where: { business_id: biz },
                required: false,
                limit: 10,
                order: [['createdAt', 'DESC']]
            }]
        });
        if (!customer) {
            return res.status(404).json({ error: 'Cliente no encontrado' });
        }
        res.json(customer);
    } catch (error) {
        logger.error('Error al obtener cliente:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// POST /api/customers
router.post('/', createCustomerLimiter, authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const { phone, name, address, notes } = req.body;
        if (!phone || !name) {
            return res.status(400).json({ error: 'Teléfono y nombre son requeridos' });
        }

        // Validar longitudes
        if (name.length > 200) return res.status(400).json({ error: 'El nombre no puede tener más de 200 caracteres' });
        if (address && address.length > 500) return res.status(400).json({ error: 'La dirección no puede tener más de 500 caracteres' });
        if (notes && notes.length > 1000) return res.status(400).json({ error: 'Las notas no pueden tener más de 1000 caracteres' });

        // Validar formato de teléfono
        const phoneRegex = /^[0-9\s\-\+\(\)]{7,20}$/;
        if (!phoneRegex.test(phone.trim())) {
            return res.status(400).json({ error: 'Formato de teléfono inválido' });
        }

        // Verificar si ya existe en este negocio
        const exists = await Customer.findOne({ where: { phone, business_id: biz } });
        if (exists) {
            return res.status(400).json({ error: 'Ya existe un cliente con ese teléfono' });
        }
        const customer = await Customer.create({ phone, name, address, notes, business_id: biz });

        // Push notification: nuevo cliente registrado
        enviarNotificacion(
            biz,
            'notif_cliente_nuevo',
            '👤 Nuevo cliente registrado',
            `${name}${phone ? ' · ' + phone : ''}`
        );

        res.status(201).json(customer);
    } catch (error) {
        logger.error('Error al crear cliente:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// PUT /api/customers/:id
// Body puede incluir { employee_id, pin } para registrar en auditoría quién autorizó el cambio
router.put('/:id', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const customer = await Customer.findOne({
            where: { id: req.params.id, business_id: biz }
        });
        if (!customer) {
            return res.status(404).json({ error: 'Cliente no encontrado' });
        }

        const { phone, name, address, notes, employee_id, pin, employee_name, role } = req.body;

        // Validar longitudes
        if (name && name.length > 200) return res.status(400).json({ error: 'El nombre no puede tener más de 200 caracteres' });
        if (address && address.length > 500) return res.status(400).json({ error: 'La dirección no puede tener más de 500 caracteres' });
        if (notes && notes.length > 1000) return res.status(400).json({ error: 'Las notas no pueden tener más de 1000 caracteres' });

        // Validar formato de teléfono
        if (phone) {
            const phoneRegex = /^[0-9\s\-\+\(\)]{7,20}$/;
            if (!phoneRegex.test(phone.trim())) {
                return res.status(400).json({ error: 'Formato de teléfono inválido' });
            }
        }

        // Acción auditada: se pide autorización si el cliente la ofrece, con el
        // PIN de PUESTO (`role`) o la contraseña de CUENTA (`employee_id`).
        // Aceptar solo la segunda dejaba la edición con PIN muerta en el POS
        // (el cajero no tiene cuenta propia). Ver §19.19.
        let authorizedEmployee = null;
        if (employee_id || role) {
            const auth = await autorizarAccionPrivilegiada({
                businessId: biz,
                actorId: req.user.id,
                employee_id, employee_name, role, pin,
                branchId: req.user.branch_id || null,
            });
            if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
            authorizedEmployee = { id: auth.empleadoId, name: auth.nombre };
        }

        if (phone && phone !== customer.phone) {
            const exists = await Customer.findOne({ where: { phone, business_id: biz } });
            if (exists) {
                return res.status(400).json({ error: 'Ya existe un cliente con ese teléfono' });
            }
        }

        // Capturar datos antes del cambio para auditoría
        const beforeData = {
            name: customer.name,
            phone: customer.phone,
            address: customer.address,
            notes: customer.notes
        };

        await customer.update({ phone, name, address, notes });

        // Registrar en auditoría si hubo autorización
        if (authorizedEmployee) {
            const afterData = {
                name: customer.name,
                phone: customer.phone,
                address: customer.address,
                notes: customer.notes
            };
            await PrivilegedActionLog.create({
                business_id: biz,
                branch_id: null,
                employee_id: authorizedEmployee.id,
                employee_name: employee_name || authorizedEmployee.name,
                action_type: 'edit_customer',
                target_description: `Cliente #${customer.id} — ${customer.name}`,
                before_data: JSON.stringify(beforeData),
                after_data: JSON.stringify(afterData)
            });
            notificarAudit(biz);
        }

        res.json(customer);
    } catch (error) {
        logger.error('Error al actualizar cliente:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// PATCH /api/customers/:id/loyalty — actualizar puntos e inscripción en fidelidad
router.patch('/:id/loyalty', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const customer = await Customer.findOne({ where: { id: req.params.id, business_id: biz } });
        if (!customer) return res.status(404).json({ error: 'Cliente no encontrado' });
        const { points_delta, in_loyalty } = req.body;
        const updates = {};
        const puntosAntes = customer.loyalty_points || 0;
        if (points_delta !== undefined) {
            updates.loyalty_points = Math.max(0, puntosAntes + points_delta);
        }
        if (in_loyalty !== undefined) updates.in_loyalty = in_loyalty;
        await customer.update(updates);

        // Push notification: cliente canjeó puntos (points_delta negativo = canje)
        if (points_delta !== undefined && points_delta < 0) {
            enviarNotificacion(
                biz,
                'notif_puntos_canjeados',
                '🎁 Puntos canjeados',
                `${customer.name} canjeó ${Math.abs(points_delta)} puntos · Saldo: ${updates.loyalty_points}`
            );
        }

        res.json(customer);
    } catch (error) {
        logger.error('Error al actualizar fidelidad:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// DELETE /api/customers/:id
router.delete('/:id', authenticate, isOwner, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const customer = await Customer.findOne({
            where: { id: req.params.id, active: true, business_id: biz }
        });
        if (!customer) {
            return res.status(404).json({ error: 'Cliente no encontrado' });
        }
        await customer.update({ active: false });
        res.json({ message: 'Cliente eliminado correctamente' });
    } catch (error) {
        logger.error('Error al eliminar cliente:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

module.exports = router;
