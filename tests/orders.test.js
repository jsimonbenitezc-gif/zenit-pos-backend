jest.mock('../utils/push', () => ({
    enviarNotificacion: jest.fn(),
    getPrefs: jest.fn().mockResolvedValue({}),
}));

const request = require('supertest');
const { app, sequelize, models, initTestDb, createTestOwner } = require('./setup');

let owner, ownerToken, product, productZero;

beforeAll(async () => {
    await initTestDb();

    // Crear owner
    const result = await createTestOwner();
    owner = result.user;
    ownerToken = result.token;

    // Crear categoría y productos
    const category = await models.Category.create({
        name: 'Bebidas',
        business_id: owner.id,
    });

    product = await models.Product.create({
        name: 'Café',
        price: 25.00,
        category_id: category.id,
        business_id: owner.id,
    });

    productZero = await models.Product.create({
        name: 'Producto Inválido',
        price: 0,
        category_id: category.id,
        business_id: owner.id,
    });
});

afterAll(async () => {
    await sequelize.close();
});

describe('Orders — flujos críticos', () => {

    test('Crear pedido con productos válidos → 201, total correcto', async () => {
        const res = await request(app)
            .post('/api/orders')
            .set('Authorization', `Bearer ${ownerToken}`)
            .send({
                items: [
                    { product_id: product.id, quantity: 2 },
                ],
                payment_method: 'efectivo',
            });

        expect(res.status).toBe(201);
        expect(parseFloat(res.body.total)).toBe(50.00);
        expect(res.body.items).toHaveLength(1);
        expect(res.body.items[0].quantity).toBe(2);
    });

    test('Idempotencia: mismo client_uuid no duplica el pedido', async () => {
        const client_uuid = 'test-uuid-0001-idempotente';
        const payload = {
            items: [{ product_id: product.id, quantity: 2 }],
            payment_method: 'efectivo',
            client_uuid,
        };

        const primera = await request(app)
            .post('/api/orders')
            .set('Authorization', `Bearer ${ownerToken}`)
            .send(payload);
        expect(primera.status).toBe(201);

        // Reintento con el mismo uuid → debe devolver el MISMO pedido, no crear otro
        const segunda = await request(app)
            .post('/api/orders')
            .set('Authorization', `Bearer ${ownerToken}`)
            .send(payload);
        expect(segunda.status).toBe(200);
        expect(segunda.body.id).toBe(primera.body.id);

        // Solo debe existir un pedido con ese client_uuid
        const cuantos = await models.Order.count({ where: { client_uuid } });
        expect(cuantos).toBe(1);
    });

    test('Crear pedido con precio inválido (0) → 400', async () => {
        const res = await request(app)
            .post('/api/orders')
            .set('Authorization', `Bearer ${ownerToken}`)
            .send({
                items: [
                    { product_id: productZero.id, quantity: 1 },
                ],
            });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/[Pp]recio/);
    });

    test('Cancelar pedido CON pin válido → 200', async () => {
        // Crear pedido primero
        const createRes = await request(app)
            .post('/api/orders')
            .set('Authorization', `Bearer ${ownerToken}`)
            .send({ items: [{ product_id: product.id, quantity: 1 }] });

        expect(createRes.status).toBe(201);
        const orderId = createRes.body.id;

        // Cancelar con PIN del owner (su contraseña)
        const res = await request(app)
            .delete(`/api/orders/${orderId}`)
            .set('Authorization', `Bearer ${ownerToken}`)
            .send({ employee_id: owner.id, pin: 'TestPass123' });

        expect(res.status).toBe(200);
        expect(res.body.message).toMatch(/cancelado/i);
    });

    test('Cancelar pedido SIN pin → 400', async () => {
        // Crear pedido
        const createRes = await request(app)
            .post('/api/orders')
            .set('Authorization', `Bearer ${ownerToken}`)
            .send({ items: [{ product_id: product.id, quantity: 1 }] });

        const orderId = createRes.body.id;

        // Intentar cancelar sin PIN
        const res = await request(app)
            .delete(`/api/orders/${orderId}`)
            .set('Authorization', `Bearer ${ownerToken}`)
            .send({});

        expect(res.status).toBe(400);
    });

    test('Cancelar con pin incorrecto → 403', async () => {
        // Crear pedido
        const createRes = await request(app)
            .post('/api/orders')
            .set('Authorization', `Bearer ${ownerToken}`)
            .send({ items: [{ product_id: product.id, quantity: 1 }] });

        const orderId = createRes.body.id;

        // Intentar cancelar con PIN incorrecto
        const res = await request(app)
            .delete(`/api/orders/${orderId}`)
            .set('Authorization', `Bearer ${ownerToken}`)
            .send({ employee_id: owner.id, pin: 'PinIncorrecto999' });

        expect(res.status).toBe(403);
    });
});
