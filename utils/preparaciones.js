/**
 * PREPARACIONES: cuánta TANDA consume una receta — un solo lugar.
 *
 * ── EL BUG QUE ESTO ARREGLA (2026-08-27) ────────────────────────────────────
 *
 * Una preparación es una receta de cocina que RINDE una cantidad:
 * "Salsa verde, unidad: litro, rinde: 4" significa *esta receta produce 4 litros*.
 * Cuando un producto la usa —"Chilaquiles: 0.5 de Salsa"— está usando **0.5
 * litros**, es decir **0.5/4 = 12.5% de la tanda**.
 *
 * El sistema ignoraba el rinde: multiplicaba los insumos de la tanda COMPLETA
 * por 0.5 y descontaba **8 veces** lo que debía. Nadie lo notó porque el desktop
 * manda `yield_quantity: 1` fijo, pero el **mobile tiene un campo "Rinde"
 * editable** (`InventarioScreen`), así que era alcanzable en producción.
 *
 * Para colmo, `POST /inventory/preparations/:id/recipe` SÍ divide entre el rinde
 * al guardar `cost_per_unit`: el mismo campo se interpretaba de dos maneras
 * opuestas según quién lo leyera.
 *
 * Ahora el criterio es UNO y vive aquí. Lo usan los cinco caminos que expanden
 * una preparación a insumos (descontar, restaurar, verificar stock, requerir por
 * modificador y calcular disponibilidad) más el costo de `utils/costos.js`.
 *
 * ⚠️ El desktop repite la fórmula en su SQLite local (`database/db.js`), como el
 * impuesto (§29) y las propinas (§30). Si la cambias, cámbiala en los dos.
 */

/**
 * Fracción de la TANDA de una preparación que consume una receta.
 *
 * @param {number|string} cantidadEnReceta  cuánto pide la receta, en la unidad de la preparación
 * @param {object|null} preparacion         la Preparation (solo se lee `yield_quantity`)
 * @returns {number} el multiplicador que se aplica a los insumos de la tanda
 *
 * ⚠️ Un rinde ausente, cero, negativo o no numérico cae a **1 tanda**, que es
 * exactamente el comportamiento anterior a este arreglo. Es deliberado: dividir
 * entre cero o hacer fallar una venta por un dato mal capturado sería peor que
 * descontar de más (mismo criterio que §26: ningún dato sospechoso tumba una
 * venta).
 */
function fraccionDeTanda(cantidadEnReceta, preparacion) {
    const cantidad = parseFloat(cantidadEnReceta);
    if (!Number.isFinite(cantidad)) return 0;

    const rinde = parseFloat(preparacion && preparacion.yield_quantity);
    if (!Number.isFinite(rinde) || rinde <= 0) return cantidad;

    return cantidad / rinde;
}

module.exports = { fraccionDeTanda };
