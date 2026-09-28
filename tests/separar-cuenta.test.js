// ============================================================================
// PLAN_CUENTAS_V1 — Cobrar una mesa por partes (POST /api/orders/:id/separar)
//
// El mesero va comensal por comensal: "¿qué pagas tú?" → cobra → "¿y tú?".
// Cada parte cobrada es una VENTA APARTE ligada a la mesa (`parent_order_id`);
// la mesa sigue abierta con lo que queda. Lo que se cuida aquí:
//   · que la suma de las partes y el resto dé EXACTO lo que se le dijo a la mesa;
//   · que la caja cuadre (efectivo esperado, propina de la parte);
//   · que el inventario NO se mueva (ya se descontó al agregar a la mesa);
//   · la tasa CONGELADA de la mesa, no la de hoy;
//   · una promo sale entera; un reintento no separa dos veces.
// ============================================================================
jest.mock('../utils/push', () => ({
    enviarNotificacion: jest.fn(),
    getPrefs: jest.fn().mockResolvedValue({}),
}));

const request = require('supertest');
const { app, sequelize, models, initTestDb, createTestOwner } = require('./setup');
const { limpiarCacheImpuestos } = require('../utils/impuestos');
const { invalidarPropinasNegocio } = require('../utils/propinas');

let owner, token, cerveza, pastor, arrachera, dosPorUno;
let mesaN = 0, uuidN = 0;
const auth = () => ({ Authorization: `Bearer ${token}` });
const uuid = () => `55555555-5555-4555-8555-${String(++uuidN).padStart(12, '0')}`;
const num = (v) => parseFloat(v);

async function ajustes(cambios) {
    await owner.reload();
    const s = JSON.parse(owner.settings || '{}');
    await owner.update({ settings: JSON.stringify({ ...s, ...cambios }) });
    limpiarCacheImpuestos();
    invalidarPropinasNegocio(owner.id);
}

async function abrirMesa(items) {
    const mesa = await models.Table.create({ name: `M${++mesaN}`, business_id: owner.id });
    const abierta = await request(app).post('/api/orders').set(auth()).send({ table_id: mesa.id, items: [] });
    expect(abierta.status).toBe(201);
    const con = await request(app).post(`/api/orders/${abierta.body.id}/items`).set(auth())
        .send({ items, client_uuid: uuid() });
    expect(con.status).toBe(200);
    return { mesa, pedido: con.body };
}

const separar = (id, body) => request(app).post(`/api/orders/${id}/separar`).set(auth())
    .send({ client_uuid: uuid(), ...body });

const promo2x1 = () => ({
    promo_id: dosPorUno.id,
    productos: [{ product_id: pastor.id }, { product_id: arrachera.id }],
});

beforeAll(async () => {
    await initTestDb();
    const r = await createTestOwner({ settings: JSON.stringify({ tz: 'America/Mexico_City' }) });
    owner = r.user;
    token = r.token;
    const tacos = await models.Category.create({ name: 'Tacos', business_id: owner.id });
    // Cerveza con existencias por unidades (sin receta): la mesa las descuenta al agregar.
    cerveza = await models.Product.create({ name: 'Cerveza', price: 40, stock: 20, business_id: owner.id });
    pastor = await models.Product.create({ name: 'Pastor', price: 25, category_id: tacos.id, business_id: owner.id });
    arrachera = await models.Product.create({ name: 'Arrachera', price: 35, category_id: tacos.id, business_id: owner.id });
    const c = await request(app).post('/api/offers/combos').set(auth())
        .send({ name: '2x1 Tacos', tipo: 'regalar_mas_barato', paga: 1 });
    const it = await request(app).post(`/api/offers/combos/${c.body.id}/items`).set(auth())
        .send({ items: [{ category_id: tacos.id, quantity: 2 }] });
    dosPorUno = it.body;
});

afterAll(async () => { await sequelize.close(); });

beforeEach(async () => {
    await ajustes({ tax_enabled: true, tax_rate: 16, tax_included: false, propinas_activas: true });
});

describe('El caso real: una mesa cobrada en 3 partes', () => {
    test('3 cervezas + 2x1 con IVA agregado → 1 cerveza, la promo, el resto: todo cuadra', async () => {
        const turno = await request(app).post('/api/turnos').set(auth())
            .send({ cajero_nombre: 'Ana', fondo_inicial: 500 });
        expect(turno.status).toBe(201);

        const { mesa, pedido } = await abrirMesa([{ product_id: cerveza.id, quantity: 3 }, promo2x1()]);
        // Base 120 + 35 = 155 · IVA 24.80 · total 179.80
        expect(num(pedido.total)).toBe(179.8);
        const stockTrasAgregar = (await models.Product.findByPk(cerveza.id)).stock;

        const cervezaRenglon = pedido.items.find(i => i.product_id === cerveza.id);
        const uno = await separar(pedido.id, {
            items: [{ item_id: cervezaRenglon.id, quantity: 1 }],
            payment_method: 'efectivo', tip_amount: 10,
        });
        expect(uno.status).toBe(201);
        expect(num(uno.body.parte.total)).toBe(46.4);
        expect(num(uno.body.parte.tax_amount)).toBe(6.4);
        expect(num(uno.body.parte.tip_amount)).toBe(10);
        expect(uno.body.parte.status).toBe('completado');
        expect(uno.body.parte.paid_at).toBeTruthy();
        expect(uno.body.parte.parent_order_id).toBe(pedido.id);
        expect(uno.body.parte.table_id).toBe(mesa.id);
        expect(uno.body.parte.items).toHaveLength(1);
        expect(uno.body.parte.items[0].quantity).toBe(1);
        expect(num(uno.body.mesa.total)).toBe(133.4);
        expect(uno.body.mesa.status).toBe('registrado');
        expect(uno.body.mesa.paid_at).toBeNull();
        const quedan = uno.body.mesa.items.find(i => i.id === cervezaRenglon.id);
        expect(quedan.quantity).toBe(2);
        expect(num(quedan.subtotal)).toBe(80);
        expect(uno.body.partes).toHaveLength(1);

        // La promo: se elige UN taco y sale el 2x1 entero.
        const unTaco = uno.body.mesa.items.find(i => i.product_id === pastor.id);
        const dos = await separar(pedido.id, {
            items: [{ item_id: unTaco.id }], payment_method: 'tarjeta',
        });
        expect(dos.status).toBe(201);
        expect(dos.body.parte.items).toHaveLength(2);
        expect(num(dos.body.parte.total)).toBe(40.6);
        expect(num(dos.body.mesa.total)).toBe(92.8);
        expect(dos.body.mesa.items).toHaveLength(1);
        expect(dos.body.partes).toHaveLength(2);

        // "Ya pagaron" en la lista de mesas.
        const mesas = await request(app).get('/api/tables').set(auth());
        const laMesa = mesas.body.find(m => m.id === mesa.id);
        expect(laMesa.open_order.partes.map(p => num(p.total))).toEqual([46.4, 40.6]);

        // El resto, con el cobro de siempre.
        const resto = await request(app).put(`/api/orders/${pedido.id}/status`).set(auth())
            .send({ status: 'completado', payment_method: 'efectivo' });
        expect(resto.status).toBe(200);

        // La suma de las 3 ventas = el total original, al centavo.
        const ventas = await models.Order.findAll({ where: { business_id: owner.id, table_id: mesa.id } });
        const suma = ventas.reduce((s, o) => s + Math.round(num(o.total) * 100), 0) / 100;
        expect(suma).toBe(179.8);

        // El inventario no se movió al separar.
        expect((await models.Product.findByPk(cerveza.id)).stock).toBe(stockTrasAgregar);

        // La mesa quedó libre.
        const despues = await request(app).get('/api/tables').set(auth());
        expect(despues.body.find(m => m.id === mesa.id).open_order).toBeNull();

        // La caja: efectivo = 46.40 + 92.80; esperado = fondo + efectivo + propina en efectivo.
        const totales = await request(app).get(`/api/turnos/${turno.body.id}/totales`).set(auth());
        expect(totales.status).toBe(200);
        expect(totales.body.total_efectivo).toBe(139.2);
        expect(totales.body.total_tarjeta).toBe(40.6);
        expect(totales.body.efectivo_esperado).toBe(649.2);
        await request(app).put(`/api/turnos/${turno.body.id}/cerrar`).set(auth()).send({ efectivo_contado: 649.2 });
    });

    test('la parte deja rastro en auditoría', async () => {
        const { pedido } = await abrirMesa([{ product_id: cerveza.id, quantity: 2 }]);
        const r = await separar(pedido.id, { items: [{ item_id: pedido.items[0].id, quantity: 1 }], payment_method: 'efectivo' });
        expect(r.status).toBe(201);
        const log = await models.PrivilegedActionLog.findOne({
            where: { business_id: owner.id, action_type: 'separar_cuenta', target_description: `Pedido #${pedido.id}` },
        });
        expect(log).toBeTruthy();
        expect(JSON.parse(log.after_data).cobrado).toBe(46.4);
        expect(JSON.parse(log.before_data).productos).toMatch(/1 × Cerveza/);
    });

    test('la cocina no ve la parte como pedido nuevo', async () => {
        const { pedido } = await abrirMesa([{ product_id: cerveza.id, quantity: 2 }]);
        const r = await separar(pedido.id, { items: [{ item_id: pedido.items[0].id, quantity: 1 }], payment_method: 'efectivo' });
        const kds = await request(app).get('/api/orders?status=registrado&limit=200').set(auth());
        const ids = (kds.body.data || kds.body).map(o => o.id);
        expect(ids).toContain(pedido.id);
        expect(ids).not.toContain(r.body.parte.id);
    });
});

describe('Dinero', () => {
    test('🔴 la tasa CONGELADA de la mesa, no la de hoy', async () => {
        const { pedido } = await abrirMesa([{ product_id: cerveza.id, quantity: 2 }]);   // 16%: 92.80
        await ajustes({ tax_rate: 8 });
        const r = await separar(pedido.id, { items: [{ item_id: pedido.items[0].id, quantity: 1 }], payment_method: 'efectivo' });
        expect(r.status).toBe(201);
        expect(num(r.body.parte.tax_rate)).toBe(16);
        expect(num(r.body.parte.total)).toBe(46.4);
        expect(num(r.body.mesa.total)).toBe(46.4);
    });

    test('IVA incluido: la parte es su precio y la suma es exacta', async () => {
        await ajustes({ tax_included: true });
        const { pedido } = await abrirMesa([{ product_id: cerveza.id, quantity: 3 }]);   // 120 con IVA dentro
        const r = await separar(pedido.id, { items: [{ item_id: pedido.items[0].id, quantity: 1 }], payment_method: 'efectivo' });
        expect(num(r.body.parte.total)).toBe(40);
        expect(num(r.body.mesa.total)).toBe(80);
        const m = r.body.mesa, p = r.body.parte;
        expect(Math.round((num(m.subtotal) + num(m.tax_amount)) * 100)).toBe(Math.round(num(m.total) * 100));
        expect(Math.round((num(p.subtotal) + num(p.tax_amount)) * 100)).toBe(Math.round(num(p.total) * 100));
    });

    test('centavos: la suma de las partes da exacto aunque el IVA redondee', async () => {
        const raro = await models.Product.create({ name: 'Raro', price: 10.33, business_id: owner.id });
        const { pedido } = await abrirMesa([{ product_id: raro.id, quantity: 3 }]);
        const totalMesa = Math.round(num(pedido.total) * 100);
        const a = await separar(pedido.id, { items: [{ item_id: pedido.items[0].id, quantity: 1 }], payment_method: 'efectivo' });
        const b = await separar(pedido.id, { items: [{ item_id: pedido.items[0].id, quantity: 1 }], payment_method: 'efectivo' });
        expect(b.status).toBe(201);
        const suma = Math.round(num(a.body.parte.total) * 100) + Math.round(num(b.body.parte.total) * 100)
            + Math.round(num(b.body.mesa.total) * 100);
        expect(suma).toBe(totalMesa);
    });

    test('pago dividido dentro de una parte (mitad efectivo, mitad tarjeta)', async () => {
        const { pedido } = await abrirMesa([{ product_id: cerveza.id, quantity: 2 }]);
        const r = await separar(pedido.id, {
            items: [{ item_id: pedido.items[0].id, quantity: 1 }],
            payments: [{ method: 'efectivo', amount: 20 }, { method: 'tarjeta', amount: 26.4 }],
        });
        expect(r.status).toBe(201);
        expect(r.body.parte.payment_method).toBe('multiple');
        expect(r.body.parte.payments).toHaveLength(2);
    });

    test('un reparto que no cuadra con la parte → 400 y no se separa nada', async () => {
        const { pedido } = await abrirMesa([{ product_id: cerveza.id, quantity: 2 }]);
        const r = await separar(pedido.id, {
            items: [{ item_id: pedido.items[0].id, quantity: 1 }],
            payments: [{ method: 'efectivo', amount: 10 }],
        });
        expect(r.status).toBe(400);
        const mesa = await models.Order.findByPk(pedido.id);
        expect(num(mesa.total)).toBe(92.8);
        expect(await models.Order.count({ where: { parent_order_id: pedido.id } })).toBe(0);
    });
});

describe('Reglas', () => {
    test('elegir TODA la cuenta → 400 "usa Cobrar"', async () => {
        const { pedido } = await abrirMesa([{ product_id: cerveza.id, quantity: 2 }]);
        const r = await separar(pedido.id, { items: [{ item_id: pedido.items[0].id }], payment_method: 'efectivo' });
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('ES_TODA_LA_CUENTA');
    });

    test('la promo sola en la mesa es TODA la cuenta', async () => {
        const { pedido } = await abrirMesa([promo2x1()]);
        const r = await separar(pedido.id, { items: [{ item_id: pedido.items[0].id }], payment_method: 'efectivo' });
        expect(r.body.code).toBe('ES_TODA_LA_CUENTA');
    });

    test('cantidad de más, o un renglón de otra mesa → 400', async () => {
        const { pedido } = await abrirMesa([{ product_id: cerveza.id, quantity: 2 }]);
        const otra = await abrirMesa([{ product_id: cerveza.id, quantity: 2 }]);
        const deMas = await separar(pedido.id, { items: [{ item_id: pedido.items[0].id, quantity: 3 }], payment_method: 'efectivo' });
        expect(deMas.status).toBe(400);
        const ajeno = await separar(pedido.id, { items: [{ item_id: otra.pedido.items[0].id, quantity: 1 }], payment_method: 'efectivo' });
        expect(ajeno.status).toBe(400);
    });

    test('sin forma de pago o sin productos → 400', async () => {
        const { pedido } = await abrirMesa([{ product_id: cerveza.id, quantity: 2 }]);
        expect((await separar(pedido.id, { items: [{ item_id: pedido.items[0].id, quantity: 1 }] })).status).toBe(400);
        expect((await separar(pedido.id, { items: [], payment_method: 'efectivo' })).status).toBe(400);
    });

    test('una mesa ya cobrada → 409', async () => {
        const { pedido } = await abrirMesa([{ product_id: cerveza.id, quantity: 2 }]);
        await request(app).put(`/api/orders/${pedido.id}/status`).set(auth())
            .send({ status: 'completado', payment_method: 'efectivo' });
        const r = await separar(pedido.id, { items: [{ item_id: pedido.items[0].id, quantity: 1 }], payment_method: 'efectivo' });
        expect(r.status).toBe(409);
        expect(r.body.code).toBe('MESA_NO_ABIERTA');
    });

    test('una venta de mostrador no se separa → 409', async () => {
        const v = await request(app).post('/api/orders').set(auth())
            .send({ items: [{ product_id: pastor.id, quantity: 2 }], payment_method: 'efectivo', skip_stock_check: true });
        const r = await separar(v.body.id, { items: [{ item_id: v.body.items[0].id, quantity: 1 }], payment_method: 'efectivo' });
        expect(r.status).toBe(409);
    });

    test('una mesa con descuento → 409 (no se reparte)', async () => {
        const { pedido } = await abrirMesa([{ product_id: cerveza.id, quantity: 2 }]);
        await models.Order.update({ discount_amount: 5 }, { where: { id: pedido.id } });
        const r = await separar(pedido.id, { items: [{ item_id: pedido.items[0].id, quantity: 1 }], payment_method: 'efectivo' });
        expect(r.status).toBe(409);
        expect(r.body.code).toBe('MESA_CON_DESCUENTO');
    });

    test('otro negocio no puede separar mi mesa → 404', async () => {
        const { pedido } = await abrirMesa([{ product_id: cerveza.id, quantity: 2 }]);
        const otro = await createTestOwner({ username: 'otro_separar', email: 'otro_separar@test.com' });
        const r = await request(app).post(`/api/orders/${pedido.id}/separar`)
            .set({ Authorization: `Bearer ${otro.token}` })
            .send({ items: [{ item_id: pedido.items[0].id, quantity: 1 }], payment_method: 'efectivo' });
        expect(r.status).toBe(404);
    });

    test('🔴 el mismo cobro repetido (reintento) no separa dos veces', async () => {
        const { pedido } = await abrirMesa([{ product_id: cerveza.id, quantity: 3 }]);
        const body = { client_uuid: uuid(), items: [{ item_id: pedido.items[0].id, quantity: 1 }], payment_method: 'efectivo' };
        const a = await separar(pedido.id, body);
        const b = await separar(pedido.id, body);
        expect(a.status).toBe(201);
        expect(b.status).toBe(200);
        expect(b.body.parte.id).toBe(a.body.parte.id);
        expect(num(b.body.mesa.total)).toBe(92.8);
        expect(await models.Order.count({ where: { parent_order_id: pedido.id } })).toBe(1);
    });
});
