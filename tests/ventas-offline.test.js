jest.mock('../utils/push', () => ({
    enviarNotificacion: jest.fn(),
    getPrefs: jest.fn().mockResolvedValue({}),
}));

const request = require('supertest');
const { app, sequelize, models, initTestDb, createTestOwner } = require('./setup');
const { resolverFechaVenta, resolverPrecioUnitario } = require('../utils/ventaOffline');

let owner, token, product;

let contador = 0;
const uuid = () => `11111111-1111-4111-8111-${String(++contador).padStart(12, '0')}`;

function venta(body = {}) {
    return request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${token}`)
        .send({ items: [{ product_id: product.id, quantity: 1 }], skip_stock_check: true, ...body });
}

beforeAll(async () => {
    await initTestDb();
    const result = await createTestOwner();
    owner = result.user;
    token = result.token;

    const category = await models.Category.create({ name: 'Comida', business_id: owner.id });
    product = await models.Product.create({
        name: 'Taco', price: 30.00, category_id: category.id, business_id: owner.id,
    });
});

afterEach(async () => {
    await models.OrderItem.destroy({ where: {} });
    await models.Order.destroy({ where: {} });
    await models.PrivilegedActionLog.destroy({ where: {} });
    await models.Table.destroy({ where: {} });
    await product.update({ price: 30.00 });
});

afterAll(async () => {
    await sequelize.close();
});

describe('Bloque 5 — Fidelidad de ventas offline', () => {

    // ── utils/ventaOffline: validación de la hora ────────────────────────────
    describe('resolverFechaVenta', () => {
        test('acepta una hora reciente en el pasado', () => {
            const hace2h = new Date(Date.now() - 2 * 60 * 60 * 1000);
            const { fecha, motivo } = resolverFechaVenta(hace2h.toISOString());
            expect(motivo).toBe('ok');
            expect(fecha.getTime()).toBe(hace2h.getTime());
        });

        test('descarta una hora del futuro (reloj adelantado)', () => {
            const enUnaHora = new Date(Date.now() + 60 * 60 * 1000);
            expect(resolverFechaVenta(enUnaHora.toISOString())).toEqual({ fecha: null, motivo: 'futura' });
        });

        test('tolera un desfase pequeño de reloj (1 minuto adelante) SIN guardar la venta en el futuro', () => {
            const ahora = new Date();
            const enUnMinuto = new Date(ahora.getTime() + 60 * 1000);
            const { fecha, motivo } = resolverFechaVenta(enUnMinuto.toISOString(), ahora);

            // La venta se ACEPTA: para eso existe la tolerancia (rechazarla la
            // dejaría atascada en la cola del POS para siempre).
            expect(fecha).not.toBeNull();
            // Pero NO se le cree la hora: se le fija la del servidor.
            expect(motivo).toBe('futura_ajustada');
            expect(fecha.getTime()).toBe(ahora.getTime());
        });

        test('ninguna venta se guarda con fecha en el futuro (el hueco del corte de caja)', () => {
            // REGRESIÓN. Una venta fechada por delante del reloj del servidor
            // aparecía en los totales del turno (`createdAt >= apertura`) y
            // desaparecía del cierre (`BETWEEN apertura AND ahora`), dejando un
            // sobrante fantasma con el dinero correcto en el cajón. Lo encontró
            // el banco de pruebas del BLOQUE 15. Ver CLAUDE.md §38.
            const ahora = new Date();
            for (const segundos of [1, 30, 90, 299]) {
                const adelantada = new Date(ahora.getTime() + segundos * 1000);
                const { fecha } = resolverFechaVenta(adelantada.toISOString(), ahora);
                expect(fecha.getTime()).toBeLessThanOrEqual(ahora.getTime());
            }
        });

        test('descarta una hora absurdamente vieja y un texto inválido', () => {
            const hace90dias = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
            expect(resolverFechaVenta(hace90dias.toISOString()).motivo).toBe('antigua');
            expect(resolverFechaVenta('ayer por la tarde').motivo).toBe('invalida');
            expect(resolverFechaVenta(null).motivo).toBe('ausente');
        });
    });

    // ── utils/ventaOffline: validación del precio ────────────────────────────
    describe('resolverPrecioUnitario', () => {
        test('venta normal (online): manda el catálogo aunque el cliente proponga otro', () => {
            expect(resolverPrecioUnitario(30, 5, false)).toEqual({ unitPrice: 30, origen: 'catalogo' });
        });

        test('venta diferida: se respeta el precio cobrado', () => {
            expect(resolverPrecioUnitario(35, 30, true)).toEqual({ unitPrice: 30, origen: 'cliente' });
        });

        test('precios imposibles caen al catálogo en vez de romper la venta', () => {
            for (const malo of [-5, 0, 'gratis', null, undefined, 99999999999]) {
                expect(resolverPrecioUnitario(30, malo, true)).toEqual({ unitPrice: 30, origen: 'catalogo' });
            }
        });
    });

    // ── Hora real de la venta ────────────────────────────────────────────────
    test('Venta offline con sold_at: se registra con SU hora, no con la de llegada', async () => {
        const ayer = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const res = await venta({ client_uuid: uuid(), sold_at: ayer.toISOString() });

        expect(res.status).toBe(201);
        const order = await models.Order.findByPk(res.body.id);
        expect(new Date(order.createdAt).getTime()).toBe(ayer.getTime());
        // updatedAt conserva la hora en que llegó al servidor: se puede saber
        // cuánto tiempo estuvo el equipo sin internet.
        expect(new Date(order.updatedAt).getTime()).toBeGreaterThan(ayer.getTime());
    });

    test('sold_at sin client_uuid se ignora (solo la cola offline declara su hora)', async () => {
        const ayer = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const res = await venta({ sold_at: ayer.toISOString() });

        expect(res.status).toBe(201);
        const order = await models.Order.findByPk(res.body.id);
        expect(new Date(order.createdAt).getTime()).toBeGreaterThan(ayer.getTime() + 60 * 1000);
    });

    test('sold_at inválido NO tumba la venta: se registra con la hora del servidor', async () => {
        const res = await venta({ client_uuid: uuid(), sold_at: new Date(Date.now() + 86400000).toISOString() });

        expect(res.status).toBe(201);
        const order = await models.Order.findByPk(res.body.id);
        expect(new Date(order.createdAt).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    });

    // ── Precio real cobrado ──────────────────────────────────────────────────
    test('El precio subió mientras el equipo estaba sin red: se cobra el precio viejo', async () => {
        const ayer = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
        await product.update({ price: 45.00 }); // el dueño subió el precio hoy

        const res = await venta({
            client_uuid: uuid(),
            sold_at: ayer,
            items: [{ product_id: product.id, quantity: 2, unit_price: 30 }],
        });

        expect(res.status).toBe(201);
        expect(parseFloat(res.body.total)).toBe(60);
        const items = await models.OrderItem.findAll({ where: { order_id: res.body.id } });
        expect(parseFloat(items[0].unit_price)).toBe(30);
    });

    test('Una venta ONLINE no puede imponer su precio (sigue mandando el catálogo)', async () => {
        const res = await venta({
            client_uuid: uuid(),
            items: [{ product_id: product.id, quantity: 1, unit_price: 1 }],
        });

        expect(res.status).toBe(201);
        expect(parseFloat(res.body.total)).toBe(30);
    });

    test('Un precio distinto al catálogo queda en la auditoría', async () => {
        const ayer = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
        const res = await venta({
            client_uuid: uuid(),
            sold_at: ayer,
            items: [{ product_id: product.id, quantity: 1, unit_price: 12 }],
        });

        expect(res.status).toBe(201);
        const log = await models.PrivilegedActionLog.findOne({ where: { action_type: 'offline_price' } });
        expect(log).not.toBeNull();
        expect(log.target_description).toBe(`Pedido #${res.body.id}`);
        const after = JSON.parse(log.after_data);
        expect(after.items[0]).toMatchObject({ producto: 'Taco', cobrado: 12, catalogo: 30 });
    });

    test('Precio igual al catálogo: no ensucia la auditoría', async () => {
        await venta({
            client_uuid: uuid(),
            sold_at: new Date(Date.now() - 3600000).toISOString(),
            items: [{ product_id: product.id, quantity: 1, unit_price: 30 }],
        });

        expect(await models.PrivilegedActionLog.count({ where: { action_type: 'offline_price' } })).toBe(0);
    });

    // ── Idempotencia de mesas ────────────────────────────────────────────────
    test('Doble tap al abrir una mesa con el mismo client_uuid no duplica el pedido', async () => {
        const mesa = await models.Table.create({ name: 'Mesa 1', business_id: owner.id });
        const u = uuid();

        const primera = await venta({ client_uuid: u, table_id: mesa.id, items: [] });
        const segunda = await venta({ client_uuid: u, table_id: mesa.id, items: [] });

        expect(primera.status).toBe(201);
        expect(segunda.status).toBe(200);
        expect(segunda.body.id).toBe(primera.body.id);
        expect(await models.Order.count({ where: { table_id: mesa.id } })).toBe(1);
    });

    test('Reenviar los productos de una mesa con el mismo uuid no los duplica', async () => {
        const mesa = await models.Table.create({ name: 'Mesa 2', business_id: owner.id });
        const pedido = await venta({ client_uuid: uuid(), table_id: mesa.id, items: [] });
        const u = uuid();

        const agregar = () => request(app)
            .post(`/api/orders/${pedido.body.id}/items`)
            .set('Authorization', `Bearer ${token}`)
            .send({ client_uuid: u, items: [{ product_id: product.id, quantity: 2 }] });

        const primera = await agregar();
        const segunda = await agregar();

        expect(primera.status).toBe(200);
        expect(segunda.status).toBe(200);
        expect(await models.OrderItem.count({ where: { order_id: pedido.body.id } })).toBe(1);
        const order = await models.Order.findByPk(pedido.body.id);
        expect(parseFloat(order.total)).toBe(60);
    });

    test('Sin client_uuid, agregar dos veces sí agrega dos veces (comportamiento previo)', async () => {
        const mesa = await models.Table.create({ name: 'Mesa 3', business_id: owner.id });
        const pedido = await venta({ client_uuid: uuid(), table_id: mesa.id, items: [] });

        const agregar = () => request(app)
            .post(`/api/orders/${pedido.body.id}/items`)
            .set('Authorization', `Bearer ${token}`)
            .send({ items: [{ product_id: product.id, quantity: 1 }] });

        await agregar();
        await agregar();

        expect(await models.OrderItem.count({ where: { order_id: pedido.body.id } })).toBe(2);
    });
});
