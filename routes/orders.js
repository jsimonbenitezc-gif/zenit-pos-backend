const express = require('express');
const router = express.Router();
const { Order, OrderItem, Product, Customer, sequelize } = require('../models');
const { authenticate } = require('../middleware/auth');
const { Op } = require('sequelize');

// GET /api/orders - Obtener todos los pedidos
router.get('/', authenticate, async (req, res) => {
    try {
        const { status, order_type, date_from, date_to, limit } = req.query;
        
        const where = {};
        if (status) where.status = status;
        if (order_type) where.order_type = order_type;
        if (date_from || date_to) {
            where.createdAt = {};
            if (date_from) where.createdAt[Op.gte] = new Date(date_from);
            if (date_to) where.createdAt[Op.lte] = new Date(date_to);
        }

        const orders = await Order.findAll({
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
            limit: limit ? parseInt(limit) : undefined
        });

        res.json(orders);
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// GET /api/orders/:id - Obtener detalles de un pedido
router.get('/:id', authenticate, async (req, res) => {
    try {
        const order = await Order.findByPk(req.params.id, {
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
            return res.status(404).json({ error: 'Order not found' });
        }

        res.json(order);
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// POST /api/orders - Crear nuevo pedido
router.post('/', authenticate, async (req, res) => {
    const t = await sequelize.transaction();
    
    try {
        const {
            customer_id,
            customer_temp_info,
            items,
            total,
            payment_method,
            order_type,
            reference,
            delivery_address,
            maps_link,
            notes
        } = req.body;

        // Validar que haya items
        if (!items || items.length === 0) {
            await t.rollback();
            return res.status(400).json({ error: 'Order must have at least one item' });
        }

        // Crear el pedido
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
            notes
        }, { transaction: t });

        // Crear los items del pedido y actualizar stock
        for (const item of items) {
            const product = await Product.findByPk(item.product_id || item.id, { transaction: t });
            
            if (!product) {
                await t.rollback();
                return res.status(404).json({ error: `Product ${item.product_id || item.id} not found` });
            }

            // Verificar stock suficiente
            if (product.stock < item.quantity) {
                await t.rollback();
                return res.status(400).json({ 
                    error: `Insufficient stock for ${product.name}. Available: ${product.stock}, Requested: ${item.quantity}` 
                });
            }

            // Crear el item
            await OrderItem.create({
                order_id: order.id,
                product_id: product.id,
                quantity: item.quantity || 1,
                unit_price: item.unit_price || item.precio || product.price,
                subtotal: item.subtotal || (item.quantity || 1) * (item.unit_price || item.precio || product.price),
                notes: item.notes || item.nota || ''
            }, { transaction: t });

            // Actualizar stock
            await product.update({
                stock: product.stock - (item.quantity || 1)
            }, { transaction: t });
        }

        await t.commit();

        // Obtener el pedido completo con sus relaciones
        const fullOrder = await Order.findByPk(order.id, {
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
            ]
        });

        res.status(201).json(fullOrder);
    } catch (error) {
        await t.rollback();
        console.error('Create order error:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// PUT /api/orders/:id/status - Actualizar estado del pedido
router.put('/:id/status', authenticate, async (req, res) => {
    try {
        const { status } = req.body;

        if (!['registrado', 'completado', 'entregado', 'cancelado'].includes(status)) {
            return res.status(400).json({ error: 'Invalid status' });
        }

        const order = await Order.findByPk(req.params.id);

        if (!order) {
            return res.status(404).json({ error: 'Order not found' });
        }

        await order.update({ status });

        res.json(order);
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// PUT /api/orders/:id - Actualizar pedido completo
router.put('/:id', authenticate, async (req, res) => {
    try {
        const order = await Order.findByPk(req.params.id);

        if (!order) {
            return res.status(404).json({ error: 'Order not found' });
        }

        const {
            status,
            payment_method,
            order_type,
            reference,
            delivery_address,
            maps_link,
            notes
        } = req.body;

        await order.update({
            status,
            payment_method,
            order_type,
            reference,
            delivery_address,
            maps_link,
            notes
        });

        res.json(order);
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// DELETE /api/orders/:id - Cancelar pedido
router.delete('/:id', authenticate, async (req, res) => {
    const t = await sequelize.transaction();
    
    try {
        const order = await Order.findByPk(req.params.id, {
            include: [{
                model: OrderItem,
                as: 'items'
            }]
        }, { transaction: t });

        if (!order) {
            await t.rollback();
            return res.status(404).json({ error: 'Order not found' });
        }

        // Restaurar stock de los productos
        for (const item of order.items) {
            const product = await Product.findByPk(item.product_id, { transaction: t });
            if (product) {
                await product.update({
                    stock: product.stock + item.quantity
                }, { transaction: t });
            }
        }

        // Marcar como cancelado en lugar de eliminar
        await order.update({ status: 'cancelado' }, { transaction: t });

        await t.commit();
        res.json({ message: 'Order cancelled successfully' });
    } catch (error) {
        await t.rollback();
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

module.exports = router;
