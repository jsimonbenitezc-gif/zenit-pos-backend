jest.mock('../utils/push', () => ({
    enviarNotificacion: jest.fn(),
    getPrefs: jest.fn().mockResolvedValue({}),
}));

const request = require('supertest');
const crypto = require('crypto');
const { app, sequelize, models, initTestDb } = require('./setup');

const EMAIL = 'multi@test.com';
const PASSWORD = 'TestPass123';

function login() {
    return request(app).post('/api/auth/login').send({ username: EMAIL, password: PASSWORD });
}

function refrescar(refreshToken) {
    return request(app).post('/api/auth/refresh').send({ refreshToken });
}

beforeAll(async () => {
    await initTestDb();
    await models.User.create({
        username: EMAIL, password: PASSWORD, name: 'Dueño', role: 'owner', plan: 'premium',
    });
});

afterAll(async () => {
    await sequelize.close();
});

describe('Sesiones multi-dispositivo', () => {

    test('Entrar desde un segundo equipo NO cierra la sesión del primero', async () => {
        // El bug: users.refresh_token_hash era una sola columna, así que el login del
        // celular pisaba el refresh token del desktop y ese equipo se deslogueaba en
        // cuanto su access token cumplía 15 minutos.
        const desktop = await login();
        expect(desktop.status).toBe(200);

        const celular = await login();
        expect(celular.status).toBe(200);
        expect(celular.body.refreshToken).not.toBe(desktop.body.refreshToken);

        // El desktop debe poder renovar aunque el celular haya entrado después
        const renovado = await refrescar(desktop.body.refreshToken);
        expect(renovado.status).toBe(200);
        expect(renovado.body.token).toBeTruthy();

        // Y el celular sigue con la suya intacta
        const renovadoCelular = await refrescar(celular.body.refreshToken);
        expect(renovadoCelular.status).toBe(200);
    });

    test('Un refresh token se usa UNA sola vez (rotación)', async () => {
        const sesion = await login();
        const primero = await refrescar(sesion.body.refreshToken);
        expect(primero.status).toBe(200);

        const repetido = await refrescar(sesion.body.refreshToken);
        expect(repetido.status).toBe(401);
    });

    test('Refrescar en un equipo no invalida la sesión del otro', async () => {
        const a = await login();
        const b = await login();

        const rotadoA = await refrescar(a.body.refreshToken);
        expect(rotadoA.status).toBe(200);

        // B nunca participó en esa rotación: su token sigue sirviendo
        expect((await refrescar(b.body.refreshToken)).status).toBe(200);
        // y el token nuevo de A también
        expect((await refrescar(rotadoA.body.refreshToken)).status).toBe(200);
    });

    test('Un refresh token vencido → 401 y se elimina', async () => {
        const sesion = await login();
        const hash = crypto.createHash('sha256').update(sesion.body.refreshToken).digest('hex');
        await models.RefreshToken.update(
            { expires_at: new Date(Date.now() - 1000) },
            { where: { token_hash: hash } }
        );

        expect((await refrescar(sesion.body.refreshToken)).status).toBe(401);
        expect(await models.RefreshToken.count({ where: { token_hash: hash } })).toBe(0);
    });

    test('El login SÍ persiste la sesión (regresión del bug de fondo)', async () => {
        // El bug original: se escribía en users.refresh_token_hash, una columna que el
        // modelo User no declara → Sequelize ignoraba el UPDATE y nunca se guardaba
        // nada. El refresh siempre daba 401 y la sesión moría a los 15 minutos.
        const antes = await models.RefreshToken.count();
        const sesion = await login();
        expect(await models.RefreshToken.count()).toBe(antes + 1);

        const hash = crypto.createHash('sha256').update(sesion.body.refreshToken).digest('hex');
        expect(await models.RefreshToken.count({ where: { token_hash: hash } })).toBe(1);
    });

    test('Un token inventado → 401 (no se cuela nada)', async () => {
        const falso = crypto.randomBytes(64).toString('hex');
        expect((await refrescar(falso)).status).toBe(401);
    });

    test('Resetear la contraseña cierra TODAS las sesiones', async () => {
        const a = await login();
        const b = await login();

        const user = await models.User.findOne({ where: { username: EMAIL } });
        const { revocarTodasLasSesiones } = require('../utils/refreshTokens');
        await revocarTodasLasSesiones(user.id);

        expect((await refrescar(a.body.refreshToken)).status).toBe(401);
        expect((await refrescar(b.body.refreshToken)).status).toBe(401);
    });
});
