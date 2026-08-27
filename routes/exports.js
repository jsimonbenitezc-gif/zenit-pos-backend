const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { Order, OrderItem, OrderPayment, Product, Category, Customer, User, sequelize } = require('../models');
const { metodoDePago } = require('../utils/pagos');
const { authenticate } = require('../middleware/auth');
const { Op } = require('sequelize');

// ── Generador CSV (sin librerías externas) ───────────────────────────────────
function toCSV(headers, rows) {
    const escape = (val) => {
        const str = String(val ?? '');
        return str.includes(',') || str.includes('"') || str.includes('\n')
            ? '"' + str.replace(/"/g, '""') + '"' : str;
    };
    const lines = [headers.map(escape).join(',')];
    for (const row of rows) { lines.push(row.map(escape).join(',')); }
    return '\ufeff' + lines.join('\r\n');
}

// GET /api/exports/sales?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
router.get('/sales', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const { start_date, end_date } = req.query;

        if (!start_date || !end_date) {
            return res.status(400).json({ error: 'start_date y end_date son requeridos (YYYY-MM-DD)' });
        }

        const startDate = new Date(start_date);
        const endDate = new Date(end_date);
        endDate.setHours(23, 59, 59, 999);

        const includes = [
            {
                model: OrderItem,
                as: 'items',
                include: [{ model: Product, as: 'product', attributes: ['name'] }],
            },
            // Desglose por método (BLOQUE 10): sin esto, una venta dividida saldría
            // en el CSV del contador como si hubiera entrado por un solo lado.
            { model: OrderPayment, as: 'payments', required: false },
        ];

        // Solo incluir creator si la asociación existe (evita error si aún no se migró)
        try {
            const assoc = Order.associations.creator;
            if (assoc) {
                includes.push({
                    model: User,
                    as: 'creator',
                    attributes: ['name'],
                    required: false,
                });
            }
        } catch { /* asociación no definida */ }

        const orders = await Order.findAll({
            where: {
                business_id: biz,
                status: { [Op.ne]: 'cancelado' },
                createdAt: { [Op.between]: [startDate, endDate] },
            },
            include: includes,
            order: [['createdAt', 'ASC']],
        });

        // Subtotal e impuesto van en el CSV porque este archivo es el que el dueño
        // le pasa al contador (BLOQUE 8). Un pedido anterior al bloque no tiene
        // subtotal: ahí el total ES la base, y el impuesto es 0.
        // La propina va en su propia columna (BLOQUE 9) y NO está dentro de
        // 'Total': no es ingreso del negocio. 'Cobrado al cliente' es la suma de
        // ambos, que es lo que de verdad entró por caja en ese ticket.
        // BLOQUE 10 — Con pagos divididos, 'Metodo de Pago' dice 'multiple' y el
        // reparto real va en las tres columnas por método. Una venta de un solo
        // método deja dos de ellas en 0, que es la verdad.
        const headers = ['Fecha', 'Hora', 'Numero de Pedido', 'Productos', 'Subtotal', 'Impuesto', 'Total', 'Propina', 'Metodo de Propina', 'Cobrado al Cliente', 'Metodo de Pago', 'Efectivo', 'Tarjeta', 'Transferencia', 'Empleado'];
        const rows = orders.map(o => {
            const fecha = new Date(o.createdAt);
            const productos = (o.items || []).map(i => {
                const name = i.product ? i.product.name : 'Producto';
                return `${i.quantity}x ${name}`;
            }).join(', ');

            // Reparto de ESTE ticket. Sin pagos, el total entra entero por su
            // método, igual que antes del BLOQUE 10.
            const porMetodo = { efectivo: 0, tarjeta: 0, transferencia: 0 };
            if (o.payments && o.payments.length > 0) {
                for (const pago of o.payments) {
                    porMetodo[metodoDePago(pago.method)] += parseFloat(pago.amount) || 0;
                }
            } else {
                porMetodo[metodoDePago(o.payment_method)] += parseFloat(o.total) || 0;
            }
            return [
                fecha.toISOString().split('T')[0],
                fecha.toTimeString().split(' ')[0],
                o.id,
                productos,
                parseFloat(o.subtotal ?? o.total).toFixed(2),
                parseFloat(o.tax_amount || 0).toFixed(2),
                parseFloat(o.total).toFixed(2),
                parseFloat(o.tip_amount || 0).toFixed(2),
                parseFloat(o.tip_amount || 0) > 0 ? (o.tip_method || o.payment_method || '') : '',
                (parseFloat(o.total) + (parseFloat(o.tip_amount) || 0)).toFixed(2),
                o.payment_method || '',
                porMetodo.efectivo.toFixed(2),
                porMetodo.tarjeta.toFixed(2),
                porMetodo.transferencia.toFixed(2),
                o.creator ? o.creator.name : '',
            ];
        });

        const csv = toCSV(headers, rows);
        const filename = `ventas_${start_date}_${end_date}.csv`;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(csv);
    } catch (error) {
        logger.error('Export sales error:', error);
        res.status(500).json({ error: 'Error al exportar ventas' });
    }
});

// GET /api/exports/products
router.get('/products', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;

        const products = await Product.findAll({
            where: { business_id: biz },
            include: [{ model: Category, as: 'category', attributes: ['name'] }],
            order: [['name', 'ASC']],
        });

        const headers = ['Nombre', 'Categoria', 'Precio', 'Stock Disponible', 'Activo'];
        const rows = products.map(p => [
            p.name,
            p.category ? p.category.name : '',
            parseFloat(p.price).toFixed(2),
            p.stock ?? 0,
            p.active ? 'Sí' : 'No',
        ]);

        const csv = toCSV(headers, rows);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="productos.csv"');
        res.send(csv);
    } catch (error) {
        logger.error('Export products error:', error);
        res.status(500).json({ error: 'Error al exportar productos' });
    }
});

// GET /api/exports/customers
router.get('/customers', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;

        const customers = await Customer.findAll({
            where: { business_id: biz, active: true },
            include: [{
                model: Order,
                as: 'orders',
                where: { business_id: biz },
                attributes: [],
                required: false,
            }],
            attributes: [
                'id', 'name', 'phone',
                [sequelize.fn('COUNT', sequelize.col('orders.id')), 'visitas'],
                [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('orders.total')), 0), 'total_gastado'],
                [sequelize.fn('MAX', sequelize.col('orders.createdAt')), 'ultima_visita'],
            ],
            group: ['Customer.id'],
            order: [['name', 'ASC']],
            raw: true,
        });

        const headers = ['Nombre', 'Telefono', 'Email', 'Visitas', 'Total Gastado', 'Ultima Visita'];
        const rows = customers.map(c => [
            c.name,
            c.phone || '',
            '',  // El modelo Customer no tiene campo email
            c.visitas || 0,
            parseFloat(c.total_gastado || 0).toFixed(2),
            c.ultima_visita ? new Date(c.ultima_visita).toISOString().split('T')[0] : '',
        ]);

        const csv = toCSV(headers, rows);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="clientes.csv"');
        res.send(csv);
    } catch (error) {
        logger.error('Export customers error:', error);
        res.status(500).json({ error: 'Error al exportar clientes' });
    }
});

module.exports = router;
