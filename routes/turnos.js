const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { Op } = require('sequelize');
const { Turno, Order, CashMovement, PrivilegedActionLog, sequelize } = require('../models');
const { authenticate } = require('../middleware/auth');
const { filtroVentaContable } = require('../utils/ordersFilter');
const { resolverBranchId, filtroSucursalTurno, BranchError } = require('../utils/branch');
const { configurarSSE } = require('../utils/sse');
const { enviarNotificacion, getPrefs } = require('../utils/push');
const { verifyEmployeePin, verificarPinDePerfil } = require('../utils/verifyPin');
const { User } = require('../models');
const { TIPOS, totalesMovimientos, efectivoEsperado, montoValido } = require('../utils/cashMovements');

// ── Movimientos de caja (BLOQUE 7) ──────────────────────────────────────────
// Sacar efectivo del cajón es una acción de dinero, igual que un descuento: pide
// PIN de empleado y queda auditada. El dueño puede apagar la exigencia del PIN en
// Ajustes (`movimientos_caja_pin`) para un negocio de una sola persona, donde el
// PIN solo estorba. Meter dinero (`deposito`) nunca lo pide: nadie se roba la caja
// metiéndole billetes.
const ETIQUETA_TIPO = { retiro: 'Retiro', gasto: 'Gasto', deposito: 'Depósito' };

/**
 * ¿Este movimiento necesita PIN?
 * @param {number} businessId
 * @param {string} tipo  'retiro' | 'gasto' | 'deposito'
 */
async function _requierePin(businessId, tipo) {
    if (tipo === 'deposito') return false;
    const prefs = await getPrefs(businessId);
    return prefs.movimientos_caja_pin !== false; // encendido por defecto
}

/**
 * Autoriza una acción de caja con el PIN que el cliente REALMENTE tiene.
 *
 * ⚠️ Zenit maneja dos credenciales distintas (ver utils/verifyPin.js): el PIN de
 * PUESTO que el cajero teclea en el POS vive en `settings.permisos_roles`, y la
 * contraseña de CUENTA vive en `users`. Aceptar solo la segunda dejaría esta
 * función muerta en el desktop y en el mobile, que no tienen forma de producirla.
 *
 * @returns {Promise<{ok:boolean, error?:string, status?:number, empleadoId:number|null, nombre:string|null}>}
 */
async function _autorizarCaja(req, { employee_id, employee_name, role, pin, branchId }) {
    const biz = req.user.business_id;

    if (!pin || (!employee_id && !role)) {
        return { ok: false, status: 400, error: 'Se requiere PIN para esta acción' };
    }

    // 1) PIN de puesto (el caso normal: desktop y mobile).
    if (role) {
        const r = await verificarPinDePerfil({ businessId: biz, role, pin, branchId });
        if (!r.valid) return { ok: false, status: 403, error: 'PIN incorrecto' };
        if (r.settingsMigrados && r.ownerId) {
            // Se validó por SHA256 legacy: se persiste el bcrypt recién generado.
            await User.update({ settings: JSON.stringify(r.settingsMigrados) }, { where: { id: r.ownerId } });
        }
        // No hay un User por puesto: se atribuye a la cuenta con la que está
        // firmado el equipo, y el puesto queda en el nombre.
        return { ok: true, empleadoId: req.user.id, nombre: employee_name || role };
    }

    // 2) Contraseña de cuenta (staff dado de alta con email).
    try {
        const empleado = await verifyEmployeePin(employee_id, pin, biz);
        return { ok: true, empleadoId: empleado.id, nombre: employee_name || empleado.name };
    } catch (pinErr) {
        return { ok: false, status: 403, error: pinErr.message };
    }
}

/** Formato consistente para el cliente (el monto viaja como número, no como string). */
function _serializarMovimiento(m) {
    return {
        id: m.id,
        turno_id: m.turno_id,
        branch_id: m.branch_id,
        tipo: m.tipo,
        monto: parseFloat(m.monto) || 0,
        motivo: m.motivo || null,
        employee_id: m.employee_id,
        employee_name: m.employee_name || null,
        anulado: !!m.anulado,
        anulado_por_nombre: m.anulado_por_nombre || null,
        anulado_at: m.anulado_at || null,
        motivo_anulacion: m.motivo_anulacion || null,
        createdAt: m.createdAt,
    };
}

// ── SSE: notificaciones en tiempo real de cambios de turno ───────────────────
const _turnoClients = new Map(); // businessId (string) → Set<Response>

function _notificarTurno(businessId) {
    const clients = _turnoClients.get(String(businessId));
    if (!clients || clients.size === 0) return;
    const msg = `data: {}\n\n`;
    for (const res of clients) {
        if (res.writableEnded) { clients.delete(res); continue; }
        try { res.write(msg); } catch { clients.delete(res); }
    }
}

router.get('/events', (req, res) => {
    configurarSSE(_turnoClients, req, res);
});

// GET /api/turnos/activo — Turno activo del negocio (o sucursal si se indica)
router.get('/activo', authenticate, async (req, res) => {
    try {
        const where = { business_id: req.user.business_id, estado: 'abierto' };
        // Un empleado asignado a una sucursal solo ve el turno de la suya: así no puede
        // cerrar por error la caja de otra sucursal.
        if (req.user.branch_id) where.branch_id = req.user.branch_id;
        else if (req.query.branch_id) where.branch_id = req.query.branch_id;

        const turno = await Turno.findOne({ where, order: [['apertura', 'DESC']] });
        if (!turno) return res.json(null);
        res.json(turno);
    } catch (error) {
        logger.error('Error al obtener turno activo:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// GET /api/turnos/historial — Turnos cerrados (paginado, últimos 50)
router.get('/historial', authenticate, async (req, res) => {
    try {
        const where = { business_id: req.user.business_id, estado: 'cerrado' };
        if (req.user.branch_id) where.branch_id = req.user.branch_id;
        else if (req.query.branch_id) where.branch_id = req.query.branch_id;

        const turnos = await Turno.findAll({
            where,
            order: [['cierre', 'DESC']],
            limit: 50
        });
        res.json(turnos);
    } catch (error) {
        logger.error('Error al obtener historial de turnos:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// POST /api/turnos — Abrir un nuevo turno
router.post('/', authenticate, async (req, res) => {
    const t = await sequelize.transaction();
    try {
        const { cajero_nombre, rol, fondo_inicial, branch_id } = req.body;

        if (parseFloat(fondo_inicial) < 0) {
            await t.rollback();
            return res.status(400).json({ error: 'El fondo inicial no puede ser negativo' });
        }

        // Sucursal del turno (BLOQUE 4): un turno sin sucursal hacía que el cierre
        // sumara los pedidos de TODAS las sucursales. Ver utils/branch.js.
        let branchIdFinal;
        try {
            branchIdFinal = await resolverBranchId({ user: req.user, branchId: branch_id, transaction: t });
        } catch (branchErr) {
            if (branchErr instanceof BranchError) {
                await t.rollback();
                return res.status(branchErr.status).json({ error: branchErr.message });
            }
            throw branchErr;
        }

        // Solo puede haber un turno abierto por sucursal.
        // El FOR UPDATE bloquea la fila si existe; el índice parcial único en BD
        // rechaza la creación si dos requests llegan al mismo tiempo.
        const existing = await Turno.findOne({
            where: {
                business_id: req.user.business_id,
                estado: 'abierto',
                branch_id: branchIdFinal
            },
            lock: t.LOCK.UPDATE,
            transaction: t
        });
        if (existing) {
            await t.rollback();
            return res.status(400).json({ error: 'Ya hay un turno abierto' });
        }

        const turno = await Turno.create({
            business_id: req.user.business_id,
            branch_id:   branchIdFinal,
            cajero_nombre: cajero_nombre || 'Sin nombre',
            rol:         rol          || null,
            fondo_inicial: parseFloat(fondo_inicial) || 0,
            apertura:    new Date(),
            estado:      'abierto'
        }, { transaction: t });

        await t.commit();

        _notificarTurno(req.user.business_id);

        // Push notification: turno abierto
        enviarNotificacion(
            req.user.business_id,
            'notif_turno_abierto',
            '🟢 Turno abierto',
            `${cajero_nombre || 'Sin nombre'} abrió caja con fondo de $${parseFloat(fondo_inicial || 0).toFixed(2)}`
        );

        res.status(201).json(turno);
    } catch (error) {
        await t.rollback();
        if (error.name === 'SequelizeUniqueConstraintError') {
            return res.status(400).json({ error: 'Ya hay un turno abierto' });
        }
        logger.error('Error al abrir turno:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

/**
 * Ventas del turno agrupadas por método de pago.
 * Lo comparten /:id/totales y /:id/cerrar: si cada uno lo calculara aparte, el
 * cajero vería un número al contar el dinero y otro al confirmar el cierre.
 */
async function _ventasDelTurno(turno, hasta = null) {
    const pedidos = await Order.findAll({
        where: {
            business_id: turno.business_id,
            ...filtroVentaContable(),
            createdAt: hasta
                ? { [Op.between]: [turno.apertura, hasta] }
                : { [Op.gte]: turno.apertura },
            ...(await filtroSucursalTurno(turno))
        },
        attributes: ['id', 'total', 'payment_method']
    });

    let totalVentas = 0, totalEfectivo = 0, totalTarjeta = 0, totalTransferencia = 0;
    for (const p of pedidos) {
        const t = parseFloat(p.total) || 0;
        totalVentas += t;
        const metodo = (p.payment_method || '').toLowerCase();
        if (metodo === 'tarjeta' || metodo === 'card') {
            totalTarjeta += t;
        } else if (metodo === 'transferencia') {
            totalTransferencia += t;
        } else {
            totalEfectivo += t;
        }
    }

    return {
        total_pedidos:       pedidos.length,
        total_ventas:        parseFloat(totalVentas.toFixed(2)),
        total_efectivo:      parseFloat(totalEfectivo.toFixed(2)),
        total_tarjeta:       parseFloat(totalTarjeta.toFixed(2)),
        total_transferencia: parseFloat(totalTransferencia.toFixed(2))
    };
}

// GET /api/turnos/:id/totales — Totales en tiempo real para un turno abierto
router.get('/:id/totales', authenticate, async (req, res) => {
    try {
        const turno = await Turno.findOne({
            where: { id: req.params.id, business_id: req.user.business_id }
        });
        if (!turno) return res.status(404).json({ error: 'Turno no encontrado' });

        const ventas = await _ventasDelTurno(turno);
        const movs   = await totalesMovimientos(turno.id);

        res.json({
            ...ventas,
            ...movs,
            // El número que el cajero debe encontrar en el cajón al contar.
            efectivo_esperado: efectivoEsperado({
                fondoInicial:   turno.fondo_inicial,
                ventasEfectivo: ventas.total_efectivo,
                movimientos:    movs
            })
        });
    } catch (error) {
        logger.error('Error calculando totales de turno:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// PUT /api/turnos/:id/cerrar — Cerrar turno y calcular totales
router.put('/:id/cerrar', authenticate, async (req, res) => {
    try {
        const turno = await Turno.findOne({
            where: { id: req.params.id, business_id: req.user.business_id, estado: 'abierto' }
        });
        if (!turno) return res.status(404).json({ error: 'Turno no encontrado o ya cerrado' });

        const { efectivo_contado, notas } = req.body;
        const efectivo = parseFloat(efectivo_contado) || 0;
        const ahora    = new Date();

        const ventas = await _ventasDelTurno(turno, ahora);
        const movs   = await totalesMovimientos(turno.id);

        // BLOQUE 7 — El efectivo que debe haber en el cajón cuenta también lo que
        // entró y salió por fuera de las ventas:
        //   esperado = fondo_inicial + ventas_efectivo + depósitos − retiros − gastos
        // Antes la fórmula ignoraba los movimientos, así que cada gasto del turno
        // aparecía como un faltante y la "diferencia" dejaba de significar algo.
        const esperado   = efectivoEsperado({
            fondoInicial:   turno.fondo_inicial,
            ventasEfectivo: ventas.total_efectivo,
            movimientos:    movs
        });
        const diferencia = efectivo - esperado;

        await turno.update({
            estado:             'cerrado',
            cierre:             ahora,
            efectivo_contado:   efectivo,
            diferencia:         parseFloat(diferencia.toFixed(2)),
            total_pedidos:      ventas.total_pedidos,
            total_ventas:       ventas.total_ventas,
            total_efectivo:     ventas.total_efectivo,
            total_tarjeta:      ventas.total_tarjeta,
            total_transferencia: ventas.total_transferencia,
            // Congelados: el reporte de un turno cerrado no debe cambiar si alguien
            // anula un movimiento después.
            total_depositos:    movs.total_depositos,
            total_retiros:      movs.total_retiros,
            total_gastos:       movs.total_gastos,
            notas:              notas || null
        });

        _notificarTurno(req.user.business_id);

        // Push notification: turno cerrado
        const biz = req.user.business_id;
        const difAbs = Math.abs(parseFloat(diferencia.toFixed(2)));
        const prefs = await getPrefs(biz);
        const umbral = parseFloat(prefs.notif_diferencia_caja_umbral ?? 50);

        enviarNotificacion(
            biz,
            'notif_turno_cerrado',
            '🔴 Turno cerrado',
            `${turno.cajero_nombre} cerró caja · ${ventas.total_pedidos} pedidos · $${ventas.total_ventas} en ventas`
        );

        // Notificación extra si la diferencia de caja supera el umbral configurado
        if (prefs.notif_diferencia_caja !== false && difAbs >= umbral) {
            const signo = diferencia > 0 ? '+' : '-';
            enviarNotificacion(
                biz,
                null, // ya validamos la pref arriba
                '⚠️ Diferencia de caja',
                `${turno.cajero_nombre} cerró con diferencia de ${signo}$${difAbs.toFixed(2)}`
            );
        }

        res.json(turno);
    } catch (error) {
        logger.error('Error al cerrar turno:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// MOVIMIENTOS DE CAJA (BLOQUE 7)
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/turnos/:id/movimientos — Movimientos de un turno (incluye los anulados)
router.get('/:id/movimientos', authenticate, async (req, res) => {
    try {
        const turno = await Turno.findOne({
            where: { id: req.params.id, business_id: req.user.business_id },
            attributes: ['id']
        });
        if (!turno) return res.status(404).json({ error: 'Turno no encontrado' });

        const movs = await CashMovement.findAll({
            where: { turno_id: turno.id, business_id: req.user.business_id },
            order: [['createdAt', 'ASC']]
        });

        res.json({
            movimientos: movs.map(_serializarMovimiento),
            totales: await totalesMovimientos(turno.id)
        });
    } catch (error) {
        logger.error('Error al listar movimientos de caja:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// POST /api/turnos/:id/movimientos — Registrar retiro, gasto o depósito
router.post('/:id/movimientos', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const { tipo, monto, motivo, employee_id, employee_name, role, pin, client_uuid } = req.body;

        if (!TIPOS.includes(tipo)) {
            return res.status(400).json({ error: 'Tipo de movimiento inválido' });
        }

        const montoFinal = montoValido(monto);
        if (montoFinal === null) {
            return res.status(400).json({ error: 'El monto debe ser un número mayor a cero' });
        }

        // Idempotencia: un reintento por timeout de red devuelve el mismo movimiento
        // en vez de sacar el dinero dos veces (mismo criterio que POST /api/orders).
        if (client_uuid) {
            const yaExiste = await CashMovement.findOne({ where: { client_uuid, business_id: biz } });
            if (yaExiste) return res.json(_serializarMovimiento(yaExiste));
        }

        const turno = await Turno.findOne({
            where: { id: req.params.id, business_id: biz }
        });
        if (!turno) return res.status(404).json({ error: 'Turno no encontrado' });
        // Un movimiento pertenece a un turno vivo: si el turno ya cerró, su corte ya
        // se calculó y agregarle dinero después descuadraría un reporte ya leído.
        if (turno.estado !== 'abierto') {
            return res.status(400).json({ error: 'El turno ya está cerrado. Abre un turno para registrar movimientos de caja.' });
        }

        // Autorización: sacar dinero pide PIN (salvo que el dueño lo haya apagado).
        let autorizado = null;
        if (await _requierePin(biz, tipo)) {
            const auth = await _autorizarCaja(req, {
                employee_id, employee_name, role, pin, branchId: turno.branch_id
            });
            if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
            autorizado = auth;
        }

        const nombre = autorizado?.nombre || employee_name || null;

        const mov = await CashMovement.create({
            business_id: biz,
            branch_id:   turno.branch_id || null,
            turno_id:    turno.id,
            tipo,
            monto:       montoFinal,
            motivo:      motivo ? String(motivo).slice(0, 500) : null,
            employee_id: autorizado?.empleadoId || (Number.isInteger(parseInt(employee_id)) ? parseInt(employee_id) : null),
            employee_name: nombre,
            client_uuid: client_uuid || null
        });

        // Auditoría: solo tiene sentido cuando alguien se identificó con su PIN. Sin
        // PIN no hay a quién atribuirle el movimiento más allá del nombre escrito.
        if (autorizado) {
            await PrivilegedActionLog.create({
                business_id: biz,
                branch_id:   turno.branch_id || null,
                employee_id: autorizado.empleadoId,
                employee_name: nombre || 'Sin identificar',
                action_type: 'cash_movement',
                target_description: `${ETIQUETA_TIPO[tipo]} de $${montoFinal.toFixed(2)} · Turno #${turno.id}`,
                after_data: JSON.stringify({ id: mov.id, tipo, monto: montoFinal, motivo: mov.motivo })
            });
        }

        _notificarTurno(biz);

        if (tipo !== 'deposito') {
            enviarNotificacion(
                biz,
                'notif_movimiento_caja',
                tipo === 'retiro' ? '💸 Retiro de caja' : '🧾 Gasto de caja',
                `${nombre || 'Sin identificar'} registró $${montoFinal.toFixed(2)}${mov.motivo ? ' · ' + mov.motivo : ''}`
            );
        }

        res.status(201).json(_serializarMovimiento(mov));
    } catch (error) {
        if (error.name === 'SequelizeUniqueConstraintError' && req.body.client_uuid) {
            // Carrera contra el índice de client_uuid: el otro request ya lo guardó.
            const existente = await CashMovement.findOne({
                where: { client_uuid: req.body.client_uuid, business_id: req.user.business_id }
            });
            if (existente) return res.json(_serializarMovimiento(existente));
        }
        logger.error('Error al registrar movimiento de caja:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// POST /api/turnos/:id/movimientos/:movId/anular — Anular (NUNCA borrar)
router.post('/:id/movimientos/:movId/anular', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const { employee_id, employee_name, role, pin, motivo } = req.body;

        const mov = await CashMovement.findOne({
            where: { id: req.params.movId, turno_id: req.params.id, business_id: biz }
        });
        if (!mov) return res.status(404).json({ error: 'Movimiento no encontrado' });
        if (mov.anulado) return res.status(400).json({ error: 'Este movimiento ya fue anulado' });

        const turno = await Turno.findOne({ where: { id: mov.turno_id, business_id: biz } });
        // Un turno cerrado ya tiene su corte firmado: anular ahí cambiaría un reporte
        // que el dueño ya leyó. La corrección se hace en el turno en curso.
        if (!turno || turno.estado !== 'abierto') {
            return res.status(400).json({ error: 'El turno ya está cerrado: no se pueden anular sus movimientos' });
        }

        // La anulación sigue la misma preferencia que el registro: si el negocio pide
        // PIN para mover dinero, también lo pide para deshacer el movimiento.
        let autorizado = null;
        const prefs = await getPrefs(biz);
        if (prefs.movimientos_caja_pin !== false) {
            const auth = await _autorizarCaja(req, {
                employee_id, employee_name, role, pin, branchId: mov.branch_id
            });
            if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
            autorizado = auth;
        }

        const nombre = autorizado?.nombre || employee_name || null;

        await mov.update({
            anulado: true,
            anulado_por: autorizado?.empleadoId || (Number.isInteger(parseInt(employee_id)) ? parseInt(employee_id) : null),
            anulado_por_nombre: nombre,
            anulado_at: new Date(),
            motivo_anulacion: motivo ? String(motivo).slice(0, 500) : null
        });

        if (autorizado) {
            await PrivilegedActionLog.create({
                business_id: biz,
                branch_id:   mov.branch_id || null,
                employee_id: autorizado.empleadoId,
                employee_name: nombre || 'Sin identificar',
                action_type: 'cash_movement_void',
                target_description: `Anulación de ${(ETIQUETA_TIPO[mov.tipo] || mov.tipo).toLowerCase()} de $${(parseFloat(mov.monto) || 0).toFixed(2)} · Turno #${mov.turno_id}`,
                before_data: JSON.stringify({ id: mov.id, tipo: mov.tipo, monto: parseFloat(mov.monto) || 0, anulado: false }),
                after_data: JSON.stringify({ id: mov.id, anulado: true, motivo_anulacion: mov.motivo_anulacion })
            });
        }

        _notificarTurno(biz);
        res.json(_serializarMovimiento(mov));
    } catch (error) {
        logger.error('Error al anular movimiento de caja:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

module.exports = router;
module.exports._notificarTurno = _notificarTurno;
