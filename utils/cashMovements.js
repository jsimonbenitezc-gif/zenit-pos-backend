// utils/cashMovements.js — Movimientos de caja (BLOQUE 7 V5)
//
// Único lugar donde se decide CÓMO suman los movimientos en la caja. Los totales
// en vivo (`GET /turnos/:id/totales`), el cierre (`PUT /turnos/:id/cerrar`) y el
// reporte impreso tienen que dar el mismo número: si cada uno lo calculara por su
// cuenta, el cajero vería una cifra al contar el dinero y otra al cerrar.

const { CashMovement } = require('../models');

const TIPOS = ['retiro', 'gasto', 'deposito'];

// Los movimientos anulados siguen existiendo (se ven en la lista, marcados),
// pero no mueven un centavo del cierre.
const SOLO_VIGENTES = { anulado: false };

/**
 * Suma los movimientos vigentes de un turno.
 *
 * @param {number} turnoId
 * @param {object=} opts
 * @param {object=} opts.transaction  transacción Sequelize en curso, si la hay
 * @returns {Promise<{total_depositos:number,total_retiros:number,total_gastos:number,neto:number}>}
 *          `neto` es lo que los movimientos le suman (o restan) al efectivo esperado.
 */
async function totalesMovimientos(turnoId, { transaction = null } = {}) {
    const movs = await CashMovement.findAll({
        where: { turno_id: turnoId, ...SOLO_VIGENTES },
        attributes: ['tipo', 'monto'],
        transaction,
    });

    let depositos = 0, retiros = 0, gastos = 0;
    for (const m of movs) {
        const monto = parseFloat(m.monto) || 0;
        if (m.tipo === 'deposito')    depositos += monto;
        else if (m.tipo === 'retiro') retiros   += monto;
        else if (m.tipo === 'gasto')  gastos    += monto;
    }

    return {
        total_depositos: redondear(depositos),
        total_retiros:   redondear(retiros),
        total_gastos:    redondear(gastos),
        neto:            redondear(depositos - retiros - gastos),
    };
}

/**
 * Efectivo que DEBERÍA haber en el cajón al cerrar.
 *
 *   esperado = fondo_inicial + ventas_efectivo + depósitos − retiros − gastos
 *
 * @param {object} opts
 * @param {number} opts.fondoInicial
 * @param {number} opts.ventasEfectivo
 * @param {{neto:number}} opts.movimientos  resultado de totalesMovimientos()
 * @returns {number}
 */
function efectivoEsperado({ fondoInicial, ventasEfectivo, movimientos }) {
    return redondear(
        (parseFloat(fondoInicial) || 0) +
        (parseFloat(ventasEfectivo) || 0) +
        (movimientos?.neto || 0)
    );
}

function redondear(n) {
    return parseFloat((Math.round(n * 100) / 100).toFixed(2));
}

/** Normaliza y valida el monto que manda el cliente. Devuelve null si no sirve. */
function montoValido(valor) {
    const monto = parseFloat(valor);
    if (!Number.isFinite(monto) || monto <= 0) return null;
    // Mismo tope que los precios de venta (utils/ventaOffline.js): un monto
    // absurdo es un dedazo, no un movimiento real.
    if (monto > 1000000) return null;
    return redondear(monto);
}

module.exports = { TIPOS, totalesMovimientos, efectivoEsperado, montoValido, redondear };
