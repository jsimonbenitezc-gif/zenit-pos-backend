const jwt = require('jsonwebtoken');
const { User } = require('../models');

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

        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // Tokens del KDS (purpose:'kds'): se firman con el MISMO JWT_SECRET y viajan
        // en un QR, así que hay que acotarlos. Sin este cerrojo servían como token de
        // sesión completo: al no traer `id`, la búsqueda de usuario fallaba, se caía al
        // fallback `business_id = decoded.business_id` y quedaban habilitados contra
        // cualquier ruta que filtre por negocio (clientes, inventario, ventas...).
        // Solo pueden leer la cola de cocina, que es lo único que consume kds.html.
        if (decoded.purpose === 'kds') {
            const esColaDeCocina = req.method === 'GET'
                && req.baseUrl === '/api/orders'
                && (req.path === '/' || req.path === '');
            if (!esColaDeCocina) {
                return res.status(403).json({ error: 'Este token solo permite consultar la cola de cocina' });
            }
            req.user = {
                business_id: decoded.business_id,
                branch_id: decoded.branch_id ?? null,
                esKds: true
            };
            return next();
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
