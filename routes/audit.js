const express = require('express');
const router = express.Router();
const { PrivilegedActionLog } = require('../models');
const { authenticate, isOwner } = require('../middleware/auth');

// GET /api/audit — Listar registros de acciones privilegiadas (solo dueño)
// Query params opcionales: action_type, limit (max 100), page
router.get('/', authenticate, isOwner, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const limitNum = Math.min(parseInt(req.query.limit) || 50, 100);
        const pageNum  = Math.max(parseInt(req.query.page)  || 1, 1);
        const offset   = (pageNum - 1) * limitNum;

        const where = { business_id: biz };
        if (req.query.action_type) where.action_type = req.query.action_type;
        if (req.query.branch_id)   where.branch_id   = parseInt(req.query.branch_id);

        const { count, rows } = await PrivilegedActionLog.findAndCountAll({
            where,
            order: [['createdAt', 'DESC']],
            limit: limitNum,
            offset
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
        console.error('Error al obtener logs de auditoría:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

module.exports = router;
