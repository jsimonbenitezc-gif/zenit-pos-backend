/**
 * Bloque 6 del PLAN_ARREGLOS_V5 — puesta en producción.
 *
 * Cubre las partes del bloque que son código (el resto es configuración externa:
 * Sentry, UptimeRobot, plan de Render, dominio de Resend):
 *   1. Rate limit del login: por IP + usuario, sin castigar los logins exitosos.
 *   2. Sentry: el cableado no usa la API que desapareció en el SDK v8
 *      (`Sentry.Handlers`), que habría tumbado el arranque al poner SENTRY_DSN.
 *   3. Saneado de los eventos que se mandan a Sentry (no salen contraseñas ni tokens).
 *   4. El token del KDS dura un turno completo (12h), no 2h.
 */
jest.mock('../utils/push', () => ({
    enviarNotificacion: jest.fn(),
    getPrefs: jest.fn().mockResolvedValue({}),
}));

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { app, sequelize, models, initTestDb } = require('./setup');
const { LOGIN_MAX_INTENTOS } = require('../utils/rateLimitLogin');

const PASSWORD = 'ClaveCorrecta123';

// Fuente de server.js: hay piezas (Sentry, token del KDS) que viven ahí y no se
// pueden montar en la app ligera de tests porque server.js abre el puerto.
const fuenteServer = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

async function crearUsuario(username) {
    return models.User.create({
        username,
        password: PASSWORD,
        name: 'Cajero de prueba',
        role: 'owner',
    });
}

beforeAll(async () => {
    await initTestDb();
});

afterAll(async () => {
    await sequelize.close();
});

describe('Rate limit del login (Bloque 6.5)', () => {

    test(`bloquea al usuario tras ${LOGIN_MAX_INTENTOS} intentos fallidos`, async () => {
        const username = 'bloqueable@test.com';
        await crearUsuario(username);

        for (let i = 0; i < LOGIN_MAX_INTENTOS; i++) {
            const res = await request(app)
                .post('/api/auth/login')
                .send({ username, password: 'incorrecta' });
            expect(res.status).toBe(401);
        }

        const bloqueado = await request(app)
            .post('/api/auth/login')
            .send({ username, password: 'incorrecta' });
        expect(bloqueado.status).toBe(429);
    }, 120000);

    test('bloquear a un usuario NO bloquea a otro desde la misma IP (el caso del local con varias cajas)', async () => {
        // El test anterior dejó 'bloqueable@test.com' agotado desde esta misma IP.
        const otro = 'companero@test.com';
        await crearUsuario(otro);

        const res = await request(app)
            .post('/api/auth/login')
            .send({ username: otro, password: 'incorrecta' });

        expect(res.status).toBe(401); // pasa el limitador: la cuenta es por IP + usuario
    }, 30000);

    test('los logins exitosos no consumen cupo', async () => {
        const username = 'trabajador@test.com';
        await crearUsuario(username);

        // Más entradas correctas que el límite: si contaran, el último sería 429.
        for (let i = 0; i < LOGIN_MAX_INTENTOS + 5; i++) {
            const res = await request(app)
                .post('/api/auth/login')
                .send({ username, password: PASSWORD });
            expect(res.status).toBe(200);
        }
    }, 120000);
});

describe('Sentry (Bloque 6.1)', () => {

    test('el SDK instalado expone setupExpressErrorHandler y ya NO expone Handlers', () => {
        const Sentry = require('@sentry/node');
        expect(typeof Sentry.setupExpressErrorHandler).toBe('function');
        expect(Sentry.Handlers).toBeUndefined();
    });

    test('server.js no usa la API eliminada (poner SENTRY_DSN no debe tumbar el arranque)', () => {
        expect(fuenteServer).not.toMatch(/Sentry\.Handlers/);
        expect(fuenteServer).toMatch(/Sentry\.setupExpressErrorHandler\(app\)/);
    });

    test('server.js carga instrument.js antes que Express', () => {
        const posInstrument = fuenteServer.indexOf("require('./instrument')");
        const posExpress = fuenteServer.indexOf("require('express')");
        expect(posInstrument).toBeGreaterThan(-1);
        expect(posInstrument).toBeLessThan(posExpress);
    });

    test('sin SENTRY_DSN el monitoreo queda apagado y no rompe nada', () => {
        const { sentryActivo } = require('../instrument');
        expect(sentryActivo).toBe(false); // los tests corren sin DSN
    });

    test('el evento sale saneado: sin contraseñas, PIN ni tokens', () => {
        const { sanitizarEventoSentry } = require('../instrument');

        const evento = sanitizarEventoSentry({
            request: {
                url: 'https://api/kds?token=abc123&branch=2',
                query_string: 'token=abc123&branch=2',
                data: { username: 'ana@test.com', password: 'secreta', anidado: { pin: '1234' } },
            },
        });

        expect(evento.request.data.password).toBe('[REDACTADO]');
        expect(evento.request.data.anidado.pin).toBe('[REDACTADO]');
        expect(evento.request.data.username).toBe('ana@test.com'); // lo no sensible se conserva
        expect(evento.request.query_string).not.toContain('abc123');
        expect(evento.request.url).not.toContain('abc123');
        expect(evento.request.url).toContain('branch=2');
    });

    test('un body de texto no parseable se omite entero en vez de arriesgar una fuga', () => {
        const { sanitizarEventoSentry } = require('../instrument');
        const evento = sanitizarEventoSentry({ request: { data: 'password=secreta&x=1' } });
        expect(evento.request.data).toBe('[OMITIDO]');
    });
});

describe('Puente logger → Sentry (Bloque 6.1)', () => {

    const { conectarASentry } = require('../utils/logger');

    function loggerFalso() {
        const escritos = [];
        return { escritos, error: (m, meta) => escritos.push([m, meta]) };
    }

    test('un error atrapado por una ruta (logger.error) llega a Sentry', () => {
        const sentry = { captureException: jest.fn(), captureMessage: jest.fn() };
        const log = conectarASentry(loggerFalso(), sentry);
        const fallo = new Error('la base no responde');

        log.error('Error al obtener empleados:', fallo);

        expect(sentry.captureException).toHaveBeenCalledWith(fallo);
        expect(log.escritos).toHaveLength(1); // y se sigue escribiendo en los logs
    });

    test('un error sin objeto Error se manda como mensaje, no se pierde', () => {
        const sentry = { captureException: jest.fn(), captureMessage: jest.fn() };
        const log = conectarASentry(loggerFalso(), sentry);

        log.error('POST /api/orders → algo salió mal', { stack: '...' });

        expect(sentry.captureMessage).toHaveBeenCalled();
        expect(sentry.captureException).not.toHaveBeenCalled();
    });

    test('si Sentry falla, el log se escribe igual', () => {
        const sentry = { captureException: () => { throw new Error('sentry caído'); }, captureMessage: jest.fn() };
        const log = conectarASentry(loggerFalso(), sentry);

        expect(() => log.error('x', new Error('y'))).not.toThrow();
        expect(log.escritos).toHaveLength(1);
    });
});

describe('Operación del piloto (Bloque 6.6)', () => {

    // Este test afirmaba que el pase del KDS duraba 12 h ("no lo bajes: obliga a
    // re-escanear el QR en hora pico"). El BLOQUE 13 fue más lejos y lo ELIMINÓ:
    // la seguridad ya no la da la vida del pase sino el dispositivo aprobado y
    // revocable. Lo que hay que vigilar ahora es que nadie vuelva a meter una
    // credencial en la URL del KDS — que es como nació la llave maestra del §19.13.
    test('la pantalla de cocina ya no se abre con un pase que caduca (BLOQUE 13)', () => {
        expect(fuenteServer).not.toMatch(/purpose: 'kds'/);
        expect(fuenteServer).not.toMatch(/\/api\/kds\/token/);
        expect(fuenteServer).toMatch(/app\.use\('\/api\/kds'/);
    });

    test('/health consulta la base y responde 503 si está caída (sirve para el monitor externo)', () => {
        expect(fuenteServer).toMatch(/app\.get\('\/health'/);
        expect(fuenteServer).toMatch(/status: 'error', database: 'disconnected'/);
    });
});
