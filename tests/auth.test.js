jest.mock('../utils/push', () => ({
    enviarNotificacion: jest.fn(),
    getPrefs: jest.fn().mockResolvedValue({}),
}));

const request = require('supertest');
const { app, sequelize, initTestDb, createTestOwner } = require('./setup');

beforeAll(async () => {
    await initTestDb();
});

afterAll(async () => {
    await sequelize.close();
});

describe('Auth — flujos críticos', () => {

    test('Registrar negocio nuevo → 201 + token', async () => {
        const res = await request(app)
            .post('/api/auth/register')
            .send({ name: 'Mi Negocio', email: 'nuevo@test.com', password: 'password123' });

        expect(res.status).toBe(201);
        expect(res.body.token).toBeDefined();
        expect(res.body.user.role).toBe('owner');
    });

    test('Login correcto → 200 + token', async () => {
        // Registrar primero
        await request(app)
            .post('/api/auth/register')
            .send({ name: 'Login Test', email: 'login@test.com', password: 'password123' });

        // Luego login
        const res = await request(app)
            .post('/api/auth/login')
            .send({ username: 'login@test.com', password: 'password123' });

        expect(res.status).toBe(200);
        expect(res.body.token).toBeDefined();
        expect(res.body.user).toBeDefined();
    });

    test('Login contraseña incorrecta → 401', async () => {
        const res = await request(app)
            .post('/api/auth/login')
            .send({ username: 'login@test.com', password: 'wrongpassword' });

        expect(res.status).toBe(401);
    });

    test('Ruta protegida sin token → 401', async () => {
        const res = await request(app).get('/api/auth/me');

        expect(res.status).toBe(401);
    });

    test('Ruta protegida con usuario desactivado → 401', async () => {
        const { user, token } = await createTestOwner();
        await user.update({ active: false });

        const res = await request(app)
            .get('/api/auth/me')
            .set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(401);
    });

    test('Contraseña < 8 caracteres → 400', async () => {
        const res = await request(app)
            .post('/api/auth/register')
            .send({ name: 'Short', email: 'short@test.com', password: '1234567' });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/8 caracteres/);
    });
});
