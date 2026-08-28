/**
 * CONVERSIÓN DE UNIDADES — un solo lugar.
 *
 * Una receta puede estar escrita en gramos mientras el insumo se compra en kilos.
 * La tabla vivía DUPLICADA en `routes/orders.js` (FACTORES_CONVERSION, usada para
 * descontar inventario) y en `routes/inventory.js` (UNIT_CONVERSION, usada para
 * calcular disponibilidad y el costo de una preparación). Eran idénticas por
 * casualidad: nada obligaba a que lo siguieran siendo, y si se desviaban el
 * sistema descontaría una cantidad y cobraría otra.
 *
 * Desde el BLOQUE 12 la tabla vive aquí y los tres consumidores la importan
 * (inventario, ventas y el costo de rentabilidad).
 *
 * ⚠️ Una unidad sin factor conocido se devuelve TAL CUAL, sin lanzar. Es
 * deliberado: 'pzas' → 'kg' no tiene conversión posible y hacer fallar una venta
 * por eso sería peor que descontar una pieza por un kilo. Las unidades que sí
 * necesitan conversión ('pzas', 'latas', 'bolsas'...) se modelan con
 * `contenido_cantidad`/`contenido_unidad` del insumo, no aquí.
 */
const FACTORES_CONVERSION = {
    'kg_g': 1000,
    'g_kg': 0.001,
    'l_ml': 1000,
    'ml_l': 0.001,
    'ml_gal': 0.000264,
    'gal_ml': 3785.41,
    'l_gal': 0.26417,
    'gal_l': 3.78541,
};

/**
 * @param {number} cantidad      cantidad escrita en la receta
 * @param {string} unidadOrigen  unidad de la receta (puede venir null)
 * @param {string} unidadDestino unidad en la que se guarda el insumo
 * @returns {number} la cantidad expresada en la unidad del insumo
 */
function convertirCantidad(cantidad, unidadOrigen, unidadDestino) {
    if (!unidadOrigen || !unidadDestino || unidadOrigen === unidadDestino) return cantidad;
    const clave = `${unidadOrigen}_${unidadDestino}`;
    return FACTORES_CONVERSION[clave] ? cantidad * FACTORES_CONVERSION[clave] : cantidad;
}

module.exports = { FACTORES_CONVERSION, convertirCantidad };
