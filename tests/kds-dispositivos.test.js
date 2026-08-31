/**
 * BLOQUE 13 — Dispositivos de cocina: aprobación con PIN, auditoría y revocación.
 *
 * Lo que estas pruebas defienden, en orden de importancia:
 *   1. **Emparejar NO es acceder.** Un código robado deja la pantalla en
 *      `pendiente` y ahí se queda hasta que una persona teclee el PIN.
 *   2. **Revocar corta AL INSTANTE.** No "cuando venza el token" — que era todo
 *      lo que se podía hacer antes con una tablet perdida.
 *   3. **Queda escrito quién autorizó.** Antes se guardaba una IP y ningún nombre.
 */
jest.mock('../utils/push', () => ({
    enviarNotificacion: jest.fn(),
    getPrefs: jest.fn().mockResolvedValue({}),
}));

const request = require('supertest');
const bcrypt = require('bcrypt');
const { app, sequelize, models, initTestDb, createTestOwner } = require('./setup');
const {
    hashSecreto, tokenDeSecreto,
    crearCodigoEmparejamiento, consumirCodigoEmparejamiento, limpiarCodigosEmparejamiento,
} = require('../utils/kdsDevices');

const PIN = '2468';

beforeAll(async () => {
    await initTestDb();
});

afterAll(async () => {
    await sequelize.close();
});

let contador = 0;
function secretoNuevo() {
    contador += 1;
    return `d-secreto-de-prueba-${contador}-${Math.random().toString(36).slice(2)}`;
}

/** Dueño con el puesto "cajero" configurado CON PIN. */
async function ownerConPin() {
    const { user, token } = await createTestOwner();
    const settings = {
        permisos_roles: {
            cajero: { pin_set: true, pin_bcrypt: await bcrypt.hash(PIN, 10) },
            mesero: { pin_set: false },
        },
    };
    await user.update({ settings: JSON.stringify(settings) });
    return { user, token };
}

/** Empareja una pantalla y la deja en `pendiente`. */
async function emparejar(token, { branch_id = null, secreto = null } = {}) {
    const valor = secreto || secretoNuevo();
    const pairing = await request(app)
        .post('/api/kds/pairing')
        .set('Authorization', `Bearer ${token}`)
        .send({ branch_id });
    expect(pairing.status).toBe(200);

    const registro = await request(app)
        .post('/api/kds/devices/register')
        .send({ codigo: pairing.body.codigo, device_secret: valor, nombre: 'Tablet de la barra' });

    return { registro, secreto: valor, codigo: pairing.body.codigo };
}

describe('Emparejar no es acceder', () => {

    test('Una pantalla recién emparejada queda pendiente y NO lee nada', async () => {
        const { token } = await ownerConPin();
        const { registro, secreto } = await emparejar(token);

        expect(registro.status).toBe(201);
        expect(registro.body.estado).toBe('pendiente');

        const cola = await request(app)
            .get('/api/orders?status=registrado')
            .set('Authorization', `Bearer ${tokenDeSecreto(secreto)}`);

        expect(cola.status).toBe(403);
        expect(cola.body.error).toMatch(/pendiente/i);
    });

    test('El código sirve UNA sola vez', async () => {
        const { token } = await ownerConPin();
        const { codigo } = await emparejar(token);

        const segundo = await request(app)
            .post('/api/kds/devices/register')
            .send({ codigo, device_secret: secretoNuevo() });

        expect(segundo.status).toBe(401);
    });

    test('Un código inventado no empareja nada', async () => {
        const res = await request(app)
            .post('/api/kds/devices/register')
            .send({ codigo: 'ZZZZZZZZ', device_secret: secretoNuevo() });

        expect(res.status).toBe(401);
    });

    test('Un secreto demasiado corto se rechaza: sería adivinable', async () => {
        const { token } = await ownerConPin();
        const pairing = await request(app)
            .post('/api/kds/pairing')
            .set('Authorization', `Bearer ${token}`)
            .send({});

        const res = await request(app)
            .post('/api/kds/devices/register')
            .send({ codigo: pairing.body.codigo, device_secret: 'abc' });

        expect(res.status).toBe(400);
    });

    test('Recargar la página no crea una pantalla nueva ni gasta otro código', async () => {
        const { token } = await ownerConPin();
        const { registro, secreto } = await emparejar(token);

        const otraVez = await request(app)
            .post('/api/kds/devices/register')
            .send({ device_secret: secreto });

        expect(otraVez.status).toBe(200);
        expect(otraVez.body.id).toBe(registro.body.id);

        const total = await models.KdsDevice.count({ where: { secret_hash: hashSecreto(secreto) } });
        expect(total).toBe(1);
    });

    test('Un código vencido no vale (10 minutos)', () => {
        limpiarCodigosEmparejamiento();
        const { codigo } = crearCodigoEmparejamiento({ businessId: 1, branchId: null });

        const ahora = Date.now();
        const spy = jest.spyOn(Date, 'now').mockReturnValue(ahora + 11 * 60 * 1000);
        expect(consumirCodigoEmparejamiento(codigo)).toBeNull();
        spy.mockRestore();
    });
});

describe('Aprobar con PIN', () => {

    test('Sin PIN no se aprueba, aunque el puesto exista', async () => {
        const { token } = await ownerConPin();
        const { registro } = await emparejar(token);

        const res = await request(app)
            .post(`/api/kds/devices/${registro.body.id}/approve`)
            .set('Authorization', `Bearer ${token}`)
            .send({ role: 'cajero', nombre: 'Cocina' });

        expect(res.status).toBe(400);
    });

    test('Con el PIN equivocado tampoco', async () => {
        const { token } = await ownerConPin();
        const { registro } = await emparejar(token);

        const res = await request(app)
            .post(`/api/kds/devices/${registro.body.id}/approve`)
            .set('Authorization', `Bearer ${token}`)
            .send({ role: 'cajero', pin: '0000' });

        expect(res.status).toBe(403);
    });

    test('Con el PIN correcto: queda activa, lee la cocina y consta quién la autorizó', async () => {
        const { token } = await ownerConPin();
        const { registro, secreto } = await emparejar(token);

        const res = await request(app)
            .post(`/api/kds/devices/${registro.body.id}/approve`)
            .set('Authorization', `Bearer ${token}`)
            .send({ role: 'cajero', pin: PIN, employee_name: 'Ana', nombre: 'Cocina caliente' });

        expect(res.status).toBe(200);
        expect(res.body.estado).toBe('activo');
        expect(res.body.nombre).toBe('Cocina caliente');
        expect(res.body.aprobado_por_nombre).toBe('Ana');
        expect(res.body.aprobado_en).toBeTruthy();
        // El secreto NUNCA sale del servidor, ni siquiera hasheado.
        expect(JSON.stringify(res.body)).not.toContain('secret');

        const cola = await request(app)
            .get('/api/orders?status=registrado')
            .set('Authorization', `Bearer ${tokenDeSecreto(secreto)}`);
        expect(cola.status).toBe(200);
    });

    test('La aprobación queda auditada con nombre, equipo y sucursal', async () => {
        const { user, token } = await ownerConPin();
        const { registro } = await emparejar(token);

        await request(app)
            .post(`/api/kds/devices/${registro.body.id}/approve`)
            .set('Authorization', `Bearer ${token}`)
            .send({ role: 'cajero', pin: PIN, employee_name: 'Ana' });

        const log = await models.PrivilegedActionLog.findOne({
            where: { business_id: user.id, action_type: 'approve_kds_device' },
        });
        expect(log).toBeTruthy();
        expect(log.employee_name).toBe('Ana');
        expect(log.target_description).toMatch(/pantalla de cocina/i);
    });

    test('Un puesto SIN PIN configurado solo confirma — y se sigue auditando (§19.19)', async () => {
        const { user, token } = await ownerConPin();
        const { registro, secreto } = await emparejar(token);

        const res = await request(app)
            .post(`/api/kds/devices/${registro.body.id}/approve`)
            .set('Authorization', `Bearer ${token}`)
            .send({ role: 'mesero', employee_name: 'Luis' });

        expect(res.status).toBe(200);
        expect(res.body.estado).toBe('activo');

        const cola = await request(app)
            .get('/api/orders?status=registrado')
            .set('Authorization', `Bearer ${tokenDeSecreto(secreto)}`);
        expect(cola.status).toBe(200);

        const logs = await models.PrivilegedActionLog.count({
            where: { business_id: user.id, action_type: 'approve_kds_device' },
        });
        expect(logs).toBe(1);
    });

    test('Nadie aprueba la pantalla de otro negocio', async () => {
        const { token: tokenA } = await ownerConPin();
        const { token: tokenB } = await ownerConPin();
        const { registro } = await emparejar(tokenA);

        const res = await request(app)
            .post(`/api/kds/devices/${registro.body.id}/approve`)
            .set('Authorization', `Bearer ${tokenB}`)
            .send({ role: 'cajero', pin: PIN });

        expect(res.status).toBe(404);
    });
});

describe('Revocar corta el acceso al instante', () => {

    test('La pantalla deja de leer la cocina en la siguiente petición', async () => {
        const { token } = await ownerConPin();
        const { registro, secreto } = await emparejar(token);
        const tokenDispositivo = tokenDeSecreto(secreto);

        await request(app)
            .post(`/api/kds/devices/${registro.body.id}/approve`)
            .set('Authorization', `Bearer ${token}`)
            .send({ role: 'cajero', pin: PIN });

        // Esta lectura DEJA EL DISPOSITIVO EN EL CACHÉ: es justo la condición en
        // la que "revocar" podría tardar 30 segundos si no se invalidara.
        const antes = await request(app)
            .get('/api/orders?status=registrado')
            .set('Authorization', `Bearer ${tokenDispositivo}`);
        expect(antes.status).toBe(200);

        const revocacion = await request(app)
            .post(`/api/kds/devices/${registro.body.id}/revoke`)
            .set('Authorization', `Bearer ${token}`)
            .send({ role: 'cajero', pin: PIN, employee_name: 'Ana', motivo: 'Tablet extraviada' });
        expect(revocacion.status).toBe(200);
        expect(revocacion.body.estado).toBe('revocado');

        const despues = await request(app)
            .get('/api/orders?status=registrado')
            .set('Authorization', `Bearer ${tokenDispositivo}`);
        expect(despues.status).toBe(401);
    });

    test('Revocar también pide PIN', async () => {
        const { token } = await ownerConPin();
        const { registro } = await emparejar(token);

        await request(app)
            .post(`/api/kds/devices/${registro.body.id}/approve`)
            .set('Authorization', `Bearer ${token}`)
            .send({ role: 'cajero', pin: PIN });

        const res = await request(app)
            .post(`/api/kds/devices/${registro.body.id}/revoke`)
            .set('Authorization', `Bearer ${token}`)
            .send({ role: 'cajero', pin: '9999' });

        expect(res.status).toBe(403);
    });

    test('La revocación queda auditada', async () => {
        const { user, token } = await ownerConPin();
        const { registro } = await emparejar(token);

        await request(app)
            .post(`/api/kds/devices/${registro.body.id}/approve`)
            .set('Authorization', `Bearer ${token}`)
            .send({ role: 'cajero', pin: PIN });
        await request(app)
            .post(`/api/kds/devices/${registro.body.id}/revoke`)
            .set('Authorization', `Bearer ${token}`)
            .send({ role: 'cajero', pin: PIN, employee_name: 'Ana' });

        const log = await models.PrivilegedActionLog.findOne({
            where: { business_id: user.id, action_type: 'revoke_kds_device' },
        });
        expect(log).toBeTruthy();
        expect(log.employee_name).toBe('Ana');
    });

    test('El registro NO se borra: la fila revocada es la prueba de lo ocurrido', async () => {
        const { token } = await ownerConPin();
        const { registro } = await emparejar(token);

        await request(app)
            .post(`/api/kds/devices/${registro.body.id}/revoke`)
            .set('Authorization', `Bearer ${token}`)
            .send({ role: 'cajero', pin: PIN });

        const fila = await models.KdsDevice.findByPk(registro.body.id);
        expect(fila).toBeTruthy();
        expect(fila.estado).toBe('revocado');
        expect(fila.revocado_en).toBeTruthy();
    });

    test('Un secreto revocado no se reactiva reusándolo: hay que emparejar de nuevo', async () => {
        const { token } = await ownerConPin();
        const { registro, secreto } = await emparejar(token);

        await request(app)
            .post(`/api/kds/devices/${registro.body.id}/revoke`)
            .set('Authorization', `Bearer ${token}`)
            .send({ role: 'cajero', pin: PIN });

        const pairing = await request(app)
            .post('/api/kds/pairing')
            .set('Authorization', `Bearer ${token}`)
            .send({});
        const res = await request(app)
            .post('/api/kds/devices/register')
            .send({ codigo: pairing.body.codigo, device_secret: secreto });

        expect(res.status).toBe(403);
        expect(res.body.estado).toBe('revocado');
    });

    test('No se puede borrar de la lista una pantalla ACTIVA (primero se revoca)', async () => {
        const { token } = await ownerConPin();
        const { registro } = await emparejar(token);

        await request(app)
            .post(`/api/kds/devices/${registro.body.id}/approve`)
            .set('Authorization', `Bearer ${token}`)
            .send({ role: 'cajero', pin: PIN });

        const res = await request(app)
            .delete(`/api/kds/devices/${registro.body.id}`)
            .set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(400);
    });
});

describe('Lo que ve el dueño y lo que ve la pantalla', () => {

    test('El listado no filtra el secreto de ningún dispositivo', async () => {
        const { token } = await ownerConPin();
        await emparejar(token);

        const res = await request(app)
            .get('/api/kds/devices')
            .set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(200);
        expect(res.body.data.length).toBe(1);
        expect(JSON.stringify(res.body)).not.toContain('secret_hash');
    });

    test('Cada negocio ve solo sus pantallas', async () => {
        const { token: tokenA } = await ownerConPin();
        const { token: tokenB } = await ownerConPin();
        await emparejar(tokenA);

        const res = await request(app)
            .get('/api/kds/devices')
            .set('Authorization', `Bearer ${tokenB}`);

        expect(res.body.data).toEqual([]);
    });

    test('La pantalla puede consultar su propio estado (así se entera de que la aprobaron)', async () => {
        const { token } = await ownerConPin();
        const { registro, secreto } = await emparejar(token);

        const pendiente = await request(app)
            .get('/api/kds/devices/me')
            .set('Authorization', `Bearer ${tokenDeSecreto(secreto)}`);
        expect(pendiente.body.estado).toBe('pendiente');

        await request(app)
            .post(`/api/kds/devices/${registro.body.id}/approve`)
            .set('Authorization', `Bearer ${token}`)
            .send({ role: 'cajero', pin: PIN });

        const activa = await request(app)
            .get('/api/kds/devices/me')
            .set('Authorization', `Bearer ${tokenDeSecreto(secreto)}`);
        expect(activa.body.estado).toBe('activo');
    });

    test('Una pantalla ve SOLO la cocina de su sucursal, aunque pida otra en la URL', async () => {
        const { user, token } = await ownerConPin();
        const centro = await models.Branch.create({ name: 'Centro', business_id: user.id });
        const norte  = await models.Branch.create({ name: 'Norte',  business_id: user.id });

        await models.Order.create({
            business_id: user.id, branch_id: centro.id, status: 'registrado', total: 100,
        });
        await models.Order.create({
            business_id: user.id, branch_id: norte.id, status: 'registrado', total: 200,
        });

        const { registro, secreto } = await emparejar(token, { branch_id: centro.id });
        await request(app)
            .post(`/api/kds/devices/${registro.body.id}/approve`)
            .set('Authorization', `Bearer ${token}`)
            .send({ role: 'cajero', pin: PIN });

        // Pide explícitamente la sucursal ajena: la URL la controla quien tenga
        // la tablet, así que el servidor impone la sucursal del dispositivo.
        const res = await request(app)
            .get(`/api/orders?status=registrado&branch_id=${norte.id}`)
            .set('Authorization', `Bearer ${tokenDeSecreto(secreto)}`);

        expect(res.status).toBe(200);
        const sucursales = res.body.data.map(o => o.branch_id);
        expect(sucursales).not.toContain(norte.id);
        expect(sucursales).toContain(centro.id);
    });
});
