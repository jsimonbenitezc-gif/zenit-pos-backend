/**
 * BLOQUE 14 — Horarios laborales como SEÑAL de seguridad, nunca como candado.
 *
 * Lo que estas pruebas defienden, en orden de importancia:
 *
 *   1. **VENDER NUNCA SE BLOQUEA.** Es la tesis entera del bloque: una venta, un
 *      cobro y un turno a las 3 de la mañana funcionan igual que a mediodía. Si
 *      alguna vez alguien "endurece" esto, aquí es donde tiene que fallar.
 *   2. **La ventana que cruza medianoche.** Un bar de 18:00–02:00 tendría toda su
 *      noche marcada como sospechosa con la comparación ingenua. Es el caso que
 *      más negocios reales rompe.
 *   3. **La única puerta con llave es aprobar una pantalla de cocina**, y ni
 *      siquiera es un bloqueo: fuera de horario la sube al DUEÑO.
 *   4. **El horario es del dueño.** Un empleado que pudiera cambiarlo apagaría la
 *      alarma que vigila sus propias acciones.
 *   5. **Sin horario configurado, nada cambia** respecto de antes del bloque.
 */
jest.mock('../utils/push', () => ({
    enviarNotificacion: jest.fn(),
    getPrefs: jest.fn().mockResolvedValue({}),
}));

const request = require('supertest');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { app, sequelize, models, initTestDb, createTestOwner, fijarHorario } = require('./setup');
const { enviarNotificacion } = require('../utils/push');
const {
    normalizarHorario, dentroDeHorario, ventanaDelDia, horaLegible,
    evaluarHorario, avisarFueraDeHorario, _limpiarAvisos, _emitirAhora,
} = require('../utils/horarios');

const PIN = '4321';
const TZ = 'America/Mexico_City';

beforeAll(async () => { await initTestDb(); });
afterAll(async () => { await sequelize.close(); });
beforeEach(() => { enviarNotificacion.mockClear(); });

// Semana de referencia: 0 = domingo. Lunes es un bar 18:00–02:00, sábado 24 h,
// domingo cerrado, el resto 09:00–18:00.
const SEMANA = [
    { cerrado: true },
    { cerrado: false, abre: '18:00', cierra: '02:00' },
    { cerrado: false, abre: '09:00', cierra: '18:00' },
    { cerrado: false, abre: '09:00', cierra: '18:00' },
    { cerrado: false, abre: '09:00', cierra: '18:00' },
    { cerrado: false, abre: '09:00', cierra: '18:00' },
    { cerrado: false, abre: '00:00', cierra: '00:00' },
];

async function ownerConPin(overrides = {}) {
    const { user, token } = await createTestOwner(overrides);
    const settings = user.settings ? JSON.parse(user.settings) : {};
    settings.permisos_roles = {
        cajero: { pin_set: true, pin_bcrypt: await bcrypt.hash(PIN, 10) },
    };
    await user.update({ settings: JSON.stringify(settings) });
    return { user, token };
}

/** Empleado real (cuenta propia) del mismo negocio, con su JWT. */
async function empleadoDe(owner) {
    const uid = Math.random().toString(36).slice(2, 8);
    const emp = await models.User.create({
        username: `emp_${uid}@test.com`,
        password: 'TestPass123',
        name: 'Cajero de prueba',
        role: 'cashier',
        business_id: owner.id,
    });
    const token = jwt.sign(
        { id: emp.id, username: emp.username, role: emp.role, business_id: owner.id },
        process.env.JWT_SECRET, { expiresIn: '1d' }
    );
    return { emp, token };
}

async function crearProducto(token, precio = 100) {
    const r = await request(app).post('/api/products')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Taco', price: precio, emoji: '🌮' });
    return r.body;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. LA FÓRMULA — lo que decide qué es "fuera de horario"
// ═══════════════════════════════════════════════════════════════════════════
describe('La ventana horaria', () => {
    const U = s => new Date(s);

    test('sin horario definido, TODO está dentro de horario', () => {
        expect(dentroDeHorario(null, TZ, new Date())).toBe(true);
        expect(dentroDeHorario(undefined, TZ, new Date())).toBe(true);
        expect(dentroDeHorario([], TZ, new Date())).toBe(true);
    });

    test('miércoles 10:00 está dentro de 09:00–18:00; 03:00 no', () => {
        expect(dentroDeHorario(SEMANA, TZ, U('2026-09-02T16:00:00Z'))).toBe(true);
        expect(dentroDeHorario(SEMANA, TZ, U('2026-09-02T09:00:00Z'))).toBe(false);
    });

    test('los bordes: abre incluye, cierra excluye', () => {
        expect(dentroDeHorario(SEMANA, TZ, U('2026-09-02T15:00:00Z'))).toBe(true);  // 09:00
        expect(dentroDeHorario(SEMANA, TZ, U('2026-09-03T00:00:00Z'))).toBe(false); // 18:00
    });

    // EL CASO QUE MÁS IMPORTA: sin esto, un bar tendría toda su noche marcada
    // como actividad sospechosa y el dueño acabaría silenciando las alertas.
    test('un bar de 18:00–02:00 sigue abierto a la 1:30 de la MADRUGADA SIGUIENTE', () => {
        expect(dentroDeHorario(SEMANA, TZ, U('2026-09-01T01:00:00Z'))).toBe(true);  // lun 19:00
        expect(dentroDeHorario(SEMANA, TZ, U('2026-09-01T07:30:00Z'))).toBe(true);  // mar 01:30
        expect(dentroDeHorario(SEMANA, TZ, U('2026-09-01T09:30:00Z'))).toBe(false); // mar 03:30, ya cerró
    });

    test('un día marcado cerrado lo está a cualquier hora', () => {
        expect(dentroDeHorario(SEMANA, TZ, U('2026-08-31T01:00:00Z'))).toBe(false); // dom 19:00
        expect(dentroDeHorario(SEMANA, TZ, U('2026-09-06T18:00:00Z'))).toBe(false); // dom 12:00
    });

    test('abre === cierra significa 24 horas', () => {
        expect(dentroDeHorario(SEMANA, TZ, U('2026-09-05T09:00:00Z'))).toBe(true);  // sáb 03:00
    });

    // El horario se lee en la zona del NEGOCIO, no en la del servidor (Render corre
    // en UTC): el mismo instante cae dentro o fuera según dónde esté el local.
    test('el MISMO instante cae dentro en México y fuera en Madrid', () => {
        const instante = U('2026-09-02T16:00:00Z'); // 10:00 en México, 18:00 en Madrid
        expect(dentroDeHorario(SEMANA, TZ, instante)).toBe(true);
        expect(dentroDeHorario(SEMANA, 'Europe/Madrid', instante)).toBe(false);
    });

    test('la ventana y la hora se describen para el mensaje', () => {
        expect(ventanaDelDia(SEMANA, TZ, U('2026-09-02T16:00:00Z'))).toBe('09:00–18:00');
        expect(ventanaDelDia(SEMANA, TZ, U('2026-09-06T18:00:00Z'))).toBe('cerrado');
        expect(horaLegible(TZ, U('2026-09-02T09:00:00Z'))).toBe('3:00 a.m.');
        expect(horaLegible(TZ, U('2026-09-02T06:30:00Z'))).toBe('12:30 a.m.');
    });
});

describe('Validación del horario', () => {
    test('null, vacío y ausente significan SIN HORARIO', () => {
        expect(normalizarHorario(null).horario).toBeNull();
        expect(normalizarHorario(undefined).horario).toBeNull();
        expect(normalizarHorario([]).horario).toBeNull();
    });

    test('siete días cerrados NO es un horario: es no tener horario', () => {
        // Guardarlo dejaría al negocio con toda su actividad marcada. Es ruido puro.
        expect(normalizarHorario(Array(7).fill({ cerrado: true })).horario).toBeNull();
    });

    test('rechaza lo que no puede interpretar en vez de caer a un default', () => {
        expect(normalizarHorario([{}, {}, {}]).ok).toBe(false);
        expect(normalizarHorario(Array(7).fill({ abre: '25:00', cierra: '09:00' })).ok).toBe(false);
        expect(normalizarHorario(Array(7).fill({ abre: '9', cierra: '18' })).ok).toBe(false);
        expect(normalizarHorario('{{{').ok).toBe(false);
        expect(normalizarHorario(42).ok).toBe(false);
    });

    test('acepta la semana ya serializada como texto', () => {
        expect(normalizarHorario(JSON.stringify(SEMANA)).horario).toHaveLength(7);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. LA TESIS DEL BLOQUE — vender NUNCA se bloquea
// ═══════════════════════════════════════════════════════════════════════════
describe('El horario nunca impide operar', () => {
    test('con el negocio CERRADO se puede vender, cobrar y abrir turno', async () => {
        const { user, token } = await ownerConPin();
        await fijarHorario(user, 'cerrado');
        const prod = await crearProducto(token);

        const venta = await request(app).post('/api/orders')
            .set('Authorization', `Bearer ${token}`)
            .send({ items: [{ product_id: prod.id, quantity: 2, unit_price: 100 }], payment_method: 'efectivo' });
        expect(venta.status).toBe(201);
        expect(parseFloat(venta.body.total)).toBe(200);

        const turno = await request(app).post('/api/turnos')
            .set('Authorization', `Bearer ${token}`)
            .send({ cajero_nombre: 'Ana', fondo_inicial: 500 });
        expect(turno.status).toBe(201);

        const cobro = await request(app).put(`/api/orders/${venta.body.id}/status`)
            .set('Authorization', `Bearer ${token}`)
            .send({ status: 'completado', payment_method: 'tarjeta' });
        expect(cobro.status).toBe(200);
    });

    test('una venta fuera de horario NO genera aviso ni marca: vender no es sospechoso', async () => {
        const { user, token } = await ownerConPin();
        await fijarHorario(user, 'cerrado');
        const prod = await crearProducto(token);

        await request(app).post('/api/orders')
            .set('Authorization', `Bearer ${token}`)
            .send({ items: [{ product_id: prod.id, quantity: 1, unit_price: 100 }], payment_method: 'efectivo' });

        const logs = await models.PrivilegedActionLog.findAll({ where: { business_id: user.id } });
        expect(logs).toHaveLength(0);
        _emitirAhora(user.id);
        expect(enviarNotificacion).not.toHaveBeenCalled();
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. LA MARCA EN LA AUDITORÍA
// ═══════════════════════════════════════════════════════════════════════════
describe('La marca de fuera de horario en la auditoría', () => {
    async function cancelarPedido(user, token, prod) {
        const venta = await request(app).post('/api/orders')
            .set('Authorization', `Bearer ${token}`)
            .send({ items: [{ product_id: prod.id, quantity: 1, unit_price: 100 }], payment_method: 'efectivo' });
        return request(app).put(`/api/orders/${venta.body.id}/status`)
            .set('Authorization', `Bearer ${token}`)
            .send({ status: 'cancelado', role: 'cajero', pin: PIN, employee_name: 'Ana' });
    }

    test('una cancelación con el negocio CERRADO queda marcada', async () => {
        const { user, token } = await ownerConPin();
        await fijarHorario(user, 'cerrado');
        const prod = await crearProducto(token);

        const r = await cancelarPedido(user, token, prod);
        expect(r.status).toBe(200);

        const log = await models.PrivilegedActionLog.findOne({
            where: { business_id: user.id, action_type: 'cancel_order' }
        });
        expect(log).not.toBeNull();
        expect(log.fuera_horario).toBe(true);
    });

    test('la misma cancelación DENTRO de horario no queda marcada', async () => {
        const { user, token } = await ownerConPin();
        await fijarHorario(user, 'abierto');
        const prod = await crearProducto(token);

        await cancelarPedido(user, token, prod);
        const log = await models.PrivilegedActionLog.findOne({
            where: { business_id: user.id, action_type: 'cancel_order' }
        });
        expect(log.fuera_horario).toBe(false);
    });

    // Sin horario configurado —el default de todo negocio existente— nada se marca:
    // "sin horario definido" no es lo mismo que "todo es fuera de horario".
    test('SIN horario configurado nada se marca', async () => {
        const { user, token } = await ownerConPin();
        const prod = await crearProducto(token);

        await cancelarPedido(user, token, prod);
        const log = await models.PrivilegedActionLog.findOne({
            where: { business_id: user.id, action_type: 'cancel_order' }
        });
        expect(log.fuera_horario).toBe(false);
    });

    test('una devolución fuera de horario queda marcada', async () => {
        const { user, token } = await ownerConPin();
        await fijarHorario(user, 'cerrado');
        const prod = await crearProducto(token);

        const venta = await request(app).post('/api/orders')
            .set('Authorization', `Bearer ${token}`)
            .send({ items: [{ product_id: prod.id, quantity: 1, unit_price: 100 }], payment_method: 'efectivo' });
        await request(app).put(`/api/orders/${venta.body.id}/status`)
            .set('Authorization', `Bearer ${token}`).send({ status: 'completado' });

        const dev = await request(app).post(`/api/orders/${venta.body.id}/devolucion`)
            .set('Authorization', `Bearer ${token}`)
            .send({ role: 'cajero', pin: PIN, employee_name: 'Ana', motivo: 'cliente insatisfecho' });
        expect(dev.status).toBe(200);

        const log = await models.PrivilegedActionLog.findOne({
            where: { business_id: user.id, action_type: 'return_order' }
        });
        expect(log.fuera_horario).toBe(true);
    });

    // El cliente MANDA el log (descuentos del desktop, KDS local); la marca la pone
    // el servidor. Si la pusiera el cliente, un equipo comprometido se declararía
    // "dentro de horario" y la señal dejaría de servir justo cuando importa.
    test('el cliente no puede declararse dentro de horario', async () => {
        const { user, token } = await ownerConPin();
        await fijarHorario(user, 'cerrado');

        const r = await request(app).post('/api/audit')
            .set('Authorization', `Bearer ${token}`)
            .send({ employee_name: 'Ana', action_type: 'apply_discount', fuera_horario: false });
        expect(r.status).toBe(201);

        const log = await models.PrivilegedActionLog.findByPk(r.body.id);
        expect(log.fuera_horario).toBe(true);
    });

    test('el historial se puede filtrar por fuera_horario', async () => {
        const { user, token } = await ownerConPin();

        await fijarHorario(user, 'cerrado');
        await request(app).post('/api/audit').set('Authorization', `Bearer ${token}`)
            .send({ employee_name: 'Ana', action_type: 'apply_discount', target_description: 'de noche' });

        await fijarHorario(user, 'abierto');
        await request(app).post('/api/audit').set('Authorization', `Bearer ${token}`)
            .send({ employee_name: 'Ana', action_type: 'apply_discount', target_description: 'de día' });

        const todos = await request(app).get('/api/audit')
            .set('Authorization', `Bearer ${token}`);
        expect(todos.body.data).toHaveLength(2);

        const soloNoche = await request(app).get('/api/audit?fuera_horario=true')
            .set('Authorization', `Bearer ${token}`);
        expect(soloNoche.body.data).toHaveLength(1);
        expect(soloNoche.body.data[0].target_description).toBe('de noche');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. EL AVISO AL DUEÑO
// ═══════════════════════════════════════════════════════════════════════════
describe('El aviso al dueño', () => {
    beforeEach(() => { _limpiarAvisos(); enviarNotificacion.mockClear(); });

    test('una ráfaga de cancelaciones sale como UN solo aviso con el conteo', () => {
        const marca = { fuera: true, hora: '3:40 a.m.', ventana: '09:00–18:00' };
        avisarFueraDeHorario(77, 'cancel_order', marca);
        avisarFueraDeHorario(77, 'cancel_order', marca);
        avisarFueraDeHorario(77, 'cancel_order', marca);
        expect(enviarNotificacion).not.toHaveBeenCalled(); // todavía agrupando

        _emitirAhora(77);
        expect(enviarNotificacion).toHaveBeenCalledTimes(1);
        const [biz, pref, titulo, cuerpo] = enviarNotificacion.mock.calls[0];
        expect(biz).toBe('77');
        expect(pref).toBe('notif_fuera_horario');
        expect(titulo).toContain('Actividad fuera de horario');
        expect(cuerpo).toContain('3 cancelaciones');
        expect(cuerpo).toContain('3:40 a.m.');
    });

    test('tipos distintos se enumeran en el mismo aviso', () => {
        const marca = { fuera: true, hora: '2:15 a.m.', ventana: '09:00–18:00' };
        avisarFueraDeHorario(88, 'cancel_order', marca);
        avisarFueraDeHorario(88, 'cancel_order', marca);
        avisarFueraDeHorario(88, 'apply_discount', marca);
        _emitirAhora(88);

        const cuerpo = enviarNotificacion.mock.calls[0][3];
        expect(cuerpo).toContain('2 cancelaciones');
        expect(cuerpo).toContain('1 descuento');
    });

    test('cada negocio agrupa por su cuenta', () => {
        const marca = { fuera: true, hora: '1:00 a.m.', ventana: 'cerrado' };
        avisarFueraDeHorario(101, 'cancel_order', marca);
        avisarFueraDeHorario(202, 'cancel_order', marca);
        _emitirAhora(101);
        _emitirAhora(202);
        expect(enviarNotificacion).toHaveBeenCalledTimes(2);
    });

    test('dentro de horario no se avisa nada', () => {
        avisarFueraDeHorario(303, 'cancel_order', { fuera: false });
        avisarFueraDeHorario(303, 'cancel_order', null);
        _emitirAhora(303);
        expect(enviarNotificacion).not.toHaveBeenCalled();
    });

    test('una cancelación real fuera de horario encola su aviso', async () => {
        const { user, token } = await ownerConPin();
        await fijarHorario(user, 'cerrado');
        const prod = await crearProducto(token);

        const venta = await request(app).post('/api/orders')
            .set('Authorization', `Bearer ${token}`)
            .send({ items: [{ product_id: prod.id, quantity: 1, unit_price: 100 }], payment_method: 'efectivo' });
        await request(app).put(`/api/orders/${venta.body.id}/status`)
            .set('Authorization', `Bearer ${token}`)
            .send({ status: 'cancelado', role: 'cajero', pin: PIN, employee_name: 'Ana' });

        enviarNotificacion.mockClear();
        _emitirAhora(user.id);
        expect(enviarNotificacion).toHaveBeenCalledTimes(1);
        expect(enviarNotificacion.mock.calls[0][3]).toContain('1 cancelación');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. LA ÚNICA PUERTA CON LLAVE: aprobar una pantalla de cocina
// ═══════════════════════════════════════════════════════════════════════════
describe('Aprobar una pantalla de cocina fuera de horario', () => {
    let contador = 0;

    async function emparejar(token, owner) {
        contador += 1;
        const secreto = `d-secreto-horarios-${contador}-${Math.random().toString(36).slice(2)}`;
        const pairing = await request(app).post('/api/kds/pairing')
            .set('Authorization', `Bearer ${token}`).send({});
        const reg = await request(app).post('/api/kds/devices/register')
            .send({ codigo: pairing.body.codigo, device_secret: secreto, nombre: 'Cocina' });
        expect(reg.status).toBe(201);
        return { id: reg.body.id, secreto };
    }

    test('el DUEÑO sí puede: es la salida para quien instala la tablet antes de abrir', async () => {
        const { user, token } = await ownerConPin();
        await fijarHorario(user, 'cerrado');
        const disp = await emparejar(token, user);

        const r = await request(app).post(`/api/kds/devices/${disp.id}/approve`)
            .set('Authorization', `Bearer ${token}`)
            .send({ role: 'cajero', pin: PIN, nombre: 'Cocina' });
        expect(r.status).toBe(200);
        expect(r.body.estado).toBe('activo');
    });

    test('un EMPLEADO no puede fuera de horario, y el error dice qué hacer', async () => {
        const { user, token } = await ownerConPin();
        const { token: tokenEmp } = await empleadoDe(user);
        await fijarHorario(user, 'cerrado');
        const disp = await emparejar(token, user);

        const r = await request(app).post(`/api/kds/devices/${disp.id}/approve`)
            .set('Authorization', `Bearer ${tokenEmp}`)
            .send({ role: 'cajero', pin: PIN, nombre: 'Cocina' });
        expect(r.status).toBe(403);
        expect(r.body.error).toContain('administrador');

        const fila = await models.KdsDevice.findByPk(disp.id);
        expect(fila.estado).toBe('pendiente');
    });

    test('ese mismo empleado SÍ puede dentro de horario', async () => {
        const { user, token } = await ownerConPin();
        const { token: tokenEmp } = await empleadoDe(user);
        await fijarHorario(user, 'abierto');
        const disp = await emparejar(token, user);

        const r = await request(app).post(`/api/kds/devices/${disp.id}/approve`)
            .set('Authorization', `Bearer ${tokenEmp}`)
            .send({ role: 'cajero', pin: PIN, nombre: 'Cocina' });
        expect(r.status).toBe(200);
    });

    test('sin horario configurado el empleado puede a cualquier hora (como antes del bloque)', async () => {
        const { user, token } = await ownerConPin();
        const { token: tokenEmp } = await empleadoDe(user);
        const disp = await emparejar(token, user);

        const r = await request(app).post(`/api/kds/devices/${disp.id}/approve`)
            .set('Authorization', `Bearer ${tokenEmp}`)
            .send({ role: 'cajero', pin: PIN, nombre: 'Cocina' });
        expect(r.status).toBe(200);
    });

    // Quitarle el acceso a una tablet perdida es JUSTO lo que hay que poder hacer a
    // las 3 a.m. Restringir revocar sería proteger al ladrón.
    test('REVOCAR nunca se restringe por horario', async () => {
        const { user, token } = await ownerConPin();
        const { token: tokenEmp } = await empleadoDe(user);
        await fijarHorario(user, 'abierto');
        const disp = await emparejar(token, user);
        await request(app).post(`/api/kds/devices/${disp.id}/approve`)
            .set('Authorization', `Bearer ${token}`).send({ role: 'cajero', pin: PIN });

        await fijarHorario(user, 'cerrado');
        const r = await request(app).post(`/api/kds/devices/${disp.id}/revoke`)
            .set('Authorization', `Bearer ${tokenEmp}`)
            .send({ role: 'cajero', pin: PIN });
        expect(r.status).toBe(200);
        expect(r.body.estado).toBe('revocado');

        const log = await models.PrivilegedActionLog.findOne({
            where: { business_id: user.id, action_type: 'revoke_kds_device' }
        });
        expect(log.fuera_horario).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. QUIÉN PUEDE CONFIGURARLO
// ═══════════════════════════════════════════════════════════════════════════
describe('Configurar el horario', () => {
    test('el dueño lo guarda y se lee de vuelta normalizado', async () => {
        const { token } = await ownerConPin();
        const r = await request(app).put('/api/settings')
            .set('Authorization', `Bearer ${token}`)
            .send({ horario_operacion: SEMANA });
        expect(r.status).toBe(200);
        expect(r.body.horario_operacion).toHaveLength(7);
        expect(r.body.horario_operacion[1]).toEqual({ cerrado: false, abre: '18:00', cierra: '02:00' });
        expect(r.body.horario_operacion[0]).toEqual({ cerrado: true });
    });

    // Que lo cambiara un empleado sería dejarle apagar la alarma que vigila sus
    // propias acciones. Mismo criterio que el impuesto (§29) y las propinas (§30).
    test('un empleado recibe 403', async () => {
        const { user } = await ownerConPin();
        const { token: tokenEmp } = await empleadoDe(user);
        const r = await request(app).put('/api/settings')
            .set('Authorization', `Bearer ${tokenEmp}`)
            .send({ horario_operacion: SEMANA });
        expect(r.status).toBe(403);
        expect(r.body.error).toContain('administrador');
    });

    test('un horario mal formado se rechaza con 400 y un mensaje que dice el día', async () => {
        const { token } = await ownerConPin();
        const roto = SEMANA.map((d, i) => (i === 3 ? { abre: '99:99', cierra: '18:00' } : d));
        const r = await request(app).put('/api/settings')
            .set('Authorization', `Bearer ${token}`)
            .send({ horario_operacion: roto });
        expect(r.status).toBe(400);
        expect(r.body.error).toContain('miércoles');
    });

    test('guardar null quita el horario (y con él, todas las señales)', async () => {
        const { user, token } = await ownerConPin();
        await request(app).put('/api/settings')
            .set('Authorization', `Bearer ${token}`).send({ horario_operacion: SEMANA });

        const r = await request(app).put('/api/settings')
            .set('Authorization', `Bearer ${token}`).send({ horario_operacion: null });
        expect(r.status).toBe(200);
        expect(r.body.horario_operacion).toBeNull();

        // Y el caché se invalidó: la señal se apaga al instante, no en 60 segundos.
        const marca = await evaluarHorario(user.id);
        expect(marca.configurado).toBe(false);
        expect(marca.fuera).toBe(false);
    });

    test('el caché se invalida al guardar: el horario nuevo aplica de inmediato', async () => {
        const { user, token } = await ownerConPin();
        await fijarHorario(user, 'abierto');
        expect((await evaluarHorario(user.id)).fuera).toBe(false);

        const hoy = (await evaluarHorario(user.id)).tz;
        expect(hoy).toBe(TZ);

        const { semana } = await fijarHorario(user, 'cerrado');
        await request(app).put('/api/settings')
            .set('Authorization', `Bearer ${token}`).send({ horario_operacion: semana });
        expect((await evaluarHorario(user.id)).fuera).toBe(true);
    });
});
