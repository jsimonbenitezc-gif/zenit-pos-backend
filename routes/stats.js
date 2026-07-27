const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { Order, OrderItem, Product, Customer, Ingredient, BranchStock, sequelize } = require('../models');
const { authenticate } = require('../middleware/auth');
const { Op } = require('sequelize');
const { filtroVentaContable } = require('../utils/ordersFilter');
const {
    zonaDelNegocio, inicioDiaLocal, inicioDiaLocalISO,
    sqlFechaLocal, sqlHoraLocal, sqlMesLocal
} = require('../utils/tz');

/**
 * Traduce los filtros `date_from`/`date_to` a un rango de instantes según la zona del
 * negocio. Una fecha suelta ('2026-07-24') significa el DÍA LOCAL completo: desde su
 * medianoche local hasta (exclusivo) la medianoche del día siguiente. Antes se parseaba
 * como UTC, así que el rango quedaba corrido varias horas.
 * Si el texto trae hora (ISO completo) se respeta tal cual.
 */
function rangoFechas(tz, date_from, date_to) {
    if (!date_from && !date_to) return {};
    const createdAt = {};
    if (date_from) {
        createdAt[Op.gte] = inicioDiaLocalISO(tz, date_from) || new Date(date_from);
    }
    if (date_to) {
        const finExclusivo = inicioDiaLocalISO(tz, date_to, 1);
        if (finExclusivo) createdAt[Op.lt] = finExclusivo;
        else createdAt[Op.lte] = new Date(date_to);
    }
    return { createdAt };
}

// GET /api/stats/dashboard - Estadísticas completas del dashboard
router.get('/dashboard', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;
        // Filtro opcional por sucursal. Sin branch_id = ver todas (tab "Todas")
        const branchFilter = req.query.branch_id ? { branch_id: parseInt(req.query.branch_id) } : {};

        // Los cortes de día usan la zona horaria del NEGOCIO, no la del servidor
        // (Render corre en UTC: sin esto el día cortaba a las 6pm en México).
        const tz = await zonaDelNegocio(biz);
        const ahora = new Date();
        const hoy = inicioDiaLocal(tz, ahora);
        const ayer = inicioDiaLocal(tz, ahora, -1);
        const hace7Dias = inicioDiaLocal(tz, ahora, -6);

        // Expresiones SQL para agrupar por fecha/hora LOCAL del negocio
        const exprFechaLocal = sqlFechaLocal(sequelize, '"createdAt"', tz);
        const exprHoraLocal = sqlHoraLocal(sequelize, '"createdAt"', tz);

        // 1. VENTAS DE HOY
        const ventasHoy = await Order.findAll({
            where: {
                business_id: biz,
                createdAt: { [Op.gte]: hoy },
                ...branchFilter,
                ...filtroVentaContable()
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
                business_id: biz,
                createdAt: {
                    [Op.gte]: ayer,
                    [Op.lt]: hoy
                },
                ...branchFilter,
                ...filtroVentaContable()
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
                business_id: biz,
                createdAt: { [Op.gte]: hace7Dias },
                ...branchFilter,
                ...filtroVentaContable()
            },
            attributes: [
                [sequelize.literal(exprFechaLocal), 'fecha'],
                [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('total')), 0), 'monto'],
                [sequelize.fn('COUNT', sequelize.col('id')), 'pedidos']
            ],
            group: [sequelize.literal(exprFechaLocal)],
            order: [sequelize.literal(`${exprFechaLocal} ASC`)],
            raw: true
        });

        // 4. ITEMS VENDIDOS HOY
        const itemsVendidosHoy = await OrderItem.findAll({
            include: [{
                model: Order,
                as: 'order',
                where: {
                    business_id: biz,
                    createdAt: { [Op.gte]: hoy },
                    ...branchFilter,
                    ...filtroVentaContable()
                },
                attributes: []
            }],
            attributes: [
                [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('quantity')), 0), 'total_items']
            ],
            raw: true
        });

        // 5. INSUMOS CON STOCK BAJO — tabla BranchStock primero, fallback JSON
        const branchIdStr = req.query.branch_id ? String(req.query.branch_id) : null;
        let productosStockBajo, productosStockBajoLista;
        if (branchIdStr) {
            const allIngredients = await Ingredient.findAll({
                where: { business_id: biz, active: true, min_stock: { [Op.gt]: 0 } }
            });
            // Precargar de tabla BranchStock
            const ingIds = allIngredients.map(i => i.id);
            const bsRecords = ingIds.length > 0
                ? await BranchStock.findAll({ where: { ingredient_id: { [Op.in]: ingIds }, branch_id: parseInt(branchIdStr) } })
                : [];
            const tableMap = {};
            for (const r of bsRecords) tableMap[r.ingredient_id] = parseFloat(r.quantity);

            const getBranchStk = ing => {
                // Tabla primero
                if (ing.id in tableMap) return tableMap[ing.id];
                // Fallback JSON
                const bs = ing.branch_stocks || {};
                if (branchIdStr in bs) return parseFloat(bs[branchIdStr]);
                if (Object.keys(bs).length === 0) return parseFloat(ing.stock) || 0;
                return 0;
            };
            const lowStock = allIngredients.filter(ing => getBranchStk(ing) < parseFloat(ing.min_stock));
            productosStockBajo = lowStock.length;
            productosStockBajoLista = lowStock.slice(0, 10).map(ing => ({
                id: ing.id, name: ing.name,
                stock: getBranchStk(ing), min_stock: parseFloat(ing.min_stock)
            }));
        } else {
            // Sin sucursal: comparar stock global directamente en SQL
            productosStockBajo = await Ingredient.count({
                where: {
                    business_id: biz, active: true, min_stock: { [Op.gt]: 0 },
                    [Op.and]: sequelize.where(sequelize.col('stock'), Op.lt, sequelize.col('min_stock'))
                }
            });
            const lista = await Ingredient.findAll({
                where: {
                    business_id: biz, active: true, min_stock: { [Op.gt]: 0 },
                    [Op.and]: sequelize.where(sequelize.col('stock'), Op.lt, sequelize.col('min_stock'))
                },
                attributes: ['id', 'name', 'stock', 'min_stock'],
                order: [['stock', 'ASC']], limit: 10
            });
            productosStockBajoLista = lista;
        }

        // 6. CLIENTES ÚNICOS HOY
        const clientesHoy = await Order.count({
            where: {
                business_id: biz,
                createdAt: { [Op.gte]: hoy },
                customer_id: { [Op.ne]: null },
                ...branchFilter,
                ...filtroVentaContable()
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
                        business_id: biz,
                        createdAt: { [Op.gte]: hace7Dias },
                        ...branchFilter,
                        ...filtroVentaContable()
                    },
                    attributes: []
                },
                {
                    model: Product,
                    as: 'product',
                    // Sin `image`: el dashboard dibuja el emoji/ícono, y las fotos base64
                    // viajaban además dentro del GROUP BY (ver §23 de CLAUDE.md).
                    attributes: ['id', 'name', 'emoji']
                }
            ],
            attributes: [
                'product_id',
                [sequelize.fn('SUM', sequelize.col('quantity')), 'total_vendido']
            ],
            group: [
                'OrderItem.product_id',
                sequelize.col('product.id'),
                sequelize.col('product.name'),
                sequelize.col('product.emoji')
            ],
            order: [[sequelize.literal('total_vendido'), 'DESC']],
            limit: 5,
            raw: true,
            nest: true
        });

        // 8. ÚLTIMAS 5 VENTAS
        const ultimasVentas = await Order.findAll({
            where: { business_id: biz, ...branchFilter, ...filtroVentaContable() },
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
                    business_id: biz,
                    createdAt: { [Op.gte]: hoy },
                    ...branchFilter,
                    ...filtroVentaContable()
                },
                attributes: []
            }],
            attributes: ['id', 'name', 'phone'],
            // El conteo de "compras" para ser VIP también excluye canceladas/devueltas
            // y mesas abiertas (mismo criterio de venta contable).
            where: sequelize.literal(`(
                SELECT COUNT(*) FROM orders
                WHERE orders.customer_id = "Customer"."id"
                AND orders.business_id = $biz
                AND orders.status NOT IN ('cancelado', 'devuelto')
                AND NOT (orders.status = 'registrado' AND orders.table_id IS NOT NULL)
            ) >= 3`),
            bind: { biz }
        });

        // 10. VENTAS POR HORA HOY (para gráfica de 24h)
        const ventasPorHora = await Order.findAll({
            where: {
                business_id: biz,
                createdAt: { [Op.gte]: hoy },
                ...branchFilter,
                ...filtroVentaContable()
            },
            attributes: [
                [sequelize.literal(exprHoraLocal), 'hora'],
                [sequelize.fn('COUNT', sequelize.col('id')), 'pedidos'],
                [sequelize.fn('SUM', sequelize.col('total')), 'monto']
            ],
            group: [sequelize.literal(exprHoraLocal)],
            order: [sequelize.literal(`${exprHoraLocal} ASC`)],
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
                total_vendido: parseInt(p.total_vendido)
            })),
            ultimasVentas: ultimasVentasFormateadas,
            clientesVIPHoy: clientesVIPHoy.map(c => ({ id: c.id, name: c.name, phone: c.phone })),
            ventasPorHora,
            productosStockBajoLista: productosStockBajoLista.map(p => ({
                id: p.id,
                name: p.name,
                emoji: '',
                stock: p.stock
            }))
        });
    } catch (error) {
        logger.error('Dashboard stats error:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// GET /api/stats/sales - Estadísticas de ventas por periodo
router.get('/sales', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const { date_from, date_to, group_by } = req.query;

        const tz = await zonaDelNegocio(biz);
        const where = { business_id: biz, ...filtroVentaContable() };
        Object.assign(where, rangoFechas(tz, date_from, date_to));

        let groupField;
        switch (group_by) {
            case 'hour':
                groupField = sqlHoraLocal(sequelize, '"createdAt"', tz);
                break;
            case 'month':
                groupField = sqlMesLocal(sequelize, '"createdAt"', tz);
                break;
            case 'day':
            default:
                groupField = sqlFechaLocal(sequelize, '"createdAt"', tz);
        }

        const sales = await Order.findAll({
            where,
            attributes: [
                [sequelize.literal(groupField), 'periodo'],
                [sequelize.fn('COUNT', sequelize.col('id')), 'total_pedidos'],
                [sequelize.fn('SUM', sequelize.col('total')), 'monto_total'],
                [sequelize.fn('AVG', sequelize.col('total')), 'ticket_promedio']
            ],
            group: [sequelize.literal(groupField)],
            order: [sequelize.literal(`${groupField} ASC`)],
            raw: true
        });

        res.json(sales);
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// GET /api/stats/products - Productos más/menos vendidos
router.get('/products', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const { date_from, date_to, limit } = req.query;

        const tz = await zonaDelNegocio(biz);
        const orderWhere = { business_id: biz, ...filtroVentaContable() };
        Object.assign(orderWhere, rangoFechas(tz, date_from, date_to));

        const productStats = await OrderItem.findAll({
            include: [
                {
                    model: Order,
                    as: 'order',
                    where: orderWhere,
                    attributes: []
                },
                {
                    model: Product,
                    as: 'product',
                    attributes: ['id', 'name', 'emoji', 'price']
                }
            ],
            attributes: [
                'product_id',
                [sequelize.fn('SUM', sequelize.col('quantity')), 'cantidad_vendida'],
                [sequelize.fn('SUM', sequelize.col('subtotal')), 'ingresos']
            ],
            group: ['product_id', 'product.id', 'product.name', 'product.emoji', 'product.price'],
            order: [[sequelize.literal('cantidad_vendida'), 'DESC']],
            limit: limit ? parseInt(limit) : 20,
            raw: true,
            nest: true
        });

        res.json(productStats);
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

module.exports = router;
