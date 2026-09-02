const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { Order, OrderItem, Product, Customer, Ingredient, BranchStock, sequelize } = require('../models');
const { authenticate } = require('../middleware/auth');
const { Op } = require('sequelize');
const { filtroVentaContable } = require('../utils/ordersFilter');
const { requirePremium } = require('../middleware/checkPlan');
const { mapaDeCostos, costoDeModificadores, centavos } = require('../utils/costos');
const {
    zonaDelNegocio, inicioDiaLocal, inicioDiaLocalISO,
    sqlFechaLocal, sqlHoraLocal, sqlMesLocal
} = require('../utils/tz');
const { horarioDelNegocio, ventanaDelDia } = require('../utils/horarios');

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
                [sequelize.fn('COALESCE', sequelize.fn('AVG', sequelize.col('total')), 0), 'ticket_promedio'],
                // BLOQUE 8 — Impuesto recaudado hoy. Se agrega como línea aparte:
                // `monto_total` sigue siendo lo COBRADO (el número que el dueño ya
                // conoce), y de ahí se deriva cuánto es suyo y cuánto del fisco.
                [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('tax_amount')), 0), 'impuesto_total'],
                // BLOQUE 9 — Propinas de hoy. También es una línea aparte, y por
                // una razón más fuerte: la propina NI SIQUIERA es del negocio, así
                // que jamás debe sumarse a `monto_total`.
                [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('tip_amount')), 0), 'propinas_total']
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
                ticket_promedio: parseFloat(ventasHoy[0].ticket_promedio) || 0,
                impuesto_total: parseFloat(ventasHoy[0].impuesto_total) || 0,
                monto_neto: parseFloat(
                    ((parseFloat(ventasHoy[0].monto_total) || 0) - (parseFloat(ventasHoy[0].impuesto_total) || 0)).toFixed(2)
                ),
                propinas_total: parseFloat(ventasHoy[0].propinas_total) || 0
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
            // BLOQUE 14 — la ventana de HOY, para que la gráfica por hora no dibuje
            // 24 barras cuando el negocio abre 9 horas: 15 columnas vacías esconden
            // las que sí tienen datos. Es null si no hay horario configurado, y ahí
            // los clientes siguen pintando el día completo, como siempre.
            horarioHoy: ventanaDelDia(await horarioDelNegocio(biz), tz),
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

// ── RENTABILIDAD POR PRODUCTO (BLOQUE 12) ────────────────────────────────────
//
// Cruza lo que se vendió con lo que costó producirlo. El costo NO está guardado
// en ninguna columna: sale de la receta del producto (utils/costos.js).
//
// ⚠️ EL INGRESO QUE SE COMPARA CONTRA EL COSTO ES **NETO**, no lo cobrado.
// Un renglón de $116 con IVA incluido no dejó $116: dejó $100, porque $16 son
// del fisco. Y si la venta llevaba descuento, el producto tampoco dejó su precio
// de lista. Los dos ajustes se hacen con UN SOLO factor por pedido:
//
//     factor = (subtotal del pedido) / (suma de los renglones)
//
// porque Order.subtotal es, por definición del BLOQUE 8, la base gravable ya sin
// descuentos y sin impuesto. En modo INCLUIDO el factor quita impuesto y
// descuento de una vez; en modo AGREGADO el impuesto nunca estuvo en el renglón
// y el factor solo quita el descuento. Un pedido anterior al BLOQUE 8 tiene
// subtotal NULL y ahí su total ES lo cobrado, así que se usa ese.
//
// Sin este factor, encender el impuesto en modo INCLUIDO —el modo por defecto—
// inflaría el margen de todos los platillos de golpe.
//
// La propina (BLOQUE 9) no entra: no es ingreso del negocio.
router.get('/profitability', authenticate, requirePremium, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const { date_from, date_to, order_by, limit } = req.query;
        const tz = await zonaDelNegocio(biz);

        // Rango. Sin fechas: los últimos 30 días LOCALES del negocio (incluido
        // hoy). Es un reporte para decidir el menú de la semana, no un archivo
        // histórico: leer "todo" de un negocio con años de ventas traería
        // cientos de miles de renglones a memoria.
        let desde = null, hasta = null;
        if (date_from || date_to) {
            const rango = rangoFechas(tz, date_from, date_to);
            const c = rango.createdAt || {};
            desde = c[Op.gte] || null;
            hasta = c[Op.lt] || c[Op.lte] || null;
        }
        if (!desde) desde = inicioDiaLocal(tz, new Date(), -29);
        if (!hasta) hasta = inicioDiaLocal(tz, new Date(), 1);

        const dias = (hasta - desde) / 86400000;
        if (dias <= 0) {
            return res.status(400).json({ error: 'La fecha inicial debe ser anterior a la final.' });
        }
        if (dias > 366) {
            return res.status(400).json({ error: 'El periodo no puede ser mayor a un año. Elige un rango más corto.' });
        }

        const orderWhere = {
            business_id: biz,
            createdAt: { [Op.gte]: desde, [Op.lt]: hasta },
            ...filtroVentaContable()
        };
        // Sucursal: igual que el dashboard, sin branch_id se ven todas.
        if (req.query.branch_id) orderWhere.branch_id = parseInt(req.query.branch_id);

        // Un solo barrido de renglones. Se traen los modificadores porque el
        // extra que se cobró también consumió insumos (BLOQUE 11) y sin ellos el
        // "extra queso" parecería margen puro.
        const renglones = await OrderItem.findAll({
            attributes: ['order_id', 'product_id', 'quantity', 'subtotal', 'modifiers'],
            include: [
                {
                    model: Order,
                    as: 'order',
                    where: orderWhere,
                    attributes: ['id', 'subtotal', 'total']
                },
                {
                    // Sin `image`: son data-URIs base64 y el reporte dibuja el
                    // emoji (§23 de CLAUDE.md).
                    model: Product,
                    as: 'product',
                    attributes: ['id', 'name', 'emoji'],
                    required: false
                }
            ],
            raw: true,
            nest: true
        });

        // Factor neto por pedido (ver el comentario de arriba).
        const brutoPorPedido = new Map();
        for (const r of renglones) {
            const id = Number(r.order_id);
            brutoPorPedido.set(id, (brutoPorPedido.get(id) || 0) + (parseFloat(r.subtotal) || 0));
        }
        const factorPorPedido = new Map();
        for (const r of renglones) {
            const id = Number(r.order_id);
            if (factorPorPedido.has(id)) continue;
            const bruto = brutoPorPedido.get(id) || 0;
            const neto = (r.order.subtotal !== null && r.order.subtotal !== undefined)
                ? parseFloat(r.order.subtotal)
                : parseFloat(r.order.total);
            // Un pedido sin renglones cobrables (o con números raros) se deja
            // tal cual en vez de dividir por cero: el reporte no puede reventar.
            factorPorPedido.set(id, (bruto > 0 && Number.isFinite(neto)) ? neto / bruto : 1);
        }

        const costos = await mapaDeCostos(biz);

        const acumulado = new Map();
        for (const r of renglones) {
            const productId = Number(r.product_id);
            const qty = parseInt(r.quantity) || 0;
            const factor = factorPorPedido.has(Number(r.order_id)) ? factorPorPedido.get(Number(r.order_id)) : 1;

            let fila = acumulado.get(productId);
            if (!fila) {
                const info = costos.productos.get(productId) || {
                    costo: null, completo: false, faltantes: [], sin_receta: true
                };
                fila = {
                    product_id: productId,
                    nombre: (r.product && r.product.name) || 'Producto eliminado',
                    emoji: (r.product && r.product.emoji) || '',
                    unidades: 0,
                    ingreso: 0,
                    costo: 0,
                    sin_receta: info.sin_receta,
                    costo_confiable: info.sin_receta ? false : info.completo,
                    insumos_sin_costo: new Set(info.faltantes),
                    _costoUnitarioReceta: info.costo
                };
                acumulado.set(productId, fila);
            }

            fila.unidades += qty;
            fila.ingreso += (parseFloat(r.subtotal) || 0) * factor;

            if (!fila.sin_receta) {
                fila.costo += (fila._costoUnitarioReceta || 0) * qty;
                const extras = costoDeModificadores(r.modifiers, costos.opciones);
                fila.costo += extras.costo * qty;
                if (extras.faltantes.length) {
                    extras.faltantes.forEach(f => fila.insumos_sin_costo.add(f));
                    fila.costo_confiable = false;
                }
            }
        }

        // Formateo. Un producto SIN receta se devuelve con costo/margen en null,
        // nunca en 0: un margen del 100% inventado es peor que un hueco visible.
        const productos = [...acumulado.values()].map(f => {
            const ingreso = centavos(f.ingreso);
            if (f.sin_receta) {
                return {
                    product_id: f.product_id, nombre: f.nombre, emoji: f.emoji,
                    unidades: f.unidades, ingreso,
                    costo: null, costo_unitario: null, margen: null, margen_pct: null,
                    sin_receta: true, costo_confiable: false, insumos_sin_costo: []
                };
            }
            const costo = centavos(f.costo);
            const margen = centavos(ingreso - costo);
            return {
                product_id: f.product_id, nombre: f.nombre, emoji: f.emoji,
                unidades: f.unidades, ingreso, costo,
                costo_unitario: centavos(f._costoUnitarioReceta || 0),
                margen,
                // Sobre el INGRESO (margen comercial), no sobre el costo. Es la
                // lectura que le sirve al dueño: "de cada $100 que entran por
                // este platillo, me quedan $X".
                margen_pct: ingreso > 0 ? Math.round((margen / ingreso) * 1000) / 10 : null,
                sin_receta: false,
                costo_confiable: f.costo_confiable,
                insumos_sin_costo: [...f.insumos_sin_costo]
            };
        });

        // Orden. Por defecto el margen en DINERO: el platillo que más deja al
        // negocio no es el del mayor porcentaje, es el que más veces se vende.
        const criterios = {
            margen:     (a, b) => (b.margen === null ? -Infinity : b.margen) - (a.margen === null ? -Infinity : a.margen),
            margen_pct: (a, b) => (b.margen_pct === null ? -Infinity : b.margen_pct) - (a.margen_pct === null ? -Infinity : a.margen_pct),
            ingreso:    (a, b) => b.ingreso - a.ingreso,
            unidades:   (a, b) => b.unidades - a.unidades
        };
        productos.sort(criterios[order_by] || criterios.margen);

        const conCosto = productos.filter(p => !p.sin_receta);
        const insumosSinCosto = new Set();
        conCosto.forEach(p => p.insumos_sin_costo.forEach(i => insumosSinCosto.add(i)));

        const ingresoTotal = centavos(conCosto.reduce((s, p) => s + p.ingreso, 0));
        const costoTotal = centavos(conCosto.reduce((s, p) => s + p.costo, 0));
        const margenTotal = centavos(ingresoTotal - costoTotal);

        const tope = limit ? Math.max(1, parseInt(limit)) : null;

        res.json({
            periodo: { desde, hasta, tz },
            // El resumen SOLO suma los productos con receta: mezclar los que no
            // la tienen daría un margen que parece del negocio entero sin serlo.
            resumen: {
                ingreso: ingresoTotal,
                costo: costoTotal,
                margen: margenTotal,
                margen_pct: ingresoTotal > 0 ? Math.round((margenTotal / ingresoTotal) * 1000) / 10 : null,
                productos_con_receta: conCosto.length,
                productos_sin_receta: productos.length - conCosto.length,
                insumos_sin_costo: [...insumosSinCosto]
            },
            productos: tope ? productos.slice(0, tope) : productos
        });
    } catch (error) {
        logger.error('Profitability stats error:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

module.exports = router;
