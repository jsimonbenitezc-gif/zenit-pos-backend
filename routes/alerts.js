const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { Ingredient, Branch, Order, sequelize } = require('../models');
const { authenticate } = require('../middleware/auth');
const { mapaPorSucursal } = require('../utils/branchStock');
const { Op } = require('sequelize');

// GET /api/alerts
router.get('/', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const alertas = [];

        // Inicio del día actual
        const hoy = new Date();
        hoy.setHours(0, 0, 0, 0);

        // 1. Stock crítico de insumos (por sucursal)
        const [ingredients, branches] = await Promise.all([
            Ingredient.findAll({
                where: { business_id: biz, active: true },
                // ⚠️ `id` es OBLIGATORIO: sin él, Sequelize NO lo agrega solo y
                // `ing.id` queda en undefined. Así estuvo desde que se escribió,
                // así que el mapa de stock por sucursal nunca acertaba y estas
                // alertas salían siempre del JSON legado (deuda §12.1).
                attributes: ['id', 'name', 'stock', 'min_stock']
            }),
            Branch.findAll({
                where: { business_id: biz, active: true },
                attributes: ['id', 'name']
            })
        ]);

        const branchMap = {};
        branches.forEach(b => { branchMap[String(b.id)] = b.name; });

        // Stock por sucursal de todos los insumos, en una sola consulta (§12.1).
        const ingIds = ingredients.map(i => i.id);
        const porSucursal = await mapaPorSucursal(ingIds);

        ingredients.forEach(ing => {
            if (!ing.min_stock || ing.min_stock <= 0) return;
            // Con reparto por sucursal se avisa sucursal por sucursal; sin él, el
            // insumo vale su stock global (negocio de un solo local).
            const bs = porSucursal[ing.id] || null;
            if (bs && Object.keys(bs).length > 0) {
                Object.entries(bs).forEach(([branchId, stock]) => {
                    const branchName = branchMap[branchId] || `Sucursal ${branchId}`;
                    const stockNum = parseFloat(stock) || 0;
                    if (stockNum <= 0) {
                        alertas.push({ tipo: 'stock', nivel: 'peligro', icono: '🔴', mensaje: `Sin stock en ${branchName}: "${ing.name}"` });
                    } else if (stockNum <= ing.min_stock) {
                        alertas.push({ tipo: 'stock', nivel: 'advertencia', icono: '🟡', mensaje: `Stock bajo en ${branchName} (${stockNum}): "${ing.name}"` });
                    }
                });
            } else {
                const stockNum = parseFloat(ing.stock) || 0;
                if (stockNum <= 0) {
                    alertas.push({ tipo: 'stock', nivel: 'peligro', icono: '🔴', mensaje: `Sin stock: "${ing.name}"` });
                } else if (stockNum <= ing.min_stock) {
                    alertas.push({ tipo: 'stock', nivel: 'advertencia', icono: '🟡', mensaje: `Stock bajo (${stockNum}): "${ing.name}"` });
                }
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
        logger.error('Alerts error:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

module.exports = router;
