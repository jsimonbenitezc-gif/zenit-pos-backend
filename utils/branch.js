// utils/branch.js — Sucursal predeterminada (BLOQUE 4 V5)
//
// Un registro (venta o turno) SIN sucursal es un registro huérfano: aparece en el
// filtro de todas las sucursales y, en el caso de los turnos, hacía que el cierre
// sumara los pedidos del negocio entero (doble conteo con los turnos por sucursal).
// Este helper es el ÚNICO lugar donde se decide a qué sucursal pertenece un registro.
//
// Reglas, en orden:
//   1. Si el empleado tiene `branch_id` en su usuario, esa manda. Si el equipo pide
//      otra distinta → 403 (no adivinamos: el conflicto se resuelve a mano).
//   2. Si el cliente manda `branch_id`, se valida que sea del negocio y esté activa.
//   3. Si no manda nada y el negocio tiene UNA sola sucursal, se asigna sola
//      (negocio de un solo local: la sucursal es invisible y no debe estorbar).
//   4. Si no manda nada y hay VARIAS, error 400 accionable: el equipo debe elegir.
//   5. Si el negocio todavía no tiene ninguna sucursal, se permite `null`.

const { Op } = require('sequelize');
const { Branch } = require('../models');

// Error tipado para que las rutas respondan con el status correcto sin repetir lógica.
class BranchError extends Error {
    constructor(status, message) {
        super(message);
        this.name = 'BranchError';
        this.status = status;
    }
}

/**
 * Resuelve la sucursal en la que debe registrarse una venta o un turno.
 *
 * @param {object}  opts
 * @param {object}  opts.user          req.user (trae business_id y branch_id del empleado)
 * @param {*}       opts.branchId      branch_id que manda el cliente (puede venir null/undefined)
 * @param {object=} opts.transaction   transacción Sequelize en curso, si la hay
 * @returns {Promise<number|null>}     id de sucursal, o null si el negocio no tiene ninguna
 * @throws  {BranchError}              403 en conflicto de empleado, 400 si falta elegir
 */
async function resolverBranchId({ user, branchId, transaction = null }) {
    const biz = user.business_id;
    const pedida = branchId ? parseInt(branchId) : null;
    const delEmpleado = user.branch_id ? parseInt(user.branch_id) : null;

    const sucursales = await Branch.findAll({
        where: { business_id: biz, active: true },
        attributes: ['id', 'name'],
        order: [['createdAt', 'ASC']],
        transaction,
    });

    // El negocio aún no tiene sucursales: no hay nada que exigir.
    if (sucursales.length === 0) return null;

    const existe = (id) => sucursales.some(s => s.id === id);

    // 1. El empleado está asignado a una sucursal → esa manda.
    if (delEmpleado) {
        if (!existe(delEmpleado)) {
            throw new BranchError(400, 'Tu usuario está asignado a una sucursal que ya no existe. Pide al dueño que la actualice.');
        }
        if (pedida && pedida !== delEmpleado) {
            const suya   = sucursales.find(s => s.id === delEmpleado);
            const equipo = sucursales.find(s => s.id === pedida);
            throw new BranchError(403,
                `Tu usuario pertenece a ${suya.name}, pero este equipo registra en ${equipo ? equipo.name : 'otra sucursal'}. ` +
                `Pide al dueño que cambie la sucursal del equipo o la de tu usuario.`);
        }
        return delEmpleado;
    }

    // 2. El equipo mandó una sucursal → validarla.
    if (pedida) {
        if (!existe(pedida)) {
            throw new BranchError(400, 'La sucursal indicada no existe o fue desactivada. Elige otra en Ajustes.');
        }
        return pedida;
    }

    // 3. Una sola sucursal → se asigna sola (negocio de un solo local).
    if (sucursales.length === 1) return sucursales[0].id;

    // 4. Varias sucursales y el equipo no eligió ninguna.
    throw new BranchError(400,
        'Este equipo no tiene una sucursal asignada. Elígela en Ajustes → Sucursal antes de registrar.');
}

/**
 * Fragmento de `where` para contar los pedidos que pertenecen a un turno.
 *
 * Antes, un turno con `branch_id` null simplemente NO filtraba por sucursal: su cierre
 * sumaba los pedidos de todas las sucursales del negocio (doble conteo con los turnos
 * que sí tenían sucursal). Ahora el null se trata explícitamente.
 *
 * Caso especial: si el negocio tiene UNA sola sucursal, "sin sucursal" y "esta sucursal"
 * son literalmente el mismo conjunto de pedidos, así que se cuentan ambos. Esto mantiene
 * cuadrados los turnos que estaban abiertos cuando se desplegó este bloque (sus primeros
 * pedidos quedaron con branch_id null y los siguientes ya con sucursal asignada).
 *
 * Devuelve la condición bajo la clave `branch_id` (no bajo `Op.and`) para poder hacer
 * spread junto a `filtroVentaContable()`, que sí usa `Op.and`.
 *
 * @param {object} turno  instancia de Turno (usa business_id y branch_id)
 * @returns {Promise<object>} fragmento de where
 */
async function filtroSucursalTurno(turno) {
    if (turno.branch_id) return { branch_id: turno.branch_id };

    const sucursales = await Branch.findAll({
        where: { business_id: turno.business_id, active: true },
        attributes: ['id'],
    });

    if (sucursales.length === 1) {
        return { branch_id: { [Op.or]: [{ [Op.is]: null }, { [Op.eq]: sucursales[0].id }] } };
    }
    return { branch_id: null };
}

module.exports = { resolverBranchId, filtroSucursalTurno, BranchError };
