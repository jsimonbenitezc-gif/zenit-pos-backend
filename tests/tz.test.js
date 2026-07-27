jest.mock('../utils/push', () => ({
    enviarNotificacion: jest.fn(),
    getPrefs: jest.fn().mockResolvedValue({}),
}));

const request = require('supertest');
const { app, sequelize, models, initTestDb, createTestOwner } = require('./setup');
const {
    zonaValida, normalizarZona, ZONA_DEFAULT,
    horaLocal, diaSemanaLocal, inicioDiaLocal, inicioDiaLocalISO,
    zonaDelNegocio, invalidarZonaNegocio,
} = require('../utils/tz');

const TZ_MX = 'America/Mexico_City'; // UTC-6, sin horario de verano desde 2022

let owner, ownerToken, product;

beforeAll(async () => {
    await initTestDb();
    const result = await createTestOwner({ settings: JSON.stringify({ tz: TZ_MX }) });
    owner = result.user;
    ownerToken = result.token;

    const category = await models.Category.create({ name: 'Comida', business_id: owner.id });
    product = await models.Product.create({
        name: 'Taco', price: 30.00, category_id: category.id, business_id: owner.id,
    });
    invalidarZonaNegocio(owner.id);
});

afterAll(async () => {
    await sequelize.close();
});

describe('Bloque 2 — utils/tz: validación de zonas', () => {
    test('acepta zonas IANA reales', () => {
        expect(zonaValida(TZ_MX)).toBe(true);
        expect(zonaValida('UTC')).toBe(true);
        expect(zonaValida('America/Bogota')).toBe(true);
    });

    test('rechaza basura y cualquier intento de inyección SQL', () => {
        expect(zonaValida('')).toBe(false);
        expect(zonaValida('No/Existe')).toBe(false);
        expect(zonaValida("UTC'; DROP TABLE orders; --")).toBe(false);
        expect(zonaValida(null)).toBe(false);
        expect(zonaValida(123)).toBe(false);
    });

    test('normalizarZona cae en la default si el valor no sirve', () => {
        expect(normalizarZona('Mars/Olympus')).toBe(ZONA_DEFAULT);
        expect(normalizarZona(undefined)).toBe(ZONA_DEFAULT);
        expect(normalizarZona(TZ_MX)).toBe(TZ_MX);
    });
});

describe('Bloque 2 — utils/tz: cortes de día en hora local', () => {
    test('inicio del día local es la medianoche local, no la UTC', () => {
        // 24-jul 03:30 UTC = 23-jul 21:30 en México → su día empieza el 23-jul 06:00 UTC
        const inicio = inicioDiaLocal(TZ_MX, new Date('2026-07-24T03:30:00Z'));
        expect(inicio.toISOString()).toBe('2026-07-23T06:00:00.000Z');
    });

    test('desplazamiento de días respeta el calendario local', () => {
        const ref = new Date('2026-07-24T18:00:00Z'); // 24-jul 12:00 local
        expect(inicioDiaLocal(TZ_MX, ref, 0).toISOString()).toBe('2026-07-24T06:00:00.000Z');
        expect(inicioDiaLocal(TZ_MX, ref, -1).toISOString()).toBe('2026-07-23T06:00:00.000Z');
        expect(inicioDiaLocal(TZ_MX, ref, -6).toISOString()).toBe('2026-07-18T06:00:00.000Z');
    });

    test('cruza cambios de mes y de año sin corromper la fecha', () => {
        const añoNuevo = new Date('2027-01-01T04:00:00Z'); // 31-dic 22:00 local
        expect(inicioDiaLocal(TZ_MX, añoNuevo).toISOString()).toBe('2026-12-31T06:00:00.000Z');
    });

    test('respeta el horario de verano donde existe', () => {
        // Nueva York: EDT (-4) en julio, EST (-5) en enero
        expect(inicioDiaLocal('America/New_York', new Date('2026-07-15T12:00:00Z')).toISOString())
            .toBe('2026-07-15T04:00:00.000Z');
        expect(inicioDiaLocal('America/New_York', new Date('2026-01-15T12:00:00Z')).toISOString())
            .toBe('2026-01-15T05:00:00.000Z');
    });

    test('inicioDiaLocalISO interpreta "YYYY-MM-DD" como día local', () => {
        expect(inicioDiaLocalISO(TZ_MX, '2026-07-24').toISOString()).toBe('2026-07-24T06:00:00.000Z');
        // +1 día = límite superior exclusivo del rango
        expect(inicioDiaLocalISO(TZ_MX, '2026-07-24', 1).toISOString()).toBe('2026-07-25T06:00:00.000Z');
        expect(inicioDiaLocalISO(TZ_MX, 'no-es-fecha')).toBeNull();
    });

    test('horaLocal y diaSemanaLocal usan la zona del negocio', () => {
        const instante = new Date('2026-07-24T03:30:00Z'); // viernes 24 UTC / jueves 23 21:30 en MX
        expect(horaLocal(TZ_MX, instante)).toBe(21);
        expect(horaLocal('UTC', instante)).toBe(3);
        expect(diaSemanaLocal(TZ_MX, instante)).toBe(4); // jueves
        expect(diaSemanaLocal('UTC', instante)).toBe(5); // viernes
    });
});

describe('Bloque 2 — la zona del negocio se guarda y se aplica', () => {
    test('zonaDelNegocio lee settings.tz del owner', async () => {
        expect(await zonaDelNegocio(owner.id)).toBe(TZ_MX);
    });

    test('PUT /api/settings guarda tz válida y rechaza inválida', async () => {
        const ok = await request(app)
            .put('/api/settings')
            .set('Authorization', `Bearer ${ownerToken}`)
            .send({ tz: 'America/Bogota' });
        expect(ok.status).toBe(200);
        expect(ok.body.tz).toBe('America/Bogota');
        expect(await zonaDelNegocio(owner.id)).toBe('America/Bogota');

        const mal = await request(app)
            .put('/api/settings')
            .set('Authorization', `Bearer ${ownerToken}`)
            .send({ tz: "UTC'; DROP TABLE orders; --" });
        expect(mal.status).toBe(400);

        // Dejar el negocio en México para el resto de las pruebas
        await request(app)
            .put('/api/settings')
            .set('Authorization', `Bearer ${ownerToken}`)
            .send({ tz: TZ_MX });
        expect(await zonaDelNegocio(owner.id)).toBe(TZ_MX);
    });

    test('POST /api/auth/register guarda la zona que manda el dispositivo', async () => {
        const res = await request(app)
            .post('/api/auth/register')
            .send({
                name: 'Negocio Bogotá',
                email: `tz_${Date.now()}@test.com`,
                password: 'TestPass123',
                tz: 'America/Bogota',
            });
        expect(res.status).toBe(201);
        expect(await zonaDelNegocio(res.body.user.id)).toBe('America/Bogota');
    });

    test('register sin tz (builds viejos) cae en la zona default', async () => {
        const res = await request(app)
            .post('/api/auth/register')
            .send({ name: 'Sin zona', email: `tz2_${Date.now()}@test.com`, password: 'TestPass123' });
        expect(res.status).toBe(201);
        expect(await zonaDelNegocio(res.body.user.id)).toBe(ZONA_DEFAULT);
    });
});

describe('Bloque 2 — el dashboard corta el día en hora local', () => {
    // Ventas alrededor de la medianoche local del negocio (México, UTC-6).
    // Con el corte viejo (medianoche UTC) la venta de las 21:30 locales caía en el
    // día SIGUIENTE y la del día anterior a las 19:00 locales caía en "hoy".
    beforeAll(async () => {
        await models.Order.destroy({ where: { business_id: owner.id } });

        const inicioHoyLocal = inicioDiaLocal(TZ_MX, new Date());

        // 1) Anoche 21:30 local → día de AYER local, pero ya día de HOY en UTC
        await models.Order.create({
            business_id: owner.id, total: 100, status: 'registrado', payment_method: 'efectivo',
            createdAt: new Date(inicioHoyLocal.getTime() - 2.5 * 3600 * 1000),
        });

        // 2) Hoy 02:00 local → día de HOY local, aún día de AYER en UTC
        await models.Order.create({
            business_id: owner.id, total: 250, status: 'registrado', payment_method: 'efectivo',
            createdAt: new Date(inicioHoyLocal.getTime() + 2 * 3600 * 1000),
        });

        invalidarZonaNegocio(owner.id);
    });

    test('ventas de hoy incluyen solo las del día LOCAL', async () => {
        const res = await request(app)
            .get('/api/stats/dashboard')
            .set('Authorization', `Bearer ${ownerToken}`);

        expect(res.status).toBe(200);
        expect(res.body.ventasHoy.total_pedidos).toBe(1);
        expect(res.body.ventasHoy.monto_total).toBe(250);
        // La venta de anoche cuenta como AYER, no como hoy
        expect(res.body.ventasAyer.total_pedidos).toBe(1);
        expect(res.body.ventasAyer.monto_total).toBe(100);
    });

    test('la gráfica de 7 días agrupa por fecha local', async () => {
        const res = await request(app)
            .get('/api/stats/dashboard')
            .set('Authorization', `Bearer ${ownerToken}`);

        expect(res.status).toBe(200);
        // Dos días locales distintos, aunque en UTC ambas ventas caen en el mismo día
        const fechas = res.body.ultimos7Dias.map(d => d.fecha);
        expect(new Set(fechas).size).toBe(2);
    });

    test('ventas por hora usa la hora local (21h y 2h, no 3h y 8h UTC)', async () => {
        const res = await request(app)
            .get('/api/stats/dashboard')
            .set('Authorization', `Bearer ${ownerToken}`);

        expect(res.status).toBe(200);
        // Solo la venta de hoy local entra en la gráfica del día
        expect(res.body.ventasPorHora.length).toBe(1);
        expect(Number(res.body.ventasPorHora[0].hora)).toBe(2);
    });

    test('/stats/sales con date_from/date_to cubre el día local completo', async () => {
        const p = new Intl.DateTimeFormat('en-CA', {
            timeZone: TZ_MX, year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(new Date());

        const res = await request(app)
            .get(`/api/stats/sales?group_by=day&date_from=${p}&date_to=${p}`)
            .set('Authorization', `Bearer ${ownerToken}`);

        expect(res.status).toBe(200);
        expect(res.body.length).toBe(1);
        expect(parseFloat(res.body[0].monto_total)).toBe(250);
    });
});
