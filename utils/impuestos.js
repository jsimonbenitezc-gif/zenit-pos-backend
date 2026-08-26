// ============================================================================
// utils/impuestos.js — Impuesto configurable por negocio (BLOQUE 8 V5)
//
// Único lugar donde se decide CÓMO se desglosa el impuesto de una venta. Lo
// comparten la creación de la venta, el recálculo de una mesa abierta y el
// reporte del turno: si cada uno lo calculara aparte, el ticket diría un número
// y el corte otro.
//
// INTERRUPTOR (settings.tax_enabled): el impuesto se enciende y se apaga sin
// perder la tasa configurada. Apagado es el estado por defecto: la mayoría de los
// negocios no cobra impuesto y no debería ver un solo renglón extra.
//
// DOS MODOS (settings.tax_included):
//   • INCLUIDO (true, DEFAULT)  — el precio del catálogo YA trae el impuesto y el
//     ticket lo desglosa hacia atrás.  total = lo que suman los items.
//     Es el estándar en México: el precio exhibido al consumidor incluye IVA.
//   • AGREGADO (false)          — el precio del catálogo es la base y el impuesto
//     se SUMA al cobrar.  total = base + impuesto (típico de mayoreo / B2B)
//
// REGLA CON DESCUENTOS: el descuento baja la BASE GRAVABLE. Se descuenta
// primero y el impuesto se calcula sobre lo que realmente se cobró (criterio
// contable estándar y el que ya seguía el sistema: total = subtotal − descuentos).
// El canje de puntos entra igual que un descuento, por el mismo motivo.
//
// INVARIANTE que respetan todos los consumidores: total = subtotal + impuesto.
// ============================================================================

const { User } = require('../models');

const TASA_MAXIMA = 100;
const NOMBRE_DEFAULT = 'IVA';
const NOMBRE_MAX = 20;

function redondear(n) {
    return parseFloat((Math.round((n + Number.EPSILON) * 100) / 100).toFixed(2));
}

/**
 * Normaliza la tasa que llega de ajustes o de un cliente.
 * @returns {number|null} null = valor inservible (usar 0 / la del negocio).
 */
function normalizarTasa(valor) {
    if (valor === undefined || valor === null || valor === '') return null;
    const tasa = parseFloat(valor);
    if (!Number.isFinite(tasa) || tasa < 0 || tasa > TASA_MAXIMA) return null;
    return parseFloat(tasa.toFixed(2));
}

/** Acepta true/'true' (los ajustes del desktop viajan como texto). */
function esIncluido(valor) {
    return valor === true || valor === 'true' || valor === 1 || valor === '1';
}

/**
 * El modo de los AJUSTES del negocio, cuyo default es INCLUIDO.
 * ⚠️ No confundir con `esIncluido` a secas, que se usa para el `tax_included` de
 * un PEDIDO: ahí un valor ausente significa "pedido anterior al bloque" (sin
 * impuesto), no "incluido".
 */
function incluidoDeAjustes(valor) {
    if (valor === undefined || valor === null || valor === '') return true;
    return esIncluido(valor);
}

/** ¿El negocio tiene el impuesto encendido? */
function activoDeAjustes(prefs = {}, tasaConfigurada = 0) {
    const valor = prefs.tax_enabled;
    // Config anterior al interruptor: encendido si tenía una tasa puesta.
    if (valor === undefined || valor === null || valor === '') return tasaConfigurada > 0;
    return valor === true || valor === 'true' || valor === 1 || valor === '1';
}

function normalizarNombre(valor) {
    if (typeof valor !== 'string') return NOMBRE_DEFAULT;
    const limpio = valor.trim().slice(0, NOMBRE_MAX);
    return limpio || NOMBRE_DEFAULT;
}

/**
 * Config de impuesto a partir de los settings del dueño.
 *
 * Apagado (el default) = negocio sin impuesto: todo se comporta como antes del
 * bloque. `tasa` es la EFECTIVA (0 si está apagado) y es la única que debe usarse
 * para cobrar; `tasaConfigurada` es la que el dueño dejó guardada, para que
 * apagar y volver a encender no le borre su 16%.
 */
function configDeAjustes(prefs = {}) {
    const tasaConfigurada = normalizarTasa(prefs.tax_rate) ?? 0;
    const activo = activoDeAjustes(prefs, tasaConfigurada);
    return {
        activo,
        tasa: activo ? tasaConfigurada : 0,
        tasaConfigurada,
        incluido: incluidoDeAjustes(prefs.tax_included),
        nombre: normalizarNombre(prefs.tax_name),
    };
}

/**
 * Desglosa una venta.
 *
 * @param {object} opts
 * @param {number} opts.base   AGREGADO: suma de items − descuentos (sin impuesto).
 *                             INCLUIDO: lo que se cobra (ya trae el impuesto).
 * @param {number} opts.tasa   Porcentaje (16 = 16%).
 * @param {boolean} opts.incluido
 * @returns {{subtotal:number, impuesto:number, total:number}}
 */
function desglosar({ base, tasa, incluido }) {
    const monto = redondear(parseFloat(base) || 0);
    const t = normalizarTasa(tasa) ?? 0;

    // Sin impuesto (o venta en cero) el desglose es trivial y el total no se mueve
    // ni un centavo respecto a como funcionaba antes del bloque.
    if (t <= 0 || monto <= 0) {
        return { subtotal: monto, impuesto: 0, total: monto };
    }

    if (incluido) {
        // El impuesto ya está dentro: se extrae hacia atrás. El subtotal se define
        // como (cobrado − impuesto) —y no como cobrado/(1+t)— para que el
        // invariante total = subtotal + impuesto se cumpla al centavo exacto.
        const impuesto = redondear(monto - monto / (1 + t / 100));
        return { subtotal: redondear(monto - impuesto), impuesto, total: monto };
    }

    const impuesto = redondear(monto * t / 100);
    return { subtotal: monto, impuesto, total: redondear(monto + impuesto) };
}

/**
 * La base que hay que volver a desglosar cuando cambia el contenido de un pedido
 * abierto (mesa a la que se le agregan o quitan productos).
 *
 * No es la misma columna en los dos modos: en AGREGADO el acumulador es el
 * subtotal (sin impuesto) y en INCLUIDO es el total cobrado (que ya lo trae).
 * Sumarle el precio de un producto a la columna equivocada descuadra la mesa.
 *
 * Un pedido anterior al bloque no tiene `subtotal` ni tasa: cae a su total, que
 * es exactamente lo que se cobró.
 */
function baseParaRecalcular(order) {
    const total = parseFloat(order.total) || 0;
    if (esIncluido(order.tax_included)) return total;
    const subtotal = order.subtotal === null || order.subtotal === undefined
        ? null
        : parseFloat(order.subtotal);
    return Number.isFinite(subtotal) ? subtotal : total;
}

/**
 * Config con la que se registra una venta.
 *
 * En una venta DIFERIDA (offline que llega tarde, BLOQUE 5) se respeta la tasa
 * que tenía el equipo al cobrar: si el dueño cambió el IVA mientras la caja
 * estaba sin red, re-desglosar con la tasa de hoy cambiaría un ticket ya
 * entregado. En una venta online manda siempre el negocio.
 *
 * ⚠️ NUNCA se acepta el `tax_amount` del cliente: el monto se recalcula aquí.
 * Lo único que se le cree es la tasa y el modo, y solo si son válidos.
 */
function resolverImpuestoVenta(configNegocio, body = {}, esVentaDiferida = false) {
    if (!esVentaDiferida) return configNegocio;
    const tasa = normalizarTasa(body.tax_rate);
    if (tasa === null) return configNegocio;
    return {
        ...configNegocio,
        activo: tasa > 0,
        tasa,
        tasaConfigurada: tasa,
        incluido: body.tax_included === undefined || body.tax_included === null
            ? configNegocio.incluido
            : esIncluido(body.tax_included),
    };
}

// ── Config del negocio (con caché corta, igual que la zona horaria) ──────────

const _cache = new Map(); // businessId → { config, expira }
const TTL_MS = 60 * 1000;

/**
 * Config de impuesto del negocio. Cachea 60s porque cada venta la pide y casi
 * nunca cambia; `invalidarImpuestoNegocio` la limpia al guardar ajustes.
 */
async function configImpuestoNegocio(businessId) {
    const clave = String(businessId);
    const guardada = _cache.get(clave);
    if (guardada && guardada.expira > Date.now()) return guardada.config;

    let config = { activo: false, tasa: 0, tasaConfigurada: 0, incluido: true, nombre: NOMBRE_DEFAULT };
    try {
        const owner = await User.findByPk(businessId, { attributes: ['settings'] });
        if (owner) config = configDeAjustes(JSON.parse(owner.settings || '{}'));
    } catch {
        // Ante cualquier fallo se vende SIN impuesto en vez de rechazar la venta:
        // cobrar de más por un JSON roto sería peor que no desglosar.
    }
    _cache.set(clave, { config, expira: Date.now() + TTL_MS });
    return config;
}

function invalidarImpuestoNegocio(businessId) {
    _cache.delete(String(businessId));
}

function limpiarCacheImpuestos() {
    _cache.clear();
}

module.exports = {
    TASA_MAXIMA,
    NOMBRE_DEFAULT,
    NOMBRE_MAX,
    redondear,
    normalizarTasa,
    normalizarNombre,
    esIncluido,
    incluidoDeAjustes,
    activoDeAjustes,
    configDeAjustes,
    desglosar,
    baseParaRecalcular,
    resolverImpuestoVenta,
    configImpuestoNegocio,
    invalidarImpuestoNegocio,
    limpiarCacheImpuestos,
};
