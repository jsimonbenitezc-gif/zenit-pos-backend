// ============================================================================
// PARTES COBRADAS DE UNA MESA (PLAN_CUENTAS_V1)
//
// Una mesa cobrada por partes: cada parte es una venta propia que apunta a la
// mesa con `parent_order_id` (POST /api/orders/:id/separar). Esto arma el
// renglón "Ya pagaron" que ven el desktop y el celular, en GET /api/tables y en
// la respuesta de /separar. Solo lo que ese renglón necesita: sin items ni
// imágenes (§23).
// ============================================================================
const { Op } = require('sequelize');
const { Order } = require('../models');

async function partesCobradasDe(mesaIds, businessId) {
    const ids = [...new Set((mesaIds || []).filter(Boolean))];
    if (!ids.length) return {};
    const partes = await Order.findAll({
        where: { business_id: businessId, parent_order_id: { [Op.in]: ids } },
        attributes: ['id', 'parent_order_id', 'total', 'tip_amount', 'payment_method', 'status', 'paid_at', 'createdAt'],
        order: [['id', 'ASC']],
    });
    const porMesa = {};
    for (const p of partes) {
        (porMesa[p.parent_order_id] = porMesa[p.parent_order_id] || []).push(p.toJSON());
    }
    return porMesa;
}

module.exports = { partesCobradasDe };
