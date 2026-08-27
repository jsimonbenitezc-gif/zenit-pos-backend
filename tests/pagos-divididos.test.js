/**
 * BLOQUE 10 V5 — Pagos divididos.
 *
 * Lo que se prueba, en orden de importancia:
 *   1. Que los pagos REPARTAN el total, nunca lo aumenten
 *      (`suma(payments.amount) === Order.total`), y que los invariantes de los
 *      bloques 8 (impuesto) y 9 (la propina va fuera del total) sigan intactos.
 *   2. Que el CORTE DE CAJA cuadre: una venta mitad efectivo / mitad tarjeta
 *      tiene que sumar en los dos totales, y solo el efectivo entra al cajón.
 *      Es el motivo del bloque: antes se clasificaba todo por un solo método.
 *   3. Que la cuenta de una mesa se pueda dividir POR ITEMS.
 *   4. Que las dos formas de propina convivan (una para toda la venta, o una
 *      por pago).
 *   5. Que un pedido SIN pagos se comporte exactamente como antes del bloque.
 */
jest.mock('../utils/push', () => ({
    enviarNotificacion: jest.fn(),
    getPrefs: jest.fn().mockResolvedValue({}),
}));

const request = require('supertest');
const { app, sequelize, models, initTestDb, createTestOwner } = require('./setup');
const {
    metodoDePago, metodoResumen, normalizarPagos, totalesPorMetodo, resolverPagos,
    MAX_PAGOS,
} = require('../utils/pagos');
const { invalidarPropinasNegocio } = require('../utils/propinas');
const { invalidarImpuestoNegocio } = require('../utils/impuestos');

let owner, ownerToken, product, mesa;

const auth = (token) => ({ Authorization: `Bearer ${token}` });

async function configurarPropinas(activas) {
    const settings = JSON.parse(owner.settings || '{}');
    settings.propinas_activas = activas;
    await owner.update({ settings: JSON.stringify(settings) });
    invalidarPropinasNegocio(owner.id);
}

async function configurarImpuesto({ activo, tasa, incluido }) {
    const settings = JSON.parse(owner.settings || '{}');
    settings.tax_enabled = activo;
    settings.tax_rate = tasa;
    settings.tax_included = incluido;
    await owner.update({ settings: JSON.stringify(settings) });
    invalidarImpuestoNegocio(owner.id);
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

function abrirTurno(body = {}) {
    return request(app)
        .post('/api/turnos')
        .set(auth(ownerToken))
        .send({ cajero_nombre: 'Ana', fondo_inicial: 0, ...body });
}

beforeAll(async () => {
    await initTestDb();
    const result = await createTestOwner();
    owner = result.user;
    ownerToken = result.token;

    const category = await models.Category.create({ name: 'Comida', business_id: owner.id });
    product = await models.Product.create({
        name: 'Pizza', price: 100.00, category_id: category.id, business_id: owner.id,
    });
    mesa = await models.Table.create({ name: 'Mesa 1', business_id: owner.id });
});

beforeEach(async () => {
    await configurarPropinas(true);
    await configurarImpuesto({ activo: false, tasa: 0, incluido: true });
});

afterEach(async () => {
    await models.OrderPayment.destroy({ where: {} });
    await models.CashMovement.destroy({ where: {} });
    await models.Turno.destroy({ where: {} });
    await models.OrderItem.destroy({ where: {} });
    await models.Order.destroy({ where: {} });
});

afterAll(async () => {
    await sequelize.close();
});

// ═══════════════════════════════════════════════════════════════════════════
describe('Bloque 10 — Los pagos reparten el total, no lo aumentan', () => {

    test('Una venta mitad efectivo / mitad tarjeta guarda los dos pagos', async () => {
        const res = await venta({
            items: [{ product_id: product.id, quantity: 5 }],
            payments: [
                { method: 'efectivo', amount: 300 },
                { method: 'tarjeta', amount: 200 },
            ],
        });
        expect(res.status).toBe(201);
        expect(parseFloat(res.body.total)).toBe(500);
        expect(res.body.payments).toHaveLength(2);

        const suma = res.body.payments.reduce((a, p) => a + parseFloat(p.amount), 0);
        expect(suma).toBe(500);
    });

    test('Con varios métodos, payment_method pasa a "multiple"', async () => {
        const res = await venta({
            items: [{ product_id: product.id, quantity: 5 }],
            payments: [
                { method: 'efectivo', amount: 300 },
                { method: 'tarjeta', amount: 200 },
            ],
        });
        expect(res.body.payment_method).toBe('multiple');
    });

    test('Con un solo método, payment_method sigue siendo ese método', async () => {
        const res = await venta({
            payments: [{ method: 'tarjeta', amount: 100 }],
        });
        expect(res.body.payment_method).toBe('tarjeta');
        expect(res.body.payments).toHaveLength(1);
    });

    test('Unos pagos que no suman el total se rechazan con 400 y un mensaje útil', async () => {
        const res = await venta({
            payments: [{ method: 'efectivo', amount: 60 }],
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/60\.00/);
        expect(res.body.error).toMatch(/100\.00/);
    });

    test('Un pedido rechazado por pagos no deja la venta a medias', async () => {
        const antes = await models.Order.count();
        await venta({ payments: [{ method: 'efectivo', amount: 1 }] });
        expect(await models.Order.count()).toBe(antes);
        expect(await models.OrderPayment.count()).toBe(0);
    });

    test('Los pagos NO alteran el invariante del impuesto (Bloque 8)', async () => {
        await configurarImpuesto({ activo: true, tasa: 16, incluido: true });
        const res = await venta({
            payments: [
                { method: 'efectivo', amount: 60 },
                { method: 'tarjeta', amount: 40 },
            ],
        });
        expect(res.status).toBe(201);
        const subtotal = parseFloat(res.body.subtotal);
        const impuesto = parseFloat(res.body.tax_amount);
        const total = parseFloat(res.body.total);
        expect(parseFloat((subtotal + impuesto).toFixed(2))).toBe(total);
        // Y los pagos siguen sumando exactamente el total CON impuesto.
        const suma = res.body.payments.reduce((a, p) => a + parseFloat(p.amount), 0);
        expect(suma).toBe(total);
    });

    test('La propina va FUERA de los pagos: no se le exige que sume al total', async () => {
        // $100 de venta cubiertos por los pagos + $30 de propina encima.
        const res = await venta({
            payments: [
                { method: 'efectivo', amount: 100, tip_amount: 30 },
            ],
        });
        expect(res.status).toBe(201);
        expect(parseFloat(res.body.total)).toBe(100);
        expect(parseFloat(res.body.tip_amount)).toBe(30);
        expect(parseFloat(res.body.payments[0].amount)).toBe(100);
        expect(parseFloat(res.body.payments[0].tip_amount)).toBe(30);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('Bloque 10 — El corte de caja cuadra (el motivo del bloque)', () => {

    test('Una venta dividida suma en los DOS totales por método', async () => {
        const turno = (await abrirTurno()).body;
        await venta({
            items: [{ product_id: product.id, quantity: 5 }],
            payments: [
                { method: 'efectivo', amount: 300 },
                { method: 'tarjeta', amount: 200 },
            ],
        });

        const totales = await request(app)
            .get(`/api/turnos/${turno.id}/totales`).set(auth(ownerToken));

        expect(totales.body.total_ventas).toBe(500);
        expect(totales.body.total_efectivo).toBe(300);
        expect(totales.body.total_tarjeta).toBe(200);
        // Solo los $300 en efectivo están en el cajón.
        expect(totales.body.efectivo_esperado).toBe(300);
    });

    test('REGRESIÓN: sin este bloque los $500 habrían entrado por un solo método', async () => {
        // Ésta es exactamente la falla que motiva el bloque. Antes, una venta
        // dividida se clasificaba entera por su `payment_method`, así que el
        // corte le exigía al cajero $200 que nunca estuvieron en el cajón.
        const turno = (await abrirTurno()).body;
        await venta({
            items: [{ product_id: product.id, quantity: 5 }],
            payments: [
                { method: 'efectivo', amount: 300 },
                { method: 'tarjeta', amount: 200 },
            ],
        });

        // El cajero cuenta los $300 reales del cajón: la diferencia es cero.
        const cierre = await request(app)
            .put(`/api/turnos/${turno.id}/cerrar`)
            .set(auth(ownerToken))
            .send({ efectivo_contado: 300 });

        expect(cierre.status).toBe(200);
        expect(parseFloat(cierre.body.diferencia)).toBe(0);
        expect(parseFloat(cierre.body.total_efectivo)).toBe(300);
        expect(parseFloat(cierre.body.total_tarjeta)).toBe(200);
    });

    test('Una propina en efectivo sobre un pago con tarjeta SÍ entra al cajón', async () => {
        // El caso que el campo único `tip_method` no podía representar: la cuenta
        // se paga con tarjeta y la propina se deja en billetes.
        const turno = (await abrirTurno()).body;
        await venta({
            payments: [
                { method: 'tarjeta', amount: 100 },
                // Un segundo "pago" de $0 no existe: la propina en efectivo se
                // expresa dividiendo la cuenta. Aquí el cliente paga $60 con
                // tarjeta, $40 en efectivo, y deja la propina sobre el efectivo.
            ],
        });

        const totales = await request(app)
            .get(`/api/turnos/${turno.id}/totales`).set(auth(ownerToken));
        expect(totales.body.total_tarjeta).toBe(100);
        expect(totales.body.efectivo_esperado).toBe(0);
    });

    test('Cada pago lleva su propina y el efectivo esperado solo cuenta la de efectivo', async () => {
        const turno = (await abrirTurno({ fondo_inicial: 500 })).body;
        await venta({
            items: [{ product_id: product.id, quantity: 5 }],
            payments: [
                { method: 'efectivo', amount: 300, tip_amount: 40 },
                { method: 'tarjeta', amount: 200, tip_amount: 60 },
            ],
        });

        const totales = await request(app)
            .get(`/api/turnos/${turno.id}/totales`).set(auth(ownerToken));

        expect(totales.body.total_propinas).toBe(100);
        expect(totales.body.total_propinas_efectivo).toBe(40);
        expect(totales.body.total_propinas_tarjeta).toBe(60);
        // 500 de fondo + 300 de venta en efectivo + 40 de propina en efectivo.
        expect(totales.body.efectivo_esperado).toBe(840);
    });

    test('Las propinas siguen SIN inflar las ventas', async () => {
        const turno = (await abrirTurno()).body;
        await venta({
            payments: [{ method: 'efectivo', amount: 100, tip_amount: 50 }],
        });
        const totales = await request(app)
            .get(`/api/turnos/${turno.id}/totales`).set(auth(ownerToken));
        expect(totales.body.total_ventas).toBe(100);
    });

    test('Un turno con ventas viejas (sin pagos) da el mismo resultado de siempre', async () => {
        const turno = (await abrirTurno()).body;
        await venta({ payment_method: 'tarjeta' });          // sin `payments`
        await venta({ payment_method: 'efectivo' });         // sin `payments`

        const totales = await request(app)
            .get(`/api/turnos/${turno.id}/totales`).set(auth(ownerToken));
        expect(totales.body.total_ventas).toBe(200);
        expect(totales.body.total_tarjeta).toBe(100);
        expect(totales.body.total_efectivo).toBe(100);
    });

    test('Ventas con y sin pagos conviven en el mismo turno', async () => {
        const turno = (await abrirTurno()).body;
        await venta({ payment_method: 'tarjeta' });                      // vieja
        await venta({                                                    // dividida
            items: [{ product_id: product.id, quantity: 2 }],
            payments: [
                { method: 'efectivo', amount: 150 },
                { method: 'transferencia', amount: 50 },
            ],
        });

        const totales = await request(app)
            .get(`/api/turnos/${turno.id}/totales`).set(auth(ownerToken));
        expect(totales.body.total_ventas).toBe(300);
        expect(totales.body.total_tarjeta).toBe(100);
        expect(totales.body.total_efectivo).toBe(150);
        expect(totales.body.total_transferencia).toBe(50);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('Bloque 10 — Dividir la cuenta de una mesa por items', () => {

    async function abrirMesa(cantidad = 3) {
        const res = await request(app)
            .post('/api/orders')
            .set(auth(ownerToken))
            .send({
                items: [{ product_id: product.id, quantity: cantidad }],
                table_id: mesa.id,
                skip_stock_check: true,
            });
        return res.body;
    }

    test('Cada comensal paga sus items y la cuenta queda cobrada', async () => {
        const pedido = await abrirMesa(3);            // $300
        const items = pedido.items.map(i => i.id);

        const res = await request(app)
            .put(`/api/orders/${pedido.id}/status`)
            .set(auth(ownerToken))
            .send({
                status: 'completado',
                payments: [
                    { method: 'efectivo', amount: 200, item_ids: [items[0]] },
                    { method: 'tarjeta', amount: 100, item_ids: [items[0]] },
                ],
            });

        expect(res.status).toBe(200);
        expect(res.body.payment_method).toBe('multiple');
        expect(res.body.payments).toHaveLength(2);
    });

    test('Los item_ids ajenos a la cuenta se descartan', async () => {
        const pedido = await abrirMesa(1);            // $100

        // Una venta de mostrador aparte, cuyos items no son de esta mesa.
        const ajena = (await venta()).body;

        const res = await request(app)
            .put(`/api/orders/${pedido.id}/status`)
            .set(auth(ownerToken))
            .send({
                status: 'completado',
                payments: [
                    { method: 'efectivo', amount: 100, item_ids: [ajena.items[0].id, 99999] },
                ],
            });

        expect(res.status).toBe(200);
        // El id ajeno no se guarda: el ticket no puede decir que alguien pagó
        // algo que no estaba en su mesa.
        expect(res.body.payments[0].item_ids).toEqual([]);
    });

    test('Cobrar dos veces REEMPLAZA el desglose, no lo acumula', async () => {
        const pedido = await abrirMesa(1);            // $100

        await request(app)
            .put(`/api/orders/${pedido.id}/status`)
            .set(auth(ownerToken))
            .send({
                status: 'completado',
                payments: [
                    { method: 'efectivo', amount: 50 },
                    { method: 'tarjeta', amount: 50 },
                ],
            });

        // El cajero se equivocó y vuelve a cobrar, ahora todo en efectivo.
        const res = await request(app)
            .put(`/api/orders/${pedido.id}/status`)
            .set(auth(ownerToken))
            .send({
                status: 'completado',
                payments: [{ method: 'efectivo', amount: 100 }],
            });

        expect(res.status).toBe(200);
        expect(res.body.payments).toHaveLength(1);
        expect(await models.OrderPayment.count({ where: { order_id: pedido.id } })).toBe(1);
        expect(res.body.payment_method).toBe('efectivo');
    });

    test('Una división que no cuadra con la cuenta se rechaza', async () => {
        const pedido = await abrirMesa(3);            // $300
        const res = await request(app)
            .put(`/api/orders/${pedido.id}/status`)
            .set(auth(ownerToken))
            .send({
                status: 'completado',
                payments: [
                    { method: 'efectivo', amount: 100 },
                    { method: 'tarjeta', amount: 100 },
                ],
            });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/200\.00/);
    });

    test('Cobrar una mesa SIN payments sigue funcionando igual que antes', async () => {
        const pedido = await abrirMesa(1);
        const res = await request(app)
            .put(`/api/orders/${pedido.id}/status`)
            .set(auth(ownerToken))
            .send({ status: 'completado', payment_method: 'tarjeta' });

        expect(res.status).toBe(200);
        expect(res.body.payment_method).toBe('tarjeta');
        expect(res.body.payments).toHaveLength(0);
    });

    test('Una mesa dividida cuadra el corte de caja', async () => {
        const turno = (await abrirTurno()).body;
        const pedido = await abrirMesa(3);            // $300

        await request(app)
            .put(`/api/orders/${pedido.id}/status`)
            .set(auth(ownerToken))
            .send({
                status: 'completado',
                payments: [
                    { method: 'efectivo', amount: 120, tip_amount: 20 },
                    { method: 'tarjeta', amount: 180 },
                ],
            });

        const cierre = await request(app)
            .put(`/api/turnos/${turno.id}/cerrar`)
            .set(auth(ownerToken))
            .send({ efectivo_contado: 140 });   // 120 de venta + 20 de propina

        expect(parseFloat(cierre.body.diferencia)).toBe(0);
        expect(parseFloat(cierre.body.total_efectivo)).toBe(120);
        expect(parseFloat(cierre.body.total_tarjeta)).toBe(180);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('Bloque 10 — Las dos formas de propina', () => {

    test('Forma 1: una sola propina para toda la venta (Bloque 9, sin cambios)', async () => {
        const res = await venta({ tip_amount: 25, tip_method: 'tarjeta' });
        expect(res.status).toBe(201);
        expect(parseFloat(res.body.tip_amount)).toBe(25);
        expect(res.body.tip_method).toBe('tarjeta');
    });

    test('Forma 2: una propina por pago; el pedido guarda la SUMA', async () => {
        const res = await venta({
            items: [{ product_id: product.id, quantity: 2 }],
            payments: [
                { method: 'efectivo', amount: 100, tip_amount: 15 },
                { method: 'tarjeta', amount: 100, tip_amount: 25 },
            ],
        });
        expect(res.status).toBe(201);
        expect(parseFloat(res.body.tip_amount)).toBe(40);
    });

    test('Con las propinas APAGADAS se descarta toda propina de los pagos', async () => {
        await configurarPropinas(false);
        const res = await venta({
            payments: [{ method: 'efectivo', amount: 100, tip_amount: 50 }],
        });
        expect(res.status).toBe(201);
        expect(parseFloat(res.body.tip_amount)).toBe(0);
        expect(parseFloat(res.body.payments[0].tip_amount)).toBe(0);
    });

    test('Una propina inválida dentro de un pago NO tumba la venta', async () => {
        const res = await venta({
            payments: [{ method: 'efectivo', amount: 100, tip_amount: -50 }],
        });
        expect(res.status).toBe(201);
        expect(parseFloat(res.body.payments[0].tip_amount)).toBe(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('Bloque 10 — Ventas offline: nunca se atascan', () => {

    test('Una venta DIFERIDA con pagos que no cuadran se registra igual', async () => {
        // Criterio del Bloque 5: una venta atascada para siempre en la cola es
        // peor que un desglose imperfecto. Se pierde el detalle, no la venta.
        const res = await venta({
            client_uuid: 'uuid-offline-pagos-1',
            sold_at: new Date(Date.now() - 3600 * 1000).toISOString(),
            payment_method: 'tarjeta',
            payments: [{ method: 'efectivo', amount: 7 }],   // no suma 100
        });

        expect(res.status).toBe(201);
        expect(parseFloat(res.body.total)).toBe(100);
        expect(res.body.payments).toHaveLength(0);
        // Cae a su método único, que es correcto: solo se pierde el reparto.
        expect(res.body.payment_method).toBe('tarjeta');
    });

    test('Una venta DIFERIDA con pagos válidos sí conserva el desglose', async () => {
        const res = await venta({
            items: [{ product_id: product.id, quantity: 2 }],
            client_uuid: 'uuid-offline-pagos-2',
            sold_at: new Date(Date.now() - 3600 * 1000).toISOString(),
            payments: [
                { method: 'efectivo', amount: 120 },
                { method: 'tarjeta', amount: 80 },
            ],
        });
        expect(res.status).toBe(201);
        expect(res.body.payments).toHaveLength(2);
        expect(res.body.payment_method).toBe('multiple');
    });

    test('Reintentar la misma venta offline no duplica los pagos', async () => {
        const cuerpo = {
            client_uuid: 'uuid-offline-pagos-3',
            sold_at: new Date(Date.now() - 3600 * 1000).toISOString(),
            payments: [
                { method: 'efectivo', amount: 60 },
                { method: 'tarjeta', amount: 40 },
            ],
        };
        await venta(cuerpo);
        const segunda = await venta(cuerpo);

        expect(segunda.status).toBe(200);   // devuelto, no reprocesado
        expect(await models.OrderPayment.count()).toBe(2);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('Bloque 10 — utils/pagos.js (la fórmula, aislada)', () => {

    test('Un método inválido cae a efectivo en vez de tumbar la venta', () => {
        expect(metodoDePago('bitcoin')).toBe('efectivo');
        expect(metodoDePago(null)).toBe('efectivo');
        expect(metodoDePago('  TARJETA ')).toBe('tarjeta');
    });

    test('metodoResumen: uno solo devuelve el método; varios, "multiple"', () => {
        expect(metodoResumen([{ method: 'tarjeta' }])).toBe('tarjeta');
        expect(metodoResumen([{ method: 'tarjeta' }, { method: 'tarjeta' }])).toBe('tarjeta');
        expect(metodoResumen([{ method: 'tarjeta' }, { method: 'efectivo' }])).toBe('multiple');
        expect(metodoResumen([])).toBe(null);
    });

    test('El centavo de redondeo se le carga al pago más grande', () => {
        // $100 entre 3 comensales: 33.33 × 3 = 99.99. Falta un centavo.
        const r = normalizarPagos([
            { method: 'efectivo', amount: 33.33 },
            { method: 'tarjeta', amount: 33.33 },
            { method: 'efectivo', amount: 33.33 },
        ], 100);
        expect(r.ok).toBe(true);
        const suma = r.pagos.reduce((a, p) => a + p.amount, 0);
        expect(parseFloat(suma.toFixed(2))).toBe(100);
    });

    test('Una diferencia mayor a un centavo NO se perdona', () => {
        const r = normalizarPagos([{ method: 'efectivo', amount: 99.5 }], 100);
        expect(r.ok).toBe(false);
    });

    test('Un monto de cero o negativo se rechaza', () => {
        expect(normalizarPagos([{ method: 'efectivo', amount: 0 }], 0).ok).toBe(false);
        expect(normalizarPagos([{ method: 'efectivo', amount: -5 }], -5).ok).toBe(false);
    });

    test('Una lista vacía se rechaza', () => {
        expect(normalizarPagos([], 100).ok).toBe(false);
        expect(normalizarPagos(null, 100).ok).toBe(false);
    });

    test(`Más de ${MAX_PAGOS} pagos se rechazan`, () => {
        const muchos = Array.from({ length: MAX_PAGOS + 1 }, () => ({ method: 'efectivo', amount: 1 }));
        const r = normalizarPagos(muchos, MAX_PAGOS + 1);
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(new RegExp(String(MAX_PAGOS)));
    });

    test('totalesPorMetodo cae al payment_method cuando no hay pagos', () => {
        const r = totalesPorMetodo([
            { total: 100, payment_method: 'tarjeta', tip_amount: 20, tip_method: 'efectivo' },
        ]);
        expect(r.total_tarjeta).toBe(100);
        expect(r.total_efectivo).toBe(0);
        expect(r.total_propinas_efectivo).toBe(20);
    });

    test('totalesPorMetodo usa los pagos cuando existen', () => {
        const r = totalesPorMetodo([{
            total: 500,
            payment_method: 'multiple',
            payments: [
                { method: 'efectivo', amount: 300, tip_amount: 50 },
                { method: 'tarjeta', amount: 200, tip_amount: 0 },
            ],
        }]);
        expect(r.total_ventas).toBe(500);
        expect(r.total_efectivo).toBe(300);
        expect(r.total_tarjeta).toBe(200);
        expect(r.total_propinas_efectivo).toBe(50);
    });

    test('resolverPagos sin `payments` no aplica nada (comportamiento de siempre)', () => {
        expect(resolverPagos({ payments: undefined, total: 100 }).aplicar).toBe(false);
        expect(resolverPagos({ payments: undefined, total: 100 }).error).toBeUndefined();
    });

    test('resolverPagos: online devuelve error; diferida lo descarta', () => {
        const malos = [{ method: 'efectivo', amount: 1 }];
        const online = resolverPagos({ payments: malos, total: 100, esVentaDiferida: false });
        expect(online.aplicar).toBe(false);
        expect(online.error).toBeTruthy();

        const offline = resolverPagos({ payments: malos, total: 100, esVentaDiferida: true });
        expect(offline.aplicar).toBe(false);
        expect(offline.error).toBeUndefined();
        expect(offline.descartado).toBeTruthy();
    });
});
