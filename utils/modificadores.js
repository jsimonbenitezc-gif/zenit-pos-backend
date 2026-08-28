// ============================================================================
// utils/modificadores.js — Modificadores de producto con precio (BLOQUE 11 V5)
//
// Único lugar donde se decide CUÁNTO cuesta un producto una vez que el cliente
// eligió sus opciones ("extra queso +$10", "grande +$25", "sin cebolla"). Lo
// comparten la venta de mostrador, el agregado a una mesa, el ticket y el KDS:
// si cada uno lo calculara aparte, el carrito diría un precio y el papel otro —
// el mismo descuadre que resolvieron el BLOQUE 8 con el impuesto y el 10 con
// los pagos.
//
// ─── EL PROBLEMA QUE RESUELVE ────────────────────────────────────────────────
// Hasta el BLOQUE 10 la única forma de decir "extra queso" era la NOTA de texto
// libre del renglón. Esa nota no cobra: el extra se regalaba o el cajero lo
// tecleaba a mano como otro producto. Tampoco descuenta insumos (el queso extra
// salía del inventario sin registrarse) ni llega estructurada a la cocina.
//
// ─── LA REGLA DE ORO ─────────────────────────────────────────────────────────
// LOS MODIFICADORES AJUSTAN EL PRECIO UNITARIO, NO SON UN RENGLÓN APARTE.
//
//   • `OrderItem.unit_price` = precio base del catálogo + suma de los deltas.
//     Es lo que el cliente paga POR UNIDAD. Todo lo que ya existía (impuesto,
//     descuentos, pagos divididos, corte de caja, reportes) sigue leyendo ese
//     campo y no necesita enterarse de que hay modificadores.
//   • `OrderItem.base_unit_price` guarda el precio del catálogo, para poder
//     imprimir el desglose y para saber qué parte del precio son extras.
//   • `OrderItem.modifiers` guarda el JSON CONGELADO de lo que se eligió
//     (nombre, grupo y delta). Reimprimir un ticket de hace un mes muestra lo
//     que se cobró, aunque el dueño haya cambiado el precio del extra o borrado
//     la opción — mismo criterio que la tasa congelada del BLOQUE 8.
//
// ─── NUNCA SE LE CREE EL PRECIO AL CLIENTE ───────────────────────────────────
// En una venta ONLINE el delta sale SIEMPRE de la base de datos: el cliente
// manda qué opción eligió (`option_id`), nunca cuánto cuesta. En una venta
// DIFERIDA (offline, §26) se acepta el delta congelado que trae el POS, porque
// es lo que el ticket ya entregado cobró, y la opción puede incluso haber sido
// borrada mientras el equipo estaba sin red. Igual que el impuesto: se respeta
// la CONFIGURACIÓN con la que se cobró, y aun así el total se recalcula aquí.
//
// ─── QUÉ SE VALIDA Y QUÉ NO ──────────────────────────────────────────────────
// Se valida lo que protege el dinero: que la opción exista, sea del negocio, y
// pertenezca a un grupo enganchado a ESE producto; y que no se exceda el
// `max_select` del grupo (elegir dos veces "extra queso" cobra doble).
//
// ⚠️ `min_select` NO se valida en el servidor, a propósito. Es guía para la UI.
// Si el dueño marca "Tamaño" como obligatorio, un binario viejo —que no manda
// modificadores— empezaría a recibir 400 en cada venta de ese producto: la
// misma trampa de despliegue coordinado del BLOQUE 1. Un pedido sin
// modificadores debe seguir siendo una venta válida para siempre.
//
// ─── COMPATIBILIDAD HACIA ATRÁS ──────────────────────────────────────────────
// Un item SIN modificadores (todos los anteriores a este bloque, y toda venta de
// un binario viejo) se comporta exactamente como antes: delta 0, `unit_price` es
// el precio del catálogo y `modifiers` queda vacío. No hay nada que migrar.
// ============================================================================

// Tope defensivo por renglón. Un producto se personaliza, no se configura sin
// límite: sin esto un cliente con un bug podría mandar miles de opciones.
const MAX_MODIFICADORES_POR_ITEM = 30;

// Tope de un delta individual. Mismo criterio que el precio unitario del
// BLOQUE 5: un valor así solo puede venir de un bug o de un dedo pesado.
const MAX_DELTA = 1000000;

const NOMBRE_MAX = 60;

function redondear(n) {
    return parseFloat((Math.round((n + Number.EPSILON) * 100) / 100).toFixed(2));
}

/**
 * Delta de una opción tal como llega del cliente o de la base.
 * Puede ser NEGATIVO ("sin queso -$5") y puede ser 0 ("sin cebolla").
 * @returns {number|null} null = valor inservible.
 */
function normalizarDelta(valor) {
    if (valor === undefined || valor === null || valor === '') return 0;
    const delta = parseFloat(valor);
    if (!Number.isFinite(delta) || Math.abs(delta) > MAX_DELTA) return null;
    return redondear(delta);
}

function _texto(valor, max = NOMBRE_MAX) {
    if (typeof valor !== 'string') return '';
    return valor.trim().slice(0, max);
}

/**
 * Suma de los deltas de una selección ya normalizada.
 * Es LA operación del bloque: la usan el carrito de los tres clientes, la venta
 * y el recálculo de una mesa. Si una copia se desviara, el cajero cobraría un
 * número y el corte le exigiría otro.
 */
function deltaDeModificadores(modificadores) {
    if (!Array.isArray(modificadores) || modificadores.length === 0) return 0;
    let suma = 0;
    for (const m of modificadores) {
        const delta = normalizarDelta(m && m.price_delta);
        if (delta !== null) suma += delta;
    }
    return redondear(suma);
}

/**
 * Precio unitario final de un renglón: base del catálogo + los extras.
 *
 * ⚠️ Nunca baja de 0. Un combo de opciones negativas mal configurado no puede
 * convertir una venta en una devolución silenciosa: se cobra 0 y el renglón
 * queda visible para que el dueño corrija la configuración.
 */
function precioConModificadores(precioBase, modificadores) {
    const base = parseFloat(precioBase);
    if (!Number.isFinite(base)) return 0;
    return Math.max(0, redondear(base + deltaDeModificadores(modificadores)));
}

/**
 * Texto de una línea de modificadores para el ticket, el KDS y el historial.
 * Los tres clientes lo pintan igual, así que vive aquí y no en cada pantalla.
 */
function resumenModificadores(modificadores) {
    if (!Array.isArray(modificadores) || modificadores.length === 0) return '';
    return modificadores
        .map(m => _texto(m && m.name))
        .filter(Boolean)
        .join(', ');
}

/**
 * Deja una selección en la forma CONGELADA que se guarda en `OrderItem.modifiers`.
 * Descarta lo que no sirve (sin nombre, delta inservible) en vez de fallar: un
 * modificador roto nunca debe tumbar una venta (§26).
 */
function normalizarSeleccion(modificadores) {
    if (!Array.isArray(modificadores)) return [];
    const limpios = [];
    for (const crudo of modificadores.slice(0, MAX_MODIFICADORES_POR_ITEM)) {
        if (!crudo || typeof crudo !== 'object') continue;
        const nombre = _texto(crudo.name || crudo.nombre);
        if (!nombre) continue;
        const delta = normalizarDelta(crudo.price_delta !== undefined ? crudo.price_delta : crudo.delta);
        if (delta === null) continue;
        const optionId = parseInt(crudo.option_id !== undefined ? crudo.option_id : crudo.id);
        const groupId = parseInt(crudo.group_id);
        limpios.push({
            option_id: Number.isInteger(optionId) ? optionId : null,
            group_id: Number.isInteger(groupId) ? groupId : null,
            group: _texto(crudo.group || crudo.grupo),
            name: nombre,
            price_delta: delta,
        });
    }
    return limpios;
}

/**
 * Ids de opción que manda el cliente, en el orden en que las eligió.
 * Acepta las dos formas: `[3, 7]` y `[{option_id: 3}, {option_id: 7}]`.
 */
function idsDeSeleccion(modificadores) {
    if (!Array.isArray(modificadores)) return [];
    const ids = [];
    for (const crudo of modificadores.slice(0, MAX_MODIFICADORES_POR_ITEM)) {
        const id = parseInt(
            crudo && typeof crudo === 'object'
                ? (crudo.option_id !== undefined ? crudo.option_id : crudo.id)
                : crudo
        );
        if (Number.isInteger(id) && id > 0) ids.push(id);
    }
    return ids;
}

/**
 * Resuelve la selección de UN renglón contra el catálogo real del negocio.
 *
 * @param {Array}   seleccion       lo que llegó en `item.modifiers`
 * @param {number}  productId       producto del renglón
 * @param {object}  catalogo        el que devuelve `catalogoModificadores()`
 * @param {boolean} esVentaDiferida §26: si viene de la cola offline
 *
 * @returns {{ok:true, modificadores:Array, delta:number}}
 *        | {ok:false, error:string}
 *
 * NO lanza. Online, un error se responde 400 (el cajero está enfrente y puede
 * volver a armar el producto). Diferida, nunca falla: se congela lo que mandó
 * el POS, porque ese ticket ya se entregó y ese dinero ya se cobró.
 */
function resolverModificadores({ seleccion, productId, catalogo, esVentaDiferida = false }) {
    if (!Array.isArray(seleccion) || seleccion.length === 0) {
        return { ok: true, modificadores: [], delta: 0 };
    }

    // Venta diferida: vale lo que el POS congeló al cobrar. Ni siquiera se mira
    // el catálogo — la opción pudo haberse borrado mientras el equipo estaba sin
    // red, y esa venta tiene que subir igual.
    if (esVentaDiferida) {
        const congelados = normalizarSeleccion(seleccion);
        return { ok: true, modificadores: congelados, delta: deltaDeModificadores(congelados) };
    }

    if (seleccion.length > MAX_MODIFICADORES_POR_ITEM) {
        return { ok: false, error: `Un producto admite como máximo ${MAX_MODIFICADORES_POR_ITEM} modificadores.` };
    }

    const ids = idsDeSeleccion(seleccion);
    if (ids.length !== seleccion.length) {
        return { ok: false, error: 'Hay un modificador sin identificar. Vuelve a armar el producto.' };
    }

    const gruposDelProducto = (catalogo && catalogo.porProducto.get(parseInt(productId))) || null;
    const resueltos = [];
    const porGrupo = new Map(); // groupId → cuántas opciones se eligieron

    for (const optionId of ids) {
        const opcion = catalogo && catalogo.opciones.get(optionId);
        if (!opcion) {
            return { ok: false, error: 'Uno de los modificadores ya no existe. Vuelve a armar el producto.' };
        }
        if (!gruposDelProducto || !gruposDelProducto.has(opcion.group_id)) {
            return { ok: false, error: `"${opcion.name}" no es un modificador de este producto.` };
        }

        const grupo = catalogo.grupos.get(opcion.group_id);
        const usados = (porGrupo.get(opcion.group_id) || 0) + 1;
        porGrupo.set(opcion.group_id, usados);

        // El tope SÍ se valida: elegir dos veces "extra queso" cobraría doble sin
        // que el cliente lo haya pedido.
        const tope = grupo && Number.isInteger(grupo.max_select) ? grupo.max_select : null;
        if (tope !== null && tope > 0 && usados > tope) {
            return {
                ok: false,
                error: `En "${grupo.name}" solo puedes elegir ${tope} ${tope === 1 ? 'opción' : 'opciones'}.`,
            };
        }

        resueltos.push({
            option_id: opcion.id,
            group_id: opcion.group_id,
            group: grupo ? grupo.name : '',
            name: opcion.name,
            // De la BASE, nunca del cliente.
            price_delta: redondear(parseFloat(opcion.price_delta) || 0),
        });
    }

    return { ok: true, modificadores: resueltos, delta: deltaDeModificadores(resueltos) };
}

/**
 * Lee `OrderItem.modifiers` (que viaja como TEXT JSON) sin reventar nunca.
 * Sequelize devuelve el string tal cual; un pedido anterior al bloque trae null.
 */
function leerModificadores(valor) {
    if (!valor) return [];
    if (Array.isArray(valor)) return valor;
    try {
        const parsed = JSON.parse(valor);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

// ============================================================================
// ── DE AQUÍ PARA ABAJO: SOLO BACKEND ────────────────────────────────────────
// Todo lo de arriba está TRIPLICADO en `pos/modulo-modificadores.js` (desktop) y
// `src/utils/modificadores.js` (mobile). Esto de abajo toca la base de datos, así
// que no se copia — mismo corte que en utils/impuestos.js y utils/propinas.js.
// ============================================================================

const { ModifierGroup, ModifierOption, ProductModifierGroup } = require('../models');

// Caché corta del catálogo. El carrito lo consulta en cada renglón de cada
// venta, y es configuración que cambia una vez al mes. Se invalida en cuanto el
// dueño edita la biblioteca (routes/modifiers.js): sin eso, crear un grupo y
// vender enseguida daría "ese modificador no existe" durante un minuto.
const TTL_MS = 60 * 1000;
const _cache = new Map(); // businessId → { catalogo, expira }

/**
 * Catálogo completo de modificadores del negocio, en la forma que necesita
 * `resolverModificadores`: tres mapas para resolver en O(1) por renglón.
 *
 *   grupos      Map groupId  → { id, name, min_select, max_select }
 *   opciones    Map optionId → { id, group_id, name, price_delta }
 *   porProducto Map productId → Set(groupId)
 */
async function catalogoModificadores(businessId) {
    const clave = String(businessId);
    const guardado = _cache.get(clave);
    if (guardado && guardado.expira > Date.now()) return guardado.catalogo;

    const [grupos, opciones, enlaces] = await Promise.all([
        ModifierGroup.findAll({ where: { business_id: businessId, active: true } }),
        ModifierOption.findAll({ where: { business_id: businessId, active: true } }),
        ProductModifierGroup.findAll({ where: { business_id: businessId } }),
    ]);

    const catalogo = {
        grupos: new Map(),
        opciones: new Map(),
        porProducto: new Map(),
    };

    for (const g of grupos) {
        catalogo.grupos.set(g.id, {
            id: g.id,
            name: g.name,
            min_select: g.min_select,
            max_select: g.max_select === null ? null : parseInt(g.max_select),
        });
    }
    for (const o of opciones) {
        // Una opción cuyo grupo está inactivo o borrado no se puede cobrar.
        if (!catalogo.grupos.has(o.group_id)) continue;
        catalogo.opciones.set(o.id, {
            id: o.id,
            group_id: o.group_id,
            name: o.name,
            price_delta: parseFloat(o.price_delta) || 0,
        });
    }
    for (const e of enlaces) {
        if (!catalogo.grupos.has(e.group_id)) continue;
        if (!catalogo.porProducto.has(e.product_id)) catalogo.porProducto.set(e.product_id, new Set());
        catalogo.porProducto.get(e.product_id).add(e.group_id);
    }

    _cache.set(clave, { catalogo, expira: Date.now() + TTL_MS });
    return catalogo;
}

function invalidarCatalogoModificadores(businessId) {
    _cache.delete(String(businessId));
}

function limpiarCacheModificadores() {
    _cache.clear();
}

module.exports = {
    MAX_MODIFICADORES_POR_ITEM,
    MAX_DELTA,
    redondear,
    normalizarDelta,
    deltaDeModificadores,
    precioConModificadores,
    resumenModificadores,
    normalizarSeleccion,
    idsDeSeleccion,
    resolverModificadores,
    leerModificadores,
    // Solo backend
    catalogoModificadores,
    invalidarCatalogoModificadores,
    limpiarCacheModificadores,
};
