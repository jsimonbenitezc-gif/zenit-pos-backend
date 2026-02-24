const express = require('express');
const router = express.Router();
const { Customer, Order, sequelize } = require('../models');
const { authenticate } = require('../middleware/auth');
const { Op } = require('sequelize');

// GET /api/customers - Obtener todos los clientes
router.get('/', authenticate, async (req, res) => {
    try {
        const customers = await Customer.findAll({
            order: [['name', 'ASC']]
        });
        res.json(customers);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /api/customers/with-stats - Clientes con estadísticas de compras
router.get('/with-stats', authenticate, async (req, res) => {
    try {
        const customers = await Customer.findAll({
            include: [{
                model: Order,
                as: 'orders',
                attributes: []
            }],
            attributes: [
                'id',
                'phone',
                'name',
                'address',
                'notes',
                'createdAt',
                [sequelize.fn('COUNT', sequelize.col('orders.id')), 'total_compras'],
                [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('orders.total')), 0), 'monto_total']
            ],
            group: ['Customer.id'],
            order: [[sequelize.literal('total_compras'), 'DESC']]
        });

        res.json(customers);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /api/customers/stats - Estadísticas de clientes
router.get('/stats', authenticate, async (req, res) => {
    try {
        // Total de clientes
        const totalClientes = await Customer.count();

        // Clientes nuevos este mes
        const primerDiaMes = new Date();
        primerDiaMes.setDate(1);
        primerDiaMes.setHours(0, 0, 0, 0);

        const clientesNuevos = await Customer.count({
            where: {
                createdAt: { [Op.gte]: primerDiaMes }
            }
        });

        // Clientes frecuentes (2+ compras este mes)
        const clientesFrecuentes = await Customer.count({
            include: [{
                model: Order,
                as: 'orders',
                where: {
                    createdAt: { [Op.gte]: primerDiaMes }
                },
                attributes: []
            }],
            group: ['Customer.id'],
            having: sequelize.where(
                sequelize.fn('COUNT', sequelize.col('orders.id')),
                { [Op.gte]: 2 }
            )
        });

        // Top 3 clientes del mes
        const topClientesMes = await Customer.findAll({
            include: [{
                model: Order,
                as: 'orders',
                where: {
                    createdAt: { [Op.gte]: primerDiaMes }
                },
                attributes: []
            }],
            attributes: [
                'id',
                'name',
                'phone',
                [sequelize.fn('COUNT', sequelize.col('orders.id')), 'total_pedidos'],
                [sequelize.fn('SUM', sequelize.col('orders.total')), 'monto_total']
            ],
            group: ['Customer.id'],
            order: [[sequelize.literal('monto_total'), 'DESC']],
            limit: 3,
            raw: true
        });

        res.json({
            totalClientes,
            clientesNuevos,
            clientesFrecuentes: clientesFrecuentes.length || 0,
            topClientesMes
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /api/customers/:id - Obtener un cliente
router.get('/:id', authenticate, async (req, res) => {
    try {
        const customer = await Customer.findByPk(req.params.id, {
            include: [{
                model: Order,
                as: 'orders',
                limit: 10,
                order: [['createdAt', 'DESC']]
            }]
        });

        if (!customer) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        res.json(customer);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST /api/customers - Crear cliente
router.post('/', authenticate, async (req, res) => {
    try {
        const { phone, name, address, notes } = req.body;

        if (!phone || !name) {
            return res.status(400).json({ error: 'Phone and name are required' });
        }

        // Verificar si ya existe
        const exists = await Customer.findOne({ where: { phone } });
        if (exists) {
            return res.status(400).json({ error: 'Customer with this phone already exists' });
        }

        const customer = await Customer.create({ phone, name, address, notes });
        res.status(201).json(customer);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// PUT /api/customers/:id - Actualizar cliente
router.put('/:id', authenticate, async (req, res) => {
    try {
        const customer = await Customer.findByPk(req.params.id);

        if (!customer) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        const { phone, name, address, notes } = req.body;

        // Si cambia el teléfono, verificar que no exista
        if (phone && phone !== customer.phone) {
            const exists = await Customer.findOne({ where: { phone } });
            if (exists) {
                return res.status(400).json({ error: 'Customer with this phone already exists' });
            }
        }

        await customer.update({ phone, name, address, notes });
        res.json(customer);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// DELETE /api/customers/:id - Eliminar cliente
router.delete('/:id', authenticate, async (req, res) => {
    try {
        const customer = await Customer.findByPk(req.params.id);

        if (!customer) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        await customer.destroy();
        res.json({ message: 'Customer deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;