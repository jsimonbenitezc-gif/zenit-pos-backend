const express = require('express');
const router = express.Router();
const { Table, Order, OrderItem, Product } = require('../models');
const { authenticate, isOwner } = require('../middleware/auth');
const { Op } = require('sequelize');

// ── GET /api/tables
// Devuelve todas las mesas activas del negocio con su pedido abierto (si tiene).
router.get('/', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;

        const tables = await Table.findAll({
            where: { business_id: biz, active: true },
            order: [['zone', 'ASC'], ['name', 'ASC']],
        });

        if (tables.length === 0) return res.json([]);

        const tableIds = tables.map(t => t.id);

        // Pedidos abiertos = status 'registrado' con table_id asignado
        const openOrders = await Order.findAll({
            where: {
                business_id: biz,
                status: 'registrado',
                table_id: { [Op.in]: tableIds },
            },
            include: [{
                model: OrderItem,
                as: 'items',
                include: [{
                    model: Product,
                    as: 'product',
                    attributes: ['id', 'name', 'emoji', 'price'],
                }],
            }],
        });

        const orderByTable = {};
        for (const o of openOrders) {
            orderByTable[o.table_id] = o;
        }

        const result = tables.map(t => ({
            ...t.toJSON(),
            open_order: orderByTable[t.id] || null,
        }));

        res.json(result);
    } catch (err) {
        console.error('GET /tables error:', err);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ── POST /api/tables  (solo dueño)
router.post('/', authenticate, isOwner, async (req, res) => {
    try {
        const { name, zone, capacity } = req.body;
        if (!name?.trim()) return res.status(400).json({ error: 'El nombre es requerido' });

        const table = await Table.create({
            business_id: req.user.business_id,
            name: name.trim(),
            zone: zone?.trim() || 'General',
            capacity: parseInt(capacity) || 4,
        });
        res.status(201).json(table);
    } catch (err) {
        console.error('POST /tables error:', err);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ── PUT /api/tables/:id  (solo dueño)
router.put('/:id', authenticate, isOwner, async (req, res) => {
    try {
        const table = await Table.findOne({
            where: { id: req.params.id, business_id: req.user.business_id },
        });
        if (!table) return res.status(404).json({ error: 'Mesa no encontrada' });

        const { name, zone, capacity } = req.body;
        await table.update({
            name: name?.trim() || table.name,
            zone: zone?.trim() || table.zone,
            capacity: parseInt(capacity) || table.capacity,
        });
        res.json(table);
    } catch (err) {
        console.error('PUT /tables/:id error:', err);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ── DELETE /api/tables/:id  (solo dueño)
router.delete('/:id', authenticate, isOwner, async (req, res) => {
    try {
        const table = await Table.findOne({
            where: { id: req.params.id, business_id: req.user.business_id },
        });
        if (!table) return res.status(404).json({ error: 'Mesa no encontrada' });

        // No eliminar si tiene un pedido abierto
        const openOrder = await Order.findOne({
            where: { table_id: table.id, status: 'registrado' },
        });
        if (openOrder) {
            return res.status(409).json({ error: 'La mesa tiene un pedido abierto. Ciérralo antes de eliminarla.' });
        }

        await table.update({ active: false });
        res.json({ ok: true });
    } catch (err) {
        console.error('DELETE /tables/:id error:', err);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

module.exports = router;
