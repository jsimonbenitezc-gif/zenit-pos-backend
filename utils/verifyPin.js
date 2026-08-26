const crypto = require('crypto');
const bcrypt = require('bcrypt');
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

/**
 * Verifica el PIN de un PUESTO (cajero, encargado, dueño) contra
 * `settings.permisos_roles` del dueño del negocio.
 *
 * ⚠️ Esto NO es lo mismo que `verifyEmployeePin`. Zenit tiene DOS credenciales
 * distintas y confundirlas deja funciones muertas:
 *   - PIN de PERFIL: 4-8 dígitos guardados (hasheados) en los ajustes del negocio.
 *     Es lo único que el cajero teclea en el desktop y en el mobile, porque los
 *     puestos son roles compartidos, no cuentas de usuario.
 *   - Contraseña de CUENTA (`verifyEmployeePin`): la de un `User` real con email.
 *     Solo existe para el dueño y para el staff dado de alta en /api/staff.
 *
 * Acepta bcrypt (`pin_bcrypt`) y el SHA256 legacy que genera el desktop; cuando
 * valida por SHA256 devuelve el objeto de settings ya migrado a bcrypt para que
 * el llamador lo persista.
 *
 * @param {object} opts
 * @param {number} opts.businessId  id del dueño (req.user.business_id)
 * @param {string} opts.role        'cajero' | 'encargado' | 'dueno' | ...
 * @param {string} opts.pin
 * @param {number|null=} opts.branchId  sucursal, para los permisos con sufijo __b_
 * @returns {Promise<{valid:boolean, settingsMigrados:object|null, ownerId:number|null}>}
 */
async function verificarPinDePerfil({ businessId, role, pin, branchId = null }) {
    const vacio = { valid: false, settingsMigrados: null, ownerId: null };
    if (!role || !pin) return vacio;

    const owner = await User.findByPk(businessId, { attributes: ['id', 'settings'] });
    if (!owner) return vacio;

    let settings = {};
    try { settings = owner.settings ? JSON.parse(owner.settings) : {}; } catch { return vacio; }
    const permisosRoles = settings.permisos_roles || {};

    // Los permisos pueden estar personalizados por sucursal (sufijo __b_{id}).
    let permisos = permisosRoles;
    const claveSucursal = branchId ? `__b_${branchId}` : null;
    if (claveSucursal && permisosRoles[claveSucursal]?.[role]) {
        permisos = permisosRoles[claveSucursal];
    } else {
        const globales = Object.fromEntries(
            Object.entries(permisosRoles).filter(([k]) => !k.startsWith('__b_'))
        );
        if (globales[role]) {
            permisos = globales;
        } else {
            // Último recurso: buscar el puesto en cualquier sucursal.
            for (const bk of Object.keys(permisosRoles).filter(k => k.startsWith('__b_'))) {
                if (permisosRoles[bk]?.[role]) { permisos = permisosRoles[bk]; break; }
            }
        }
    }

    const rolData = permisos[role];
    if (!rolData || !rolData.pin_set) return { ...vacio, ownerId: owner.id };

    if (rolData.pin_bcrypt) {
        const valid = await bcrypt.compare(pin, rolData.pin_bcrypt);
        return { valid, settingsMigrados: null, ownerId: owner.id };
    }

    if (rolData.pin) {
        const sha256 = crypto.createHash('sha256').update(pin).digest('hex');
        if (sha256 !== rolData.pin) return { ...vacio, ownerId: owner.id };
        // Migración automática a bcrypt: el llamador persiste `settingsMigrados`.
        rolData.pin_bcrypt = await bcrypt.hash(pin, 10);
        return { valid: true, settingsMigrados: settings, ownerId: owner.id };
    }

    return { ...vacio, ownerId: owner.id };
}

module.exports = { verifyEmployeePin, verificarPinDePerfil };
