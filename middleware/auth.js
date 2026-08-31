const jwt = require('jsonwebtoken');
const { User } = require('../models');
const {
    esTokenDeDispositivo, secretoDeToken, resolverDispositivo, tocarUltimoAcceso
} = require('../utils/kdsDevices');

/**
 * ¿Es esta petición la cola de cocina? Es lo ÚNICO que una pantalla de cocina
 * puede pedir, y por eso el cerrojo vive en una función con nombre: cuando el
 * KDS necesite un endpoint nuevo hay que agregarlo AQUÍ, no quitar el cerrojo.
 */
function _esColaDeCocina(req) {
    return req.method === 'GET'
        && req.baseUrl === '/api/orders'
        && (req.path === '/' || req.path === '');
}

// ── Caché corto de usuario (Bloque 3 del PLAN_ARREGLOS_V5) ───────────────────
// `authenticate` corre en CADA request y hacía un `User.findByPk` cada vez, solo
// para recalcular `business_id` y verificar que la cuenta siga activa. Con un POS
// abierto todo el día (SSE + polling + ventas) eso es un roundtrip a Supabase por
// request que casi siempre devuelve lo mismo.
//
// Se cachea `{ business_id, active, role }` por `user.id` durante 30s. El bloqueo
// de cuentas sigue funcionando: `routes/staff.js` invalida la entrada al desactivar
// o editar un empleado, así que el corte es inmediato; los 30s solo cubren cambios
// hechos por fuera de la API (SQL directo en Supabase).
const TTL_CACHE_MS = 30 * 1000;
const MAX_ENTRADAS = 1000;
const _cacheUsuarios = new Map(); // String(userId) → { business_id, active, role, existe, expira }

function _limpiarExpirados() {
    const ahora = Date.now();
    for (const [clave, valor] of _cacheUsuarios) {
        if (valor.expira <= ahora) _cacheUsuarios.delete(clave);
    }
}

/**
 * Datos mínimos del usuario para autorizar el request.
 * Lanza si la BD falla (el llamador decide el fallback) — un error de red NO se
 * cachea, para no dejar pegada una respuesta equivocada durante 30s.
 */
async function datosDelUsuario(userId) {
    const clave = String(userId);
    const guardado = _cacheUsuarios.get(clave);
    if (guardado && guardado.expira > Date.now()) return guardado;

    const dbUser = await User.findByPk(userId, {
        attributes: ['id', 'business_id', 'active', 'role']
    });

    const datos = dbUser
        ? {
            existe: true,
            business_id: dbUser.business_id || dbUser.id,
            active: dbUser.active !== false,
            role: dbUser.role
        }
        : { existe: false };

    if (_cacheUsuarios.size >= MAX_ENTRADAS) _limpiarExpirados();
    _cacheUsuarios.set(clave, { ...datos, expira: Date.now() + TTL_CACHE_MS });
    return datos;
}

/** Borra del caché a un usuario. Llamar SIEMPRE que cambie `active`, `role` o `business_id`. */
function invalidarUsuario(userId) {
    _cacheUsuarios.delete(String(userId));
}

/** Vacía el caché completo (tests, o un futuro "recargar permisos"). */
function limpiarCacheUsuarios() {
    _cacheUsuarios.clear();
}

const authenticate = async (req, res, next) => {
    try {
        const token = req.headers.authorization?.split(' ')[1]; // "Bearer TOKEN"

        if (!token) {
            return res.status(401).json({ error: 'Token no proporcionado' });
        }

        // ── Pantalla de cocina: un DISPOSITIVO APROBADO, no un pase (BLOQUE 13) ──
        // Antes esto era un JWT `purpose:'kds'` de 12 h que viajaba dentro del QR:
        // el propio código ERA la credencial, así que fotografiarlo daba medio día
        // de acceso sin forma de cortarlo. Ahora la credencial es el secreto que la
        // tablet guarda en su `localStorage`, el estado se consulta en cada
        // petición y revocar corta al instante (utils/kdsDevices.js).
        //
        // El cerrojo de alcance se mantiene igual de cerrado: solo GET /api/orders.
        // Sin él, un secreto robado leería clientes, inventario y ventas — que es
        // exactamente lo que pasaba con los tokens del KDS antes del §19.13.
        if (esTokenDeDispositivo(token)) {
            if (!_esColaDeCocina(req)) {
                return res.status(403).json({ error: 'Este dispositivo solo permite consultar la cola de cocina' });
            }
            let dispositivo;
            try {
                dispositivo = await resolverDispositivo(secretoDeToken(token));
            } catch {
                // La BD falló: sin poder comprobar el estado NO se deja pasar. Un
                // dispositivo revocado entrando "porque no se pudo verificar"
                // sería justo el agujero que este bloque viene a cerrar.
                return res.status(503).json({ error: 'No se pudo verificar el dispositivo' });
            }
            if (!dispositivo.existe || dispositivo.estado === 'revocado') {
                return res.status(401).json({ error: 'Dispositivo no autorizado' });
            }
            if (dispositivo.estado !== 'activo') {
                return res.status(403).json({ error: 'Dispositivo pendiente de aprobación' });
            }
            tocarUltimoAcceso(dispositivo.id);
            req.user = {
                business_id: dispositivo.business_id,
                branch_id: dispositivo.branch_id ?? null,
                esKds: true,
                kds_device_id: dispositivo.id
            };
            return next();
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // Un JWT con `purpose:'kds'` es un pase de los que este bloque eliminó
        // (los emitía el POST /api/kds/token que ya no existe). Se rechaza en vez
        // de ignorarse: dejarlo caer al camino normal lo convertiría otra vez en
        // un token de sesión completo, que es como nació el agujero del §19.13.
        if (decoded.purpose === 'kds') {
            return res.status(401).json({
                error: 'Este código de cocina ya no es válido. Vuelve a emparejar la pantalla desde la app.'
            });
        }

        req.user = decoded;

        // owners: business_id = su propio id | staff: business_id = id del dueño al que pertenecen
        // Se recalcula desde DB para soportar tokens antiguos emitidos con business_id incorrecto.
        try {
            const datos = await datosDelUsuario(decoded.id);
            if (datos.existe) {
                if (!datos.active) {
                    return res.status(401).json({ error: 'Cuenta desactivada' });
                }
                req.user.business_id = datos.business_id;
            } else {
                req.user.business_id = decoded.business_id || decoded.id;
            }
        } catch {
            req.user.business_id = decoded.business_id || decoded.id;
        }
        next();
    } catch (error) {
        return res.status(401).json({ error: 'Token inválido' });
    }
};

const isOwner = async (req, res, next) => {
    try {
        // Mismo caché que `authenticate`: en una ruta de dueño ya se resolvió hace
        // microsegundos, así que esto no toca la BD.
        const datos = await datosDelUsuario(req.user.id);
        if (!datos.existe || datos.role !== 'owner') {
            return res.status(403).json({ error: 'Acceso denegado. Solo para administradores.' });
        }
        next();
    } catch {
        return res.status(500).json({ error: 'Error al verificar permisos' });
    }
};

module.exports = { authenticate, isOwner, invalidarUsuario, limpiarCacheUsuarios };
