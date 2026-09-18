const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { PrivilegedActionLog, Branch } = require('../models');
const { authenticate, isOwner } = require('../middleware/auth');
const { configurarSSE } = require('../utils/sse');
const { publicar } = require('../utils/sse-adapter');
const { enviarNotificacion } = require('../utils/push');
const { evaluarHorario, avisarFueraDeHorario } = require('../utils/horarios');

// ── SSE: notificaciones en tiempo real de nuevas acciones privilegiadas ────
// Las conexiones ya no viven aquí: las guarda `utils/sse-adapter.js`, que es
// el único sitio que escribe a una conexión en vivo. Esta función conserva su
// nombre y su firma porque la llaman otras rutas.
function _notificarAudit(businessId) {
    publicar(businessId, 'audit');
}

// El endpoint de siempre. Lo usan TODOS los binarios ya instalados, así que no
// se toca y sus eventos siguen yendo SIN NOMBRE: el `onmessage` de un
// EventSource solo recibe esos. Los clientes nuevos abren UNA sola conexión en
// `GET /api/events?channels=…`, con eventos nombrados.
router.get('/events', (req, res) => {
    configurarSSE(['audit'], req, res);
});

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
        // BLOQUE 14 — "enséñame solo lo de fuera de horario". Es la vista que hace
        // útil la marca: el dueño no quiere leer 200 acciones normales para
        // encontrar las tres de la madrugada.
        if (req.query.fuera_horario === 'true') where.fuera_horario = true;

        const { count, rows } = await PrivilegedActionLog.findAndCountAll({
            where,
            include: [{ model: Branch, as: 'branch', attributes: ['id', 'name'], required: false }],
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
        logger.error('Error al obtener logs de auditoría:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// POST /api/audit — Registrar una acción privilegiada desde el frontend
// Usado para descuentos que requieren PIN (validado localmente en el frontend)
router.post('/', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const { employee_id, employee_name, action_type, target_description, before_data, after_data, branch_id } = req.body;

        if (!employee_name || !action_type) {
            return res.status(400).json({ error: 'employee_name y action_type son requeridos' });
        }

        // La marca de horario la pone SIEMPRE el servidor (BLOQUE 14), nunca el
        // cliente: es una señal de seguridad, y un equipo comprometido que pudiera
        // declararse "dentro de horario" la volvería inservible justo cuando importa.
        const marcaHorario = await evaluarHorario(biz);

        const log = await PrivilegedActionLog.create({
            business_id: biz,
            branch_id: branch_id || null,
            employee_id: employee_id || req.user.id,
            employee_name,
            action_type,
            target_description: target_description || null,
            before_data: before_data ? JSON.stringify(before_data) : null,
            after_data: after_data ? JSON.stringify(after_data) : null,
            fuera_horario: marcaHorario.fuera
        });

        _notificarAudit(biz);
        avisarFueraDeHorario(biz, action_type, marcaHorario);

        // Push notification: descuento con PIN aplicado
        if (action_type === 'apply_discount') {
            enviarNotificacion(
                biz,
                'notif_descuento_pin',
                '🔑 Descuento con PIN aplicado',
                `${employee_name} aplicó: ${target_description || 'descuento'}`
            );
        }

        res.status(201).json(log);
    } catch (error) {
        logger.error('Error al registrar acción de auditoría:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

router.notificarAudit = _notificarAudit;
module.exports = router;
