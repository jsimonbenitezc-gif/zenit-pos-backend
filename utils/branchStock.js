/**
 * STOCK POR SUCURSAL — LA ÚNICA VERDAD (deuda técnica §12.1, 2026-09-04)
 * ---------------------------------------------------------------------
 * Durante meses el stock por sucursal vivió en DOS sitios a la vez: la tabla
 * `branch_stocks` (el sistema correcto) y la columna JSON `ingredients.branch_stocks`
 * (legado). Nadie escribía uno sin el otro, así que no llegó a haber un descuadre,
 * pero SÍ había siete copias distintas del mismo "lee la tabla, y si no está, mira
 * el JSON" — cada una con sus propias reglas. Este archivo las sustituye a todas.
 *
 * 🔴 LA REGLA: la tabla `branch_stocks` es la ÚNICA fuente. El JSON ya no se lee
 * ni se escribe. La columna sigue en Postgres, congelada, como copia de respaldo
 * de lo que había el día del cambio — no la lee nadie.
 *
 * LA CADENA DE LECTURA, que es lo único delicado que hay aquí. Se conserva EXACTA
 * respecto a lo que hacía el código viejo, porque de ella depende el inventario:
 *
 *   1. Sin sucursal              → el stock global del insumo (`ingredients.stock`).
 *                                  Es el negocio de un solo local, que nunca ve
 *                                  sucursales. NO es legado y no se toca.
 *   2. Con sucursal y con fila   → esa fila.
 *   3. Con sucursal, y el insumo → el stock global. Un insumo que jamás se ha
 *      no tiene NINGUNA fila       repartido por sucursales vale lo mismo en todas;
 *                                  devolver 0 aquí vaciaría el inventario de un
 *                                  negocio que acaba de crear su segunda sucursal.
 *   4. Con sucursal, el insumo   → 0. El insumo YA está repartido y en esta
 *      tiene filas pero no ésta    sucursal no hay: eso es un cero de verdad.
 *
 * Los pasos 3 y 4 son la traducción literal de lo que el código viejo decidía
 * mirando si el JSON estaba vacío. Esa equivalencia SOLO se sostiene si el
 * respaldo (`respaldarJsonEnTabla`) ya copió el JSON a la tabla: sin él, una
 * sucursal cuyo stock vivía solo en el JSON caería al paso 3 o al 4 y leería mal.
 * Por eso el respaldo corre en `runMigrations()` y no a mano.
 */

const { Op } = require('sequelize');
const { BranchStock, sequelize } = require('../models');
const logger = require('./logger');

function _num(v) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
}

function _idSucursal(branchId) {
    if (branchId === null || branchId === undefined || branchId === '') return null;
    const n = parseInt(branchId, 10);
    return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Stock de UN insumo en UNA sucursal. Es el que usa el camino de la venta, por eso
 * acepta transacción y bloquea la fila: dos ventas simultáneas del mismo platillo
 * no pueden leer el mismo stock y descontar cada una por su lado.
 *
 * @param {object} ingredient  instancia de Ingredient (necesita id y stock)
 * @param {number|string|null} branchId
 * @param {object|null} transaction
 * @returns {Promise<number>}
 */
async function leerStockSucursal(ingredient, branchId, transaction = null) {
    const bid = _idSucursal(branchId);
    if (!bid) return _num(ingredient.stock);

    const fila = await BranchStock.findOne({
        where: { ingredient_id: ingredient.id, branch_id: bid },
        ...(transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {})
    });
    if (fila) return _num(fila.quantity);

    // Sin fila para ESTA sucursal: ¿el insumo está repartido o no lo está?
    const repartido = await BranchStock.count({
        where: { ingredient_id: ingredient.id },
        ...(transaction ? { transaction } : {})
    });
    return repartido > 0 ? 0 : _num(ingredient.stock);
}

/**
 * Fija el stock de un insumo en una sucursal. Sin sucursal escribe el stock global.
 */
async function escribirStockSucursal(ingredient, branchId, cantidad, transaction = null) {
    const bid = _idSucursal(branchId);
    const valor = _num(cantidad);
    const opts = transaction ? { transaction } : {};

    if (!bid) {
        await ingredient.update({ stock: valor }, opts);
        return;
    }
    await BranchStock.upsert({
        ingredient_id: ingredient.id,
        branch_id: bid,
        quantity: valor,
        business_id: ingredient.business_id
    }, opts);
}

/**
 * Lectura EN BLOQUE para los listados (insumos, alertas, disponibilidad, lista de
 * compras, dashboard). Una sola consulta para todos los insumos, en vez de una por
 * insumo: estas pantallas las abre el dueño a diario.
 *
 * Devuelve una función `stockDe(ingrediente)` que aplica la misma cadena de lectura
 * de `leerStockSucursal`, sin volver a la base.
 *
 * @param {number[]} ingredientIds
 * @param {number|string|null} branchId  null = stock global (negocio de un local)
 */
async function lectorDeStock(ingredientIds, branchId) {
    const bid = _idSucursal(branchId);
    // Se normalizan a entero: un id puede llegar como texto desde el body de una
    // petición, y filtrar por `Number.isInteger` a secas lo tiraría en silencio.
    const ids = [...new Set((ingredientIds || []).map(n => parseInt(n, 10)).filter(n => Number.isInteger(n) && n > 0))];

    if (!bid || ids.length === 0) {
        return ing => _num(ing.stock);
    }

    // Se traen TODAS las sucursales, no solo la pedida: hace falta saber si el
    // insumo está repartido para distinguir el paso 3 del 4 de la cadena.
    const filas = await BranchStock.findAll({
        where: { ingredient_id: { [Op.in]: ids } },
        attributes: ['ingredient_id', 'branch_id', 'quantity']
    });

    const enEstaSucursal = new Map();
    const repartidos = new Set();
    for (const f of filas) {
        repartidos.add(f.ingredient_id);
        if (f.branch_id === bid) enEstaSucursal.set(f.ingredient_id, _num(f.quantity));
    }

    return ing => {
        if (enEstaSucursal.has(ing.id)) return enEstaSucursal.get(ing.id);
        return repartidos.has(ing.id) ? 0 : _num(ing.stock);
    };
}

/**
 * Stock de cada insumo desglosado POR SUCURSAL: { ingredientId: { branchId: cantidad } }.
 * Lo usan las alertas, que avisan sucursal por sucursal.
 */
async function mapaPorSucursal(ingredientIds) {
    // Se normalizan a entero: un id puede llegar como texto desde el body de una
    // petición, y filtrar por `Number.isInteger` a secas lo tiraría en silencio.
    const ids = [...new Set((ingredientIds || []).map(n => parseInt(n, 10)).filter(n => Number.isInteger(n) && n > 0))];
    if (ids.length === 0) return {};

    const filas = await BranchStock.findAll({
        where: { ingredient_id: { [Op.in]: ids } },
        attributes: ['ingredient_id', 'branch_id', 'quantity']
    });

    const mapa = {};
    for (const f of filas) {
        if (!mapa[f.ingredient_id]) mapa[f.ingredient_id] = {};
        mapa[f.ingredient_id][String(f.branch_id)] = _num(f.quantity);
    }
    return mapa;
}

/**
 * Suma del stock de cada insumo en TODAS sus sucursales: { ingredientId: total }.
 * Es lo que ve el dueño cuando mira el inventario sin elegir sucursal.
 */
async function mapaSumaTodasSucursales(ingredientIds) {
    const porSucursal = await mapaPorSucursal(ingredientIds);
    const suma = {};
    for (const [ingId, sucursales] of Object.entries(porSucursal)) {
        suma[ingId] = Object.values(sucursales).reduce((s, v) => s + v, 0);
    }
    return suma;
}

/**
 * RESPALDO: copia el JSON legado `ingredients.branch_stocks` a la tabla, para los
 * pares (insumo, sucursal) que no estén ya en ella.
 *
 * 🔴 ESTO NO ES LIMPIEZA: es lo que evita borrar un inventario. Medido en la base
 * de producción el 2026-09-04, 10 de los 17 pares vivían SOLO en el JSON — la
 * sucursal 3 entera no tenía ni una fila en la tabla. Sin esta copia, quitar el
 * fallback dejaría todo ese inventario leyendo 0.
 *
 * Reglas:
 *  - La TABLA MANDA. Un par que ya existe no se toca nunca, aunque el JSON diga
 *    otra cosa: el JSON guarda floats (1.1099999999999999) y la tabla DECIMAL(10,3);
 *    pisarla con el JSON metería ruido de coma flotante en el inventario.
 *  - Es IDEMPOTENTE: al segundo arranque no encuentra nada que copiar.
 *  - El JSON NO se borra. La columna queda congelada en Postgres como copia de
 *    seguridad del día del cambio. Nadie la lee.
 *  - Lee por SQL crudo a propósito: el modelo `Ingredient` ya no declara la
 *    columna, que es justamente lo que impide que el resto del código la use.
 *
 * @param {number|null} businessId  limitar a un negocio (el endpoint manual); null = todos
 * @returns {Promise<{revisados:number, copiados:number, omitidos:number}>}
 */
async function respaldarJsonEnTabla(businessId = null) {
    const resultado = { revisados: 0, copiados: 0, omitidos: 0 };

    const filtroNegocio = businessId ? ` AND business_id = ${parseInt(businessId, 10)}` : '';
    let filas;
    try {
        const [rows] = await sequelize.query(
            'SELECT id, business_id, branch_stocks FROM ingredients' +
            " WHERE branch_stocks IS NOT NULL AND branch_stocks <> '{}'" + filtroNegocio
        );
        filas = rows;
    } catch (err) {
        // La columna puede no existir (base nueva creada por sync()): no hay nada
        // que respaldar y no es un error.
        return resultado;
    }
    if (!filas || filas.length === 0) return resultado;

    // Pares que YA están en la tabla. Una sola consulta en vez de una por par.
    const ingIds = filas.map(f => f.id);
    const existentes = new Set(
        (await BranchStock.findAll({
            where: { ingredient_id: { [Op.in]: ingIds } },
            attributes: ['ingredient_id', 'branch_id']
        })).map(r => r.ingredient_id + ':' + r.branch_id)
    );

    const porCrear = [];
    for (const fila of filas) {
        let json;
        try {
            json = typeof fila.branch_stocks === 'string'
                ? JSON.parse(fila.branch_stocks)
                : fila.branch_stocks;
        } catch {
            resultado.omitidos++;
            continue;
        }
        if (!json || typeof json !== 'object') { resultado.omitidos++; continue; }

        for (const [clave, valor] of Object.entries(json)) {
            resultado.revisados++;
            const bid = _idSucursal(clave);
            const cantidad = parseFloat(valor);
            if (!bid || !Number.isFinite(cantidad)) { resultado.omitidos++; continue; }
            if (existentes.has(fila.id + ':' + bid)) { resultado.omitidos++; continue; }

            porCrear.push({
                ingredient_id: fila.id,
                branch_id: bid,
                quantity: cantidad,
                business_id: fila.business_id
            });
            existentes.add(fila.id + ':' + bid);
        }
    }

    if (porCrear.length > 0) {
        // Todo o nada: un respaldo a medias es justo el descuadre que se viene a evitar.
        await sequelize.transaction(async t => {
            await BranchStock.bulkCreate(porCrear, { transaction: t });
        });
        resultado.copiados = porCrear.length;
        logger.info(
            'Stock por sucursal: ' + porCrear.length +
            ' pares copiados del JSON legado a la tabla branch_stocks'
        );
    }

    return resultado;
}

module.exports = {
    leerStockSucursal,
    escribirStockSucursal,
    lectorDeStock,
    mapaPorSucursal,
    mapaSumaTodasSucursales,
    respaldarJsonEnTabla,
};
