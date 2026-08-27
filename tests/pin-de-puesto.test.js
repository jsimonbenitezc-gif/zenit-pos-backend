/**
 * PIN DE PUESTO en las acciones privilegiadas (deuda técnica §12.2, 2026-08-26).
 *
 * ─── LO QUE ESTABA ROTO ──────────────────────────────────────────────────────
 * Zenit tiene DOS credenciales (§19.19): el **PIN de PUESTO** que vive en
 * `settings.permisos_roles` del dueño y que es lo único que el cajero teclea en
 * el POS, y la **contraseña de CUENTA** de un `User` real con email.
 *
 * Cancelar un pedido, devolverlo, editar un cliente y aplicar un descuento con
 * PIN solo aceptaban la SEGUNDA. Como los puestos son roles compartidos sin
 * cuenta, el cajero no tenía forma de producirla: la función nacía muerta.
 *   · desktop → mandaba `pin: null`            → 400
 *   · mobile  → mandaba `employee_id: 'cajero'` → 403 (no existe ese usuario)
 *
 * Estas pruebas fijan que las cuatro acciones acepten AMBAS credenciales.
 */
jest.mock('../utils/push', () => ({
    enviarNotificacion: jest.fn(),
    getPrefs: jest.fn().mockResolvedValue({}),
}));

const request = require('supertest');
const bcrypt = require('bcrypt');
const { app, sequelize, models, initTestDb, createTestOwner } = require('./setup');

let owner, ownerToken, product, cliente, cuentaEmpleado;

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const PIN_CAJERO = '4321';

/** Configura el puesto `cajero` con (o sin) PIN, como lo haría el dueño. */
async function configurarPuesto({ conPin = true } = {}) {
    const settings = JSON.parse(owner.settings || '{}');
    settings.permisos_roles = {
        cajero: conPin
            ? { enabled: true, pin_set: true, pin_bcrypt: await bcrypt.hash(PIN_CAJERO, 10) }
            : { enabled: true, pin_set: false },
    };
    await owner.update({ settings: JSON.stringify(settings) });
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

    cuentaEmpleado = await models.User.create({
        username: `staff_pin_${owner.id}@test.com`,
        password: 'ClaveDeCuenta1',
        name: 'Ana con cuenta',
        role: 'cashier',
        business_id: owner.id,
    });
});

beforeEach(async () => {
    await configurarPuesto({ conPin: true });
    cliente = await models.Customer.create({
        name: 'Cliente Prueba', phone: `55${Date.now() % 100000000}`, business_id: owner.id,
    });
});

afterEach(async () => {
    await models.PrivilegedActionLog.destroy({ where: {} });
    await models.OrderItem.destroy({ where: {} });
    await models.Order.destroy({ where: {} });
    await models.Customer.destroy({ where: {} });
});

afterAll(async () => {
    await sequelize.close();
});

// ═══════════════════════════════════════════════════════════════════════════
describe('§12.2 — Cancelar un pedido con el PIN del puesto', () => {

    test('El cajero cancela con `role` + su PIN de puesto', async () => {
        const pedido = (await venta()).body;

        const res = await request(app)
            .put(`/api/orders/${pedido.id}/status`)
            .set(auth(ownerToken))
            .send({ status: 'cancelado', role: 'cajero', pin: PIN_CAJERO, employee_name: 'Ana' });

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('cancelado');
    });

    test('REGRESIÓN: el desktop mandaba pin null → ya no puede pasar en silencio', async () => {
        const pedido = (await venta()).body;
        const res = await request(app)
            .put(`/api/orders/${pedido.id}/status`)
            .set(auth(ownerToken))
            .send({ status: 'cancelado', role: 'cajero', pin: null });
        expect(res.status).toBe(400);
    });

    test('REGRESIÓN: el mobile mandaba el puesto como employee_id → daba 403', async () => {
        const pedido = (await venta()).body;
        // Así lo mandaba antes: 'cajero' en el campo del id de cuenta.
        const res = await request(app)
            .put(`/api/orders/${pedido.id}/status`)
            .set(auth(ownerToken))
            .send({ status: 'cancelado', employee_id: 'cajero', pin: PIN_CAJERO });
        expect(res.status).toBe(403);

        // Y así lo manda ahora: funciona.
        const ok = await request(app)
            .put(`/api/orders/${pedido.id}/status`)
            .set(auth(ownerToken))
            .send({ status: 'cancelado', role: 'cajero', pin: PIN_CAJERO });
        expect(ok.status).toBe(200);
    });

    test('Un PIN de puesto incorrecto sigue dando 403', async () => {
        const pedido = (await venta()).body;
        const res = await request(app)
            .put(`/api/orders/${pedido.id}/status`)
            .set(auth(ownerToken))
            .send({ status: 'cancelado', role: 'cajero', pin: '0000' });
        expect(res.status).toBe(403);
    });

    test('La contraseña de CUENTA sigue funcionando (staff con email)', async () => {
        const pedido = (await venta()).body;
        const res = await request(app)
            .put(`/api/orders/${pedido.id}/status`)
            .set(auth(ownerToken))
            .send({ status: 'cancelado', employee_id: cuentaEmpleado.id, pin: 'ClaveDeCuenta1' });
        expect(res.status).toBe(200);
    });

    test('Sin ninguna credencial sigue dando 400', async () => {
        const pedido = (await venta()).body;
        const res = await request(app)
            .put(`/api/orders/${pedido.id}/status`)
            .set(auth(ownerToken))
            .send({ status: 'cancelado' });
        expect(res.status).toBe(400);
    });

    test('La cancelación con PIN de puesto queda AUDITADA', async () => {
        const pedido = (await venta()).body;
        await request(app)
            .put(`/api/orders/${pedido.id}/status`)
            .set(auth(ownerToken))
            .send({ status: 'cancelado', role: 'cajero', pin: PIN_CAJERO, employee_name: 'Ana' });

        const logs = await models.PrivilegedActionLog.findAll({ where: { action_type: 'cancel_order' } });
        expect(logs).toHaveLength(1);
        // No hay un User por puesto: se atribuye a la cuenta del equipo y el
        // puesto (o el nombre que mande el cliente) queda en el nombre.
        expect(logs[0].employee_id).toBe(owner.id);
        expect(logs[0].employee_name).toBe('Ana');
    });

    test('Cancelar con PIN de puesto restaura los insumos igual que antes', async () => {
        const ingrediente = await models.Ingredient.create({
            name: 'Queso', unit: 'kg', stock: 10, business_id: owner.id,
        });
        await models.ProductRecipe.create({
            product_id: product.id, item_type: 'ingredient', item_id: ingrediente.id,
            quantity: 2, unit_recipe: 'kg',
        });

        const pedido = (await venta()).body;
        await ingrediente.reload();
        const stockTrasVenta = parseFloat(ingrediente.stock);

        await request(app)
            .put(`/api/orders/${pedido.id}/status`)
            .set(auth(ownerToken))
            .send({ status: 'cancelado', role: 'cajero', pin: PIN_CAJERO });

        await ingrediente.reload();
        expect(parseFloat(ingrediente.stock)).toBeCloseTo(stockTrasVenta + 2, 2);

        await models.ProductRecipe.destroy({ where: {} });
        await models.Ingredient.destroy({ where: {} });
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('§12.2 — Las otras tres acciones', () => {

    test('DELETE /:id (alias de cancelar) acepta el PIN de puesto', async () => {
        const pedido = (await venta()).body;
        const res = await request(app)
            .delete(`/api/orders/${pedido.id}`)
            .set(auth(ownerToken))
            .send({ role: 'cajero', pin: PIN_CAJERO });
        expect(res.status).toBe(200);
    });

    test('La devolución acepta el PIN de puesto', async () => {
        const pedido = (await venta()).body;
        await request(app)
            .put(`/api/orders/${pedido.id}/status`)
            .set(auth(ownerToken))
            .send({ status: 'completado' });

        const res = await request(app)
            .post(`/api/orders/${pedido.id}/devolucion`)
            .set(auth(ownerToken))
            .send({ role: 'cajero', pin: PIN_CAJERO, motivo: 'Producto en mal estado' });

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('devuelto');
    });

    test('Editar un cliente acepta el PIN de puesto y lo audita', async () => {
        const res = await request(app)
            .put(`/api/customers/${cliente.id}`)
            .set(auth(ownerToken))
            .send({
                name: 'Nombre Corregido', phone: cliente.phone,
                role: 'cajero', pin: PIN_CAJERO, employee_name: 'Ana',
            });

        expect(res.status).toBe(200);
        const logs = await models.PrivilegedActionLog.findAll({ where: { action_type: 'edit_customer' } });
        expect(logs).toHaveLength(1);
    });

    test('Editar un cliente con PIN de puesto incorrecto da 403 y NO guarda', async () => {
        const res = await request(app)
            .put(`/api/customers/${cliente.id}`)
            .set(auth(ownerToken))
            .send({ name: 'No debería guardarse', phone: cliente.phone, role: 'cajero', pin: '0000' });

        expect(res.status).toBe(403);
        await cliente.reload();
        expect(cliente.name).toBe('Cliente Prueba');
    });

    test('Un descuento que exige PIN se aplica con el PIN de puesto', async () => {
        const descuento = await models.Discount.create({
            name: 'Cortesía', type: 'fixed', value: 20,
            requires_pin: true, is_active: true, business_id: owner.id,
        });

        const res = await venta({
            discount_amount: 20,
            discount_id: descuento.id,
            role: 'cajero',
            pin: PIN_CAJERO,
        });

        expect(res.status).toBe(201);
        expect(parseFloat(res.body.total)).toBe(80);
        await models.Discount.destroy({ where: {} });
    });

    test('Un descuento que exige PIN se RECHAZA sin credencial', async () => {
        const descuento = await models.Discount.create({
            name: 'Cortesía', type: 'fixed', value: 20,
            requires_pin: true, is_active: true, business_id: owner.id,
        });

        const res = await venta({ discount_amount: 20, discount_id: descuento.id });
        expect(res.status).toBe(403);
        await models.Discount.destroy({ where: {} });
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('§12.2 — Puesto SIN PIN configurado', () => {

    // Decisión del bloque: si el dueño no le puso PIN a ese puesto, no hay nada
    // contra qué validar. Exigir uno dejaría al negocio SIN PODER CANCELAR, que
    // es justo lo que este arreglo viene a resolver. Mismo criterio que el §28.4
    // (el dueño puede apagar el PIN de los movimientos de caja).

    test('Se puede cancelar solo confirmando, sin teclear PIN', async () => {
        await configurarPuesto({ conPin: false });
        const pedido = (await venta()).body;

        const res = await request(app)
            .put(`/api/orders/${pedido.id}/status`)
            .set(auth(ownerToken))
            .send({ status: 'cancelado', role: 'cajero', employee_name: 'Ana' });

        expect(res.status).toBe(200);
    });

    test('Aun sin PIN, la acción SIGUE quedando auditada', async () => {
        await configurarPuesto({ conPin: false });
        const pedido = (await venta()).body;

        await request(app)
            .put(`/api/orders/${pedido.id}/status`)
            .set(auth(ownerToken))
            .send({ status: 'cancelado', role: 'cajero', employee_name: 'Ana' });

        const logs = await models.PrivilegedActionLog.findAll({ where: { action_type: 'cancel_order' } });
        expect(logs).toHaveLength(1);
        // Lo que se pierde es la barrera, no el rastro.
        expect(logs[0].employee_name).toBe('Ana');
    });

    test('Un puesto que NO existe en los permisos sigue dando 403', async () => {
        await configurarPuesto({ conPin: true });
        const pedido = (await venta()).body;

        const res = await request(app)
            .put(`/api/orders/${pedido.id}/status`)
            .set(auth(ownerToken))
            .send({ status: 'cancelado', role: 'puesto_inventado', pin: PIN_CAJERO });

        expect(res.status).toBe(403);
    });
});
