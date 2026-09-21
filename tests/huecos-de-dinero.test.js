// ============================================================================
// PLAN_OFERTAS_V1 — BLOQUE 0: los huecos de dinero que estaban en producción
//
//  1. Un descuento configurado solo servía para saltarse el PIN: el MONTO lo
//     decidía el cliente. Un 5% regalaba la cuenta entera.
//  2. Quitar un producto de una cuenta abierta no dejaba rastro.
//  3. PUT /orders/:id cambiaba la forma de pago de cualquier venta, sin rastro.
// ============================================================================
jest.mock('../utils/push', () => ({
    enviarNotificacion: jest.fn(),
    getPrefs: jest.fn().mockResolvedValue({}),
}));

const request = require('supertest');
const { app, sequelize, models, initTestDb, createTestOwner } = require('./setup');
const { descuentoVigente, montoMaximo, revisarDescuento } = require('../utils/descuentos');

let owner, token, taco;
let contador = 0;
const uuid = () => `22222222-2222-4222-8222-${String(++contador).padStart(12, '0')}`;
const auth = () => ({ Authorization: `Bearer ${token}` });

// Venta de mostrador: 2 tacos de $50 = $100 de base.
function vender(extra = {}) {
    return request(app)
        .post('/api/orders')
        .set(auth())
        .send({ items: [{ product_id: taco.id, quantity: 2 }], skip_stock_check: true, ...extra });
}

function logs(actionType, pedidoId) {
    return models.PrivilegedActionLog.findAll({
        where: { business_id: owner.id, action_type: actionType, target_description: `Pedido #${pedidoId}` },
    });
}

beforeAll(async () => {
    await initTestDb();
    const r = await createTestOwner();
    owner = r.user;
    token = r.token;
    const cat = await models.Category.create({ name: 'Tacos', business_id: owner.id });
    taco = await models.Product.create({ name: 'Taco', price: 50, category_id: cat.id, business_id: owner.id });
});

afterAll(async () => {
    await sequelize.close();
});

// ── La regla, sola ──────────────────────────────────────────────────────────
describe('utils/descuentos', () => {
    const pct = (value, extra = {}) => ({ type: 'percentage', value, active: true, ...extra });

    test('porcentaje sobre la base, a centavos; fijo topado a la base', () => {
        expect(montoMaximo(pct(5), 100)).toBe(5);
        expect(montoMaximo(pct(10), 33.33)).toBe(3.33);
        expect(montoMaximo({ type: 'fixed', value: 80 }, 50)).toBe(50);
    });

    test('un centavo de holgura (el desktop no redondea antes de guardar)', () => {
        expect(revisarDescuento(pct(10), 3.34, 33.33).ok).toBe(true);
        expect(revisarDescuento(pct(10), 3.36, 33.33).ok).toBe(false);
    });

    test('cada fecha es opcional POR SEPARADO', () => {
        const ayer = new Date(Date.now() - 86400000);
        const manana = new Date(Date.now() + 86400000);
        expect(descuentoVigente(pct(5, { start_date: ayer }))).toBe(true);   // el filtro viejo decía que no
        expect(descuentoVigente(pct(5, { start_date: manana }))).toBe(false);
        expect(descuentoVigente(pct(5, { end_date: ayer }))).toBe(false);
        expect(descuentoVigente(pct(5, { active: false }))).toBe(false);
    });
});

// ── 1. El monto de un descuento configurado ─────────────────────────────────
describe('Hueco 1 — el monto del descuento lo decide la regla, no el cliente', () => {
    let cinco;
    beforeAll(async () => {
        cinco = await models.Discount.create({
            name: 'Cliente frecuente', type: 'percentage', value: 5, business_id: owner.id,
        });
    });

    test('online, el monto correcto pasa', async () => {
        const res = await vender({ discount_id: cinco.id, discount_amount: 5 });
        expect(res.status).toBe(201);
        expect(parseFloat(res.body.total)).toBe(95);
    });

    test('🔴 online, un 5% que intenta regalar la cuenta → 400 y NO se registra', async () => {
        const antes = await models.Order.count({ where: { business_id: owner.id } });
        const res = await vender({ discount_id: cinco.id, discount_amount: 100 });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('DESCUENTO_FUERA_DE_REGLA');
        expect(res.body.error).toMatch(/\$5\.00/);
        expect(await models.Order.count({ where: { business_id: owner.id } })).toBe(antes);
    });

    test('online, un descuento desactivado → 400', async () => {
        const viejo = await models.Discount.create({
            name: 'Del mes pasado', type: 'fixed', value: 10, active: false, business_id: owner.id,
        });
        const res = await vender({ discount_id: viejo.id, discount_amount: 10 });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/ya no está activo/);
    });

    test('online, un descuento con fecha de fin ya pasada → 400', async () => {
        const vencido = await models.Discount.create({
            name: 'Buen Fin', type: 'fixed', value: 10, end_date: new Date(Date.now() - 86400000),
            business_id: owner.id,
        });
        const res = await vender({ discount_id: vencido.id, discount_amount: 10 });
        expect(res.status).toBe(400);
    });

    test('🔴 DIFERIDA con un monto de más: se registra igual (§26) y queda auditada aparte', async () => {
        const res = await vender({
            discount_id: cinco.id, discount_amount: 60,
            client_uuid: uuid(), sold_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        });
        expect(res.status).toBe(201);
        expect(parseFloat(res.body.total)).toBe(40); // lo que de verdad se cobró

        const marcas = await logs('discount_mismatch', res.body.id);
        expect(marcas.length).toBe(1);
        expect(JSON.parse(marcas[0].before_data).maximo_permitido).toBe(5);
        expect(JSON.parse(marcas[0].after_data).descuento_cobrado).toBe(60);
    });

    test('DIFERIDA: la vigencia se mide a la hora de la VENTA, no a la de llegada', async () => {
        // Valía hasta hace 1 hora; la venta se hizo hace 2 horas y llega ahora.
        const hastaHaceUnaHora = await models.Discount.create({
            name: 'Happy hour', type: 'fixed', value: 10,
            end_date: new Date(Date.now() - 60 * 60 * 1000), business_id: owner.id,
        });
        const res = await vender({
            discount_id: hastaHaceUnaHora.id, discount_amount: 10,
            client_uuid: uuid(), sold_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        });
        expect(res.status).toBe(201);
        expect(await logs('discount_mismatch', res.body.id)).toHaveLength(0);
    });

    test('DIFERIDA con el monto correcto no ensucia la auditoría', async () => {
        const res = await vender({
            discount_id: cinco.id, discount_amount: 5,
            client_uuid: uuid(), sold_at: new Date(Date.now() - 60 * 1000).toISOString(),
        });
        expect(res.status).toBe(201);
        expect(await logs('discount_mismatch', res.body.id)).toHaveLength(0);
    });

    test('/discounts/active ya enseña el descuento que solo tiene fecha de inicio', async () => {
        const conInicio = await models.Discount.create({
            name: 'Desde ayer', type: 'fixed', value: 1,
            start_date: new Date(Date.now() - 86400000), business_id: owner.id,
        });
        await models.User.update(
            { plan: 'premium', plan_expires_at: new Date(Date.now() + 30 * 86400000) },
            { where: { id: owner.id } }
        );
        const res = await request(app).get('/api/offers/discounts/active').set(auth());
        expect(res.status).toBe(200);
        expect(res.body.map(d => d.id)).toContain(conInicio.id);
    });
});

// ── 2. Quitar un producto de una cuenta abierta ─────────────────────────────
describe('Hueco 2 — quitar un producto de una cuenta deja rastro', () => {
    test('🔴 queda en la auditoría: qué, cuánto, el total antes y después, y quién', async () => {
        const mesa = await models.Table.create({ name: `Mesa ${Date.now()}`, business_id: owner.id });
        const abrir = await request(app).post('/api/orders').set(auth())
            .send({ table_id: mesa.id, items: [], payment_method: 'efectivo', skip_stock_check: true });
        const agregar = await request(app).post(`/api/orders/${abrir.body.id}/items`).set(auth())
            .send({ items: [{ product_id: taco.id, quantity: 3 }] });
        expect(agregar.status).toBe(200);

        const itemId = agregar.body.items[0].id;
        const quitar = await request(app).delete(`/api/orders/${abrir.body.id}/items/${itemId}`)
            .set(auth()).send({ employee_name: 'Beto (mesero)' });
        expect(quitar.status).toBe(200);

        const rastro = await logs('remove_item', abrir.body.id);
        expect(rastro).toHaveLength(1);
        expect(rastro[0].employee_name).toBe('Beto (mesero)');
        const antes = JSON.parse(rastro[0].before_data);
        expect(antes).toMatchObject({ producto: 'Taco', cantidad: 3, importe: 150, total_antes: 150 });
        expect(JSON.parse(rastro[0].after_data).total).toBe(0);
    });

    test('sin nombre de puesto, queda a nombre de la cuenta (nunca vacío)', async () => {
        const mesa = await models.Table.create({ name: `Mesa b ${Date.now()}`, business_id: owner.id });
        const abrir = await request(app).post('/api/orders').set(auth())
            .send({ table_id: mesa.id, items: [], payment_method: 'efectivo', skip_stock_check: true });
        const agregar = await request(app).post(`/api/orders/${abrir.body.id}/items`).set(auth())
            .send({ items: [{ product_id: taco.id, quantity: 1 }] });
        await request(app).delete(`/api/orders/${abrir.body.id}/items/${agregar.body.items[0].id}`).set(auth());

        const rastro = await logs('remove_item', abrir.body.id);
        expect(rastro).toHaveLength(1);
        expect(rastro[0].employee_name).toBeTruthy();
    });
});

// ── 3. La forma de pago de una venta ────────────────────────────────────────
describe('Hueco 3 — PUT /orders/:id ya no cambia la forma de pago', () => {
    test('🔴 efectivo → tarjeta en una venta cerrada → 400 y no cambia', async () => {
        const venta = await vender({ payment_method: 'efectivo' });
        await request(app).put(`/api/orders/${venta.body.id}/status`).set(auth()).send({ status: 'completado' });

        const res = await request(app).put(`/api/orders/${venta.body.id}`).set(auth())
            .send({ payment_method: 'tarjeta' });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('METODO_PAGO_NO_EDITABLE');

        const guardado = await models.Order.findByPk(venta.body.id);
        expect(guardado.payment_method).toBe('efectivo');
    });

    test('mandar el MISMO método, o no mandarlo, sigue funcionando', async () => {
        const venta = await vender({ payment_method: 'efectivo' });
        const mismo = await request(app).put(`/api/orders/${venta.body.id}`).set(auth())
            .send({ payment_method: 'efectivo', notes: 'sin cebolla' });
        expect(mismo.status).toBe(200);
        const sinMetodo = await request(app).put(`/api/orders/${venta.body.id}`).set(auth())
            .send({ reference: 'Mesa 4' });
        expect(sinMetodo.status).toBe(200);
    });
});
