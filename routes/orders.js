const express = require('express');
const router = express.Router();
const { Order, OrderItem, Product, Customer, sequelize } = require('../models');
const { authenticate } = require('../middleware/auth');
const { Op } = require('sequelize');

// GET /api/orders
router.get('/', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const { status, order_type, date_from, date_to, payment_method, limit = '50', page = '1' } = req.query;

        const limitNum = Math.min(Math.max(parseInt(limit) || 50, 1), 200);
        const pageNum = Math.max(parseInt(page) || 1, 1);
        const offset = (pageNum - 1) * limitNum;

        const where = { business_id: biz };
        if (status) where.status = status;
        if (order_type) where.order_type = order_type;
        if (payment_method) where.payment_method = payment_method;
        if (req.query.branch_id) where[Op.and] = [{ [Op.or]: [{ branch_id: parseInt(req.query.branch_id) }, { branch_id: null }] }];
        if (date_from || date_to) {
            where.createdAt = {};
            if (date_from) where.createdAt[Op.gte] = new Date(date_from);
            if (date_to) {
                const end = new Date(date_to);
                end.setHours(23, 59, 59, 999);
                where.createdAt[Op.lte] = end;
            }
        }

        const { count, rows } = await Order.findAndCountAll({
            where,
            include: [
                {
                    model: Customer,
                    as: 'customer',
                    attributes: ['id', 'name', 'phone']
                },
                {
                    model: OrderItem,
                    as: 'items',
                    include: [{
                        model: Product,
                        as: 'product',
                        attributes: ['id', 'name', 'emoji', 'image']
                    }]
                }
            ],
            order: [['createdAt', 'DESC']],
            limit: limitNum,
            offset,
            distinct: true
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
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// GET /api/orders/:id
router.get('/:id', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const order = await Order.findOne({
            where: { id: req.params.id, business_id: biz },
            include: [
                {
                    model: Customer,
                    as: 'customer',
                    attributes: ['id', 'name', 'phone', 'address']
                },
                {
                    model: OrderItem,
                    as: 'items',
                    include: [{
                        model: Product,
                        as: 'product',
                        attributes: ['id', 'name', 'description', 'emoji', 'image']
                    }]
                }
            ]
        });

        if (!order) {
            return res.status(404).json({ error: 'Pedido no encontrado' });
        }

        res.json(order);
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// POST /api/orders
router.post('/', authenticate, async (req, res) => {
    const t = await sequelize.transaction();

    try {
        const biz = req.user.business_id;
        const {
            customer_id, customer_temp_info, items, total,
            payment_method, order_type, reference,
            delivery_address, maps_link, notes, branch_id
        } = req.body;

        if (!items || items.length === 0) {
            await t.rollback();
            return res.status(400).json({ error: 'El pedido debe tener al menos un producto' });
        }

        const order = await Order.create({
            customer_id,
            customer_temp_info,
            total,
            status: 'registrado',
            payment_method: payment_method || 'efectivo',
            order_type: order_type || 'comer',
            reference,
            delivery_address,
            maps_link,
            notes,
            business_id: biz,
            branch_id: branch_id || null
        }, { transaction: t });

        for (const item of items) {
            const product = await Product.findByPk(item.product_id || item.id, { transaction: t });

            if (!product) {
                await t.rollback();
                return res.status(404).json({ error: `Producto ${item.product_id || item.id} no encontrado` });
            }

            await OrderItem.create({
                order_id: order.id,
                product_id: product.id,
                quantity: item.quantity || 1,
                unit_price: item.unit_price || item.precio || product.price,
                subtotal: item.subtotal || (item.quantity || 1) * (item.unit_price || item.precio || product.price),
                notes: item.notes || item.nota || ''
            }, { transaction: t });

            await product.update({
                stock: product.stock - (item.quantity || 1)
            }, { transaction: t });
        }

        await t.commit();

        const fullOrder = await Order.findByPk(order.id, {
            include: [
                { model: Customer, as: 'customer', attributes: ['id', 'name', 'phone'] },
                {
                    model: OrderItem,
                    as: 'items',
                    include: [{ model: Product, as: 'product', attributes: ['id', 'name', 'emoji', 'image'] }]
                }
            ]
        });

        res.status(201).json(fullOrder);
    } catch (error) {
        await t.rollback();
        console.error('Create order error:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// PUT /api/orders/:id/status
router.put('/:id/status', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const { status } = req.body;

        if (!['registrado', 'completado', 'entregado', 'cancelado'].includes(status)) {
            return res.status(400).json({ error: 'Estado inválido. Use: registrado, completado, entregado o cancelado' });
        }

        const order = await Order.findOne({ where: { id: req.params.id, business_id: biz } });
        if (!order) {
            return res.status(404).json({ error: 'Pedido no encontrado' });
        }

        await order.update({ status });
        res.json(order);
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// PUT /api/orders/:id
router.put('/:id', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const order = await Order.findOne({ where: { id: req.params.id, business_id: biz } });
        if (!order) {
            return res.status(404).json({ error: 'Pedido no encontrado' });
        }
        const { status, payment_method, order_type, reference, delivery_address, maps_link, notes } = req.body;
        await order.update({ status, payment_method, order_type, reference, delivery_address, maps_link, notes });
        res.json(order);
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// DELETE /api/orders/:id
router.delete('/:id', authenticate, async (req, res) => {
    const t = await sequelize.transaction();

    try {
        const biz = req.user.business_id;
        const order = await Order.findOne({
            where: { id: req.params.id, business_id: biz },
            include: [{ model: OrderItem, as: 'items' }],
            transaction: t
        });

        if (!order) {
            await t.rollback();
            return res.status(404).json({ error: 'Pedido no encontrado' });
        }

        // Solo restaurar stock si el pedido no estaba ya cancelado (evita doble restauración)
        if (order.status !== 'cancelado') {
            for (const item of order.items) {
                const product = await Product.findByPk(item.product_id, { transaction: t });
                if (product) {
                    await product.update({ stock: product.stock + item.quantity }, { transaction: t });
                }
            }
        }

        await order.update({ status: 'cancelado' }, { transaction: t });
        await t.commit();
        res.json({ message: 'Pedido cancelado correctamente' });
    } catch (error) {
        await t.rollback();
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

module.exports = router;
