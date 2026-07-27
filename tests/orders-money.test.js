jest.mock('../utils/push', () => ({
    enviarNotificacion: jest.fn(),
    getPrefs: jest.fn().mockResolvedValue({}),
}));

const request = require('supertest');
const { app, sequelize, models, initTestDb, createTestOwner } = require('./setup');

let owner, ownerToken, product, ingrediente;

// Crea un pedido base (mostrador) y devuelve su id
async function crearPedido(qty = 1, extra = {}) {
    const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ items: [{ product_id: product.id, quantity: qty }], skip_stock_check: true, ...extra });
    return res;
}

beforeAll(async () => {
    await initTestDb();

    const result = await createTestOwner();
    owner = result.user;
    ownerToken = result.token;

    const category = await models.Category.create({ name: 'Comida', business_id: owner.id });
    product = await models.Product.create({ name: 'Taco', price: 30.00, category_id: category.id, business_id: owner.id });

    // Ingrediente + receta para probar restauración de stock
    ingrediente = await models.Ingredient.create({
        name: 'Tortilla', unit: 'pcs', stock: 100, min_stock: 0, business_id: owner.id,
    });
    await models.ProductRecipe.create({
        product_id: product.id, item_type: 'ingredient', item_id: ingrediente.id, quantity: 2, unit_recipe: 'pcs',
    });
});

afterAll(async () => {
    await sequelize.close();
});

describe('Bloque 1 — Seguridad de dinero', () => {

    // ── Descuentos ──────────────────────────────────────────────────────
    test('Descuento manual SIN PIN ni discount_id → 403', async () => {
        const res = await crearPedido(1, { discount_amount: 10 });
        expect(res.status).toBe(403);
        expect(res.body.error).toMatch(/PIN/i);
    });

    test('Descuento manual CON PIN → 201 y queda registrado en auditoría', async () => {
        const res = await crearPedido(1, {
            discount_amount: 10, employee_id: owner.id, pin: 'TestPass123',
        });
        expect(res.status).toBe(201);
        expect(parseFloat(res.body.total)).toBe(20.00); // 30 - 10
        expect(parseFloat(res.body.discount_amount)).toBe(10.00);

        const logs = await models.PrivilegedActionLog.findAll({
            where: { business_id: owner.id, action_type: 'apply_discount', target_description: `Pedido #${res.body.id}` },
        });
        expect(logs.length).toBe(1);
        const after = JSON.parse(logs[0].after_data);
        expect(after.discount_amount).toBe(10);
    });

    test('Descuento manual con PIN incorrecto → 403', async () => {
        const res = await crearPedido(1, { discount_amount: 5, employee_id: owner.id, pin: 'malo999' });
        expect(res.status).toBe(403);
    });

    test('Descuento vía discount_id configurado (sin requires_pin) → 201 sin PIN', async () => {
        const desc = await models.Discount.create({
            name: 'Promo', type: 'fixed', value: 5, requires_pin: false, business_id: owner.id,
        });
        const res = await crearPedido(1, { discount_amount: 5, discount_id: desc.id });
        expect(res.status).toBe(201);
        expect(parseFloat(res.body.total)).toBe(25.00);
    });

    // ── Canje de puntos: NO requiere PIN (el cliente gasta lo que ganó) ─
    test('Canje de puntos sin PIN → 201 (no es descuento de empleado)', async () => {
        const cliente = await models.Customer.create({
            name: 'Ana', phone: '5550001', business_id: owner.id, loyalty_points: 100,
        });
        // puntos_valor por defecto = 0.10 → 100 puntos = $10
        const res = await crearPedido(1, {
            customer_id: cliente.id,
            loyalty_points_used: 100,
            loyalty_discount_amount: 10,
        });
        expect(res.status).toBe(201);
        expect(parseFloat(res.body.total)).toBe(20.00); // 30 - 10

        // No se audita como descuento de empleado
        const logs = await models.PrivilegedActionLog.findAll({
            where: { action_type: 'apply_discount', target_description: `Pedido #${res.body.id}` },
        });
        expect(logs.length).toBe(0);

        // Los puntos se descontaron del cliente
        const tras = await models.Customer.findByPk(cliente.id);
        expect(tras.loyalty_points).toBe(0);
    });

    test('Canje de puntos inflado se topa a puntos × puntos_valor', async () => {
        const cliente = await models.Customer.create({
            name: 'Beto', phone: '5550002', business_id: owner.id, loyalty_points: 50,
        });
        // Intento de abuso: 10 puntos (=$1) pero reclama $25 de descuento
        const res = await crearPedido(1, {
            customer_id: cliente.id,
            loyalty_points_used: 10,
            loyalty_discount_amount: 25,
        });
        expect(res.status).toBe(201);
        // Se topa a 10 × 0.10 = $1 → total 30 - 1 = 29
        expect(parseFloat(res.body.total)).toBe(29.00);
    });

    test('Descuento por puntos sin declarar puntos canjeados → 400', async () => {
        const res = await crearPedido(1, { loyalty_discount_amount: 15 });
        expect(res.status).toBe(400);
    });

    // ── Cancelación: rechazo sin PIN por TODAS las rutas ────────────────
    test('Cancelar sin PIN vía PUT /:id/status → 400', async () => {
        const c = await crearPedido(1);
        const res = await request(app)
            .put(`/api/orders/${c.body.id}/status`)
            .set('Authorization', `Bearer ${ownerToken}`)
            .send({ status: 'cancelado' });
        expect(res.status).toBe(400);
    });

    test('Cancelar sin PIN vía DELETE /:id → 400', async () => {
        const c = await crearPedido(1);
        const res = await request(app)
            .delete(`/api/orders/${c.body.id}`)
            .set('Authorization', `Bearer ${ownerToken}`)
            .send({});
        expect(res.status).toBe(400);
    });

    test('Cancelar vía PUT /:id genérico está bloqueado → 400', async () => {
        const c = await crearPedido(1);
        const res = await request(app)
            .put(`/api/orders/${c.body.id}`)
            .set('Authorization', `Bearer ${ownerToken}`)
            .send({ status: 'cancelado' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/cancelaci[oó]n|devoluci[oó]n|PIN/i);

        // Sigue en 'registrado', no se cambió
        const order = await models.Order.findByPk(c.body.id);
        expect(order.status).toBe('registrado');
    });

    // ── Cancelación en 'registrado' restaura stock ──────────────────────
    test('Cancelar pedido en registrado restaura el stock de insumos', async () => {
        // update estático: fuerza el SQL (una instancia cacheada en 100 haría no-op)
        await models.Ingredient.update({ stock: 100 }, { where: { id: ingrediente.id } });
        const c = await crearPedido(3); // usa 3 * 2 = 6 tortillas
        const tras = await models.Ingredient.findByPk(ingrediente.id);
        expect(parseFloat(tras.stock)).toBe(94);

        const res = await request(app)
            .put(`/api/orders/${c.body.id}/status`)
            .set('Authorization', `Bearer ${ownerToken}`)
            .send({ status: 'cancelado', employee_id: owner.id, pin: 'TestPass123' });
        expect(res.status).toBe(200);

        const restaurado = await models.Ingredient.findByPk(ingrediente.id);
        expect(parseFloat(restaurado.stock)).toBe(100);
    });

    // ── Devolución en 'completado' NO restaura stock pero cambia estado ─
    test('Devolución de pedido completado: cambia a devuelto y NO restaura stock', async () => {
        await models.Ingredient.update({ stock: 100 }, { where: { id: ingrediente.id } });
        const c = await crearPedido(2); // usa 4 tortillas → 96
        const trasVenta = await models.Ingredient.findByPk(ingrediente.id);
        expect(parseFloat(trasVenta.stock)).toBe(96);

        // Pasar a completado (transición permitida sin PIN)
        const compl = await request(app)
            .put(`/api/orders/${c.body.id}/status`)
            .set('Authorization', `Bearer ${ownerToken}`)
            .send({ status: 'completado' });
        expect(compl.status).toBe(200);

        // No se puede CANCELAR un completado
        const cancel = await request(app)
            .put(`/api/orders/${c.body.id}/status`)
            .set('Authorization', `Bearer ${ownerToken}`)
            .send({ status: 'cancelado', employee_id: owner.id, pin: 'TestPass123' });
        expect(cancel.status).toBe(400);

        // Devolución con PIN
        const dev = await request(app)
            .post(`/api/orders/${c.body.id}/devolucion`)
            .set('Authorization', `Bearer ${ownerToken}`)
            .send({ employee_id: owner.id, pin: 'TestPass123', motivo: 'Cliente insatisfecho' });
        expect(dev.status).toBe(200);
        expect(dev.body.status).toBe('devuelto');

        // Stock NO se restauró (insumos ya consumidos)
        const ing = await models.Ingredient.findByPk(ingrediente.id);
        expect(parseFloat(ing.stock)).toBe(96);

        // Auditoría
        const logs = await models.PrivilegedActionLog.findAll({
            where: { action_type: 'return_order', target_description: `Pedido #${c.body.id}` },
        });
        expect(logs.length).toBe(1);
    });

    test('Devolución de pedido en registrado → 400 (usar cancelación)', async () => {
        const c = await crearPedido(1);
        const res = await request(app)
            .post(`/api/orders/${c.body.id}/devolucion`)
            .set('Authorization', `Bearer ${ownerToken}`)
            .send({ employee_id: owner.id, pin: 'TestPass123' });
        expect(res.status).toBe(400);
    });

    // ── Stats excluye canceladas y devueltas ────────────────────────────
    test('El dashboard excluye pedidos cancelados y devueltos', async () => {
        // Estado limpio de pedidos
        await models.Order.destroy({ where: { business_id: owner.id } });

        // Venta válida de mostrador
        const v1 = await crearPedido(1); // total 30
        // Venta que se cancela
        const v2 = await crearPedido(1);
        await request(app)
            .put(`/api/orders/${v2.body.id}/status`)
            .set('Authorization', `Bearer ${ownerToken}`)
            .send({ status: 'cancelado', employee_id: owner.id, pin: 'TestPass123' });
        // Venta que se completa y se devuelve
        const v3 = await crearPedido(1);
        await request(app).put(`/api/orders/${v3.body.id}/status`)
            .set('Authorization', `Bearer ${ownerToken}`).send({ status: 'completado' });
        await request(app).post(`/api/orders/${v3.body.id}/devolucion`)
            .set('Authorization', `Bearer ${ownerToken}`).send({ employee_id: owner.id, pin: 'TestPass123' });

        // Se usa /stats/sales (agrupa por DATE, compatible con SQLite; el dashboard
        // usa EXTRACT que SQLite no soporta, pero comparte filtroVentaContable()).
        const res = await request(app)
            .get('/api/stats/sales?group_by=day')
            .set('Authorization', `Bearer ${ownerToken}`);
        expect(res.status).toBe(200);
        // Solo la venta v1 (30) debe contar: canceladas y devueltas excluidas
        const totalPedidos = res.body.reduce((s, r) => s + parseInt(r.total_pedidos), 0);
        const montoTotal = res.body.reduce((s, r) => s + parseFloat(r.monto_total), 0);
        expect(totalPedidos).toBe(1);
        expect(montoTotal).toBe(30);
    });

    test('Una mesa ABIERTA (registrado con table_id) no cuenta como venta', async () => {
        await models.Order.destroy({ where: { business_id: owner.id } });
        const mesa = await models.Table.create({ name: 'Mesa 1', business_id: owner.id });

        // Venta de mostrador válida
        await crearPedido(1); // 30
        // Mesa abierta (registrado + table_id): NO debe contar aún
        await request(app).post('/api/orders')
            .set('Authorization', `Bearer ${ownerToken}`)
            .send({ items: [{ product_id: product.id, quantity: 1 }], table_id: mesa.id, skip_stock_check: true });

        const res = await request(app)
            .get('/api/stats/sales?group_by=day')
            .set('Authorization', `Bearer ${ownerToken}`);
        const totalPedidos = res.body.reduce((s, r) => s + parseInt(r.total_pedidos), 0);
        const montoTotal = res.body.reduce((s, r) => s + parseFloat(r.monto_total), 0);
        expect(totalPedidos).toBe(1);
        expect(montoTotal).toBe(30);
    });
});
