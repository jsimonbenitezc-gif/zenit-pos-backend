jest.mock('../utils/push', () => ({
    enviarNotificacion: jest.fn(),
    getPrefs: jest.fn().mockResolvedValue({}),
}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { app, sequelize, initTestDb, createTestOwner } = require('./setup');

beforeAll(async () => {
    await initTestDb();
});

afterAll(async () => {
    await sequelize.close();
});

// Firma un token como lo hace POST /api/kds/token en server.js
function firmarTokenKds(businessId, branchId = null) {
    return jwt.sign(
        { business_id: businessId, branch_id: branchId, purpose: 'kds' },
        process.env.JWT_SECRET,
        { expiresIn: '12h' }
    );
}

describe('Token del KDS — alcance acotado', () => {

    test('Puede leer la cola de cocina (lo único que usa kds.html)', async () => {
        const { user } = await createTestOwner();
        const kdsToken = firmarTokenKds(user.id);

        const res = await request(app)
            .get('/api/orders?status=registrado&limit=100')
            .set('Authorization', `Bearer ${kdsToken}`);

        expect(res.status).toBe(200);
    });

    test('NO puede leer la lista de clientes', async () => {
        const { user } = await createTestOwner();
        const kdsToken = firmarTokenKds(user.id);

        const res = await request(app)
            .get('/api/customers')
            .set('Authorization', `Bearer ${kdsToken}`);

        expect(res.status).toBe(403);
    });

    test('NO puede leer el inventario', async () => {
        const { user } = await createTestOwner();
        const kdsToken = firmarTokenKds(user.id);

        const res = await request(app)
            .get('/api/inventory/ingredients')
            .set('Authorization', `Bearer ${kdsToken}`);

        expect(res.status).toBe(403);
    });

    test('NO puede crear pedidos (solo lectura)', async () => {
        const { user } = await createTestOwner();
        const kdsToken = firmarTokenKds(user.id);

        const res = await request(app)
            .post('/api/orders')
            .set('Authorization', `Bearer ${kdsToken}`)
            .send({ items: [], total: 100, payment_method: 'cash' });

        expect(res.status).toBe(403);
    });

    test('Queda acotado al negocio que lo emitió', async () => {
        const { user: duenoA } = await createTestOwner();
        const kdsToken = firmarTokenKds(duenoA.id);

        const res = await request(app)
            .get('/api/orders')
            .set('Authorization', `Bearer ${kdsToken}`);

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
