// ============================================================================
// utils/promosNegocio.js — las promos de un negocio, leídas de la base
// (PLAN_OFERTAS_V1, Bloque 1)
//
// La regla pura (precio, reparto, calendario) vive en utils/promos.js y se
// copia a los clientes. Aquí va solo lo que necesita la base: cargar las promos
// que menciona una venta, traducir los renglones de combo a "huecos" y leer el
// interruptor de "juntar ofertas".
//
// ⚠️ Se llama ANTES de abrir la transacción de la venta, igual que el catálogo
// de modificadores: con la transacción abierta, una consulta sin `transaction`
// pide otra conexión del pool y nueve ventas a la vez se ahorcan (§50.1).
// ============================================================================

const { Combo, ComboItem, User } = require('../models');
const { Op } = require('sequelize');
const { leerCalendario, tipoDePromo, productosQueLleva } = require('./promos');

/**
 * Un renglón de `combo_items` como hueco: { id, quantity, product_ids, category_id }.
 * El renglón viejo (producto fijo) es "N de [ese producto]".
 */
function huecoDeRenglon(it) {
    const ids = Array.isArray(it.product_ids) ? it.product_ids.map(Number).filter(Number.isInteger) : [];
    if (!ids.length && it.product_id) ids.push(Number(it.product_id));
    return {
        id: it.id,
        quantity: Math.max(1, parseInt(it.quantity, 10) || 1),
        product_ids: ids,
        category_id: ids.length ? null : (it.category_id ?? null),
    };
}

/** La promo como la usa la venta: plana, con sus huecos y su calendario leído. */
function promoPlana(combo) {
    const huecos = (combo.items || []).map(huecoDeRenglon)
        .filter(h => h.product_ids.length || h.category_id !== null);
    return {
        id: combo.id,
        name: combo.name,
        tipo: tipoDePromo(combo),
        price: parseFloat(combo.price) || 0,
        lleva: productosQueLleva(huecos),
        paga: combo.paga !== null && combo.paga !== undefined ? parseInt(combo.paga, 10) : null,
        calendario: leerCalendario(combo.calendario),
        active: combo.active !== false,
        huecos,
    };
}

/** Las promos que menciona una venta, en un Map id → promo plana. */
async function cargarPromos(businessId, ids) {
    const unicos = [...new Set((ids || []).map(Number).filter(Number.isInteger))];
    const mapa = new Map();
    if (!unicos.length) return mapa;
    const combos = await Combo.findAll({
        where: { id: { [Op.in]: unicos }, business_id: businessId },
        include: [{ model: ComboItem, as: 'items' }],
    });
    for (const c of combos) mapa.set(c.id, promoPlana(c));
    return mapa;
}

/**
 * La forma que viaja a los clientes en GET /offers/combos.
 *
 * 🔴 TRAMPA 1 DEL PLAN: `items` sigue trayendo SOLO renglones con producto
 * fijo. El `syncCombos` del desktop publicado inserta `item.product_id` en una
 * columna NOT NULL: un renglón "2 de [Tacos]" en `items` le rompería la
 * sincronización entera. La forma nueva va en `slots`, que un binario viejo no
 * lee — ve un combo sin productos y sigue funcionando.
 */
function serializarCombo(combo, { activa = null } = {}) {
    const json = typeof combo.toJSON === 'function' ? combo.toJSON() : { ...combo };
    const renglones = json.items || [];
    json.items = renglones.filter(it => it.product_id !== null && it.product_id !== undefined);
    json.slots = renglones.map(huecoDeRenglon)
        .filter(h => h.product_ids.length || h.category_id !== null);
    json.tipo = tipoDePromo(json);
    json.lleva = productosQueLleva(json.slots) || null;
    json.calendario = leerCalendario(json.calendario);
    if (activa !== null) json.activa_ahora = activa;
    return json;
}

/**
 * ¿Los descuentos de la cuenta alcanzan también a lo que ya está en promo?
 * `settings.ofertas_acumulables` del DUEÑO. Apagado de fábrica (§3.4 del plan).
 * Un fallo de lectura cae a apagado: nunca apila descuentos por accidente.
 */
async function ofertasAcumulables(businessId) {
    try {
        const owner = await User.findByPk(businessId, { attributes: ['settings'] });
        const prefs = owner && owner.settings ? JSON.parse(owner.settings) : {};
        return prefs.ofertas_acumulables === true;
    } catch {
        return false;
    }
}

module.exports = { huecoDeRenglon, promoPlana, cargarPromos, serializarCombo, ofertasAcumulables };
