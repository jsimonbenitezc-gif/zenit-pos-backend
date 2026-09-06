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
 * por eso sería peor que descontar una pieza por un kilo.
 *
 * 🔴 Y ESTE COMENTARIO DESCRIBÍA UN MECANISMO QUE NO EXISTÍA (§45). Decía —con
 * razón— que las unidades de PAQUETE ('latas', 'bolsas', 'pzas') se resuelven con
 * el contenido del insumo… pero esas columnas solo existían en la SQLite del
 * desktop: el modelo `Ingredient` del backend no las declaraba, así que Sequelize
 * descartaba en silencio lo que el desktop mandaba (la trampa del §25, tercera
 * vez) y `convertirCantidad` —que solo recibe dos cadenas— no tenía con qué
 * convertir. Resultado en modo conectado: una receta de 18 g contra un insumo en
 * bolsas de 50 g descontaba **18 bolsas**, cincuenta veces de más y sin avisar.
 *
 * Desde el 2026-09-05 el contenido vive también en el backend y la conversión que
 * lo usa es `convertirParaInsumo`, que RECIBE EL INSUMO. `convertirCantidad`
 * se queda como la primitiva de unidad a unidad.
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

/**
 * La conversión REAL: cuánto del insumo consume una línea de receta.
 *
 * Es la única que deben usar los caminos que tocan inventario o costo, porque es
 * la única que sabe de PAQUETES. Tres pasos, en este orden:
 *
 *   1. Equivalencia natural (g→kg, ml→l, gal→l…). Es la de siempre.
 *   2. CONTENIDO DEL PAQUETE. Un insumo guardado en 'bolsas' que declara
 *      `content_amount: 50, content_unit: 'g'` significa "una bolsa trae 50 g".
 *      Una receta de 18 g consume entonces 18/50 = 0.36 bolsas. Y si la receta
 *      viniera en kg, primero se pasa a gramos y después se divide.
 *   3. Sin conversión conocida: se devuelve tal cual, sin lanzar (ver arriba).
 *
 * ⚠️ ESPEJO EXACTO de `convertirUnidad()` en el `database/db.js` del desktop. Si
 * cambias una, cambia la otra: hoy el desktop convierte bien en modo local y el
 * backend lo hacía mal en modo conectado, y eso es justo lo que produce que la
 * misma venta descuente cantidades distintas según haya internet o no.
 *
 * @param {number} cantidad     cantidad escrita en la receta
 * @param {string} unidadReceta unidad de la receta (puede venir null)
 * @param {object} insumo       el INGREDIENTE entero: `unit`, `content_amount`, `content_unit`
 */
function convertirParaInsumo(cantidad, unidadReceta, insumo) {
    const destino = insumo && insumo.unit;
    if (!unidadReceta || !destino || unidadReceta === destino) return cantidad;

    // 1. Equivalencia natural directa.
    const claveNatural = `${unidadReceta}_${destino}`;
    if (FACTORES_CONVERSION[claveNatural]) return cantidad * FACTORES_CONVERSION[claveNatural];

    // 2. A través del contenido del paquete.
    const contenido = parseFloat(insumo.content_amount);
    const unidadContenido = insumo.content_unit;
    // Un contenido de 0 —o negativo, o basura— NO se usa: dividir entre él daría
    // Infinity o NaN y vaciaría el inventario de un golpe. Se cae al paso 3, que
    // es el comportamiento de siempre.
    if (unidadContenido && isFinite(contenido) && contenido > 0) {
        if (unidadReceta === unidadContenido) return cantidad / contenido;
        const claveHaciaContenido = `${unidadReceta}_${unidadContenido}`;
        if (FACTORES_CONVERSION[claveHaciaContenido]) {
            return (cantidad * FACTORES_CONVERSION[claveHaciaContenido]) / contenido;
        }
    }

    // 3. Sin conversión conocida.
    return cantidad;
}

/**
 * Sanea el contenido declarado de un insumo ANTES de guardarlo.
 *
 * Es la otra mitad del §45: la conversión ignora un contenido inservible, pero
 * guardarlo sería dejar en la base un dato que parece configurado y no hace
 * nada — el usuario rellena el campo, ve que se guardó y sigue descontando mal.
 * Aquí se decide de una vez, y lo que no sirve queda en NULL.
 *
 * Se descarta cuando: no hay unidad, la cantidad no es un número finito > 0, o
 * la unidad del contenido es LA MISMA del insumo (decir que una bolsa trae 50
 * bolsas no significa nada y dividir por ello desviaría el inventario).
 */
function normalizarContenido(cantidad, unidad, unidadDelInsumo) {
    const n = parseFloat(cantidad);
    const u = typeof unidad === 'string' ? unidad.trim() : '';
    if (!u || !isFinite(n) || n <= 0 || u === unidadDelInsumo) {
        return { cantidad: null, unidad: null };
    }
    return { cantidad: n, unidad: u };
}

module.exports = { FACTORES_CONVERSION, convertirCantidad, convertirParaInsumo, normalizarContenido };
