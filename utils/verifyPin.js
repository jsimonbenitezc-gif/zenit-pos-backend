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
    // Sin PIN NO se sale de inmediato: hay que llegar hasta `rolData` para poder
    // distinguir 'este puesto no tiene PIN configurado' de 'faltó teclearlo'.
    if (!role) return vacio;

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
    // `sinPin` distingue "este puesto NO tiene PIN configurado" de "el PIN está
    // mal". No es lo mismo y quien llama necesita poder decidir: ver
    // `autorizarAccionPrivilegiada`.
    if (!rolData) {
        // ⚠️ EL DUEÑO NO ES UN PUESTO. `permisos_roles` guarda los puestos que el
        // dueño configura (cajero, encargado, los custom); él mismo nunca está ahí,
        // porque su credencial es la de la CUENTA. Sin esta rama, un equipo que
        // opera como "Administrador" —lo que hace TODA cuenta recién creada, que
        // nace sin puestos— recibía 400 "Se requiere PIN para esta acción" al
        // cancelar un pedido, devolverlo, editar un cliente o mover la caja: la
        // quinta cara de la trampa del §19.19, esta vez pidiendo un PIN que por
        // definición no puede existir. Lo encontró el recorrido `conectado` de
        // pruebas-ui del desktop.
        //
        // Se autoriza confirmando, y SE SIGUE AUDITANDO: lo que se pierde es una
        // barrera que nunca estuvo puesta, no el rastro. La barrera del dueño está
        // antes, al entrar como Administrador (contraseña del equipo, §7).
        //
        // Cualquier OTRO rol desconocido sigue rechazándose: si se aceptara, un
        // negocio con PIN en todos sus puestos podría saltárselo inventándose uno.
        if (role === 'dueno') return { ...vacio, sinPin: true, ownerId: owner.id };
        return { ...vacio, ownerId: owner.id };
    }
    if (!rolData.pin_set) return { ...vacio, sinPin: true, ownerId: owner.id };

    // El puesto SÍ tiene PIN configurado pero no llegó ninguno: inválido.
    if (!pin) return { ...vacio, ownerId: owner.id };

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

/**
 * Autoriza una acción privilegiada aceptando CUALQUIERA de las dos credenciales
 * que existen en Zenit. Es el único lugar donde se decide quién puede cancelar,
 * devolver, editar un cliente o mover la caja.
 *
 * ⚠️ LA TRAMPA QUE ESTO RESUELVE (CLAUDE.md §19.19). Zenit tiene DOS claves:
 *
 *   • **PIN de PUESTO** — vive en `settings.permisos_roles` del dueño y es lo
 *     ÚNICO que el cajero teclea en el POS, porque los puestos (cajero,
 *     encargado…) son roles compartidos SIN cuenta de usuario.
 *   • **Contraseña de CUENTA** — la de un `User` real con email. Solo la tienen
 *     el dueño y el staff dado de alta por `/api/staff`.
 *
 * Aceptar solo la segunda deja la función MUERTA en el POS: es exactamente lo
 * que pasaba con cancelar un pedido y editar un cliente, que respondían 400/403
 * a cualquier cajero. Si escribes una ruta nueva que exija PIN, úsala desde aquí.
 *
 * Como no hay un `User` por puesto, la auditoría se atribuye a la cuenta con la
 * que está firmado el equipo (`actorId`) y el puesto queda en el nombre.
 *
 * @returns {Promise<{ok:boolean, status?:number, error?:string, empleadoId:number|null, nombre:string|null}>}
 */
async function autorizarAccionPrivilegiada({
    businessId, actorId, employee_id, employee_name, role, pin, branchId = null,
}) {
    if (!employee_id && !role) {
        return { ok: false, status: 400, error: 'Se requiere PIN para esta acción', empleadoId: null, nombre: null };
    }

    // 1) PIN de puesto — el caso normal en desktop y mobile.
    if (role) {
        const r = await verificarPinDePerfil({ businessId, role, pin, branchId });

        // ⚠️ PUESTO SIN PIN CONFIGURADO = solo confirmar, no bloquear.
        // Si el dueño no le puso PIN a ese puesto, no hay nada contra qué
        // validar: exigir uno dejaría al negocio SIN PODER CANCELAR un pedido,
        // que es justo el problema que este arreglo viene a resolver. Es la
        // misma decisión que ya tomaron el §28.4 (el dueño puede apagar el PIN
        // de los movimientos de caja) y el §24 (el desktop cae a una simple
        // confirmación cuando el equipo no tiene contraseña de app).
        // La acción se sigue AUDITANDO: lo que se pierde es la barrera, no el rastro.
        if (r.sinPin) {
            return { ok: true, empleadoId: actorId, nombre: employee_name || role };
        }

        if (!pin) {
            return { ok: false, status: 400, error: 'Se requiere PIN para esta acción', empleadoId: null, nombre: null };
        }
        if (!r.valid) {
            return { ok: false, status: 403, error: 'PIN incorrecto', empleadoId: null, nombre: null };
        }
        if (r.settingsMigrados && r.ownerId) {
            // Se validó por SHA256 legacy: se persiste el bcrypt recién generado.
            await User.update({ settings: JSON.stringify(r.settingsMigrados) }, { where: { id: r.ownerId } });
        }
        return { ok: true, empleadoId: actorId, nombre: employee_name || role };
    }

    // 2) Contraseña de cuenta (staff con email). Aquí el PIN nunca es opcional:
    // una cuenta SIEMPRE tiene contraseña, así que su ausencia es un error.
    if (!pin) {
        return { ok: false, status: 400, error: 'Se requiere PIN para esta acción', empleadoId: null, nombre: null };
    }
    try {
        const empleado = await verifyEmployeePin(employee_id, pin, businessId);
        return { ok: true, empleadoId: empleado.id, nombre: employee_name || empleado.name };
    } catch (pinErr) {
        return { ok: false, status: 403, error: pinErr.message, empleadoId: null, nombre: null };
    }
}

module.exports = { verifyEmployeePin, verificarPinDePerfil, autorizarAccionPrivilegiada };
