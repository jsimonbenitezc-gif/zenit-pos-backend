/**
 * routes/kds.js — Dispositivos de cocina (BLOQUE 13 del PLAN_ARREGLOS_V5).
 *
 * Sustituye al pase que caducaba por dispositivos APROBADOS y REVOCABLES.
 *
 * EL FLUJO, y por qué es más seguro que el QR anterior:
 *   1. El dueño abre "Agregar pantalla" → `POST /api/kds/pairing` devuelve un
 *      código de un solo uso que vive 10 minutos.
 *   2. La tablet lo escanea, genera SU PROPIO secreto y lo manda a
 *      `POST /api/kds/devices/register`. Queda en `pendiente`: no lee nada.
 *   3. El dueño la aprueba con su PIN (`POST /:id/approve`). Recién ahí el
 *      dispositivo puede leer la cola de cocina, y para siempre.
 *   4. `POST /:id/revoke` corta el acceso AL INSTANTE, no cuando venza nada.
 *
 * Antes, el QR ERA la credencial: quien lo fotografiara tenía 12 h de acceso.
 * Ahora fotografiar el código solo permite PEDIR permiso — y el permiso lo da
 * una persona tecleando el PIN del negocio.
 */
const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const logger = require('../utils/logger');
const { KdsDevice, Branch, PrivilegedActionLog } = require('../models');
const { authenticate, isOwner } = require('../middleware/auth');
const { autorizarAccionPrivilegiada } = require('../utils/verifyPin');
const { enviarNotificacion } = require('../utils/push');
const { evaluarHorario, avisarFueraDeHorario } = require('../utils/horarios');
const {
    hashSecreto, secretoValido, invalidarDispositivo,
    crearCodigoEmparejamiento, consumirCodigoEmparejamiento,
} = require('../utils/kdsDevices');

// Registrar un dispositivo es la única ruta de este archivo SIN sesión: la
// tablet todavía no tiene credencial. Cada intento consume un código de un solo
// uso, así que no se puede iterar a ciegas, pero el limitador cierra el paso a
// quien lo intente igualmente.
const limitadorRegistro = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.KDS_REGISTER_MAX || 20),
    standardHeaders: true,
    legacyHeaders: false,
    // `ipKeyGenerator` es obligatorio al escribir una clave propia: normaliza
    // IPv6 a su /56. Con `req.ip` pelado, quien tenga un rango IPv6 estrena IP
    // en cada intento y el limitador no limita nada (§27.2).
    keyGenerator: (req) => ipKeyGenerator(req.ip || ''),
    // La suite empareja decenas de pantallas desde la misma "IP" y se toparía
    // con el tope a mitad de camino: los tests dejarían de probar el flujo para
    // pasar a probar el limitador, y en un orden que cambia con cada test nuevo.
    skip: () => process.env.NODE_ENV === 'test',
    message: { error: 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.' },
});

/** Lo que ve el cliente. El `secret_hash` NUNCA sale de aquí. */
function _serializar(d) {
    return {
        id: d.id,
        nombre: d.nombre,
        estado: d.estado,
        branch_id: d.branch_id ?? null,
        branch_name: d.branch?.name ?? null,
        aprobado_por_nombre: d.aprobado_por_nombre ?? null,
        aprobado_en: d.aprobado_en ?? null,
        revocado_por_nombre: d.revocado_por_nombre ?? null,
        revocado_en: d.revocado_en ?? null,
        ultimo_acceso: d.ultimo_acceso ?? null,
        user_agent: d.user_agent ?? null,
        ip_registro: d.ip_registro ?? null,
        createdAt: d.createdAt,
    };
}

/**
 * Autoriza aprobar o revocar. Pasa por `autorizarAccionPrivilegiada` como todo
 * lo demás que pide PIN en Zenit: acepta el PIN de PUESTO (lo único que el
 * cajero tiene) o la contraseña de una cuenta. Aceptar solo la segunda dejaría
 * la función muerta en el POS — la trampa del §19.19.
 */
function _autorizar(req, { employee_id, employee_name, role, pin, branchId }) {
    return autorizarAccionPrivilegiada({
        businessId: req.user.business_id,
        actorId: req.user.id,
        employee_id, employee_name, role, pin, branchId,
    });
}

// ─── POST /api/kds/pairing — código de emparejamiento de un solo uso ─────────
router.post('/pairing', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;
        let branchId = req.body?.branch_id ?? null;

        if (branchId) {
            const sucursal = await Branch.findOne({
                where: { id: branchId, business_id: biz }
            });
            if (!sucursal) return res.status(400).json({ error: 'Sucursal no encontrada' });
        }

        const { codigo, expira_en_segundos } = crearCodigoEmparejamiento({
            businessId: biz,
            branchId: branchId || null,
        });

        const base = process.env.APP_URL || '';
        res.json({
            codigo,
            expira_en_segundos,
            // La tablet abre esta URL. El código va en `pair`, no en `token`:
            // no es una credencial, es una invitación de un solo uso.
            url: `${base}/kds?pair=${codigo}`,
        });
    } catch (error) {
        logger.error('Error al crear código de emparejamiento del KDS:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ─── GET /api/kds/devices — lista de pantallas del negocio ───────────────────
router.get('/devices', authenticate, async (req, res) => {
    try {
        const dispositivos = await KdsDevice.findAll({
            where: { business_id: req.user.business_id },
            include: [{ model: Branch, as: 'branch', attributes: ['id', 'name'], required: false }],
            order: [['createdAt', 'DESC']],
            limit: 200,
        });
        res.json({ data: dispositivos.map(_serializar) });
    } catch (error) {
        logger.error('Error al listar dispositivos del KDS:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ─── POST /api/kds/devices/register — la tablet pide permiso ────────────────
// Sin sesión: la tablet aún no tiene credencial. Lo máximo que consigue esta
// ruta es dejar el dispositivo en `pendiente`.
router.post('/devices/register', limitadorRegistro, async (req, res) => {
    try {
        const { codigo, device_secret, nombre } = req.body || {};

        if (!secretoValido(device_secret)) {
            return res.status(400).json({ error: 'Identificador de dispositivo inválido' });
        }

        const hash = hashSecreto(device_secret);
        const userAgent = String(req.headers['user-agent'] || '').slice(0, 500);
        const ip = String(req.ip || '').slice(0, 64);

        // Un dispositivo que ya se registró vuelve a preguntar (la página se
        // recargó, o está esperando aprobación): se le responde su estado sin
        // gastar el código ni crear una fila nueva.
        const existente = await KdsDevice.findOne({ where: { secret_hash: hash } });
        if (existente) {
            if (existente.estado === 'revocado') {
                // No se reactiva reusando el secreto: la fila revocada es el
                // registro de que a ese equipo se le cortó el acceso, y
                // resucitarla lo borraría. La tablet genera un secreto nuevo y
                // vuelve a emparejarse, dejando las dos filas visibles.
                return res.status(403).json({
                    error: 'Este dispositivo fue revocado. Pide un código nuevo para volver a emparejarlo.',
                    estado: 'revocado',
                });
            }
            return res.json({
                id: existente.id,
                estado: existente.estado,
                nombre: existente.nombre,
            });
        }

        const emparejamiento = consumirCodigoEmparejamiento(codigo);
        if (!emparejamiento) {
            return res.status(401).json({
                error: 'Código inválido o vencido. Genera uno nuevo desde la app.',
            });
        }

        const dispositivo = await KdsDevice.create({
            business_id: emparejamiento.businessId,
            branch_id: emparejamiento.branchId,
            nombre: nombre ? String(nombre).slice(0, 80) : null,
            secret_hash: hash,
            estado: 'pendiente',
            user_agent: userAgent,
            ip_registro: ip,
        });

        // El dueño puede estar en otra parte del local: sin este aviso tendría
        // que adivinar que la tablet está esperando.
        enviarNotificacion(
            emparejamiento.businessId,
            'notif_kds_dispositivo',
            '📺 Pantalla de cocina esperando aprobación',
            `${dispositivo.nombre || 'Un dispositivo nuevo'} quiere ver la cola de cocina. Apruébalo en Ajustes.`,
            { tipo: 'kds_device', id: dispositivo.id }
        );

        res.status(201).json({ id: dispositivo.id, estado: 'pendiente', nombre: dispositivo.nombre });
    } catch (error) {
        logger.error('Error al registrar dispositivo del KDS:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ─── GET /api/kds/devices/me — la tablet consulta su propio estado ──────────
// No usa `authenticate`: ese middleware acota los tokens de dispositivo a la
// cola de cocina, y esta ruta es justo la excepción — es como la tablet se
// entera de que la aprobaron (o de que la revocaron).
router.get('/devices/me', async (req, res) => {
    try {
        const cabecera = req.headers.authorization || '';
        const secreto = cabecera.startsWith('Bearer ')
            ? cabecera.slice(7).replace(/^zkds_/, '')
            : null;
        if (!secreto) return res.status(401).json({ error: 'Dispositivo no identificado' });

        const dispositivo = await KdsDevice.findOne({
            where: { secret_hash: hashSecreto(secreto) },
            include: [{ model: Branch, as: 'branch', attributes: ['id', 'name'], required: false }],
        });
        if (!dispositivo) return res.status(404).json({ error: 'Dispositivo no encontrado', estado: 'desconocido' });

        res.json({
            id: dispositivo.id,
            estado: dispositivo.estado,
            nombre: dispositivo.nombre,
            branch_id: dispositivo.branch_id ?? null,
            branch_name: dispositivo.branch?.name ?? null,
        });
    } catch (error) {
        logger.error('Error al consultar estado del dispositivo del KDS:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ─── POST /api/kds/devices/:id/approve — aprobar con PIN ────────────────────
router.post('/devices/:id/approve', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const { nombre, employee_id, employee_name, role, pin, branch_id } = req.body || {};

        const dispositivo = await KdsDevice.findOne({
            where: { id: req.params.id, business_id: biz }
        });
        if (!dispositivo) return res.status(404).json({ error: 'Dispositivo no encontrado' });
        if (dispositivo.estado === 'activo') {
            return res.status(400).json({ error: 'Este dispositivo ya está aprobado' });
        }
        if (dispositivo.estado === 'revocado') {
            return res.status(400).json({
                error: 'Este dispositivo fue revocado. Empareja la pantalla de nuevo para volver a autorizarla.'
            });
        }

        // Aprobar una pantalla es dar acceso permanente a la cola de pedidos:
        // pide PIN, igual que cancelar un pedido o sacar dinero de la caja.
        const auth = await _autorizar(req, {
            employee_id, employee_name, role, pin, branchId: dispositivo.branch_id
        });
        if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

        // ── BLOQUE 14: la ÚNICA acción que el horario restringe ──────────────
        //
        // El horario es una señal, nunca un candado (utils/horarios.js): jamás se
        // bloquea vender, cobrar, abrir turno ni ver la cocina. Aquí sí, y por una
        // razón concreta: aprobar una pantalla da acceso PERMANENTE a la cola de
        // pedidos, y a las 3 de la mañana no hay nadie mirando quién teclea un PIN
        // que además es compartido entre todo un puesto.
        //
        // No es un bloqueo duro: es una ESCALERA. Dentro del horario aprueba
        // cualquier puesto con PIN; fuera, solo el dueño. Así el que instala la
        // tablet a las 8 a.m. antes de abrir tiene salida, y no se repite el error
        // del pase de 12 h del §35 (proteger poco y estorbar mucho a la vez).
        const marcaHorario = await evaluarHorario(biz);
        if (marcaHorario.fuera && req.user.id !== req.user.business_id) {
            return res.status(403).json({
                error: `Fuera del horario del negocio (hoy ${marcaHorario.ventana}) solo el administrador puede autorizar una pantalla de cocina. Pídeselo, o cambia el horario en Ajustes.`
            });
        }

        if (branch_id !== undefined && branch_id !== null) {
            const sucursal = await Branch.findOne({ where: { id: branch_id, business_id: biz } });
            if (!sucursal) return res.status(400).json({ error: 'Sucursal no encontrada' });
            dispositivo.branch_id = branch_id;
        }

        dispositivo.nombre = (nombre ? String(nombre).slice(0, 80) : dispositivo.nombre) || `Pantalla ${dispositivo.id}`;
        dispositivo.estado = 'activo';
        dispositivo.aprobado_por = auth.empleadoId || req.user.id || null;
        dispositivo.aprobado_por_nombre = auth.nombre || employee_name || 'Sin identificar';
        dispositivo.aprobado_en = new Date();
        await dispositivo.save();

        // Sin esto el dispositivo seguiría viendo su estado viejo hasta 30 s.
        invalidarDispositivo(dispositivo.secret_hash);

        await PrivilegedActionLog.create({
            business_id: biz,
            branch_id: dispositivo.branch_id || null,
            employee_id: auth.empleadoId,
            employee_name: dispositivo.aprobado_por_nombre,
            action_type: 'approve_kds_device',
            fuera_horario: marcaHorario.fuera,
            target_description: `Aprobó la pantalla de cocina "${dispositivo.nombre}"`,
            after_data: JSON.stringify({
                id: dispositivo.id,
                nombre: dispositivo.nombre,
                branch_id: dispositivo.branch_id,
                user_agent: dispositivo.user_agent,
                ip_registro: dispositivo.ip_registro,
            }),
        });
        avisarFueraDeHorario(biz, 'approve_kds_device', marcaHorario);

        res.json(_serializar(dispositivo));
    } catch (error) {
        logger.error('Error al aprobar dispositivo del KDS:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ─── POST /api/kds/devices/:id/revoke — cortar el acceso ────────────────────
// Sirve también para rechazar uno pendiente: en los dos casos el registro se
// conserva. Un dispositivo que se puede borrar sin rastro no sirve como
// control, igual que los movimientos de caja del §28.5.
router.post('/devices/:id/revoke', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const { employee_id, employee_name, role, pin, motivo } = req.body || {};

        const dispositivo = await KdsDevice.findOne({
            where: { id: req.params.id, business_id: biz }
        });
        if (!dispositivo) return res.status(404).json({ error: 'Dispositivo no encontrado' });
        if (dispositivo.estado === 'revocado') {
            return res.json(_serializar(dispositivo));
        }

        const auth = await _autorizar(req, {
            employee_id, employee_name, role, pin, branchId: dispositivo.branch_id
        });
        if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

        // Revocar NO se restringe por horario: quitarle el acceso a una pantalla
        // perdida es justo lo que hay que poder hacer a las 3 a.m. Solo se marca.
        const marcaRevocacion = await evaluarHorario(biz);

        const estadoAnterior = dispositivo.estado;
        dispositivo.estado = 'revocado';
        dispositivo.revocado_por = auth.empleadoId || req.user.id || null;
        dispositivo.revocado_por_nombre = auth.nombre || employee_name || 'Sin identificar';
        dispositivo.revocado_en = new Date();
        await dispositivo.save();

        // EL CORTE ES AQUÍ. Sin invalidar el caché, la tablet seguiría leyendo la
        // cocina hasta 30 segundos más, y "revocar corta al instante" sería mentira.
        invalidarDispositivo(dispositivo.secret_hash);

        await PrivilegedActionLog.create({
            business_id: biz,
            branch_id: dispositivo.branch_id || null,
            employee_id: auth.empleadoId,
            employee_name: dispositivo.revocado_por_nombre,
            action_type: 'revoke_kds_device',
            fuera_horario: marcaRevocacion.fuera,
            target_description: estadoAnterior === 'pendiente'
                ? `Rechazó la pantalla de cocina "${dispositivo.nombre || 'sin nombre'}"`
                : `Revocó la pantalla de cocina "${dispositivo.nombre || 'sin nombre'}"`,
            before_data: JSON.stringify({ estado: estadoAnterior }),
            after_data: JSON.stringify({
                id: dispositivo.id,
                estado: 'revocado',
                motivo: motivo ? String(motivo).slice(0, 300) : null,
            }),
        });
        avisarFueraDeHorario(biz, 'revoke_kds_device', marcaRevocacion);

        res.json(_serializar(dispositivo));
    } catch (error) {
        logger.error('Error al revocar dispositivo del KDS:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ─── DELETE /api/kds/devices/:id — limpiar la lista ─────────────────────────
// Solo el dueño, y NUNCA sobre uno activo: borrar el registro de un equipo con
// acceso lo dejaría con acceso y sin rastro. Primero se revoca (queda auditado),
// después se puede quitar de la vista.
router.delete('/devices/:id', authenticate, isOwner, async (req, res) => {
    try {
        const dispositivo = await KdsDevice.findOne({
            where: { id: req.params.id, business_id: req.user.business_id }
        });
        if (!dispositivo) return res.status(404).json({ error: 'Dispositivo no encontrado' });
        if (dispositivo.estado === 'activo') {
            return res.status(400).json({ error: 'Revoca el dispositivo antes de quitarlo de la lista' });
        }

        invalidarDispositivo(dispositivo.secret_hash);
        await dispositivo.destroy();
        res.json({ success: true });
    } catch (error) {
        logger.error('Error al eliminar dispositivo del KDS:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

module.exports = router;
