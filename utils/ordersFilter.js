const { Op } = require('sequelize');

/**
 * Filtro de "venta contable" para el dashboard (stats) y el cierre de caja (turnos).
 * Debe usarse el MISMO criterio en ambos para que los números cuadren.
 *
 * Cuenta como venta real:
 *   - Ventas de mostrador: status 'registrado' SIN mesa (table_id null). Los clientes
 *     (desktop/mobile) crean las ventas sin enviar status, así que quedan en 'registrado'.
 *   - Mesas cerradas / entregadas: status 'completado' o 'entregado'.
 *
 * Excluye:
 *   - Canceladas y devueltas ('cancelado', 'devuelto').
 *   - Mesas ABIERTAS (status 'registrado' CON table_id): aún no se han pagado, así que
 *     no deben inflar las ventas del día ni el cierre de caja.
 *
 * Se devuelve como fragmento de `where` de Sequelize para hacer spread (`...`) sobre el
 * where de cada consulta de Order. Usa `status` + `[Op.and]` para no colisionar con
 * otras claves del where (business_id, createdAt, branch_id, etc.).
 */
function filtroVentaContable() {
    return {
        status: { [Op.notIn]: ['cancelado', 'devuelto'] },
        [Op.and]: [
            { [Op.or]: [{ status: { [Op.ne]: 'registrado' } }, { table_id: null }] }
        ]
    };
}

module.exports = { filtroVentaContable };
