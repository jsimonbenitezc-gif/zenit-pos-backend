const express = require('express');
const router = express.Router();
const { Order, OrderItem, Product, Customer, sequelize } = require('../models');
const { authenticate } = require('../middleware/auth');
const { Op } = require('sequelize');

// GET /api/stats/dashboard - Estadísticas completas del dashboard
router.get('/dashboard', authenticate, async (req, res) => {
    try {
        const hoy = new Date();
        hoy.setHours(0, 0, 0, 0);
        
        const ayer = new Date(hoy);
        ayer.setDate(ayer.getDate() - 1);

        const hace7Dias = new Date(hoy);
        hace7Dias.setDate(hace7Dias.getDate() - 6);

        const primerDiaMes = new Date(hoy.getFullYear(), hoy.getMonth(), 1);

        // 1. VENTAS DE HOY
        const ventasHoy = await Order.findAll({
            where: {
                createdAt: { [Op.gte]: hoy }
            },
            attributes: [
                [sequelize.fn('COUNT', sequelize.col('id')), 'total_pedidos'],
                [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('total')), 0), 'monto_total'],
                [sequelize.fn('COALESCE', sequelize.fn('AVG', sequelize.col('total')), 0), 'ticket_promedio']
            ],
            raw: true
        });

        // 2. VENTAS DE AYER
        const ventasAyer = await Order.findAll({
            where: {
                createdAt: {
                    [Op.gte]: ayer,
                    [Op.lt]: hoy
                }
            },
            attributes: [
                [sequelize.fn('COUNT', sequelize.col('id')), 'total_pedidos'],
                [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('total')), 0), 'monto_total']
            ],
            raw: true
        });

        // 3. VENTAS ÚLTIMOS 7 DÍAS (para gráfica)
        const ultimos7Dias = await Order.findAll({
            where: {
                createdAt: { [Op.gte]: hace7Dias }
            },
            attributes: [
                [sequelize.fn('DATE', sequelize.col('createdAt')), 'fecha'],
                [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('total')), 0), 'monto'],
                [sequelize.fn('COUNT', sequelize.col('id')), 'pedidos']
            ],
            group: [sequelize.fn('DATE', sequelize.col('createdAt'))],
            order: [[sequelize.fn('DATE', sequelize.col('createdAt')), 'ASC']],
            raw: true
        });

        // 4. ITEMS VENDIDOS HOY
        const itemsVendidosHoy = await OrderItem.findAll({
            include: [{
                model: Order,
                as: 'order',
                where: {
                    createdAt: { [Op.gte]: hoy }
                },
                attributes: []
            }],
            attributes: [
                [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('quantity')), 0), 'total_items']
            ],
            raw: true
        });

        // 5. PRODUCTOS CON STOCK BAJO (menos de 10)
        const productosStockBajo = await Product.count({
            where: {
                stock: { [Op.lt]: 10 },
                active: true
            }
        });

        // 6. CLIENTES ÚNICOS HOY
        const clientesHoy = await Order.count({
            where: {
                createdAt: { [Op.gte]: hoy },
                customer_id: { [Op.ne]: null }
            },
            distinct: true,
            col: 'customer_id'
        });

        // 7. TOP 5 PRODUCTOS MÁS VENDIDOS (últimos 7 días)
        const topProductos = await OrderItem.findAll({
            include: [
                {
                    model: Order,
                    as: 'order',
                    where: {
                        createdAt: { [Op.gte]: hace7Dias }
                    },
                    attributes: []
                },
                {
                    model: Product,
                    as: 'product',
                    attributes: ['id', 'name', 'emoji', 'image']
                }
            ],
            attributes: [
                'product_id',
                [sequelize.fn('SUM', sequelize.col('quantity')), 'total_vendido']
            ],
            group: ['product_id', 'product.id', 'product.name', 'product.emoji', 'product.image'],
            order: [[sequelize.literal('total_vendido'), 'DESC']],
            limit: 5,
            raw: true,
            nest: true
        });

        // 8. ÚLTIMAS 5 VENTAS
        const ultimasVentas = await Order.findAll({
            include: [{
                model: Customer,
                as: 'customer',
                attributes: ['name']
            }],
            attributes: ['id', 'total', 'createdAt', 'customer_temp_info'],
            order: [['createdAt', 'DESC']],
            limit: 5
        });

        // 9. CLIENTES VIP QUE COMPRARON HOY
        const clientesVIPHoy = await Customer.findAll({
            include: [{
                model: Order,
                as: 'orders',
                where: {
                    createdAt: { [Op.gte]: hoy }
                },
                attributes: []
            }],
            attributes: ['id', 'name', 'phone'],
            where: sequelize.literal(`(
                SELECT COUNT(*) FROM orders 
                WHERE orders.customer_id = Customer.id
            ) >= 3`),
            raw: true
        });

        // 10. VENTAS POR HORA HOY (para gráfica de 24h)
        const ventasPorHora = await Order.findAll({
            where: {
                createdAt: { [Op.gte]: hoy }
            },
            attributes: [
                [sequelize.fn('EXTRACT', sequelize.literal("HOUR FROM \"createdAt\"")), 'hora'],
                [sequelize.fn('COUNT', sequelize.col('id')), 'pedidos'],
                [sequelize.fn('SUM', sequelize.col('total')), 'monto']
            ],
            group: [sequelize.fn('EXTRACT', sequelize.literal("HOUR FROM \"createdAt\""))],
            order: [[sequelize.fn('EXTRACT', sequelize.literal("HOUR FROM \"createdAt\"")), 'ASC']],
            raw: true
        });

        // Formatear últimas ventas
        const ultimasVentasFormateadas = ultimasVentas.map(v => ({
            id: v.id,
            total: parseFloat(v.total),
            fecha_pedido: v.createdAt,
            cliente: v.customer ? v.customer.name : (v.customer_temp_info || 'General')
        }));

        res.json({
            ventasHoy: {
                monto_total: parseFloat(ventasHoy[0].monto_total) || 0,
                total_pedidos: parseInt(ventasHoy[0].total_pedidos) || 0,
                ticket_promedio: parseFloat(ventasHoy[0].ticket_promedio) || 0
            },
            ventasAyer: {
                monto_total: parseFloat(ventasAyer[0]?.monto_total) || 0,
                total_pedidos: parseInt(ventasAyer[0]?.total_pedidos) || 0
            },
            ultimos7Dias,
            itemsVendidosHoy: parseInt(itemsVendidosHoy[0].total_items) || 0,
            productosStockBajo,
            clientesHoy,
            topProductos: topProductos.map(p => ({
                nombre: p.product.name,
                emoji: p.product.emoji,
                image: p.product.image,
                total_vendido: parseInt(p.total_vendido)
            })),
            ultimasVentas: ultimasVentasFormateadas,
            clientesVIPHoy,
            ventasPorHora
        });
    } catch (error) {
        console.error('Dashboard stats error:', error);
        res.status(500).json({ error: error.message });
    }
});

// GET /api/stats/sales - Estadísticas de ventas por periodo
router.get('/sales', authenticate, async (req, res) => {
    try {
        const { date_from, date_to, group_by } = req.query;

        const where = {};
        if (date_from || date_to) {
            where.createdAt = {};
            if (date_from) where.createdAt[Op.gte] = new Date(date_from);
            if (date_to) where.createdAt[Op.lte] = new Date(date_to);
        }

        let groupField;
        switch (group_by) {
            case 'hour':
                groupField = sequelize.fn('EXTRACT', sequelize.literal("HOUR FROM \"createdAt\""));
                break;
            case 'day':
                groupField = sequelize.fn('DATE', sequelize.col('createdAt'));
                break;
            case 'month':
                groupField = sequelize.fn('EXTRACT', sequelize.literal("MONTH FROM \"createdAt\""));
                break;
            default:
                groupField = sequelize.fn('DATE', sequelize.col('createdAt'));
        }

        const sales = await Order.findAll({
            where,
            attributes: [
                [groupField, 'periodo'],
                [sequelize.fn('COUNT', sequelize.col('id')), 'total_pedidos'],
                [sequelize.fn('SUM', sequelize.col('total')), 'monto_total'],
                [sequelize.fn('AVG', sequelize.col('total')), 'ticket_promedio']
            ],
            group: [groupField],
            order: [[groupField, 'ASC']],
            raw: true
        });

        res.json(sales);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /api/stats/products - Productos más/menos vendidos
router.get('/products', authenticate, async (req, res) => {
    try {
        const { date_from, date_to, limit } = req.query;

        const where = {};
        if (date_from || date_to) {
            where.createdAt = {};
            if (date_from) where.createdAt[Op.gte] = new Date(date_from);
            if (date_to) where.createdAt[Op.lte] = new Date(date_to);
        }

        const productStats = await OrderItem.findAll({
            include: [
                {
                    model: Order,
                    as: 'order',
                    where,
                    attributes: []
                },
                {
                    model: Product,
                    as: 'product',
                    attributes: ['id', 'name', 'emoji', 'image', 'price']
                }
            ],
            attributes: [
                'product_id',
                [sequelize.fn('SUM', sequelize.col('quantity')), 'cantidad_vendida'],
                [sequelize.fn('SUM', sequelize.col('subtotal')), 'ingresos']
            ],
            group: ['product_id', 'product.id', 'product.name', 'product.emoji', 'product.image', 'product.price'],
            order: [[sequelize.literal('cantidad_vendida'), 'DESC']],
            limit: limit ? parseInt(limit) : 20,
            raw: true,
            nest: true
        });

        res.json(productStats);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
