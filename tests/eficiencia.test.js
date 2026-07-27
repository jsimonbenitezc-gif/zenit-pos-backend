/**
 * Bloque 3 del PLAN_ARREGLOS_V5 — eficiencia del backend.
 *
 * Cubre las cuatro tareas del bloque:
 *   1. Las fotos (data-URI base64) ya no viajan en pedidos ni en stats,
 *      pero SÍ siguen en el catálogo del POS.
 *   2. `middleware/auth.js` cachea al usuario 30s (menos roundtrips) sin perder
 *      el bloqueo inmediato de cuentas desactivadas.
 *   3. El límite del body es 2mb, no los 100kb por defecto de Express.
 *   4. Superarlo responde 413 con un mensaje entendible, no un 500 genérico.
 */
jest.mock('../utils/push', () => ({
    enviarNotificacion: jest.fn(),
    getPrefs: jest.fn().mockResolvedValue({}),
}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { app, sequelize, models, initTestDb, createTestOwner } = require('./setup');

// data-URI mínima pero reconocible, para detectarla si se cuela en una respuesta
const IMAGEN = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let owner, ownerToken, categoria, producto;

beforeAll(async () => {
    await initTestDb();

    const result = await createTestOwner();
    owner = result.user;
    ownerToken = result.token;

    categoria = await models.Category.create({
        name: 'Bebidas',
        image: IMAGEN,
        business_id: owner.id,
    });

    producto = await models.Product.create({
        name: 'Café',
        price: 25.00,
        emoji: '☕',
        image: IMAGEN,
        category_id: categoria.id,
        business_id: owner.id,
    });
});

afterAll(async () => {
    await sequelize.close();
});

describe('Imágenes: solo donde se usan', () => {

    test('POST /api/orders → la respuesta del pedido no trae la foto del producto', async () => {
        const res = await request(app)
            .post('/api/orders')
            .set('Authorization', `Bearer ${ownerToken}`)
            .send({ items: [{ product_id: producto.id, quantity: 1 }], payment_method: 'efectivo' });

        expect(res.status).toBe(201);
        expect(res.body.items[0].product.emoji).toBe('☕');
        expect(res.body.items[0].product.image).toBeUndefined();
    });

    test('GET /api/orders y GET /api/orders/:id → sin fotos en los items', async () => {
        const lista = await request(app)
            .get('/api/orders')
            .set('Authorization', `Bearer ${ownerToken}`);

        expect(lista.status).toBe(200);
        expect(lista.body.data.length).toBeGreaterThan(0);
        expect(JSON.stringify(lista.body)).not.toContain('data:image');
        expect(lista.body.data[0].items[0].product.name).toBe('Café');

        const detalle = await request(app)
            .get(`/api/orders/${lista.body.data[0].id}`)
            .set('Authorization', `Bearer ${ownerToken}`);

        expect(detalle.status).toBe(200);
        expect(JSON.stringify(detalle.body)).not.toContain('data:image');
    });

    test('GET /api/stats/dashboard → top productos sin fotos', async () => {
        const res = await request(app)
            .get('/api/stats/dashboard')
            .set('Authorization', `Bearer ${ownerToken}`);

        expect(res.status).toBe(200);
        expect(JSON.stringify(res.body)).not.toContain('data:image');
    });

    test('GET /api/products/grouped → el POS SÍ conserva las fotos', async () => {
        const res = await request(app)
            .get('/api/products/grouped')
            .set('Authorization', `Bearer ${ownerToken}`);

        expect(res.status).toBe(200);
        const cat = res.body.find(c => c.id === categoria.id);
        expect(cat.image).toBe(IMAGEN);
        expect(cat.products.find(p => p.id === producto.id).image).toBe(IMAGEN);
    });
});

describe('Caché de autenticación', () => {

    test('Dos requests seguidos → una sola consulta del usuario', async () => {
        // Dueño recién creado: nadie lo ha cacheado todavía
        const { token } = await createTestOwner();
        const espia = jest.spyOn(models.User, 'findByPk');

        // La primera llena el caché (GET /api/categories no consulta usuarios por su cuenta)
        await request(app).get('/api/categories').set('Authorization', `Bearer ${token}`);
        expect(espia).toHaveBeenCalled();

        espia.mockClear();
        const segunda = await request(app).get('/api/categories').set('Authorization', `Bearer ${token}`);

        expect(segunda.status).toBe(200);
        expect(espia).not.toHaveBeenCalled();
        espia.mockRestore();
    });

    test('Desactivar un empleado corta su acceso al instante (sin esperar el TTL)', async () => {
        const empleado = await models.User.create({
            name: 'Cajero Test',
            username: `cajero_${Date.now()}`,
            password: 'TestPass123',
            role: 'cashier',
            business_id: owner.id,
        });
        const tokenEmpleado = jwt.sign(
            { id: empleado.id, username: empleado.username, role: 'cashier', business_id: owner.id },
            process.env.JWT_SECRET,
            { expiresIn: '1d' }
        );

        // Request previo: deja al empleado cacheado como activo
        const antes = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${tokenEmpleado}`);
        expect(antes.status).toBe(200);

        const baja = await request(app)
            .delete(`/api/staff/${empleado.id}`)
            .set('Authorization', `Bearer ${ownerToken}`);
        expect(baja.status).toBe(200);

        const despues = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${tokenEmpleado}`);
        expect(despues.status).toBe(401);
    });

    test('El rol cacheado sigue bloqueando rutas de dueño', async () => {
        const empleado = await models.User.create({
            name: 'Mesero Test',
            username: `mesero_${Date.now()}`,
            password: 'TestPass123',
            role: 'waiter',
            business_id: owner.id,
        });
        const tokenEmpleado = jwt.sign(
            { id: empleado.id, username: empleado.username, role: 'waiter', business_id: owner.id },
            process.env.JWT_SECRET,
            { expiresIn: '1d' }
        );

        // Primero una ruta normal (llena el caché), luego una de dueño
        await request(app).get('/api/categories').set('Authorization', `Bearer ${tokenEmpleado}`);

        const res = await request(app)
            .post('/api/products')
            .set('Authorization', `Bearer ${tokenEmpleado}`)
            .send({ name: 'Prohibido', price: 10 });

        expect(res.status).toBe(403);

        // Y el dueño sí puede (mismo caché, rol distinto)
        const ok = await request(app)
            .post('/api/products')
            .set('Authorization', `Bearer ${ownerToken}`)
            .send({ name: 'Permitido', price: 10 });
        expect(ok.status).toBe(201);
    });
});

describe('Límite de body', () => {

    test('Imagen de ~500KB (antes fallaba con 100KB) → se acepta', async () => {
        const imagenGrande = `data:image/png;base64,${'A'.repeat(500 * 1024)}`;
        const res = await request(app)
            .post('/api/products')
            .set('Authorization', `Bearer ${ownerToken}`)
            .send({ name: 'Con foto', price: 10, image: imagenGrande });

        expect(res.status).toBe(201);
    });

    test('Body por encima del límite → 413 con mensaje claro, no 500', async () => {
        const enorme = `data:image/png;base64,${'A'.repeat(3 * 1024 * 1024)}`;
        const res = await request(app)
            .post('/api/products')
            .set('Authorization', `Bearer ${ownerToken}`)
            .send({ name: 'Demasiado grande', price: 10, image: enorme });

        expect(res.status).toBe(413);
        expect(res.body.error).toMatch(/demasiado grande/i);
        expect(res.body.error).not.toMatch(/Error interno/i);
    });
});
