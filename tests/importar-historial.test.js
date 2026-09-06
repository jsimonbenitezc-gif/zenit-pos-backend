/**
 * IMPORTAR EL HISTORIAL DE UN NEGOCIO SIN CUENTA (BLOQUE 18, Etapa 3).
 *
 * Un negocio que venía usando la app SIN CUENTA crea su cuenta y se lleva todo:
 * catálogo, clientes y **sus meses de ventas**. Esas ventas suben por el camino
 * de venta diferida del §26 (`client_uuid` + `sold_at`), que ya existía.
 *
 * El problema que obligó a tocar el backend: `MAXIMO_ATRASO_MS` son **30 días**.
 * Una venta más vieja perdía su fecha — y con ella `esVentaDiferida`, así que
 * perdía TAMBIÉN el precio y el impuesto congelados. Migrar tres meses producía
 * un historial fechado hoy y con los precios de hoy: ficción.
 *
 * Lo que se prueba:
 *   1. Sin la marca, nada cambia (la guarda del §38.6 sigue en pie).
 *   2. Con la marca, una venta de hace meses conserva fecha, precio e impuesto.
 *   3. 🔴 La marca es SOLO del dueño: un empleado no puede backdatar ventas.
 *   4. Los topes que no se relajan: nada del futuro, nada de hace tres años.
 *   5. Reintentar la migración no duplica (idempotencia por `client_uuid`).
 */
jest.mock('../utils/push', () => ({
    enviarNotificacion: jest.fn(),
    getPrefs: jest.fn().mockResolvedValue({}),
}));

const request = require('supertest');
const { app, sequelize, models, initTestDb, createTestOwner } = require('./setup');
const {
    resolverFechaVenta, MAXIMO_ATRASO_MS, MAXIMO_ATRASO_IMPORTACION_MS,
} = require('../utils/ventaOffline');

let owner, ownerToken, empleado, empleadoToken, categoria, producto;
const auth = (token) => ({ Authorization: `Bearer ${token}` });

const haceDias = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

/** Una venta como la que arma la migración: uuid propio + su hora real. */
function ventaHistorica({ dias, uuid, precio = 24.5, cantidad = 2, importar = true }) {
    return {
        client_uuid: uuid,
        sold_at: haceDias(dias).toISOString(),
        ...(importar ? { import_historico: true } : {}),
        payment_method: 'efectivo',
        skip_stock_check: true,
        items: [{ product_id: producto.id, quantity: cantidad, unit_price: precio }],
    };
}

const crear = (token, body) => request(app).post('/api/orders').set(auth(token)).send(body);

beforeAll(async () => {
    await initTestDb();
    const r = await createTestOwner();
    owner = r.user;
    ownerToken = r.token;
    categoria = await models.Category.create({ name: 'Tacos', business_id: owner.id });

    // Un empleado del MISMO negocio: es quien no debe poder usar la marca.
    const jwt = require('jsonwebtoken');
    empleado = await models.User.create({
        username: 'cajero_import@test.com', password: 'TestPass123',
        name: 'Cajero', role: 'cashier', business_id: owner.id, active: true,
    });
    empleadoToken = jwt.sign(
        { id: empleado.id, username: empleado.username, role: 'cashier', business_id: owner.id },
        process.env.JWT_SECRET, { expiresIn: '1d' }
    );
});

afterAll(async () => { await sequelize.close(); });

beforeEach(async () => {
    await models.OrderItem.destroy({ where: {} });
    await models.Order.destroy({ where: {} });
    await models.Product.destroy({ where: {} });
    // El precio de HOY es 30: si la venta pierde su trato de diferida, el total
    // se recalcula con este número y la prueba lo nota.
    producto = await models.Product.create({
        name: 'Taco al pastor', price: 30, category_id: categoria.id, business_id: owner.id,
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1 y 2. La ventana
// ─────────────────────────────────────────────────────────────────────────────
describe('La ventana de atraso', () => {
    test('SIN la marca, una venta de hace 90 días pierde su fecha (como siempre)', async () => {
        const res = await crear(ownerToken, ventaHistorica({ dias: 90, uuid: 'sin-marca-1', importar: false }));
        expect(res.status).toBe(201);

        const pedido = await models.Order.findByPk(res.body.id);
        // Se guarda con la hora del servidor: hoy, no hace 90 días.
        const dias = (Date.now() - new Date(pedido.createdAt).getTime()) / 86400000;
        expect(dias).toBeLessThan(1);
        // Y al no ser diferida, el precio sale del catálogo: 2 × 30 = 60.
        expect(parseFloat(pedido.total)).toBeCloseTo(60, 2);
    });

    test('CON la marca, conserva su fecha real', async () => {
        const res = await crear(ownerToken, ventaHistorica({ dias: 90, uuid: 'con-marca-1' }));
        expect(res.status).toBe(201);

        const pedido = await models.Order.findByPk(res.body.id);
        const dias = (Date.now() - new Date(pedido.createdAt).getTime()) / 86400000;
        expect(dias).toBeGreaterThan(89);
        expect(dias).toBeLessThan(91);
    });

    test('CON la marca, conserva el PRECIO que de verdad cobró', async () => {
        // Se vendió a 24.50 aunque el catálogo diga 30 hoy: 2 × 24.50 = 49.
        const res = await crear(ownerToken, ventaHistorica({ dias: 120, uuid: 'con-marca-2' }));
        expect(res.status).toBe(201);
        expect(parseFloat((await models.Order.findByPk(res.body.id)).total)).toBeCloseTo(49, 2);
    });

    test('una venta reciente no necesita la marca para nada', async () => {
        const res = await crear(ownerToken, ventaHistorica({ dias: 3, uuid: 'reciente-1', importar: false }));
        expect(res.status).toBe(201);
        const pedido = await models.Order.findByPk(res.body.id);
        const dias = (Date.now() - new Date(pedido.createdAt).getTime()) / 86400000;
        expect(dias).toBeGreaterThan(2.5);
        expect(parseFloat(pedido.total)).toBeCloseTo(49, 2);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. 🔴 LA PUERTA ES SOLO DEL DUEÑO
// ─────────────────────────────────────────────────────────────────────────────
describe('Quién puede importar', () => {
    test('un EMPLEADO no puede backdatar una venta aunque mande la marca', async () => {
        const res = await crear(empleadoToken, ventaHistorica({ dias: 90, uuid: 'empleado-1' }));
        expect(res.status).toBe(201);   // la venta se registra…

        // …pero con la hora del servidor: la marca se ignoró.
        const pedido = await models.Order.findByPk(res.body.id);
        const dias = (Date.now() - new Date(pedido.createdAt).getTime()) / 86400000;
        expect(dias).toBeLessThan(1);
    });

    test('y su venta RECIENTE sigue funcionando con normalidad', async () => {
        const res = await crear(empleadoToken, ventaHistorica({ dias: 2, uuid: 'empleado-2', importar: false }));
        expect(res.status).toBe(201);
        const dias = (Date.now() - new Date((await models.Order.findByPk(res.body.id)).createdAt).getTime()) / 86400000;
        expect(dias).toBeGreaterThan(1.5);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. LO QUE NO SE RELAJA
// ─────────────────────────────────────────────────────────────────────────────
describe('Los topes que siguen en pie', () => {
    test('ninguna venta se guarda en el FUTURO, ni importando', async () => {
        const dentroDeUnaHora = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        const res = await crear(ownerToken, {
            client_uuid: 'futura-1', sold_at: dentroDeUnaHora, import_historico: true,
            payment_method: 'efectivo', skip_stock_check: true,
            items: [{ product_id: producto.id, quantity: 1, unit_price: 24.5 }],
        });
        expect(res.status).toBe(201);
        expect(new Date((await models.Order.findByPk(res.body.id)).createdAt).getTime())
            .toBeLessThanOrEqual(Date.now() + 1000);
    });

    test('hace TRES AÑOS sigue siendo un reloj mal puesto, no un historial', () => {
        const hace3anios = new Date(Date.now() - 3 * 365 * 86400000);
        const r = resolverFechaVenta(hace3anios, new Date(), { atrasoMaximoMs: MAXIMO_ATRASO_IMPORTACION_MS });
        expect(r.motivo).toBe('antigua');
        expect(r.fecha).toBeNull();
    });

    test('la ventana por defecto no se movió', () => {
        expect(MAXIMO_ATRASO_MS).toBe(30 * 24 * 60 * 60 * 1000);
        const hace31 = haceDias(31);
        expect(resolverFechaVenta(hace31).motivo).toBe('antigua');
        expect(resolverFechaVenta(hace31, new Date(), { atrasoMaximoMs: MAXIMO_ATRASO_IMPORTACION_MS }).motivo).toBe('ok');
    });

    test('una opción basura cae a la ventana de siempre, no la abre', () => {
        const hace90 = haceDias(90);
        for (const malo of [0, -1, NaN, Infinity, 'mucho', null]) {
            expect(resolverFechaVenta(hace90, new Date(), { atrasoMaximoMs: malo }).motivo).toBe('antigua');
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. REINTENTAR NO DUPLICA — es lo que hace la migración reanudable
// ─────────────────────────────────────────────────────────────────────────────
describe('Reintentar la migración', () => {
    test('el mismo client_uuid no crea una segunda venta', async () => {
        const venta = ventaHistorica({ dias: 60, uuid: 'reintento-1' });
        const primera = await crear(ownerToken, venta);
        const segunda = await crear(ownerToken, venta);

        expect(primera.status).toBe(201);
        expect(segunda.body.id).toBe(primera.body.id);
        expect(await models.Order.count({ where: { client_uuid: 'reintento-1' } })).toBe(1);
    });
});
