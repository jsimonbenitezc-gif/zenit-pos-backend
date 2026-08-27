// ============================================================================
// utils/propinas.js — Propinas (BLOQUE 9 V5)
//
// Único lugar donde se decide QUÉ es una propina válida y CÓMO entra a la caja.
// Lo comparten la creación de la venta, el cobro de una mesa, los totales en vivo
// del turno y el cierre: si cada uno lo resolviera aparte, el cajero contaría un
// número en el cajón y el corte le exigiría otro.
//
// ─── LA REGLA DE ORO DEL BLOQUE ──────────────────────────────────────────────
// LA PROPINA NO ES UNA VENTA. No entra en `Order.total`, no paga impuesto y no
// infla las estadísticas del negocio: es dinero del cliente para el empleado que
// solo pasa por la caja. Por eso:
//
//   • `Order.total` sigue siendo lo que costaron los productos, y el invariante
//     del BLOQUE 8 (`total = subtotal + tax_amount`) se mantiene intacto.
//   • Lo que el cliente entrega es `total + tip_amount`. Ese número se calcula al
//     cobrar y se imprime en el ticket, pero NO se guarda como venta.
//   • El impuesto se calcula sobre la base gravable de siempre; la propina queda
//     fuera del cálculo por completo.
//
// ─── DÓNDE SÍ CUENTA: EL CAJÓN ───────────────────────────────────────────────
// Una propina en EFECTIVO sí está físicamente en el cajón, así que el efectivo
// esperado del cierre la incluye (ver utils/cashMovements.js). Si no, cada
// propina en efectivo aparecería como un SOBRANTE y la "diferencia" del corte
// volvería a no significar nada — exactamente el problema que resolvió el
// BLOQUE 7 con los gastos.
//
// Cuando la propina se le entrega al empleado, sale del cajón como un `retiro`
// del BLOQUE 7 (motivo "pago de propinas"). No hay un tipo de movimiento nuevo:
// el retiro ya pide PIN, ya queda auditado y ya cuadra la caja.
//
// ─── MÉTODO PROPIO ───────────────────────────────────────────────────────────
// La propina puede cobrarse por un método distinto al de la venta: es normal
// pagar la cuenta con tarjeta y dejar la propina en efectivo. Por eso
// `tip_method` es su propia columna. Si no viene, hereda el método del pago.
//
// INTERRUPTOR (settings.propinas_activas): nace APAGADO, igual que el impuesto.
// Un negocio que no recibe propinas no debe ver un solo renglón extra.
// ============================================================================

const { User } = require('../models');

// Mismo tope que los precios de venta (utils/ventaOffline.js) y los movimientos
// de caja (utils/cashMovements.js): un monto absurdo es un dedazo, no una propina.
const TOPE_PROPINA = 1000000;

// Porcentajes que el POS ofrece como botón rápido. Son solo una ayuda para
// teclear: el cajero siempre puede escribir el monto a mano.
const SUGERENCIAS_DEFAULT = [10, 15, 20];
const MAX_SUGERENCIAS = 4;

const METODOS = ['efectivo', 'tarjeta', 'transferencia'];

function redondear(n) {
    return parseFloat((Math.round((n + Number.EPSILON) * 100) / 100).toFixed(2));
}

/**
 * Normaliza el monto de propina que manda el cliente.
 *
 * Devuelve 0 —nunca un error— ante cualquier valor inservible: una venta jamás
 * debe fallar por una propina mal tecleada. Es el mismo criterio del BLOQUE 5
 * (un dato sospechoso cae al valor seguro y la venta se registra igual), porque
 * una venta atascada en la cola offline es peor que una propina perdida.
 */
function normalizarPropina(valor) {
    if (valor === undefined || valor === null || valor === '') return 0;
    const monto = parseFloat(valor);
    if (!Number.isFinite(monto) || monto <= 0 || monto > TOPE_PROPINA) return 0;
    return redondear(monto);
}

/** Método de la propina; cae al del pago si no viene o no es válido. */
function normalizarMetodo(metodoPropina, metodoPago) {
    const candidato = typeof metodoPropina === 'string' ? metodoPropina.toLowerCase().trim() : '';
    if (METODOS.includes(candidato)) return candidato;
    const pago = typeof metodoPago === 'string' ? metodoPago.toLowerCase().trim() : '';
    return METODOS.includes(pago) ? pago : 'efectivo';
}

/** ¿El negocio tiene las propinas encendidas? */
function activoDeAjustes(prefs = {}) {
    const valor = prefs.propinas_activas;
    if (valor === undefined || valor === null || valor === '') return false;
    return valor === true || valor === 'true' || valor === 1 || valor === '1';
}

/**
 * Normaliza la lista de porcentajes sugeridos.
 * Acepta el array o el texto "10,15,20" (los ajustes del desktop viajan como texto).
 */
function normalizarSugerencias(valor) {
    let crudas = valor;
    if (typeof crudas === 'string') {
        try {
            const parseado = JSON.parse(crudas);
            crudas = Array.isArray(parseado) ? parseado : crudas.split(',');
        } catch {
            crudas = crudas.split(',');
        }
    }
    if (!Array.isArray(crudas)) return [...SUGERENCIAS_DEFAULT];

    const limpias = [];
    for (const cruda of crudas) {
        const pct = parseFloat(cruda);
        if (!Number.isFinite(pct) || pct <= 0 || pct > 100) continue;
        const redondeado = parseFloat(pct.toFixed(2));
        if (!limpias.includes(redondeado)) limpias.push(redondeado);
        if (limpias.length >= MAX_SUGERENCIAS) break;
    }
    return limpias.length ? limpias : [...SUGERENCIAS_DEFAULT];
}

/**
 * Config de propinas a partir de los settings del dueño.
 *
 * Apagado (el default) = negocio sin propinas: `resolverPropina` devuelve 0 y
 * todo se comporta exactamente como antes del bloque.
 */
function configDeAjustes(prefs = {}) {
    return {
        activo: activoDeAjustes(prefs),
        sugerencias: normalizarSugerencias(prefs.propina_sugerencias),
    };
}

/**
 * Propina con la que se registra una venta.
 *
 * ⚠️ Con las propinas APAGADAS se descarta cualquier monto que llegue. Un cliente
 * viejo (o uno que se quedó con la config en caché) no puede meterle propinas a
 * un negocio que las tiene apagadas: el corte de ese negocio no las espera y
 * aparecerían como un sobrante en el cajón.
 *
 * @returns {{monto:number, metodo:string|null}} metodo es null cuando no hay propina.
 */
function resolverPropina({ config, tipAmount, tipMethod, paymentMethod }) {
    if (!config || !config.activo) return { monto: 0, metodo: null };
    const monto = normalizarPropina(tipAmount);
    if (monto <= 0) return { monto: 0, metodo: null };
    return { monto, metodo: normalizarMetodo(tipMethod, paymentMethod) };
}

/**
 * Suma las propinas de un conjunto de pedidos, separadas por método.
 *
 * Se separan porque solo la de EFECTIVO está en el cajón: la de tarjeta llega en
 * la liquidación del banco y no debe exigírsele al cajero al contar el dinero.
 *
 * @param {Array<{tip_amount:*, tip_method:*, payment_method:*}>} pedidos
 */
function totalesPropinas(pedidos = []) {
    let efectivo = 0, tarjeta = 0, transferencia = 0;
    for (const p of pedidos) {
        const monto = parseFloat(p.tip_amount) || 0;
        if (monto <= 0) continue;
        // Un pedido anterior al bloque no tiene `tip_method`; si algún día hubiera
        // uno con propina y sin método, hereda el del pago, que es la herencia que
        // aplica `resolverPropina` al registrarla.
        const metodo = normalizarMetodo(p.tip_method, p.payment_method);
        if (metodo === 'tarjeta') tarjeta += monto;
        else if (metodo === 'transferencia') transferencia += monto;
        else efectivo += monto;
    }
    return {
        total_propinas:               redondear(efectivo + tarjeta + transferencia),
        total_propinas_efectivo:      redondear(efectivo),
        total_propinas_tarjeta:       redondear(tarjeta),
        total_propinas_transferencia: redondear(transferencia),
    };
}

// ── Config del negocio (con caché corta, igual que el impuesto y la zona) ────

const _cache = new Map(); // businessId → { config, expira }
const TTL_MS = 60 * 1000;

async function configPropinasNegocio(businessId) {
    const clave = String(businessId);
    const guardada = _cache.get(clave);
    if (guardada && guardada.expira > Date.now()) return guardada.config;

    let config = { activo: false, sugerencias: [...SUGERENCIAS_DEFAULT] };
    try {
        const owner = await User.findByPk(businessId, { attributes: ['settings'] });
        if (owner) config = configDeAjustes(JSON.parse(owner.settings || '{}'));
    } catch {
        // Ante cualquier fallo se vende SIN propina en vez de rechazar la venta.
    }
    _cache.set(clave, { config, expira: Date.now() + TTL_MS });
    return config;
}

function invalidarPropinasNegocio(businessId) {
    _cache.delete(String(businessId));
}

function limpiarCachePropinas() {
    _cache.clear();
}

module.exports = {
    TOPE_PROPINA,
    SUGERENCIAS_DEFAULT,
    MAX_SUGERENCIAS,
    METODOS,
    redondear,
    normalizarPropina,
    normalizarMetodo,
    normalizarSugerencias,
    activoDeAjustes,
    configDeAjustes,
    resolverPropina,
    totalesPropinas,
    configPropinasNegocio,
    invalidarPropinasNegocio,
    limpiarCachePropinas,
};
