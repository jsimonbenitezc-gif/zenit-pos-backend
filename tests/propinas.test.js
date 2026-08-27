/**
 * BLOQUE 9 V5 — Propinas.
 *
 * Lo que se prueba, en orden de importancia:
 *   1. Que la propina NO sea una venta: no entra en `total`, no paga impuesto y
 *      no infla las estadísticas ni los totales por método de pago del turno.
 *   2. Que la caja CUADRE: la propina en efectivo está en el cajón y el efectivo
 *      esperado la cuenta; la de tarjeta no.
 *   3. Que el interruptor apagado (el default) deje todo exactamente como antes.
 *   4. Que ninguna propina inválida tumbe una venta.
 *   5. Que solo el dueño configure las propinas.
 */
jest.mock('../utils/push', () => ({
    enviarNotificacion: jest.fn(),
    getPrefs: jest.fn().mockResolvedValue({}),
}));

const request = require('supertest');
const { app, sequelize, models, initTestDb, createTestOwner } = require('./setup');
const {
    normalizarPropina, normalizarMetodo, normalizarSugerencias,
    configDeAjustes, resolverPropina, totalesPropinas,
    invalidarPropinasNegocio, SUGERENCIAS_DEFAULT,
} = require('../utils/propinas');

let owner, ownerToken, product, empleado, empleadoToken;

const auth = (token) => ({ Authorization: `Bearer ${token}` });

/** Enciende (o apaga) las propinas del negocio e invalida la caché de 60s. */
async function configurarPropinas(activas, sugerencias) {
    const settings = JSON.parse(owner.settings || '{}');
    settings.propinas_activas = activas;
    if (sugerencias !== undefined) settings.propina_sugerencias = sugerencias;
    await owner.update({ settings: JSON.stringify(settings) });
    invalidarPropinasNegocio(owner.id);
}

/** Enciende el impuesto del negocio (para probar que la propina no lo paga). */
async function configurarImpuesto({ activo, tasa, incluido }) {
    const { invalidarImpuestoNegocio } = require('../utils/impuestos');
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
        .send({ cajero_nombre: 'Ana', fondo_inicial: 500, ...body });
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

    const jwt = require('jsonwebtoken');
    empleado = await models.User.create({
        username: `cajero_prop_${owner.id}@test.com`,
        password: 'Pin12345',
        name: 'Ana Cajera',
        role: 'cashier',
        business_id: owner.id,
    });
    empleadoToken = jwt.sign(
        { id: empleado.id, username: empleado.username, role: 'cashier', business_id: owner.id },
        process.env.JWT_SECRET,
        { expiresIn: '1d' }
    );
});

beforeEach(async () => {
    await configurarPropinas(true);
    await configurarImpuesto({ activo: false, tasa: 0, incluido: true });
});

afterEach(async () => {
    await models.CashMovement.destroy({ where: {} });
    await models.Turno.destroy({ where: {} });
    await models.OrderItem.destroy({ where: {} });
    await models.Order.destroy({ where: {} });
});

afterAll(async () => {
    await sequelize.close();
});

// ═══════════════════════════════════════════════════════════════════════════
describe('Bloque 9 — La propina no es una venta', () => {

    test('La propina NO entra en el total del pedido', async () => {
        const res = await venta({ tip_amount: 20 });
        expect(res.status).toBe(201);
        // El cliente entregó $120, pero el negocio vendió $100.
        expect(parseFloat(res.body.total)).toBe(100);
        expect(parseFloat(res.body.tip_amount)).toBe(20);
    });

    test('La propina NO paga impuesto y no rompe el invariante del Bloque 8', async () => {
        // 16% incluido: un producto de $100 se cobra en $100, de los cuales
        // $13.79 son impuesto. La propina de $50 no debe tocar ese desglose.
        await configurarImpuesto({ activo: true, tasa: 16, incluido: true });

        const res = await venta({ tip_amount: 50 });
        expect(res.status).toBe(201);

        const subtotal = parseFloat(res.body.subtotal);
        const impuesto = parseFloat(res.body.tax_amount);
        const total    = parseFloat(res.body.total);

        expect(total).toBe(100);
        expect(impuesto).toBe(13.79);
        // Invariante del Bloque 8, intacto: la propina está fuera de la ecuación.
        expect(parseFloat((subtotal + impuesto).toFixed(2))).toBe(total);
        expect(parseFloat(res.body.tip_amount)).toBe(50);
    });

    test('La propina en modo AGREGADO tampoco se grava', async () => {
        await configurarImpuesto({ activo: true, tasa: 16, incluido: false });

        const res = await venta({ tip_amount: 30 });
        expect(parseFloat(res.body.subtotal)).toBe(100);
        expect(parseFloat(res.body.tax_amount)).toBe(16);
        expect(parseFloat(res.body.total)).toBe(116); // 116, no 116 + 30·16%
        expect(parseFloat(res.body.tip_amount)).toBe(30);
    });

    test('El descuento baja la base gravable; la propina no la toca', async () => {
        await configurarImpuesto({ activo: true, tasa: 10, incluido: false });
        const descuento = await models.Discount.create({
            name: '20 de descuento', type: 'fixed', value: 20, business_id: owner.id,
        });

        const res = await venta({ discount_amount: 20, discount_id: descuento.id, tip_amount: 15 });
        // base 100 − 20 = 80 → impuesto 8 → total 88. La propina va aparte.
        expect(parseFloat(res.body.subtotal)).toBe(80);
        expect(parseFloat(res.body.tax_amount)).toBe(8);
        expect(parseFloat(res.body.total)).toBe(88);
        expect(parseFloat(res.body.tip_amount)).toBe(15);
    });

    test('El dashboard reporta la propina aparte, sin inflar las ventas', async () => {
        await venta({ tip_amount: 25 });
        await venta({ tip_amount: 15 });

        const res = await request(app).get('/api/stats/dashboard').set(auth(ownerToken));
        expect(res.status).toBe(200);
        expect(res.body.ventasHoy.monto_total).toBe(200);   // 2 × $100
        expect(res.body.ventasHoy.propinas_total).toBe(40); // 25 + 15, aparte
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('Bloque 9 — La caja cuadra', () => {

    test('La propina en efectivo entra al efectivo esperado, pero no a las ventas', async () => {
        const turno = (await abrirTurno({ fondo_inicial: 500 })).body;

        await venta({ tip_amount: 20 }); // $100 venta + $20 propina, todo efectivo
        await venta({ tip_amount: 30 });

        const totales = await request(app).get(`/api/turnos/${turno.id}/totales`).set(auth(ownerToken));
        // Las ventas siguen siendo $200: la propina no las infla.
        expect(totales.body.total_ventas).toBe(200);
        expect(totales.body.total_efectivo).toBe(200);
        // Pero los $50 SÍ están en el cajón.
        expect(totales.body.total_propinas).toBe(50);
        expect(totales.body.total_propinas_efectivo).toBe(50);
        // esperado = 500 fondo + 200 ventas + 50 propinas = 750
        expect(totales.body.efectivo_esperado).toBe(750);
    });

    test('La propina en TARJETA no se le exige al cajero en el cajón', async () => {
        const turno = (await abrirTurno({ fondo_inicial: 500 })).body;

        // Cuenta con tarjeta y propina con tarjeta: nada de esto toca el cajón.
        await venta({ payment_method: 'tarjeta', tip_amount: 40 });

        const totales = await request(app).get(`/api/turnos/${turno.id}/totales`).set(auth(ownerToken));
        expect(totales.body.total_tarjeta).toBe(100);
        expect(totales.body.total_propinas).toBe(40);
        expect(totales.body.total_propinas_tarjeta).toBe(40);
        expect(totales.body.total_propinas_efectivo).toBe(0);
        expect(totales.body.efectivo_esperado).toBe(500); // solo el fondo
    });

    test('Cuenta con tarjeta y propina en efectivo: la propina sí está en el cajón', async () => {
        const turno = (await abrirTurno({ fondo_inicial: 500 })).body;

        await venta({ payment_method: 'tarjeta', tip_amount: 60, tip_method: 'efectivo' });

        const totales = await request(app).get(`/api/turnos/${turno.id}/totales`).set(auth(ownerToken));
        expect(totales.body.total_tarjeta).toBe(100);
        expect(totales.body.total_efectivo).toBe(0);
        expect(totales.body.total_propinas_efectivo).toBe(60);
        expect(totales.body.efectivo_esperado).toBe(560);
    });

    test('El cierre congela las propinas y la diferencia sale en cero', async () => {
        const turno = (await abrirTurno({ fondo_inicial: 500 })).body;

        await venta({ tip_amount: 20 });
        await venta({ payment_method: 'tarjeta', tip_amount: 30, tip_method: 'tarjeta' });

        // El cajero cuenta 500 + 100 (venta efectivo) + 20 (propina efectivo) = 620.
        const cierre = await request(app)
            .put(`/api/turnos/${turno.id}/cerrar`)
            .set(auth(ownerToken))
            .send({ efectivo_contado: 620 });

        expect(cierre.status).toBe(200);
        expect(parseFloat(cierre.body.diferencia)).toBe(0);
        expect(parseFloat(cierre.body.total_ventas)).toBe(200);
        expect(parseFloat(cierre.body.total_propinas)).toBe(50);
        expect(parseFloat(cierre.body.total_propinas_efectivo)).toBe(20);
        expect(parseFloat(cierre.body.total_propinas_tarjeta)).toBe(30);
    });

    test('Sin este bloque la propina en efectivo aparecería como sobrante', async () => {
        // Regresión explícita del motivo del bloque: si el efectivo esperado
        // ignorara la propina, contar el dinero real daría un "sobrante" de $20.
        const turno = (await abrirTurno({ fondo_inicial: 0 })).body;
        await venta({ tip_amount: 20 });

        const cierre = await request(app)
            .put(`/api/turnos/${turno.id}/cerrar`)
            .set(auth(ownerToken))
            .send({ efectivo_contado: 120 });

        expect(parseFloat(cierre.body.diferencia)).toBe(0);
    });

    test('Pagar la propina al empleado sale como retiro y vuelve a cuadrar', async () => {
        const turno = (await abrirTurno({ fondo_inicial: 0 })).body;
        await venta({ tip_amount: 20 });

        // El cajero le entrega la propina al mesero: sale como retiro (Bloque 7).
        await request(app)
            .post(`/api/turnos/${turno.id}/movimientos`)
            .set(auth(ownerToken))
            .send({ tipo: 'retiro', monto: 20, motivo: 'Pago de propinas', employee_id: empleado.id, pin: 'Pin12345' });

        const totales = await request(app).get(`/api/turnos/${turno.id}/totales`).set(auth(ownerToken));
        // 0 fondo + 100 venta + 20 propina − 20 retiro = 100
        expect(totales.body.efectivo_esperado).toBe(100);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('Bloque 9 — El interruptor', () => {

    test('Apagado (el default) descarta la propina que mande un cliente', async () => {
        await configurarPropinas(false);

        const res = await venta({ tip_amount: 50 });
        expect(res.status).toBe(201);
        expect(parseFloat(res.body.tip_amount)).toBe(0);
        expect(res.body.tip_method).toBeNull();
        expect(parseFloat(res.body.total)).toBe(100);
    });

    test('Un negocio sin configurar nace con las propinas apagadas', () => {
        expect(configDeAjustes({}).activo).toBe(false);
        expect(configDeAjustes({}).sugerencias).toEqual(SUGERENCIAS_DEFAULT);
    });

    test('Con las propinas apagadas el corte no reporta ninguna', async () => {
        await configurarPropinas(false);
        const turno = (await abrirTurno({ fondo_inicial: 100 })).body;
        await venta({ tip_amount: 50 });

        const totales = await request(app).get(`/api/turnos/${turno.id}/totales`).set(auth(ownerToken));
        expect(totales.body.total_propinas).toBe(0);
        expect(totales.body.efectivo_esperado).toBe(200); // 100 fondo + 100 venta
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('Bloque 9 — Ninguna propina inválida tumba una venta', () => {

    test.each([
        ['negativa',      -10],
        ['cero',          0],
        ['texto',         'mucha'],
        ['absurda',       9999999],
        ['null',          null],
    ])('Propina %s: la venta se registra igual, con propina 0', async (_caso, valor) => {
        const res = await venta({ tip_amount: valor });
        expect(res.status).toBe(201);
        expect(parseFloat(res.body.tip_amount)).toBe(0);
        expect(parseFloat(res.body.total)).toBe(100);
    });

    test('Un método de propina inventado cae al método del pago', async () => {
        const res = await venta({ payment_method: 'tarjeta', tip_amount: 10, tip_method: 'bitcoin' });
        expect(res.body.tip_method).toBe('tarjeta');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('Bloque 9 — Cobro de mesa', () => {

    test('Al cobrar la mesa se registran el método de pago Y la propina', async () => {
        const mesa = await models.Table.create({ name: 'Mesa 1', business_id: owner.id });
        const abierta = await venta({ table_id: mesa.id, client_uuid: 'uuid-mesa-propina-1' });
        expect(abierta.status).toBe(201);

        const cobro = await request(app)
            .put(`/api/orders/${abierta.body.id}/status`)
            .set(auth(ownerToken))
            .send({ status: 'completado', payment_method: 'tarjeta', tip_amount: 35, tip_method: 'efectivo' });

        expect(cobro.status).toBe(200);
        expect(cobro.body.payment_method).toBe('tarjeta');
        expect(parseFloat(cobro.body.tip_amount)).toBe(35);
        expect(cobro.body.tip_method).toBe('efectivo');
        expect(parseFloat(cobro.body.total)).toBe(100); // la propina no infló la cuenta
    });

    test('REGRESIÓN: cobrar la mesa con tarjeta ya no se guarda como efectivo', async () => {
        // Bug preexistente corregido en este bloque: PUT /:id/status descartaba
        // `payment_method`, así que toda mesa cobrada con tarjeta le exigía al
        // cajero un efectivo que nunca entró al cajón.
        const turno = (await abrirTurno({ fondo_inicial: 0 })).body;
        const mesa = await models.Table.create({ name: 'Mesa 2', business_id: owner.id });
        const abierta = await venta({ table_id: mesa.id, client_uuid: 'uuid-mesa-propina-2' });

        await request(app)
            .put(`/api/orders/${abierta.body.id}/status`)
            .set(auth(ownerToken))
            .send({ status: 'completado', payment_method: 'tarjeta' });

        const totales = await request(app).get(`/api/turnos/${turno.id}/totales`).set(auth(ownerToken));
        expect(totales.body.total_tarjeta).toBe(100);
        expect(totales.body.total_efectivo).toBe(0);
        expect(totales.body.efectivo_esperado).toBe(0);
    });

    test('Cancelar una mesa no le registra propina ni cambia el método', async () => {
        const mesa = await models.Table.create({ name: 'Mesa 3', business_id: owner.id });
        const abierta = await venta({ table_id: mesa.id, client_uuid: 'uuid-mesa-propina-3' });

        const cancel = await request(app)
            .put(`/api/orders/${abierta.body.id}/status`)
            .set(auth(ownerToken))
            .send({ status: 'cancelado', payment_method: 'tarjeta', tip_amount: 99, employee_id: empleado.id, pin: 'Pin12345' });

        expect(cancel.status).toBe(200);
        expect(parseFloat(cancel.body.tip_amount)).toBe(0);
        expect(cancel.body.payment_method).toBe('efectivo');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('Bloque 9 — Configurar las propinas es del dueño', () => {

    test('El dueño puede encender las propinas y elegir los porcentajes', async () => {
        const res = await request(app)
            .put('/api/settings')
            .set(auth(ownerToken))
            .send({ propinas_activas: true, propina_sugerencias: [5, 10, 15] });

        expect(res.status).toBe(200);
        expect(res.body.propinas_activas).toBe(true);
        expect(res.body.propina_sugerencias).toEqual([5, 10, 15]);
    });

    test('Un empleado NO puede cambiar la configuración de propinas', async () => {
        const res = await request(app)
            .put('/api/settings')
            .set(auth(empleadoToken))
            .send({ propinas_activas: true });

        expect(res.status).toBe(403);
        expect(res.body.error).toMatch(/administrador/i);
    });

    test('Porcentajes basura se limpian en vez de rechazar el guardado', async () => {
        const res = await request(app)
            .put('/api/settings')
            .set(auth(ownerToken))
            .send({ propinas_activas: true, propina_sugerencias: [-5, 0, 'hola', 200, 12] });

        expect(res.status).toBe(200);
        expect(res.body.propina_sugerencias).toEqual([12]);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('Bloque 9 — utils/propinas.js', () => {

    test('normalizarPropina descarta lo inservible sin lanzar', () => {
        expect(normalizarPropina(25)).toBe(25);
        expect(normalizarPropina('12.345')).toBe(12.35);
        expect(normalizarPropina(-1)).toBe(0);
        expect(normalizarPropina(0)).toBe(0);
        expect(normalizarPropina(NaN)).toBe(0);
        expect(normalizarPropina(undefined)).toBe(0);
        expect(normalizarPropina(1000001)).toBe(0);
    });

    test('normalizarMetodo hereda el del pago cuando no viene uno válido', () => {
        expect(normalizarMetodo('efectivo', 'tarjeta')).toBe('efectivo');
        expect(normalizarMetodo(null, 'tarjeta')).toBe('tarjeta');
        expect(normalizarMetodo('cheque', 'transferencia')).toBe('transferencia');
        expect(normalizarMetodo(null, null)).toBe('efectivo');
    });

    test('normalizarSugerencias acepta array y texto, y quita duplicados', () => {
        expect(normalizarSugerencias([10, 15, 20])).toEqual([10, 15, 20]);
        expect(normalizarSugerencias('10,15,20')).toEqual([10, 15, 20]);
        expect(normalizarSugerencias([10, 10, 15])).toEqual([10, 15]);
        expect(normalizarSugerencias([1, 2, 3, 4, 5])).toEqual([1, 2, 3, 4]); // máx 4
        expect(normalizarSugerencias('basura')).toEqual(SUGERENCIAS_DEFAULT);
        expect(normalizarSugerencias(undefined)).toEqual(SUGERENCIAS_DEFAULT);
    });

    test('resolverPropina devuelve 0 con el interruptor apagado', () => {
        const apagado = { activo: false, sugerencias: [] };
        expect(resolverPropina({ config: apagado, tipAmount: 50 })).toEqual({ monto: 0, metodo: null });
    });

    test('totalesPropinas separa por método y usa el del pago como herencia', () => {
        const r = totalesPropinas([
            { tip_amount: 10, tip_method: 'efectivo', payment_method: 'tarjeta' },
            { tip_amount: 20, tip_method: null,       payment_method: 'tarjeta' },
            { tip_amount: 5,  tip_method: null,       payment_method: 'transferencia' },
            { tip_amount: 0,  tip_method: 'efectivo', payment_method: 'efectivo' },
        ]);
        expect(r.total_propinas).toBe(35);
        expect(r.total_propinas_efectivo).toBe(10);
        expect(r.total_propinas_tarjeta).toBe(20);
        expect(r.total_propinas_transferencia).toBe(5);
    });
});
