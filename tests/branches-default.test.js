jest.mock('../utils/push', () => ({
    enviarNotificacion: jest.fn(),
    getPrefs: jest.fn().mockResolvedValue({}),
}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { app, sequelize, models, initTestDb, createTestOwner } = require('./setup');

let owner, ownerToken, product;

function tokenDe(user, extra = {}) {
    return jwt.sign(
        {
            id: user.id,
            username: user.username,
            role: user.role,
            business_id: user.business_id || user.id,
            ...extra,
        },
        process.env.JWT_SECRET,
        { expiresIn: '1d' }
    );
}

function venta(token, body = {}) {
    return request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${token}`)
        .send({ items: [{ product_id: product.id, quantity: 1 }], skip_stock_check: true, ...body });
}

function abrirTurno(token, body = {}) {
    return request(app)
        .post('/api/turnos')
        .set('Authorization', `Bearer ${token}`)
        .send({ cajero_nombre: 'Cajero', fondo_inicial: 100, ...body });
}

beforeAll(async () => {
    await initTestDb();
    const result = await createTestOwner();
    owner = result.user;
    ownerToken = result.token;

    const category = await models.Category.create({ name: 'Comida', business_id: owner.id });
    product = await models.Product.create({
        name: 'Taco', price: 30.00, category_id: category.id, business_id: owner.id,
    });
});

afterEach(async () => {
    // Cada test define su propio escenario de sucursales
    await models.Branch.destroy({ where: {}, truncate: true, cascade: true });
    await models.Turno.destroy({ where: {} });
    await models.OrderItem.destroy({ where: {} });
    await models.Order.destroy({ where: {} });
    await models.Table.destroy({ where: {} });
});

afterAll(async () => {
    await sequelize.close();
});

describe('Bloque 4 — Sucursal predeterminada', () => {

    // ── Ventas ──────────────────────────────────────────────────────────
    test('Negocio SIN sucursales: la venta se registra sin sucursal (no rompe)', async () => {
        const res = await venta(ownerToken);
        expect(res.status).toBe(201);
        expect(res.body.branch_id).toBeNull();
    });

    test('Negocio con UNA sucursal: se asigna sola aunque el cliente no la mande', async () => {
        const suc = await models.Branch.create({ name: 'Única', business_id: owner.id, active: true });
        const res = await venta(ownerToken);
        expect(res.status).toBe(201);
        expect(res.body.branch_id).toBe(suc.id);
    });

    test('Negocio con VARIAS sucursales y venta sin sucursal → 400 accionable', async () => {
        await models.Branch.create({ name: 'Centro', business_id: owner.id, active: true });
        await models.Branch.create({ name: 'Norte',  business_id: owner.id, active: true });

        const res = await venta(ownerToken);
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/sucursal/i);
        expect(await models.Order.count()).toBe(0);
    });

    test('Sucursal de otro negocio → 400 (no se puede registrar fuera del tenant)', async () => {
        await models.Branch.create({ name: 'Centro', business_id: owner.id, active: true });
        const otro = await createTestOwner();
        const ajena = await models.Branch.create({ name: 'Ajena', business_id: otro.user.id, active: true });

        const res = await venta(ownerToken, { branch_id: ajena.id });
        expect(res.status).toBe(400);
        expect(await models.Order.count()).toBe(0);
    });

    test('Sucursal desactivada → 400', async () => {
        await models.Branch.create({ name: 'Centro', business_id: owner.id, active: true });
        const vieja = await models.Branch.create({ name: 'Cerrada', business_id: owner.id, active: false });

        const res = await venta(ownerToken, { branch_id: vieja.id });
        expect(res.status).toBe(400);
    });

    // ── Empleado con sucursal asignada ──────────────────────────────────
    test('Empleado asignado a Centro vendiendo en un equipo de Norte → 403 explicativo', async () => {
        const centro = await models.Branch.create({ name: 'Centro', business_id: owner.id, active: true });
        const norte  = await models.Branch.create({ name: 'Norte',  business_id: owner.id, active: true });

        const empleado = await models.User.create({
            username: `cajero_${Date.now()}@test.com`, password: 'TestPass123', name: 'Cajero',
            role: 'cashier', business_id: owner.id, branch_id: centro.id,
        });
        const token = tokenDe(empleado, { branch_id: centro.id });

        const res = await venta(token, { branch_id: norte.id });
        expect(res.status).toBe(403);
        expect(res.body.error).toMatch(/Centro/);
        expect(res.body.error).toMatch(/Norte/);
        expect(await models.Order.count()).toBe(0);
    });

    test('Empleado asignado a Centro sin mandar sucursal → se registra en Centro', async () => {
        const centro = await models.Branch.create({ name: 'Centro', business_id: owner.id, active: true });
        await models.Branch.create({ name: 'Norte', business_id: owner.id, active: true });

        const empleado = await models.User.create({
            username: `cajero2_${Date.now()}@test.com`, password: 'TestPass123', name: 'Cajero 2',
            role: 'cashier', business_id: owner.id, branch_id: centro.id,
        });
        const token = tokenDe(empleado, { branch_id: centro.id });

        const res = await venta(token);
        expect(res.status).toBe(201);
        expect(res.body.branch_id).toBe(centro.id);
    });

    // ── Turnos ──────────────────────────────────────────────────────────
    test('Turno sin sucursal con VARIAS sucursales → 400', async () => {
        await models.Branch.create({ name: 'Centro', business_id: owner.id, active: true });
        await models.Branch.create({ name: 'Norte',  business_id: owner.id, active: true });

        const res = await abrirTurno(ownerToken);
        expect(res.status).toBe(400);
        expect(await models.Turno.count()).toBe(0);
    });

    test('Turno con UNA sucursal: se asigna sola', async () => {
        const suc = await models.Branch.create({ name: 'Única', business_id: owner.id, active: true });
        const res = await abrirTurno(ownerToken);
        expect(res.status).toBe(201);
        expect(res.body.branch_id).toBe(suc.id);
    });

    test('El cierre de un turno solo cuenta los pedidos de SU sucursal', async () => {
        const centro = await models.Branch.create({ name: 'Centro', business_id: owner.id, active: true });
        const norte  = await models.Branch.create({ name: 'Norte',  business_id: owner.id, active: true });

        const turnoCentro = await abrirTurno(ownerToken, { branch_id: centro.id });
        expect(turnoCentro.status).toBe(201);

        // 2 ventas en Centro ($30 c/u) y 1 en Norte ($30)
        expect((await venta(ownerToken, { branch_id: centro.id })).status).toBe(201);
        expect((await venta(ownerToken, { branch_id: centro.id })).status).toBe(201);
        expect((await venta(ownerToken, { branch_id: norte.id  })).status).toBe(201);

        const cierre = await request(app)
            .put(`/api/turnos/${turnoCentro.body.id}/cerrar`)
            .set('Authorization', `Bearer ${ownerToken}`)
            .send({ efectivo_contado: 160 }); // 100 de fondo + 60 de ventas

        expect(cierre.status).toBe(200);
        expect(cierre.body.total_pedidos).toBe(2);
        expect(parseFloat(cierre.body.total_ventas)).toBe(60.00);
        expect(parseFloat(cierre.body.diferencia)).toBe(0);
    });

    // ── Mesas ───────────────────────────────────────────────────────────
    test('Las mesas se crean en la sucursal del equipo y no se ven desde otra', async () => {
        const centro = await models.Branch.create({ name: 'Centro', business_id: owner.id, active: true });
        const norte  = await models.Branch.create({ name: 'Norte',  business_id: owner.id, active: true });

        const mesaCentro = await request(app)
            .post('/api/tables')
            .set('Authorization', `Bearer ${ownerToken}`)
            .send({ name: 'Mesa 1', branch_id: centro.id });
        expect(mesaCentro.status).toBe(201);
        expect(mesaCentro.body.branch_id).toBe(centro.id);

        const enCentro = await request(app)
            .get(`/api/tables?branch_id=${centro.id}`)
            .set('Authorization', `Bearer ${ownerToken}`);
        expect(enCentro.body.map(m => m.name)).toContain('Mesa 1');

        const enNorte = await request(app)
            .get(`/api/tables?branch_id=${norte.id}`)
            .set('Authorization', `Bearer ${ownerToken}`);
        expect(enNorte.body.map(m => m.name)).not.toContain('Mesa 1');
    });

    test('Las mesas viejas (sin sucursal) se siguen viendo en todas', async () => {
        const centro = await models.Branch.create({ name: 'Centro', business_id: owner.id, active: true });
        await models.Table.create({ name: 'Mesa vieja', business_id: owner.id, branch_id: null });

        const res = await request(app)
            .get(`/api/tables?branch_id=${centro.id}`)
            .set('Authorization', `Bearer ${ownerToken}`);
        expect(res.body.map(m => m.name)).toContain('Mesa vieja');
    });

    test('Turno legacy sin sucursal en negocio de UNA sucursal cuenta los pedidos nuevos', async () => {
        // Simula el turno que estaba abierto al desplegar este bloque: se abrió sin
        // sucursal, pero las ventas posteriores ya traen la sucursal auto-asignada.
        const suc = await models.Branch.create({ name: 'Única', business_id: owner.id, active: true });
        const turno = await models.Turno.create({
            business_id: owner.id, branch_id: null, cajero_nombre: 'Legacy',
            fondo_inicial: 0, apertura: new Date(Date.now() - 60000), estado: 'abierto',
        });

        const nueva = await venta(ownerToken);
        expect(nueva.body.branch_id).toBe(suc.id);

        const cierre = await request(app)
            .put(`/api/turnos/${turno.id}/cerrar`)
            .set('Authorization', `Bearer ${ownerToken}`)
            .send({ efectivo_contado: 30 });

        expect(cierre.status).toBe(200);
        expect(cierre.body.total_pedidos).toBe(1);
        expect(parseFloat(cierre.body.total_ventas)).toBe(30.00);
    });
});
