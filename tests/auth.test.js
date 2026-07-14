jest.mock('../utils/push', () => ({
    enviarNotificacion: jest.fn(),
    getPrefs: jest.fn().mockResolvedValue({}),
}));

// Mock de email: no enviamos correos reales en tests. Capturamos el token de
// reseteo que normalmente viajaría en el correo, para poder probar el flujo completo.
const mockResetHolder = { token: null };
jest.mock('../utils/email', () => ({
    enviarCorreo: jest.fn().mockResolvedValue(true),
    enviarCorreoVerificacion: jest.fn().mockResolvedValue(true),
    enviarCorreoReset: jest.fn((user, token) => { mockResetHolder.token = token; return Promise.resolve(true); }),
    urlVerificacion: jest.fn(),
    urlReset: jest.fn(),
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

describe('Recuperación de contraseña', () => {

    test('forgot-password con correo inexistente → 200 genérico (anti-enumeración)', async () => {
        const res = await request(app)
            .post('/api/auth/forgot-password')
            .send({ email: 'noexiste@test.com' });

        expect(res.status).toBe(200);
        expect(res.body.message).toMatch(/Si existe una cuenta/i);
    });

    test('Flujo completo: solicitar → resetear → login con nueva contraseña', async () => {
        await request(app)
            .post('/api/auth/register')
            .send({ name: 'Reset User', email: 'reset@test.com', password: 'oldpassword1' });

        mockResetHolder.token = null;
        const forgot = await request(app)
            .post('/api/auth/forgot-password')
            .send({ email: 'reset@test.com' });
        expect(forgot.status).toBe(200);
        expect(mockResetHolder.token).toBeTruthy(); // el correo llevaría este token

        const reset = await request(app)
            .post('/api/auth/reset-password')
            .send({ token: mockResetHolder.token, password: 'newpassword2' });
        expect(reset.status).toBe(200);

        // La nueva contraseña funciona
        const loginNuevo = await request(app)
            .post('/api/auth/login')
            .send({ username: 'reset@test.com', password: 'newpassword2' });
        expect(loginNuevo.status).toBe(200);
        // Al resetear se marca el correo como verificado
        expect(loginNuevo.body.user.email_verified).toBe(true);

        // La contraseña vieja ya no funciona
        const loginViejo = await request(app)
            .post('/api/auth/login')
            .send({ username: 'reset@test.com', password: 'oldpassword1' });
        expect(loginViejo.status).toBe(401);
    });

    test('reset-password con token inválido → 400', async () => {
        const res = await request(app)
            .post('/api/auth/reset-password')
            .send({ token: 'token-que-no-existe', password: 'whatever12' });

        expect(res.status).toBe(400);
    });

    test('reset-password token de un solo uso: no se puede reusar', async () => {
        await request(app)
            .post('/api/auth/register')
            .send({ name: 'Once User', email: 'once@test.com', password: 'oldpassword1' });

        mockResetHolder.token = null;
        await request(app).post('/api/auth/forgot-password').send({ email: 'once@test.com' });
        const token = mockResetHolder.token;

        const primero = await request(app)
            .post('/api/auth/reset-password')
            .send({ token, password: 'newpassword2' });
        expect(primero.status).toBe(200);

        const segundo = await request(app)
            .post('/api/auth/reset-password')
            .send({ token, password: 'otropass123' });
        expect(segundo.status).toBe(400);
    });
});
