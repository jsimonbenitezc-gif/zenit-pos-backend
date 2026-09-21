// ============================================================================
// PLAN_OFERTAS_V1 — BLOQUE 1: la cuenta COBRADA (`orders.paid_at`)
//
// En este sistema `completado` no quiere decir cobrado: la cocina también lo
// marca. Hacía falta una marca propia para dos cosas:
//  1. Una cuenta ya cobrada no cambia de forma de pago (quedaba abierto del
//     Bloque 0: pasar una mesa de efectivo a tarjeta, sin rastro).
//  2. La cocina del celular (KDSScreen) CERRABA mesas: su "Completado" dejaba la
//     mesa libre y la venta en el corte como efectivo que nadie cobró.
// ============================================================================
jest.mock('../utils/push', () => ({
    enviarNotificacion: jest.fn(),
    getPrefs: jest.fn().mockResolvedValue({}),
}));

const request = require('supertest');
const { app, sequelize, models, initTestDb, createTestOwner } = require('./setup');

let owner, token, taco, mesaN = 0;
const auth = () => ({ Authorization: `Bearer ${token}` });
const estado = (id, body) => request(app).put(`/api/orders/${id}/status`).set(auth()).send(body);

async function abrirMesaConTaco() {
    const mesa = await models.Table.create({ name: `M${++mesaN}`, business_id: owner.id });
    const abierta = await request(app).post('/api/orders').set(auth()).send({ table_id: mesa.id, items: [] });
    await request(app).post(`/api/orders/${abierta.body.id}/items`).set(auth())
        .send({ items: [{ product_id: taco.id, quantity: 2 }] });       // $100
    return { mesa, pedido: abierta.body };
}

beforeAll(async () => {
    await initTestDb();
    const r = await createTestOwner();
    owner = r.user;
    token = r.token;
    taco = await models.Product.create({ name: 'Taco', price: 50, business_id: owner.id });
});

afterAll(async () => {
    await sequelize.close();
});

describe('La marca de cobrada', () => {
    test('una venta de mostrador nace cobrada', async () => {
        const res = await request(app).post('/api/orders').set(auth())
            .send({ items: [{ product_id: taco.id }], skip_stock_check: true });
        expect(res.status).toBe(201);
        expect(res.body.paid_at).toBeTruthy();
    });

    test('una venta diferida queda cobrada a su hora REAL', async () => {
        const hace = new Date(Date.now() - 2 * 3600 * 1000);
        const res = await request(app).post('/api/orders').set(auth()).send({
            items: [{ product_id: taco.id }], skip_stock_check: true,
            client_uuid: '44444444-4444-4444-8444-000000000001', sold_at: hace.toISOString(),
        });
        expect(res.status).toBe(201);
        expect(new Date(res.body.paid_at).getTime()).toBe(hace.getTime());
    });

    test('una mesa nace SIN cobrar y queda cobrada al recibir su forma de pago', async () => {
        const { pedido } = await abrirMesaConTaco();
        const abierto = await models.Order.findByPk(pedido.id);
        expect(abierto.paid_at).toBeNull();
        const res = await estado(pedido.id, { status: 'completado', payment_method: 'tarjeta' });
        expect(res.status).toBe(200);
        expect(res.body.paid_at).toBeTruthy();
        expect(res.body.payment_method).toBe('tarjeta');
    });
});

describe('🔴 Una cuenta cobrada no cambia de forma de pago', () => {
    test('el mismo cobro repetido (reintento) pasa sin tocar nada', async () => {
        const { pedido } = await abrirMesaConTaco();
        const primero = await estado(pedido.id, { status: 'completado', payment_method: 'efectivo', tip_amount: 0 });
        const repetido = await estado(pedido.id, { status: 'completado', payment_method: 'efectivo', tip_amount: 0 });
        expect(repetido.status).toBe(200);
        expect(repetido.body.paid_at).toBe(primero.body.paid_at);
    });

    test('de efectivo a tarjeta → 400 y queda en efectivo', async () => {
        const { pedido } = await abrirMesaConTaco();
        await estado(pedido.id, { status: 'completado', payment_method: 'efectivo' });
        const res = await estado(pedido.id, { status: 'completado', payment_method: 'tarjeta' });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('CUENTA_YA_COBRADA');
        expect((await models.Order.findByPk(pedido.id)).payment_method).toBe('efectivo');
    });

    test('dividirla después de cobrada → 400', async () => {
        const { pedido } = await abrirMesaConTaco();
        await estado(pedido.id, { status: 'completado', payment_method: 'efectivo' });
        const res = await estado(pedido.id, {
            status: 'completado',
            payments: [{ method: 'efectivo', amount: 50 }, { method: 'tarjeta', amount: 50 }],
        });
        expect(res.status).toBe(400);
        expect(await models.OrderPayment.count({ where: { order_id: pedido.id } })).toBe(0);
    });

    test('pasar de completado a entregado (sin forma de pago) sigue valiendo', async () => {
        const { pedido } = await abrirMesaConTaco();
        await estado(pedido.id, { status: 'completado', payment_method: 'efectivo' });
        const res = await estado(pedido.id, { status: 'entregado' });
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('entregado');
    });
});

describe('🔴 La cocina no cierra mesas', () => {
    test('"Completado" sin forma de pago deja la mesa ABIERTA y fuera del corte', async () => {
        const { mesa, pedido } = await abrirMesaConTaco();
        const res = await estado(pedido.id, { status: 'completado' });
        expect(res.status).toBe(200);
        expect(res.body.mesa_sigue_abierta).toBe(true);
        expect(res.body.status).toBe('registrado');

        // La mesa se sigue viendo ocupada, y se puede cobrar después.
        const mesas = await request(app).get('/api/tables').set(auth());
        const m = mesas.body.find(x => x.id === mesa.id);
        expect(m.open_order && m.open_order.id).toBe(pedido.id);
        const cobro = await estado(pedido.id, { status: 'completado', payment_method: 'tarjeta' });
        expect(cobro.status).toBe(200);
        expect(cobro.body.status).toBe('completado');
    });

    test('la cocina SÍ puede marcar una venta de mostrador (ya está cobrada)', async () => {
        const v = await request(app).post('/api/orders').set(auth())
            .send({ items: [{ product_id: taco.id }], skip_stock_check: true });
        const res = await estado(v.body.id, { status: 'completado' });
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('completado');
    });

    test('cancelar una mesa abierta sigue funcionando', async () => {
        const { pedido } = await abrirMesaConTaco();
        const res = await estado(pedido.id, { status: 'cancelado', role: 'dueno' });
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('cancelado');
    });

    test('la ruta genérica tampoco cierra una mesa sin cobrar', async () => {
        const { pedido } = await abrirMesaConTaco();
        const res = await request(app).put(`/api/orders/${pedido.id}`).set(auth()).send({ status: 'completado' });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('MESA_SIN_COBRAR');
    });
});
