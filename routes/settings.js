const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const { User } = require('../models');
const { authenticate } = require('../middleware/auth');
const { configurarSSE } = require('../utils/sse');
const { zonaValida, invalidarZonaNegocio } = require('../utils/tz');
const { normalizarTasa, normalizarNombre, invalidarImpuestoNegocio, NOMBRE_MAX } = require('../utils/impuestos');
const { normalizarSugerencias, invalidarPropinasNegocio } = require('../utils/propinas');
const { normalizarHorario, invalidarHorarioNegocio } = require('../utils/horarios');

// Protección: máximo 10 intentos de verificación de PIN por minuto por IP
const pinLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    message: { error: 'Demasiados intentos de verificación de PIN. Intenta de nuevo en un minuto.' },
    standardHeaders: true,
    legacyHeaders: false
});

// ── SSE: notificaciones en tiempo real de cambios en ajustes ──────────────────
const _settingsClients = new Map(); // businessId (string) → Set<Response>

function _notificarSettings(businessId) {
    const clients = _settingsClients.get(String(businessId));
    if (!clients || clients.size === 0) return;
    const msg = `data: {}\n\n`;
    for (const res of clients) {
        if (res.writableEnded) { clients.delete(res); continue; }
        try { res.write(msg); } catch { clients.delete(res); }
    }
}

router.get('/events', (req, res) => {
    configurarSSE(_settingsClients, req, res);
});

// GET /api/settings - Obtener ajustes del negocio
router.get('/', authenticate, async (req, res) => {
    try {
        const user = await User.findByPk(req.user.id, { attributes: ['id', 'settings'] });
        if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
        const settings = user.settings ? JSON.parse(user.settings) : {};
        res.json(settings);
    } catch (error) {
        logger.error('Error al obtener ajustes:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// PUT /api/settings - Guardar ajustes del negocio
router.put('/', authenticate, async (req, res) => {
    try {
        const user = await User.findByPk(req.user.id);
        if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
        const current = user.settings ? JSON.parse(user.settings) : {};
        const ALLOWED_KEYS = [
            'business_name', 'business_phone', 'business_email', 'business_website',
            'business_rfc', 'business_instagram', 'business_city', 'business_state',
            'business_address', 'business_tipo',
            'currency_symbol', 'ticket_footer',
            'show_logo', 'show_phone', 'show_direccion', 'show_email',
            'show_website', 'show_instagram', 'show_rfc',
            'logo_base64',
            'venta_sin_turno',
            'movimientos_caja_pin',
            // Impuesto configurable (BLOQUE 8): interruptor, tasa en %, si el
            // precio ya lo incluye y cómo se llama en el ticket (IVA, ITBIS...).
            'tax_enabled', 'tax_rate', 'tax_included', 'tax_name',
            // Propinas (BLOQUE 9): interruptor y porcentajes sugeridos del POS.
            'propinas_activas', 'propina_sugerencias',
            'puntos_activos', 'puntos_por_peso', 'puntos_bono_pedido', 'puntos_valor',
            'permisos_roles',
            'sucursal_id',
            'tz',
            // Horario de operación (BLOQUE 14): SEÑAL de seguridad, nunca candado.
            // Nace SIN definir, y sin él nada de este bloque se dispara.
            'horario_operacion',
            // Preferencias de notificaciones push
            'notif_turno_abierto', 'notif_turno_cerrado',
            'notif_diferencia_caja', 'notif_diferencia_caja_umbral',
            'notif_turno_largo', 'notif_turno_largo_horas',
            'notif_stock_cero',
            'notif_ajuste_inventario',
            'notif_venta_grande', 'notif_venta_grande_umbral',
            'notif_descuento_pin',
            'notif_pedido_cancelado', 'notif_venta_anulada',
            'notif_nuevo_acceso',
            'notif_resumen_diario', 'notif_resumen_diario_hora',
            'notif_resumen_semanal',
            'notif_cliente_nuevo', 'notif_puntos_canjeados',
            'notif_fuera_horario',
        ];
        const incoming = {};
        for (const key of ALLOWED_KEYS) {
            if (key in req.body) incoming[key] = req.body[key];
        }

        // Pedir PIN para los movimientos de caja es una decisión del DUEÑO, no del
        // cajero que tiene el equipo enfrente. El backend lee esta preferencia del
        // owner (getPrefs(business_id)), así que un empleado que la apagara en sus
        // propios settings no cambiaría nada; se rechaza explícito para no dejar una
        // UI que parezca funcionar y no haga efecto.
        if ('movimientos_caja_pin' in incoming && req.user.id !== req.user.business_id) {
            return res.status(403).json({ error: 'Solo el administrador puede cambiar si los movimientos de caja piden PIN' });
        }

        // El impuesto cambia lo que se le COBRA al cliente, así que es una decisión
        // del dueño, no del cajero que tiene la caja enfrente. Mismo criterio que
        // el PIN de movimientos: el backend lee la config del owner, de modo que
        // un empleado que la cambiara en sus propios settings no lograría nada.
        const CLAVES_IMPUESTO = ['tax_enabled', 'tax_rate', 'tax_included', 'tax_name'];
        const tocaImpuesto = CLAVES_IMPUESTO.some(k => k in incoming);
        if (tocaImpuesto && req.user.id !== req.user.business_id) {
            return res.status(403).json({ error: 'Solo el administrador puede cambiar la configuración de impuestos' });
        }
        // La tasa se guarda tal cual y se usa para cobrar: un valor basura cobraría
        // de más a clientes reales, así que se rechaza en vez de caer a un default.
        if ('tax_rate' in incoming) {
            const tasa = normalizarTasa(incoming.tax_rate);
            if (tasa === null) {
                return res.status(400).json({ error: 'La tasa de impuesto debe ser un número entre 0 y 100' });
            }
            incoming.tax_rate = tasa;
        }
        if ('tax_included' in incoming) {
            incoming.tax_included = incoming.tax_included === true || incoming.tax_included === 'true';
        }
        // El interruptor apaga el impuesto SIN borrar la tasa: el negocio que lo
        // apaga temporalmente no debería tener que volver a teclear su 16%.
        if ('tax_enabled' in incoming) {
            incoming.tax_enabled = incoming.tax_enabled === true || incoming.tax_enabled === 'true';
        }
        if ('tax_name' in incoming) {
            if (typeof incoming.tax_name !== 'string' || incoming.tax_name.trim().length > NOMBRE_MAX) {
                return res.status(400).json({ error: `El nombre del impuesto no puede pasar de ${NOMBRE_MAX} caracteres` });
            }
            incoming.tax_name = normalizarNombre(incoming.tax_name);
        }

        // Las propinas cambian lo que se le PIDE al cliente y lo que el corte le
        // exige al cajero en el cajón, así que también son decisión del dueño.
        // Mismo criterio (y misma razón) que el impuesto: el backend lee la config
        // del owner, de modo que un empleado que la cambiara en sus propios
        // settings tendría una UI que parece funcionar y no hace nada.
        const CLAVES_PROPINA = ['propinas_activas', 'propina_sugerencias'];
        const tocaPropina = CLAVES_PROPINA.some(k => k in incoming);
        if (tocaPropina && req.user.id !== req.user.business_id) {
            return res.status(403).json({ error: 'Solo el administrador puede cambiar la configuración de propinas' });
        }
        if ('propinas_activas' in incoming) {
            incoming.propinas_activas = incoming.propinas_activas === true || incoming.propinas_activas === 'true';
        }
        // Los porcentajes solo son botones de ayuda para teclear, así que un valor
        // basura se limpia (cae a los sugeridos) en vez de rechazar el guardado:
        // a diferencia de la tasa de impuesto, esto no cobra de más a nadie.
        if ('propina_sugerencias' in incoming) {
            incoming.propina_sugerencias = normalizarSugerencias(incoming.propina_sugerencias);
        }

        // La zona horaria se interpola en SQL (stats agrupa por fecha local), así que
        // se rechaza cualquier valor que no sea una zona IANA real.
        if ('tz' in incoming && !zonaValida(incoming.tz)) {
            return res.status(400).json({ error: 'Zona horaria inválida' });
        }

        // El horario de operación (BLOQUE 14) es una SEÑAL DE SEGURIDAD: decide qué
        // acciones se marcan como sospechosas y sobre cuáles se avisa al dueño. Que
        // lo cambiara un empleado sería dejarle apagar la alarma que vigila justo sus
        // propias acciones, así que es del DUEÑO — mismo criterio (y misma razón) que
        // el impuesto y las propinas.
        if ('horario_operacion' in incoming && req.user.id !== req.user.business_id) {
            return res.status(403).json({ error: 'Solo el administrador puede cambiar el horario del negocio' });
        }
        // Un horario mal formado se RECHAZA en vez de caer a un default: en silencio
        // dejaría al dueño creyendo que configuró un horario que no existe, esperando
        // unas alertas que nunca van a llegar.
        if ('horario_operacion' in incoming) {
            const r = normalizarHorario(incoming.horario_operacion);
            if (!r.ok) return res.status(400).json({ error: r.error });
            incoming.horario_operacion = r.horario;
        }

        const updated = { ...current, ...incoming };
        await user.update({ settings: JSON.stringify(updated) });
        if ('tz' in incoming) invalidarZonaNegocio(req.user.business_id);
        // Sin esto, el horario recién guardado tardaría hasta 60 s en aplicarse y el
        // dueño que acaba de corregirlo seguiría recibiendo alertas del anterior.
        if ('horario_operacion' in incoming) invalidarHorarioNegocio(req.user.business_id);
        if (tocaImpuesto) invalidarImpuestoNegocio(req.user.business_id);
        if (tocaPropina) invalidarPropinasNegocio(req.user.business_id);
        // Notificar a todos los dispositivos conectados del mismo negocio
        _notificarSettings(req.user.business_id);
        res.json(updated);
    } catch (error) {
        logger.error('Error al guardar ajustes:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// POST /api/settings/verify-pin — Verificar PIN de perfil (permisos_roles) con bcrypt
// Soporta SHA256 legacy (desktop) y migra automáticamente a bcrypt al verificar.
router.post('/verify-pin', pinLimiter, authenticate, async (req, res) => {
    try {
        const { role, pin } = req.body;
        if (!role || !pin) {
            return res.status(400).json({ error: 'role y pin son requeridos' });
        }
        if (!/^\d{4,8}$/.test(pin)) {
            return res.status(400).json({ error: 'El PIN debe ser entre 4 y 8 dígitos numéricos' });
        }

        // Leer permisos_roles del owner del negocio
        const ownerId = req.user.business_id;
        const owner = await User.findByPk(ownerId, { attributes: ['id', 'settings'] });
        if (!owner) return res.status(404).json({ error: 'Negocio no encontrado' });

        const settings = owner.settings ? JSON.parse(owner.settings) : {};
        const permisosRoles = settings.permisos_roles || {};

        // Resolver permisos efectivos (puede haber por sucursal)
        let permisos = permisosRoles;
        // Si es un objeto con claves __b_ (sucursales), buscar en todas
        const branchKeys = Object.keys(permisosRoles).filter(k => k.startsWith('__b_'));
        if (branchKeys.length > 0) {
            // Primero intentar sin sucursal (nivel global)
            const globalPermisos = Object.fromEntries(
                Object.entries(permisosRoles).filter(([k]) => !k.startsWith('__b_'))
            );
            // Si el role existe a nivel global, usar esos
            if (globalPermisos[role]) {
                permisos = globalPermisos;
            } else {
                // Buscar en cada sucursal
                for (const bk of branchKeys) {
                    if (permisosRoles[bk]?.[role]) {
                        permisos = permisosRoles[bk];
                        break;
                    }
                }
            }
        }

        const rolData = permisos[role];
        if (!rolData || !rolData.pin_set) {
            return res.json({ valid: false });
        }

        let valid = false;

        // 1) Intentar bcrypt primero (ya migrado)
        if (rolData.pin_bcrypt) {
            valid = await bcrypt.compare(pin, rolData.pin_bcrypt);
        }
        // 2) Fallback a SHA256 legacy (desktop genera estos)
        else if (rolData.pin) {
            const sha256Hash = crypto.createHash('sha256').update(pin).digest('hex');
            valid = (sha256Hash === rolData.pin);

            // Migración automática: si el SHA256 coincide, guardar bcrypt
            if (valid) {
                rolData.pin_bcrypt = await bcrypt.hash(pin, 10);
                await owner.update({ settings: JSON.stringify(settings) });
                _notificarSettings(ownerId);
            }
        }

        res.json({ valid });
    } catch (error) {
        logger.error('Error en verify-pin (settings):', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// POST /api/settings/hash-pin — Generar hash bcrypt de un PIN (para crear/actualizar PINs)
router.post('/hash-pin', pinLimiter, authenticate, async (req, res) => {
    try {
        const { pin } = req.body;
        if (!pin || !/^\d{4,8}$/.test(pin)) {
            return res.status(400).json({ error: 'El PIN debe ser entre 4 y 8 dígitos numéricos' });
        }
        const hash = await bcrypt.hash(pin, 10);
        res.json({ hash });
    } catch (error) {
        logger.error('Error en hash-pin:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

module.exports = router;
