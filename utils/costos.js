/**
 * COSTO DE LO QUE SE VENDE (BLOQUE 12) — un solo lugar.
 *
 * El costo de un platillo no está guardado en ninguna columna: se DERIVA de su
 * receta (`product_recipes`) y del `cost_per_unit` de cada insumo. Este archivo
 * es el único que sabe hacer esa cuenta en el backend.
 *
 * ── LAS TRES REGLAS QUE HACEN QUE EL REPORTE SE PUEDA CREER ──────────────────
 *
 * 1. **Sin receta no hay costo: hay NULL.** Un producto sin receta no cuesta
 *    cero, cuesta *desconocido*. Devolver 0 lo pintaría como el platillo más
 *    rentable del negocio y el dueño tomaría decisiones al revés. Se marca
 *    `sin_receta` y se reporta aparte.
 *
 * 2. **Un insumo sin precio ensucia todo lo que lo toca.** Si la receta lleva
 *    tortillas y las tortillas tienen `cost_per_unit = 0`, el costo sale corto y
 *    el margen sale inflado. Ese costo se devuelve igual pero con
 *    `completo = false` y la lista de culpables, para que la vista pueda decir
 *    "te falta ponerle precio a: tortillas".
 *
 * 3. **El costo es el valor del inventario que la venta descontó.** Por eso la
 *    cuenta espeja EXACTAMENTE a `descontarIngredientesDeReceta` de
 *    routes/orders.js, incluida su manera de tratar las preparaciones.
 *
 * ⚠️ SOBRE `Preparation.yield_quantity`: una preparación RINDE una cantidad, y
 * una receta que pide 0.5 de una salsa que rinde 4 consume **1/8 de la tanda**.
 * El costo usa `fraccionDeTanda()` de `utils/preparaciones.js`, el MISMO helper
 * que el descuento de inventario — si costo y consumo no partieran del mismo
 * factor, el reporte no cuadraría con lo que salió de la bodega.
 *
 * Por eso tampoco se usa la columna `Preparation.cost_per_unit`: se calcula
 * desde los insumos, así el costo reportado es exactamente el valor del
 * inventario consumido y no un número guardado que puede haber quedado viejo.
 */
const { Op } = require('sequelize');
const {
    Product, ProductRecipe, Ingredient, Preparation, PreparationItem,
    ModifierOptionRecipe,
} = require('../models');
const { convertirCantidad } = require('./unidades');
const { fraccionDeTanda } = require('./preparaciones');

/** Redondeo a centavos. Los costos se acumulan con muchos decimales. */
function centavos(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Costo de UNA línea de receta (de un producto o de un modificador).
 * Devuelve el costo y los nombres de los insumos a los que les falta precio.
 */
function _costoDeLinea(linea, ctx) {
    const cantidad = parseFloat(linea.quantity);
    if (!Number.isFinite(cantidad)) return { costo: 0, faltantes: [] };

    if (linea.item_type === 'ingredient') {
        const ing = ctx.ingredientes.get(Number(linea.item_id));
        // Insumo borrado: la receta quedó apuntando a la nada. No es un costo de
        // cero, es un costo que no se puede calcular.
        if (!ing) return { costo: 0, faltantes: ['(insumo eliminado)'] };
        const costoUnidad = parseFloat(ing.cost_per_unit) || 0;
        const cant = convertirCantidad(cantidad, linea.unit_recipe, ing.unit);
        return {
            costo: cant * costoUnidad,
            faltantes: costoUnidad > 0 ? [] : [ing.name],
        };
    }

    if (linea.item_type === 'preparation') {
        const prep = ctx.preparaciones.get(Number(linea.item_id));
        if (!prep) return { costo: 0, faltantes: ['(preparación eliminada)'] };
        // `prep.costo` es el costo de la TANDA COMPLETA; el rinde dice qué
        // fracción de esa tanda pide la receta.
        return { costo: prep.costo * fraccionDeTanda(cantidad, prep), faltantes: prep.faltantes };
    }

    return { costo: 0, faltantes: [] };
}

/** Suma varias líneas de receta en un solo costo + la lista de faltantes sin repetir. */
function _sumarLineas(lineas, ctx) {
    let costo = 0;
    const faltantes = new Set();
    for (const linea of lineas) {
        const r = _costoDeLinea(linea, ctx);
        costo += r.costo;
        r.faltantes.forEach(f => faltantes.add(f));
    }
    return { costo, faltantes: [...faltantes] };
}

/**
 * Construye el costo de TODOS los productos y de TODAS las opciones de
 * modificador de un negocio, en cinco consultas.
 *
 * Se hace de golpe (y no producto por producto) porque el reporte necesita
 * decenas de productos: una consulta por cada uno sería el clásico N+1 sobre la
 * ruta que el dueño abre a diario.
 *
 * @returns {Promise<{
 *   productos: Map<number, {costo:number|null, completo:boolean, faltantes:string[], sin_receta:boolean}>,
 *   opciones:  Map<number, {costo:number, completo:boolean, faltantes:string[]}>
 * }>}
 */
async function mapaDeCostos(businessId) {
    // ── Insumos: la hoja del árbol, donde vive el precio ──────────────────
    const ingredientes = new Map();
    const ings = await Ingredient.findAll({
        where: { business_id: businessId },
        attributes: ['id', 'name', 'unit', 'cost_per_unit'],
        raw: true,
    });
    for (const i of ings) ingredientes.set(Number(i.id), i);

    // ── Preparaciones: se expanden a insumos, igual que el descuento ──────
    const preparaciones = new Map();
    const preps = await Preparation.findAll({
        where: { business_id: businessId },
        attributes: ['id', 'name', 'yield_quantity'],
        raw: true,
    });
    if (preps.length) {
        const prepItems = await PreparationItem.findAll({
            where: { preparation_id: { [Op.in]: preps.map(p => p.id) } },
            attributes: ['preparation_id', 'ingredient_id', 'quantity', 'unit_recipe'],
            raw: true,
        });
        const porPrep = new Map();
        for (const it of prepItems) {
            const arr = porPrep.get(Number(it.preparation_id)) || [];
            // Se normaliza al shape de ProductRecipe para reusar _costoDeLinea.
            arr.push({
                item_type: 'ingredient',
                item_id: it.ingredient_id,
                quantity: it.quantity,
                unit_recipe: it.unit_recipe,
            });
            porPrep.set(Number(it.preparation_id), arr);
        }
        const ctxSoloInsumos = { ingredientes, preparaciones };
        for (const p of preps) {
            const lineas = porPrep.get(Number(p.id)) || [];
            // `costo` = lo que cuesta la TANDA COMPLETA. El rinde se aplica al
            // usarla en una receta, no aquí.
            const r = _sumarLineas(lineas, ctxSoloInsumos);
            preparaciones.set(Number(p.id), { nombre: p.name, yield_quantity: p.yield_quantity, ...r });
        }
    }

    const ctx = { ingredientes, preparaciones };

    // ── Productos ────────────────────────────────────────────────────────
    const productos = new Map();
    const prods = await Product.findAll({
        where: { business_id: businessId },
        attributes: ['id'],
        raw: true,
    });
    if (prods.length) {
        const recetas = await ProductRecipe.findAll({
            where: { product_id: { [Op.in]: prods.map(p => p.id) } },
            attributes: ['product_id', 'item_type', 'item_id', 'quantity', 'unit_recipe'],
            raw: true,
        });
        const porProducto = new Map();
        for (const r of recetas) {
            const arr = porProducto.get(Number(r.product_id)) || [];
            arr.push(r);
            porProducto.set(Number(r.product_id), arr);
        }
        for (const p of prods) {
            const lineas = porProducto.get(Number(p.id));
            if (!lineas || lineas.length === 0) {
                // REGLA 1: sin receta el costo es desconocido, no cero.
                productos.set(Number(p.id), {
                    costo: null, completo: false, faltantes: [], sin_receta: true,
                });
                continue;
            }
            const r = _sumarLineas(lineas, ctx);
            productos.set(Number(p.id), {
                costo: r.costo,
                completo: r.faltantes.length === 0,
                faltantes: r.faltantes,
                sin_receta: false,
            });
        }
    }

    // ── Opciones de modificador (BLOQUE 11) ──────────────────────────────
    // "Extra queso" consume queso de más y "sin cebolla" DEVUELVE cebolla: su
    // `quantity` puede ser negativa, así que su costo también. Ignorarlas haría
    // que el extra —que sí cobra— pareciera margen puro.
    const opciones = new Map();
    const ajustes = await ModifierOptionRecipe.findAll({
        where: { business_id: businessId },
        attributes: ['option_id', 'item_type', 'item_id', 'quantity', 'unit_recipe'],
        raw: true,
    });
    if (ajustes.length) {
        const porOpcion = new Map();
        for (const a of ajustes) {
            const arr = porOpcion.get(Number(a.option_id)) || [];
            arr.push(a);
            porOpcion.set(Number(a.option_id), arr);
        }
        for (const [optionId, lineas] of porOpcion) {
            const r = _sumarLineas(lineas, ctx);
            opciones.set(optionId, {
                costo: r.costo,
                completo: r.faltantes.length === 0,
                faltantes: r.faltantes,
            });
        }
    }

    return { productos, opciones };
}

/**
 * Costo de los extras de UN renglón vendido, a partir del JSON congelado en
 * `order_items.modifiers`.
 *
 * Espeja a `aplicarRecetaDeModificadores` de routes/orders.js: una opción
 * elegida dos veces en el mismo renglón ajusta dos veces.
 *
 * @param {string|null} modifiersJson  el TEXT congelado del renglón
 * @param {Map} mapaOpciones           el `.opciones` de mapaDeCostos()
 */
function costoDeModificadores(modifiersJson, mapaOpciones) {
    if (!modifiersJson) return { costo: 0, faltantes: [] };
    let elegidas;
    try {
        elegidas = JSON.parse(modifiersJson);
    } catch {
        // JSON corrupto: no se inventa un costo ni se tumba el reporte.
        return { costo: 0, faltantes: [] };
    }
    if (!Array.isArray(elegidas) || elegidas.length === 0) return { costo: 0, faltantes: [] };

    let costo = 0;
    const faltantes = new Set();
    for (const m of elegidas) {
        const optionId = parseInt(m && m.option_id);
        if (!Number.isInteger(optionId)) continue;
        const info = mapaOpciones.get(optionId);
        // Una opción SIN receta no ensucia nada: casi ninguna la tiene (elegir
        // "con hielo" no consume insumos) y marcarlas como faltantes llenaría el
        // reporte de ruido. Solo cuenta lo que sí declara consumo.
        if (!info) continue;
        costo += info.costo;
        info.faltantes.forEach(f => faltantes.add(f));
    }
    return { costo, faltantes: [...faltantes] };
}

module.exports = { mapaDeCostos, costoDeModificadores, centavos };
