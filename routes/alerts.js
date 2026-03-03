const express = require('express');
const router = express.Router();
const { Product, Order, sequelize } = require('../models');
const { authenticate } = require('../middleware/auth');
const { Op } = require('sequelize');

// GET /api/alerts
router.get('/', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const alertas = [];

        // Inicio del día actual
        const hoy = new Date();
        hoy.setHours(0, 0, 0, 0);

        // 1. Stock crítico
        const productosBajoStock = await Product.findAll({
            where: { business_id: biz, active: true, stock: { [Op.lte]: 5 } },
            attributes: ['name', 'stock']
        });
        productosBajoStock.forEach(p => {
            if (p.stock <= 0) {
                alertas.push({ tipo: 'stock', nivel: 'peligro', icono: '🔴', mensaje: `Sin stock: "${p.name}"` });
            } else {
                alertas.push({ tipo: 'stock', nivel: 'advertencia', icono: '🟡', mensaje: `Stock bajo (${p.stock} ud.): "${p.name}"` });
            }
        });

        // 2. Cancelaciones hoy
        const pedidosHoy = await Order.findAll({
            where: { business_id: biz, createdAt: { [Op.gte]: hoy } },
            attributes: ['status']
        });
        if (pedidosHoy.length > 0) {
            const cancelados = pedidosHoy.filter(p => p.status === 'cancelado').length;
            const ratio = cancelados / pedidosHoy.length;
            if (ratio > 0.4) {
                alertas.push({ tipo: 'cancelaciones', nivel: 'peligro', icono: '🔴', mensaje: `Alta tasa de cancelaciones hoy: ${cancelados} de ${pedidosHoy.length} pedidos (${Math.round(ratio * 100)}%)` });
            } else if (ratio > 0.2) {
                alertas.push({ tipo: 'cancelaciones', nivel: 'advertencia', icono: '🟡', mensaje: `Cancelaciones elevadas hoy: ${cancelados} de ${pedidosHoy.length} pedidos (${Math.round(ratio * 100)}%)` });
            }
        }

        // 3. Ventas fuera de horario hoy (11pm–6am)
        const pedidosFueraHorario = await Order.findAll({
            where: {
                business_id: biz,
                createdAt: { [Op.gte]: hoy },
                [Op.or]: [
                    sequelize.where(sequelize.fn('EXTRACT', sequelize.literal('HOUR FROM "createdAt"')), { [Op.gte]: 23 }),
                    sequelize.where(sequelize.fn('EXTRACT', sequelize.literal('HOUR FROM "createdAt"')), { [Op.lt]: 6 })
                ]
            },
            attributes: ['id']
        });
        if (pedidosFueraHorario.length > 0) {
            alertas.push({ tipo: 'horario', nivel: 'info', icono: '🔵', mensaje: `${pedidosFueraHorario.length} venta(s) registradas fuera de horario habitual (11pm–6am)` });
        }

        res.json({ alertas });
    } catch (error) {
        console.error('Alerts error:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

module.exports = router;
