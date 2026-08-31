/**
 * El ALCANCE de una pantalla de cocina (§19.13 + BLOQUE 13).
 *
 * Este archivo existía antes del bloque 13 para probar que el JWT `purpose:'kds'`
 * no servía como token de sesión. Ese token ya no existe —lo reemplazaron los
 * dispositivos aprobados—, pero la garantía que probaba es LA MISMA y sigue
 * siendo la más importante del KDS: una credencial de cocina lee la cola de
 * pedidos y NADA más.
 *
 * Se comprueba además que los pases viejos ya no valen: al no reconocerlos,
 * volverían a caer al camino normal de `authenticate` y, al no traer `id`,
 * heredarían el `business_id` del propio token — que es EXACTAMENTE como nació
 * el agujero de la llave maestra.
 */
jest.mock('../utils/push', () => ({
    enviarNotificacion: jest.fn(),
    getPrefs: jest.fn().mockResolvedValue({}),
}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { app, sequelize, models, initTestDb, createTestOwner } = require('./setup');
const { hashSecreto, tokenDeSecreto } = require('../utils/kdsDevices');

beforeAll(async () => {
    await initTestDb();
});

afterAll(async () => {
    await sequelize.close();
});

/** Crea un dispositivo ya aprobado y devuelve su token de acceso. */
async function dispositivoActivo(businessId, branchId = null, secreto = null) {
    const valor = secreto || `d-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
    const dispositivo = await models.KdsDevice.create({
        business_id: businessId,
        branch_id: branchId,
        nombre: 'Pantalla de prueba',
        secret_hash: hashSecreto(valor),
        estado: 'activo',
        aprobado_en: new Date(),
    });
    return { dispositivo, token: tokenDeSecreto(valor), secreto: valor };
}

describe('Alcance de una pantalla de cocina aprobada', () => {

    test('Puede leer la cola de cocina (lo único que usa kds.html)', async () => {
        const { user } = await createTestOwner();
        const { token } = await dispositivoActivo(user.id);

        const res = await request(app)
            .get('/api/orders?status=registrado&limit=100')
            .set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(200);
    });

    test('NO puede leer la lista de clientes', async () => {
        const { user } = await createTestOwner();
        const { token } = await dispositivoActivo(user.id);

        const res = await request(app)
            .get('/api/customers')
            .set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(403);
    });

    test('NO puede leer el inventario', async () => {
        const { user } = await createTestOwner();
        const { token } = await dispositivoActivo(user.id);

        const res = await request(app)
            .get('/api/inventory/ingredients')
            .set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(403);
    });

    test('NO puede crear pedidos (solo lectura)', async () => {
        const { user } = await createTestOwner();
        const { token } = await dispositivoActivo(user.id);

        const res = await request(app)
            .post('/api/orders')
            .set('Authorization', `Bearer ${token}`)
            .send({ items: [], total: 100, payment_method: 'efectivo' });

        expect(res.status).toBe(403);
    });

    test('NO puede leer un pedido concreto: la lista es la lista, no una puerta', async () => {
        const { user } = await createTestOwner();
        const { token } = await dispositivoActivo(user.id);

        const res = await request(app)
            .get('/api/orders/1')
            .set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(403);
    });

    test('Queda acotado al negocio que lo aprobó', async () => {
        const { user: duenoA } = await createTestOwner();
        const { token } = await dispositivoActivo(duenoA.id);

        const res = await request(app)
            .get('/api/orders')
            .set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(200);
        // Sin pedidos propios, no puede estar viendo los de otro negocio
        expect(res.body.data).toEqual([]);
    });

    test('Un token de sesión normal NO se ve afectado por el cerrojo', async () => {
        const { token } = await createTestOwner();

        const res = await request(app)
            .get('/api/customers')
            .set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(200);
    });
});

describe('El pase que caducaba ya no vale', () => {

    test('Un JWT purpose:kds de los viejos es rechazado, no reinterpretado', async () => {
        const { user } = await createTestOwner();
        const pasaporteViejo = jwt.sign(
            { business_id: user.id, branch_id: null, purpose: 'kds' },
            process.env.JWT_SECRET,
            { expiresIn: '12h' }
        );

        const res = await request(app)
            .get('/api/orders?status=registrado')
            .set('Authorization', `Bearer ${pasaporteViejo}`);

        expect(res.status).toBe(401);
    });

    test('Y tampoco sirve como llave maestra contra otra ruta', async () => {
        const { user } = await createTestOwner();
        const pasaporteViejo = jwt.sign(
            { business_id: user.id, purpose: 'kds' },
            process.env.JWT_SECRET,
            { expiresIn: '12h' }
        );

        const res = await request(app)
            .get('/api/customers')
            .set('Authorization', `Bearer ${pasaporteViejo}`);

        expect(res.status).toBe(401);
        expect(Array.isArray(res.body?.data)).toBe(false);
    });
});
