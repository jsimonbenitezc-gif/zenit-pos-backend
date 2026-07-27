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
            'puntos_activos', 'puntos_por_peso', 'puntos_bono_pedido', 'puntos_valor',
            'permisos_roles',
            'sucursal_id',
            'tz',
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
        ];
        const incoming = {};
        for (const key of ALLOWED_KEYS) {
            if (key in req.body) incoming[key] = req.body[key];
        }

        // La zona horaria se interpola en SQL (stats agrupa por fecha local), así que
        // se rechaza cualquier valor que no sea una zona IANA real.
        if ('tz' in incoming && !zonaValida(incoming.tz)) {
            return res.status(400).json({ error: 'Zona horaria inválida' });
        }

        const updated = { ...current, ...incoming };
        await user.update({ settings: JSON.stringify(updated) });
        if ('tz' in incoming) invalidarZonaNegocio(req.user.business_id);
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
