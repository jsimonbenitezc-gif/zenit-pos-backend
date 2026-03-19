const { User } = require('../models');

/**
 * Verifica el PIN (contraseña) de un empleado del negocio.
 * Retorna el objeto User si es válido, lanza Error si no.
 *
 * @param {number} employee_id - ID del empleado a verificar
 * @param {string} pin - Contraseña/PIN del empleado
 * @param {number} business_id - ID del negocio (req.user.business_id del JWT)
 * @returns {Promise<User>} El empleado si el PIN es correcto
 */
async function verifyEmployeePin(employee_id, pin, business_id) {
    if (!employee_id || !pin) {
        throw new Error('employee_id y pin son requeridos');
    }

    const employee = await User.findByPk(employee_id);

    // Verificar que el empleado existe, está activo y pertenece al negocio
    // (puede ser el dueño o un empleado del negocio)
    const perteneceAlNegocio =
        employee &&
        employee.active &&
        (employee.id === business_id || employee.business_id === business_id);

    if (!perteneceAlNegocio) {
        throw new Error('Empleado no encontrado o no pertenece a este negocio');
    }

    const valid = await employee.comparePassword(pin);
    if (!valid) {
        throw new Error('PIN incorrecto');
    }

    return employee;
}

module.exports = { verifyEmployeePin };
