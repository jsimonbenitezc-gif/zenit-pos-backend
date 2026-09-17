// ============================================================================
// utils/stockProducto.js — EXISTENCIAS POR UNIDADES, PARA LO QUE SE REVENDE
//
// LA REGLA, Y ES UNA SOLA:
//     · un producto CON RECETA se controla por sus INSUMOS (§19.8, §43). Su
//       `stock` no significa nada y se guarda en NULL.
//     · un producto SIN RECETA se controla por su `stock`, si tiene número.
//     · `stock = NULL` es "SIN CONTROL", y es el default. Nadie empieza a tener
//       existencias por desplegar esto.
//
// HISTORIA, porque esto ya se decidió una vez al revés. El 2026-03-20 el commit
// `bed4bcd` desconectó `Product.stock` entero —"el stock se controla 100% por
// insumos/recetas"— y quitó también la parte que SÍ tenía sentido: la de los
// productos sin receta. Lo que quedó: el formulario del desktop seguía pidiendo
// existencias, el número se guardaba, y no se descontaba ni se validaba nunca.
// Una tienda de reventa —y TODO el plan free, que no tiene inventario— se quedó
// sin ningún control de existencias, y el dueño veía en pantalla un número que
// no era verdad (en la base de producción quedaron restos de marzo: una pizza
// con −20). Se reconecta, acotado a donde tiene sentido. Decidido con el dueño
// del producto el 2026-09-17.
//
// 🔴 AVISA, NO BLOQUEA. Falta de existencias produce un WARNING —el mismo
// mecanismo que ya usan los insumos (`stock_warning` + `skip_stock_check`)— y
// nunca un error. Un POS que se niega a vender hace más daño que el riesgo que
// evita (§1, §37, §48.1.b): el número puede estar mal y el producto estar ahí.
//
// ⚠️ Y descontar y devolver tienen que ser SIMÉTRICOS (§19.28): si la venta
// descuenta con un criterio y la cancelación devuelve con otro, las existencias
// se desvían solas, un poco en cada cancelación, sin que nadie lo note.
// ============================================================================

const { Op } = require('sequelize');
const Product = require('../models/Product');
const ProductRecipe = require('../models/ProductRecipe');

/** ¿Este producto lleva la cuenta por unidades? (sin receta y con número) */
function llevaCuentaPorUnidades(product, tieneReceta) {
    if (tieneReceta) return false;
    return product && product.stock !== null && product.stock !== undefined;
}

/**
 * De los items de una venta, los que SÍ llevan cuenta por unidades.
 * Devuelve Map<product_id, { product, qty }> con las cantidades ya sumadas:
 * dos renglones del mismo refresco (uno con hielo y otro sin) son DOS unidades
 * del mismo producto, no dos cuentas separadas.
 */
async function productosQueDescuentan(resolvedItems, t) {
    // Los items llegan de dos formas según el camino: al VENDER se tiene el
    // producto entero, y al cancelar o quitar un renglón solo su `product_id`.
    // Se admiten las dos para que descontar y devolver pasen por la MISMA
    // función: son la pareja que no se puede desincronizar (§19.28).
    const porProducto = new Map();
    for (const item of resolvedItems) {
        const id = item.product ? item.product.id : item.product_id;
        if (!id) continue;
        const qty = Number(item.qty) || 0;
        if (qty <= 0) continue;
        const previo = porProducto.get(id);
        if (previo) { previo.qty += qty; if (!previo.product && item.product) previo.product = item.product; }
        else porProducto.set(id, { product: item.product || null, qty });
    }
    if (!porProducto.size) return new Map();

    const sinCargar = [...porProducto.entries()].filter(([, d]) => !d.product).map(([id]) => id);
    if (sinCargar.length) {
        const filas = await Product.findAll({ where: { id: { [Op.in]: sinCargar } }, transaction: t });
        for (const fila of filas) porProducto.get(fila.id).product = fila;
        for (const [id, d] of [...porProducto]) if (!d.product) porProducto.delete(id);
    }

    // Una sola consulta para saber cuáles tienen receta: producto por producto
    // sería el N+1 clásico en la ruta que más se llama de todo el sistema.
    const ids = [...porProducto.keys()];
    const recetas = await ProductRecipe.findAll({
        where: { product_id: { [Op.in]: ids } },
        attributes: ['product_id'],
        transaction: t,
    });
    const conReceta = new Set(recetas.map((r) => r.product_id));

    const resultado = new Map();
    for (const [id, dato] of porProducto) {
        if (llevaCuentaPorUnidades(dato.product, conReceta.has(id))) resultado.set(id, dato);
    }
    return resultado;
}

/**
 * Bloquea las filas de los productos que se van a descontar, SIEMPRE por id
 * ascendente. Misma medicina y mismo motivo que `bloquearInsumosEnOrden` (§50.2):
 * dos cajas cobrando el mismo refresco a la vez, si toman las filas en orden
 * distinto, se provocan un deadlock que Postgres resuelve MATANDO una venta.
 *
 * Devuelve el stock RECIÉN LEÍDO de cada producto: leerlo antes del lock sería
 * leer un número que la otra caja todavía puede cambiar.
 */
async function bloquearProductosEnOrden(ids, t) {
    const ordenados = [...ids].sort((a, b) => a - b);
    if (!ordenados.length) return new Map();

    const filas = await Product.findAll({
        where: { id: { [Op.in]: ordenados } },
        order: [['id', 'ASC']],
        transaction: t,
        lock: t ? t.LOCK.UPDATE : undefined,
    });
    return new Map(filas.map((p) => [p.id, p]));
}

/**
 * Avisos por falta de existencias. NO bloquea nada: devuelve la lista y quien
 * llama decide (hoy: el cliente confirma con `skip_stock_check`).
 *
 * ⚠️ Cada aviso lleva `ingredient` con el NOMBRE DEL PRODUCTO además de los
 * campos propios, a propósito: un desktop o un APK viejo pinta la lista de
 * avisos leyendo ese campo, y sin él le saldría "undefined" al cajero. Los
 * clientes nuevos usan `tipo: 'producto'` y `product_id`.
 */
async function validarStockDeProductos(resolvedItems, t) {
    const aDescontar = await productosQueDescuentan(resolvedItems, t);
    if (!aDescontar.size) return [];

    const frescos = await bloquearProductosEnOrden([...aDescontar.keys()], t);
    const avisos = [];
    for (const [id, { product, qty }] of aDescontar) {
        const fila = frescos.get(id) || product;
        const disponible = Number(fila.stock);
        if (!Number.isFinite(disponible) || disponible >= qty) continue;
        avisos.push({
            tipo: 'producto',
            product_id: id,
            product: fila.name,
            ingredient: fila.name,     // para los binarios viejos (ver arriba)
            unit: 'pz',
            available: disponible,
            required: qty,
        });
    }
    return avisos;
}

/**
 * Mueve las existencias de una venta.  signo = -1 vender · +1 devolver.
 *
 * Nunca baja de cero: un número mal capturado no puede dejar el producto en
 * negativo, que es exactamente el estado en el que quedaron los de marzo.
 */
async function moverStockDeProductos(resolvedItems, t, signo) {
    const aMover = await productosQueDescuentan(resolvedItems, t);
    if (!aMover.size) return;

    const frescos = await bloquearProductosEnOrden([...aMover.keys()], t);
    for (const [id, { qty }] of aMover) {
        const fila = frescos.get(id);
        if (!fila) continue;
        const actual = Number(fila.stock);
        if (!Number.isFinite(actual)) continue;           // NULL = sin control
        await fila.update({ stock: Math.max(0, actual + signo * qty) }, { transaction: t });
    }
}

/**
 * Lo que se guarda cuando el cliente manda `stock` en el alta o la edición.
 * Vacío, null o basura → NULL (sin control). Un negativo NO es una cuenta: se
 * trata como "no sé", que es la verdad.
 */
function normalizarStock(valor) {
    if (valor === null || valor === undefined || valor === '') return null;
    const n = Number(valor);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.round(n);
}

module.exports = {
    llevaCuentaPorUnidades,
    productosQueDescuentan,
    bloquearProductosEnOrden,
    validarStockDeProductos,
    moverStockDeProductos,
    normalizarStock,
};
