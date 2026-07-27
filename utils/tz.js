/**
 * utils/tz.js — Zona horaria POR NEGOCIO (Bloque 2 del PLAN_ARREGLOS_V5).
 *
 * PROBLEMA QUE RESUELVE
 * Render corre en UTC. Antes, "hoy" en el dashboard y los resúmenes automáticos usaban
 * `new Date().setHours(0,0,0,0)` = medianoche del SERVIDOR. En México (UTC-6) el día
 * cortaba a las 6pm: las ventas de la noche se contaban en el día siguiente.
 *
 * SOLUCIÓN
 * Cada negocio guarda su zona IANA en `settings.tz` (p.ej. 'America/Mexico_City').
 * Aquí viven los helpers para:
 *   - resolver la zona del negocio (con caché corta, se lee en cada request de stats),
 *   - calcular los límites de "hoy/ayer/hace N días" en hora local (JS, sin SQL),
 *   - generar el SQL para agrupar por fecha/hora local (dialecto-aware).
 *
 * ⚠️ TRAMPA (verificada): `orders."createdAt"` es TIMESTAMP **WITH** TIME ZONE
 * (Sequelize DataTypes.DATE → timestamptz en Postgres). Para ese tipo la conversión
 * correcta es UNA sola: `"createdAt" AT TIME ZONE 'America/Mexico_City'`.
 * La forma doble (`(x AT TIME ZONE 'UTC') AT TIME ZONE tz`) SOLO aplica a columnas
 * `timestamp without time zone`; sobre timestamptz da un resultado silenciosamente
 * equivocado (desplazado el doble del offset).
 */

const { User } = require('../models');

// Zona por defecto para negocios que nunca la configuraron (cuentas previas a este bloque).
// Los clientes nuevos mandan la zona del dispositivo al registrarse.
const ZONA_DEFAULT = process.env.DEFAULT_TZ || 'America/Mexico_City';

/**
 * Valida que sea una zona IANA usable. Doble propósito:
 *   1) Evitar guardar basura en settings.
 *   2) SEGURIDAD: la zona se interpola en SQL (`AT TIME ZONE '...'`), así que el regex
 *      bloquea comillas y cualquier carácter que permita inyección.
 */
function zonaValida(tz) {
    if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false;
    if (!/^[A-Za-z0-9_+\-/]+$/.test(tz)) return false;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

/** Devuelve la zona si es válida, o la default. Nunca lanza. */
function normalizarZona(tz) {
    return zonaValida(tz) ? tz : ZONA_DEFAULT;
}

// ── Cálculos de hora local (puro JS con Intl, sirve en Postgres y SQLite) ─────

const _formateadores = new Map();

function _formateador(tz) {
    if (!_formateadores.has(tz)) {
        _formateadores.set(tz, new Intl.DateTimeFormat('en-US', {
            timeZone: tz,
            hourCycle: 'h23',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit'
        }));
    }
    return _formateadores.get(tz);
}

/** Partes del calendario local (año, mes 1-12, día, hora 0-23, ...) para un instante. */
function partesLocales(tz, fecha = new Date()) {
    const p = {};
    for (const parte of _formateador(normalizarZona(tz)).formatToParts(fecha)) {
        if (parte.type !== 'literal') p[parte.type] = parseInt(parte.value, 10);
    }
    return {
        year: p.year, month: p.month, day: p.day,
        hour: p.hour % 24, minute: p.minute, second: p.second
    };
}

/** Offset de la zona en minutos (local - UTC) para ese instante. México = -360. */
function offsetMinutos(tz, fecha = new Date()) {
    const p = partesLocales(tz, fecha);
    const comoUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const base = fecha.getTime() - fecha.getMilliseconds();
    return Math.round((comoUTC - base) / 60000);
}

/** Hora local del negocio (0-23). Para los crons. */
function horaLocal(tz, fecha = new Date()) {
    return partesLocales(tz, fecha).hour;
}

/** Día de la semana local (0=domingo … 1=lunes). Para el resumen semanal. */
function diaSemanaLocal(tz, fecha = new Date()) {
    const p = partesLocales(tz, fecha);
    return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
}

/**
 * Convierte una fecha civil local (año/mes/día a medianoche) al instante UTC exacto.
 * Se resuelve en dos pasos para que los cambios de horario de verano no corran el límite.
 */
function _instanteDeMedianocheLocal(tz, year, month, day) {
    const civil = Date.UTC(year, month - 1, day, 0, 0, 0);
    let instante = civil - offsetMinutos(tz, new Date(civil)) * 60000;
    instante = civil - offsetMinutos(tz, new Date(instante)) * 60000;
    return new Date(instante);
}

/**
 * Inicio del día LOCAL como instante UTC, listo para comparar contra `createdAt`.
 * @param {string} tz zona IANA
 * @param {Date}   fecha instante de referencia (default: ahora)
 * @param {number} desplazamientoDias 0 = hoy, -1 = ayer, -6 = hace 6 días
 */
function inicioDiaLocal(tz, fecha = new Date(), desplazamientoDias = 0) {
    const zona = normalizarZona(tz);
    const p = partesLocales(zona, fecha);
    return _instanteDeMedianocheLocal(zona, p.year, p.month, p.day + desplazamientoDias);
}

/**
 * Inicio del día local a partir de una fecha 'YYYY-MM-DD' (los filtros del dashboard
 * mandan fechas sin hora; interpretarlas en UTC corría el rango medio día).
 * Devuelve null si el texto no tiene ese formato.
 */
function inicioDiaLocalISO(tz, texto, desplazamientoDias = 0) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(texto || '').trim());
    if (!m) return null;
    return _instanteDeMedianocheLocal(
        normalizarZona(tz),
        parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10) + desplazamientoDias
    );
}

// ── SQL para agrupar por fecha/hora LOCAL ────────────────────────────────────

/**
 * Expresión SQL que devuelve el timestamp local del negocio.
 * Postgres: conversión real de zona (respeta horario de verano).
 * SQLite (solo tests): desplazamiento por offset fijo del momento actual — suficiente
 * para las pruebas, que no cruzan cambios de horario.
 */
function _sqlTimestampLocal(sequelize, columna, tz) {
    const zona = normalizarZona(tz);
    if (sequelize.getDialect() === 'postgres') {
        return `(${columna} AT TIME ZONE '${zona}')`;
    }
    const off = offsetMinutos(zona);
    return `datetime(${columna}, '${off} minutes')`;
}

/** SQL que devuelve la FECHA local ('YYYY-MM-DD') de una columna de timestamp. */
function sqlFechaLocal(sequelize, columna, tz) {
    if (sequelize.getDialect() === 'postgres') {
        return `DATE(${_sqlTimestampLocal(sequelize, columna, tz)})`;
    }
    return `strftime('%Y-%m-%d', ${_sqlTimestampLocal(sequelize, columna, tz)})`;
}

/** SQL que devuelve la HORA local (entero 0-23) de una columna de timestamp. */
function sqlHoraLocal(sequelize, columna, tz) {
    if (sequelize.getDialect() === 'postgres') {
        return `EXTRACT(HOUR FROM ${_sqlTimestampLocal(sequelize, columna, tz)})`;
    }
    return `CAST(strftime('%H', ${_sqlTimestampLocal(sequelize, columna, tz)}) AS INTEGER)`;
}

/** SQL que devuelve el MES local ('YYYY-MM') de una columna de timestamp. */
function sqlMesLocal(sequelize, columna, tz) {
    if (sequelize.getDialect() === 'postgres') {
        return `TO_CHAR(${_sqlTimestampLocal(sequelize, columna, tz)}, 'YYYY-MM')`;
    }
    return `strftime('%Y-%m', ${_sqlTimestampLocal(sequelize, columna, tz)})`;
}

// ── Zona del negocio (con caché corta) ───────────────────────────────────────

const _cache = new Map(); // businessId → { tz, expira }
const TTL_MS = 60 * 1000;

/**
 * Zona horaria configurada por el negocio. Cachea 60s porque stats la pide en cada
 * request y siempre es la misma. `invalidarZonaNegocio` la limpia al guardar ajustes.
 */
async function zonaDelNegocio(businessId) {
    const clave = String(businessId);
    const guardada = _cache.get(clave);
    if (guardada && guardada.expira > Date.now()) return guardada.tz;

    let tz = ZONA_DEFAULT;
    try {
        const owner = await User.findByPk(businessId, { attributes: ['settings'] });
        if (owner) {
            const prefs = JSON.parse(owner.settings || '{}');
            tz = normalizarZona(prefs.tz);
        }
    } catch {
        // Ante cualquier fallo (JSON roto, BD caída) seguimos con la default:
        // el dashboard debe responder aunque la zona no se pueda leer.
    }
    _cache.set(clave, { tz, expira: Date.now() + TTL_MS });
    return tz;
}

function invalidarZonaNegocio(businessId) {
    _cache.delete(String(businessId));
}

module.exports = {
    ZONA_DEFAULT,
    zonaValida,
    normalizarZona,
    partesLocales,
    offsetMinutos,
    horaLocal,
    diaSemanaLocal,
    inicioDiaLocal,
    inicioDiaLocalISO,
    sqlFechaLocal,
    sqlHoraLocal,
    sqlMesLocal,
    zonaDelNegocio,
    invalidarZonaNegocio,
};
