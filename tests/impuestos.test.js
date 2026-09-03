/**
 * BLOQUE 8 V5 — Impuestos configurables.
 *
 * Lo que se prueba, en orden de importancia:
 *   1. Que los dos modos den el total correcto (AGREGADO suma, INCLUIDO desglosa).
 *   2. Que el DESCUENTO baje la base gravable (se descuenta primero, luego impuesto).
 *   3. Que la config sea del DUEÑO y que no se le crea al cliente el monto.
 *   4. Que una mesa abierta recalcule con la tasa CONGELADA del pedido.
 *   5. Que un negocio sin impuesto (tasa 0, el default) cobre exactamente lo de hoy.
 */
jest.mock('../utils/push', () => ({
    enviarNotificacion: jest.fn(),
    getPrefs: jest.fn().mockResolvedValue({}),
}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { app, sequelize, models, initTestDb, createTestOwner } = require('./setup');
const {
    desglosar,
    baseParaRecalcular,
    resolverImpuestoVenta,
    configDeAjustes,
    limpiarCacheImpuestos,
} = require('../utils/impuestos');

let owner, ownerToken, product;

const auth = (token) => ({ Authorization: `Bearer ${token}` });

/** Config de impuesto del negocio (escribe settings del owner y limpia la caché). */
async function configurarImpuesto(config) {
    const actuales = owner.settings ? JSON.parse(owner.settings) : {};
    await owner.update({ settings: JSON.stringify({ ...actuales, ...config }) });
    await owner.reload();
    limpiarCacheImpuestos();
}

function venta(body = {}) {
    return request(app)
        .post('/api/orders')
        .set(auth(ownerToken))
        .send({
            items: [{ product_id: product.id, quantity: 1 }],
            payment_method: 'efectivo',
            skip_stock_check: true,
            ...body,
        });
}

beforeAll(async () => {
    await initTestDb();
    const result = await createTestOwner();
    owner = result.user;
    ownerToken = result.token;

    const category = await models.Category.create({ name: 'Comida', business_id: owner.id });
    product = await models.Product.create({
        name: 'Taco', price: 100.00, category_id: category.id, business_id: owner.id,
    });
});

afterAll(async () => { await sequelize.close(); });

beforeEach(async () => {
    await configurarImpuesto({ tax_enabled: false, tax_rate: 0, tax_included: false, tax_name: 'IVA' });
});

// El impuesto se enciende explícitamente; la tasa sola ya no basta.
function activar(config) {
    return configurarImpuesto({ tax_enabled: true, ...config });
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. La fórmula
// ═══════════════════════════════════════════════════════════════════════════
describe('desglosar()', () => {
    test('AGREGADO: el impuesto se suma sobre la base', () => {
        expect(desglosar({ base: 100, tasa: 16, incluido: false }))
            .toEqual({ subtotal: 100, impuesto: 16, total: 116 });
    });

    test('INCLUIDO: el impuesto se extrae del precio cobrado', () => {
        expect(desglosar({ base: 116, tasa: 16, incluido: true }))
            .toEqual({ subtotal: 100, impuesto: 16, total: 116 });
    });

    test('tasa 0 = negocio sin impuesto: el total no se mueve', () => {
        expect(desglosar({ base: 250.75, tasa: 0, incluido: false }))
            .toEqual({ subtotal: 250.75, impuesto: 0, total: 250.75 });
    });

    test('total = subtotal + impuesto SIEMPRE, aunque el redondeo no sea exacto', () => {
        // 33.33 al 16% incluido no divide en centavos exactos: el invariante debe
        // cumplirse igual o el ticket muestra un renglón que no suma.
        for (const base of [33.33, 0.01, 99.99, 1234.56, 7.77]) {
            for (const incluido of [true, false]) {
                const d = desglosar({ base, tasa: 16, incluido });
                expect(d.subtotal + d.impuesto).toBeCloseTo(d.total, 2);
            }
        }
    });

    test('una tasa inservible se trata como sin impuesto, nunca revienta', () => {
        for (const tasa of [null, undefined, 'abc', -5, 150, NaN]) {
            expect(desglosar({ base: 100, tasa, incluido: false }).total).toBe(100);
        }
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. La venta
// ═══════════════════════════════════════════════════════════════════════════
describe('POST /api/orders con impuesto', () => {
    test('AGREGADO: cobra el precio + el impuesto', async () => {
        await activar({ tax_rate: 16, tax_included: false });

        const res = await venta();

        expect(res.status).toBe(201);
        expect(parseFloat(res.body.subtotal)).toBe(100);
        expect(parseFloat(res.body.tax_amount)).toBe(16);
        expect(parseFloat(res.body.total)).toBe(116);
        expect(parseFloat(res.body.tax_rate)).toBe(16);
    });

    test('INCLUIDO: cobra el precio de catálogo y desglosa hacia atrás', async () => {
        await activar({ tax_rate: 16, tax_included: true });

        const res = await venta();

        expect(parseFloat(res.body.total)).toBe(100);       // el cliente paga lo etiquetado
        expect(parseFloat(res.body.tax_amount)).toBe(13.79);
        expect(parseFloat(res.body.subtotal)).toBe(86.21);
    });

    test('sin impuesto configurado la venta cobra exactamente lo de siempre', async () => {
        const res = await venta();

        expect(parseFloat(res.body.total)).toBe(100);
        expect(parseFloat(res.body.tax_amount)).toBe(0);
        expect(parseFloat(res.body.subtotal)).toBe(100);
    });

    test('el DESCUENTO baja la base gravable (se descuenta antes del impuesto)', async () => {
        await activar({ tax_rate: 16, tax_included: false });
        const descuento = await models.Discount.create({
            // 'fixed', no 'fijo': `Discount.type` es un ENUM('percentage','fixed').
            // SQLite no valida los ENUM y se tragaba 'fijo' sin decir nada, así que
            // esta prueba llevaba tiempo pasando con un dato IMPOSIBLE en producción.
            // Lo destapó `npm run test:pg` (CLAUDE.md §39), donde Postgres sí lo rechaza.
            name: 'Diez menos', type: 'fixed', value: 10, business_id: owner.id,
        });

        const res = await venta({ discount_amount: 10, discount_id: descuento.id });

        // 100 − 10 = 90 de base → 14.40 de impuesto → 104.40 a cobrar.
        expect(parseFloat(res.body.subtotal)).toBe(90);
        expect(parseFloat(res.body.tax_amount)).toBe(14.4);
        expect(parseFloat(res.body.total)).toBe(104.4);
    });

    test('el canje de puntos también baja la base gravable', async () => {
        await activar({ tax_rate: 16, tax_included: false, puntos_valor: 0.10 });
        const cliente = await models.Customer.create({
            name: 'Cliente puntos',
            phone: `55${Math.floor(Math.random() * 100000000)}`,
            business_id: owner.id,
            loyalty_points: 500,
        });

        const res = await venta({
            customer_id: cliente.id,
            loyalty_points_used: 200,
            loyalty_discount_amount: 20,
        });

        // 100 − 20 (puntos) = 80 de base → 12.80 → 92.80.
        expect(parseFloat(res.body.subtotal)).toBe(80);
        expect(parseFloat(res.body.tax_amount)).toBe(12.8);
        expect(parseFloat(res.body.total)).toBe(92.8);
    });

    test('el cliente NO puede declarar el impuesto de una venta online', async () => {
        await activar({ tax_rate: 16, tax_included: false });

        const res = await venta({ tax_rate: 0, tax_amount: 0, tax_included: true });

        // Manda la config del negocio, no lo que diga el POS.
        expect(parseFloat(res.body.tax_amount)).toBe(16);
        expect(parseFloat(res.body.total)).toBe(116);
    });

    test('una venta DIFERIDA conserva la tasa con la que se cobró', async () => {
        // El equipo vendió con 16% sin internet; el dueño ya bajó la tasa a 8%.
        await activar({ tax_rate: 8, tax_included: false });

        const res = await venta({
            client_uuid: `uuid-diferida-${Date.now()}`,
            sold_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
            tax_rate: 16,
            tax_included: false,
            items: [{ product_id: product.id, quantity: 1, unit_price: 100 }],
        });

        expect(parseFloat(res.body.tax_rate)).toBe(16);
        expect(parseFloat(res.body.tax_amount)).toBe(16);
        expect(parseFloat(res.body.total)).toBe(116);
    });

    test('en una venta diferida el MONTO se recalcula, no se le cree al cliente', async () => {
        await activar({ tax_rate: 16, tax_included: false });

        const res = await venta({
            client_uuid: `uuid-mentira-${Date.now()}`,
            sold_at: new Date(Date.now() - 60 * 1000).toISOString(),
            tax_rate: 16,
            tax_amount: 999,
            items: [{ product_id: product.id, quantity: 1, unit_price: 100 }],
        });

        expect(parseFloat(res.body.tax_amount)).toBe(16);
    });

    test('una tasa inválida en venta diferida cae a la del negocio, no rechaza la venta', async () => {
        await activar({ tax_rate: 16, tax_included: false });

        const res = await venta({
            client_uuid: `uuid-tasa-mala-${Date.now()}`,
            sold_at: new Date(Date.now() - 60 * 1000).toISOString(),
            tax_rate: 'x',
            items: [{ product_id: product.id, quantity: 1, unit_price: 100 }],
        });

        expect(res.status).toBe(201);
        expect(parseFloat(res.body.tax_amount)).toBe(16);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Mesas: la tasa queda congelada en el pedido
// ═══════════════════════════════════════════════════════════════════════════
describe('mesas abiertas', () => {
    test('AGREGADO: agregar y quitar productos recalcula el impuesto', async () => {
        await activar({ tax_rate: 16, tax_included: false });
        const mesa = await models.Table.create({ name: 'Mesa 1', business_id: owner.id });

        const abierta = await venta({ table_id: mesa.id });
        expect(parseFloat(abierta.body.total)).toBe(116);

        const conMas = await request(app)
            .post(`/api/orders/${abierta.body.id}/items`)
            .set(auth(ownerToken))
            .send({ items: [{ product_id: product.id, quantity: 1 }] });

        expect(parseFloat(conMas.body.subtotal)).toBe(200);
        expect(parseFloat(conMas.body.tax_amount)).toBe(32);
        expect(parseFloat(conMas.body.total)).toBe(232);

        const itemId = conMas.body.items[conMas.body.items.length - 1].id;
        const conMenos = await request(app)
            .delete(`/api/orders/${abierta.body.id}/items/${itemId}`)
            .set(auth(ownerToken));

        expect(parseFloat(conMenos.body.subtotal)).toBe(100);
        expect(parseFloat(conMenos.body.total)).toBe(116);
    });

    test('INCLUIDO: la suma de la mesa sigue siendo el precio de catálogo', async () => {
        await activar({ tax_rate: 16, tax_included: true });
        const mesa = await models.Table.create({ name: 'Mesa 2', business_id: owner.id });

        const abierta = await venta({ table_id: mesa.id });
        const conMas = await request(app)
            .post(`/api/orders/${abierta.body.id}/items`)
            .set(auth(ownerToken))
            .send({ items: [{ product_id: product.id, quantity: 1 }] });

        expect(parseFloat(conMas.body.total)).toBe(200);       // 2 tacos etiquetados a 100
        expect(parseFloat(conMas.body.tax_amount)).toBe(27.59);
        expect(parseFloat(conMas.body.subtotal)).toBe(172.41);
    });

    test('cambiar la tasa NO altera una mesa ya abierta', async () => {
        await activar({ tax_rate: 16, tax_included: false });
        const mesa = await models.Table.create({ name: 'Mesa 3', business_id: owner.id });
        const abierta = await venta({ table_id: mesa.id });

        // El dueño cambia el impuesto a media comida.
        await configurarImpuesto({ tax_rate: 0, tax_included: false });

        const conMas = await request(app)
            .post(`/api/orders/${abierta.body.id}/items`)
            .set(auth(ownerToken))
            .send({ items: [{ product_id: product.id, quantity: 1 }] });

        // La cuenta que el cliente ya vio se respeta: sigue al 16%.
        expect(parseFloat(conMas.body.tax_rate)).toBe(16);
        expect(parseFloat(conMas.body.tax_amount)).toBe(32);
        expect(parseFloat(conMas.body.total)).toBe(232);
    });

    test('un pedido anterior al bloque (sin subtotal) sigue sumando bien', async () => {
        const legacy = await models.Order.create({
            total: 100, business_id: owner.id, status: 'registrado',
            subtotal: null, tax_amount: 0, tax_rate: null, tax_included: null,
        });
        expect(baseParaRecalcular(legacy)).toBe(100);

        const conMas = await request(app)
            .post(`/api/orders/${legacy.id}/items`)
            .set(auth(ownerToken))
            .send({ items: [{ product_id: product.id, quantity: 1 }] });

        expect(parseFloat(conMas.body.total)).toBe(200);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. La configuración es del dueño
// ═══════════════════════════════════════════════════════════════════════════
describe('PUT /api/settings — config de impuesto', () => {
    test('el dueño puede configurarlo', async () => {
        const res = await request(app)
            .put('/api/settings')
            .set(auth(ownerToken))
            .send({ tax_rate: 16, tax_included: true, tax_name: 'IVA' });

        expect(res.status).toBe(200);
        expect(res.body.tax_rate).toBe(16);
        expect(res.body.tax_included).toBe(true);
    });

    test('un empleado NO puede cambiar el impuesto', async () => {
        const empleado = await models.User.create({
            username: `cajero_imp_${Date.now()}@test.com`,
            password: 'TestPass123', name: 'Cajero', role: 'cashier', business_id: owner.id,
        });
        const tokenEmpleado = jwt.sign(
            { id: empleado.id, username: empleado.username, role: 'cashier', business_id: owner.id },
            process.env.JWT_SECRET, { expiresIn: '1d' }
        );

        const res = await request(app)
            .put('/api/settings')
            .set(auth(tokenEmpleado))
            .send({ tax_rate: 0 });

        expect(res.status).toBe(403);
    });

    test('una tasa fuera de rango se rechaza (cobraría de más a clientes reales)', async () => {
        for (const tasa of [-1, 101, 'mucho']) {
            const res = await request(app)
                .put('/api/settings')
                .set(auth(ownerToken))
                .send({ tax_rate: tasa });
            expect(res.status).toBe(400);
        }
    });

    test('guardar el impuesto invalida la caché: la siguiente venta usa la tasa nueva', async () => {
        await venta(); // calienta la caché con tasa 0

        await request(app)
            .put('/api/settings')
            .set(auth(ownerToken))
            .send({ tax_enabled: true, tax_rate: 16, tax_included: false });

        const res = await venta();
        expect(parseFloat(res.body.tax_amount)).toBe(16);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4bis. El interruptor: apagar NO borra la tasa configurada
// ═══════════════════════════════════════════════════════════════════════════
describe('interruptor de impuesto', () => {
    test('apagado es el default: un negocio nuevo no cobra impuesto', () => {
        const cfg = configDeAjustes({});
        expect(cfg.activo).toBe(false);
        expect(cfg.tasa).toBe(0);
        // Y en México el precio exhibido YA incluye el impuesto: ese es el default.
        expect(cfg.incluido).toBe(true);
    });

    test('apagado con tasa guardada: no cobra, pero conserva el 16 para reactivar', async () => {
        await configurarImpuesto({ tax_enabled: false, tax_rate: 16, tax_included: true });

        const res = await venta();
        expect(parseFloat(res.body.tax_amount)).toBe(0);
        expect(parseFloat(res.body.total)).toBe(100);

        const cfg = configDeAjustes(JSON.parse(owner.settings));
        expect(cfg.tasa).toBe(0);              // efectiva: no se cobra
        expect(cfg.tasaConfigurada).toBe(16);  // guardada: no se perdió
    });

    test('encender y apagar desde ajustes no borra la configuración', async () => {
        await request(app).put('/api/settings').set(auth(ownerToken))
            .send({ tax_enabled: true, tax_rate: 16, tax_included: true, tax_name: 'IVA' });
        limpiarCacheImpuestos();
        expect(parseFloat((await venta()).body.tax_amount)).toBe(13.79);

        const apagado = await request(app).put('/api/settings').set(auth(ownerToken))
            .send({ tax_enabled: false });
        limpiarCacheImpuestos();
        expect(apagado.body.tax_rate).toBe(16);   // la tasa sigue ahí
        expect(parseFloat((await venta()).body.tax_amount)).toBe(0);

        await request(app).put('/api/settings').set(auth(ownerToken)).send({ tax_enabled: true });
        limpiarCacheImpuestos();
        expect(parseFloat((await venta()).body.tax_amount)).toBe(13.79);
    });

    test('un empleado tampoco puede encender ni apagar el impuesto', async () => {
        const empleado = await models.User.create({
            username: `cajero_sw_${Date.now()}@test.com`,
            password: 'TestPass123', name: 'Cajero', role: 'cashier', business_id: owner.id,
        });
        const tokenEmpleado = jwt.sign(
            { id: empleado.id, username: empleado.username, role: 'cashier', business_id: owner.id },
            process.env.JWT_SECRET, { expiresIn: '1d' }
        );

        const res = await request(app).put('/api/settings').set(auth(tokenEmpleado))
            .send({ tax_enabled: true });

        expect(res.status).toBe(403);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. El corte de caja: informativo, no cambia el efectivo esperado
// ═══════════════════════════════════════════════════════════════════════════
describe('turno con impuesto', () => {
    test('el corte reporta el impuesto recaudado y las ventas netas', async () => {
        await activar({ tax_rate: 16, tax_included: false });

        const turno = await request(app)
            .post('/api/turnos')
            .set(auth(ownerToken))
            .send({ cajero_nombre: 'Ana', fondo_inicial: 500 });

        await venta(); // 116 en efectivo, 16 de impuesto

        const totales = await request(app)
            .get(`/api/turnos/${turno.body.id}/totales`)
            .set(auth(ownerToken));

        expect(totales.body.total_ventas).toBe(116);
        expect(totales.body.total_impuesto).toBe(16);
        expect(totales.body.total_ventas_netas).toBe(100);
        // El impuesto está DENTRO del efectivo cobrado: el cajón sigue esperando
        // fondo (500) + ventas en efectivo (116).
        expect(totales.body.efectivo_esperado).toBe(616);

        const cerrado = await request(app)
            .put(`/api/turnos/${turno.body.id}/cerrar`)
            .set(auth(ownerToken))
            .send({ efectivo_contado: 616 });

        expect(parseFloat(cerrado.body.diferencia)).toBe(0);
        expect(parseFloat(cerrado.body.total_impuesto)).toBe(16);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Config diferida
// ═══════════════════════════════════════════════════════════════════════════
describe('resolverImpuestoVenta()', () => {
    const negocio = { activo: true, tasa: 8, tasaConfigurada: 8, incluido: false, nombre: 'IVA' };

    test('venta online: manda el negocio', () => {
        expect(resolverImpuestoVenta(negocio, { tax_rate: 16 }, false)).toEqual(negocio);
    });

    test('venta diferida: manda la tasa que declara el equipo', () => {
        expect(resolverImpuestoVenta(negocio, { tax_rate: 16, tax_included: true }, true))
            .toEqual({ activo: true, tasa: 16, tasaConfigurada: 16, incluido: true, nombre: 'IVA' });
    });

    test('venta diferida sin tasa: cae a la del negocio', () => {
        expect(resolverImpuestoVenta(negocio, {}, true)).toEqual(negocio);
    });
});
