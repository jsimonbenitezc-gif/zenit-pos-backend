/**
 * BLOQUE 7 V5 — Movimientos de caja (retiros, gastos, depósitos).
 *
 * Lo que se prueba, en orden de importancia:
 *   1. Que el cierre CUADRE: esperado = fondo + ventas_efectivo + dep − ret − gastos.
 *   2. Que sacar dinero pida PIN y quede auditado, y que el dueño pueda apagarlo.
 *   3. Que un movimiento se anule (no se borre) y deje de contar.
 */
jest.mock('../utils/push', () => ({
    enviarNotificacion: jest.fn(),
    getPrefs: jest.fn().mockResolvedValue({}),
}));

const request = require('supertest');
const { app, sequelize, models, initTestDb, createTestOwner } = require('./setup');
const { getPrefs } = require('../utils/push');

let owner, ownerToken, product, cajero;

const auth = (token) => ({ Authorization: `Bearer ${token}` });

function abrirTurno(body = {}) {
    return request(app)
        .post('/api/turnos')
        .set(auth(ownerToken))
        .send({ cajero_nombre: 'Ana', fondo_inicial: 500, ...body });
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

function movimiento(turnoId, body = {}) {
    return request(app)
        .post(`/api/turnos/${turnoId}/movimientos`)
        .set(auth(ownerToken))
        .send({ tipo: 'gasto', monto: 50, motivo: 'Cilantro', employee_id: cajero.id, pin: 'Pin12345', ...body });
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

    cajero = await models.User.create({
        username: `cajero_${owner.id}@test.com`,
        password: 'Pin12345',
        name: 'Ana Cajera',
        role: 'cashier',
        business_id: owner.id,
    });
});

beforeEach(() => {
    getPrefs.mockResolvedValue({}); // por defecto: PIN encendido
});

afterEach(async () => {
    await models.CashMovement.destroy({ where: {} });
    await models.PrivilegedActionLog.destroy({ where: {} });
    await models.Turno.destroy({ where: {} });
    await models.OrderItem.destroy({ where: {} });
    await models.Order.destroy({ where: {} });
});

afterAll(async () => {
    await sequelize.close();
});

describe('Bloque 7 — Movimientos de caja', () => {

    // ── El cierre cuadra ────────────────────────────────────────────────
    test('El cierre resta gastos y retiros y suma depósitos', async () => {
        const turno = (await abrirTurno({ fondo_inicial: 500 })).body;

        // 12 ventas de $100 en efectivo = $1,200
        for (let i = 0; i < 12; i++) await venta();

        await movimiento(turno.id, { tipo: 'retiro',   monto: 300, motivo: 'A caja fuerte' });
        await movimiento(turno.id, { tipo: 'gasto',    monto: 50,  motivo: 'Cilantro' });
        await movimiento(turno.id, { tipo: 'deposito', monto: 200, motivo: 'Más cambio' });

        // esperado = 500 + 1200 + 200 − 300 − 50 = 1550
        const totales = await request(app).get(`/api/turnos/${turno.id}/totales`).set(auth(ownerToken));
        expect(totales.body.total_efectivo).toBe(1200);
        expect(totales.body.total_depositos).toBe(200);
        expect(totales.body.total_retiros).toBe(300);
        expect(totales.body.total_gastos).toBe(50);
        expect(totales.body.efectivo_esperado).toBe(1550);

        // El cajero cuenta $1,545: faltan $5 de verdad, no los $355 de antes.
        const cierre = await request(app)
            .put(`/api/turnos/${turno.id}/cerrar`)
            .set(auth(ownerToken))
            .send({ efectivo_contado: 1545 });

        expect(cierre.status).toBe(200);
        expect(parseFloat(cierre.body.diferencia)).toBe(-5);
        expect(parseFloat(cierre.body.total_depositos)).toBe(200);
        expect(parseFloat(cierre.body.total_retiros)).toBe(300);
        expect(parseFloat(cierre.body.total_gastos)).toBe(50);
    });

    test('Sin movimientos, el cierre se comporta exactamente como antes', async () => {
        const turno = (await abrirTurno({ fondo_inicial: 100 })).body;
        await venta(); // $100 efectivo

        const cierre = await request(app)
            .put(`/api/turnos/${turno.id}/cerrar`)
            .set(auth(ownerToken))
            .send({ efectivo_contado: 200 });

        expect(parseFloat(cierre.body.diferencia)).toBe(0);
    });

    test('Los totales congelados en el turno cerrado no cambian si luego se anula', async () => {
        const turno = (await abrirTurno()).body;
        const mov = (await movimiento(turno.id, { tipo: 'retiro', monto: 100 })).body;

        await request(app).put(`/api/turnos/${turno.id}/cerrar`).set(auth(ownerToken)).send({ efectivo_contado: 400 });

        // Con el turno cerrado ya no se puede anular: el corte quedaría distinto
        // del reporte que el dueño ya leyó.
        const res = await request(app)
            .post(`/api/turnos/${turno.id}/movimientos/${mov.id}/anular`)
            .set(auth(ownerToken))
            .send({ employee_id: cajero.id, pin: 'Pin12345' });

        expect(res.status).toBe(400);
        const recargado = await models.Turno.findByPk(turno.id);
        expect(parseFloat(recargado.total_retiros)).toBe(100);
    });

    // ── PIN y auditoría ─────────────────────────────────────────────────
    test('Un retiro sin PIN se rechaza con 400', async () => {
        const turno = (await abrirTurno()).body;
        const res = await request(app)
            .post(`/api/turnos/${turno.id}/movimientos`)
            .set(auth(ownerToken))
            .send({ tipo: 'retiro', monto: 100 });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/PIN/i);
    });

    test('Un retiro con PIN incorrecto se rechaza con 403', async () => {
        const turno = (await abrirTurno()).body;
        const res = await movimiento(turno.id, { tipo: 'retiro', monto: 100, pin: 'incorrecto' });
        expect(res.status).toBe(403);
    });

    test('Un retiro autorizado queda en la auditoría', async () => {
        const turno = (await abrirTurno()).body;
        const res = await movimiento(turno.id, { tipo: 'retiro', monto: 250, motivo: 'A caja fuerte' });
        expect(res.status).toBe(201);

        const logs = await models.PrivilegedActionLog.findAll({ where: { action_type: 'cash_movement' } });
        expect(logs).toHaveLength(1);
        expect(logs[0].employee_id).toBe(cajero.id);
        expect(logs[0].target_description).toContain('250.00');
    });

    test('Un depósito NO pide PIN (meter dinero a la caja no es un riesgo)', async () => {
        const turno = (await abrirTurno()).body;
        const res = await request(app)
            .post(`/api/turnos/${turno.id}/movimientos`)
            .set(auth(ownerToken))
            .send({ tipo: 'deposito', monto: 200, motivo: 'Más cambio' });

        expect(res.status).toBe(201);
        expect(res.body.monto).toBe(200);
    });

    test('Con movimientos_caja_pin=false el retiro pasa sin PIN', async () => {
        getPrefs.mockResolvedValue({ movimientos_caja_pin: false });
        const turno = (await abrirTurno()).body;

        const res = await request(app)
            .post(`/api/turnos/${turno.id}/movimientos`)
            .set(auth(ownerToken))
            .send({ tipo: 'retiro', monto: 100, employee_name: 'Ana' });

        expect(res.status).toBe(201);
        // Sin PIN no hay a quién atribuirlo: no se audita.
        const logs = await models.PrivilegedActionLog.findAll({ where: { action_type: 'cash_movement' } });
        expect(logs).toHaveLength(0);
    });

    test('Solo el administrador puede cambiar movimientos_caja_pin', async () => {
        const jwt = require('jsonwebtoken');
        const tokenCajero = jwt.sign(
            { id: cajero.id, username: cajero.username, role: 'cashier', business_id: owner.id },
            process.env.JWT_SECRET, { expiresIn: '1d' }
        );

        const res = await request(app)
            .put('/api/settings')
            .set(auth(tokenCajero))
            .send({ movimientos_caja_pin: false });

        expect(res.status).toBe(403);

        const ok = await request(app)
            .put('/api/settings')
            .set(auth(ownerToken))
            .send({ movimientos_caja_pin: false });
        expect(ok.status).toBe(200);
        expect(ok.body.movimientos_caja_pin).toBe(false);

        // Restaurar para no contaminar otros tests
        await request(app).put('/api/settings').set(auth(ownerToken)).send({ movimientos_caja_pin: true });
    });

    // ── PIN de PUESTO (el que el desktop y el mobile realmente tienen) ──
    // Zenit tiene dos credenciales: el PIN de puesto (settings.permisos_roles) y
    // la contraseña de cuenta. Los clientes solo pueden producir la primera; si la
    // ruta aceptara únicamente la segunda, esta función nacería muerta en el POS.
    describe('PIN de puesto', () => {
        const crypto = require('crypto');
        const sha = (pin) => crypto.createHash('sha256').update(pin).digest('hex');

        async function ponerPinDePuesto(hash, extra = {}) {
            const u = await models.User.findByPk(owner.id);
            const s = u.settings ? JSON.parse(u.settings) : {};
            s.permisos_roles = { cajero: { pin_set: true, pin: hash, ...extra } };
            await u.update({ settings: JSON.stringify(s) });
        }

        test('Un retiro se autoriza con el PIN del puesto (SHA256 legacy del desktop)', async () => {
            await ponerPinDePuesto(sha('4321'));
            const turno = (await abrirTurno()).body;

            const res = await request(app)
                .post(`/api/turnos/${turno.id}/movimientos`)
                .set(auth(ownerToken))
                .send({ tipo: 'retiro', monto: 150, role: 'cajero', pin: '4321', employee_name: 'Ana' });

            expect(res.status).toBe(201);
            const logs = await models.PrivilegedActionLog.findAll({ where: { action_type: 'cash_movement' } });
            expect(logs).toHaveLength(1);
            expect(logs[0].employee_name).toBe('Ana');

            // Al validar por SHA256 se migra a bcrypt, y el PIN sigue funcionando.
            const u = await models.User.findByPk(owner.id);
            expect(JSON.parse(u.settings).permisos_roles.cajero.pin_bcrypt).toBeTruthy();

            const otra = await request(app)
                .post(`/api/turnos/${turno.id}/movimientos`)
                .set(auth(ownerToken))
                .send({ tipo: 'gasto', monto: 20, role: 'cajero', pin: '4321' });
            expect(otra.status).toBe(201);
        });

        test('PIN de puesto incorrecto se rechaza con 403', async () => {
            await ponerPinDePuesto(sha('4321'));
            const turno = (await abrirTurno()).body;

            const res = await request(app)
                .post(`/api/turnos/${turno.id}/movimientos`)
                .set(auth(ownerToken))
                .send({ tipo: 'retiro', monto: 150, role: 'cajero', pin: '0000' });

            expect(res.status).toBe(403);
        });

        test('Anular también acepta el PIN del puesto', async () => {
            await ponerPinDePuesto(sha('4321'));
            const turno = (await abrirTurno()).body;
            const mov = (await request(app)
                .post(`/api/turnos/${turno.id}/movimientos`)
                .set(auth(ownerToken))
                .send({ tipo: 'gasto', monto: 90, role: 'cajero', pin: '4321' })).body;

            const res = await request(app)
                .post(`/api/turnos/${turno.id}/movimientos/${mov.id}/anular`)
                .set(auth(ownerToken))
                .send({ role: 'cajero', pin: '4321', motivo: 'Dedazo' });

            expect(res.status).toBe(200);
            expect(res.body.anulado).toBe(true);
        });

        afterEach(async () => {
            const u = await models.User.findByPk(owner.id);
            const s = u.settings ? JSON.parse(u.settings) : {};
            delete s.permisos_roles;
            await u.update({ settings: JSON.stringify(s) });
        });
    });

    // ── Anulación ───────────────────────────────────────────────────────
    test('Anular deja el movimiento visible pero fuera del cálculo', async () => {
        const turno = (await abrirTurno({ fondo_inicial: 0 })).body;
        const mov = (await movimiento(turno.id, { tipo: 'gasto', monto: 80 })).body;

        let totales = await request(app).get(`/api/turnos/${turno.id}/totales`).set(auth(ownerToken));
        expect(totales.body.efectivo_esperado).toBe(-80);

        const anul = await request(app)
            .post(`/api/turnos/${turno.id}/movimientos/${mov.id}/anular`)
            .set(auth(ownerToken))
            .send({ employee_id: cajero.id, pin: 'Pin12345', motivo: 'Monto equivocado' });

        expect(anul.status).toBe(200);
        expect(anul.body.anulado).toBe(true);

        totales = await request(app).get(`/api/turnos/${turno.id}/totales`).set(auth(ownerToken));
        expect(totales.body.efectivo_esperado).toBe(0);
        expect(totales.body.total_gastos).toBe(0);

        // Sigue existiendo: nunca se borra.
        const lista = await request(app).get(`/api/turnos/${turno.id}/movimientos`).set(auth(ownerToken));
        expect(lista.body.movimientos).toHaveLength(1);
        expect(lista.body.movimientos[0].anulado).toBe(true);
        expect(lista.body.movimientos[0].motivo_anulacion).toBe('Monto equivocado');

        const logs = await models.PrivilegedActionLog.findAll({ where: { action_type: 'cash_movement_void' } });
        expect(logs).toHaveLength(1);
    });

    test('No se puede anular dos veces el mismo movimiento', async () => {
        const turno = (await abrirTurno()).body;
        const mov = (await movimiento(turno.id)).body;
        const anular = () => request(app)
            .post(`/api/turnos/${turno.id}/movimientos/${mov.id}/anular`)
            .set(auth(ownerToken))
            .send({ employee_id: cajero.id, pin: 'Pin12345' });

        expect((await anular()).status).toBe(200);
        expect((await anular()).status).toBe(400);
    });

    // ── Validaciones ────────────────────────────────────────────────────
    test('Monto inválido (cero, negativo o texto) se rechaza', async () => {
        const turno = (await abrirTurno()).body;
        for (const monto of [0, -50, 'abc', null]) {
            const res = await movimiento(turno.id, { monto });
            expect(res.status).toBe(400);
        }
    });

    test('Tipo inválido se rechaza', async () => {
        const turno = (await abrirTurno()).body;
        const res = await movimiento(turno.id, { tipo: 'prestamo' });
        expect(res.status).toBe(400);
    });

    test('No se registran movimientos en un turno ya cerrado', async () => {
        const turno = (await abrirTurno()).body;
        await request(app).put(`/api/turnos/${turno.id}/cerrar`).set(auth(ownerToken)).send({ efectivo_contado: 500 });

        const res = await movimiento(turno.id);
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/cerrado/i);
    });

    test('El mismo client_uuid no saca el dinero dos veces', async () => {
        const turno = (await abrirTurno()).body;
        const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

        const a = await movimiento(turno.id, { tipo: 'retiro', monto: 100, client_uuid: uuid });
        const b = await movimiento(turno.id, { tipo: 'retiro', monto: 100, client_uuid: uuid });

        expect(a.status).toBe(201);
        expect(b.body.id).toBe(a.body.id);

        const totales = await request(app).get(`/api/turnos/${turno.id}/totales`).set(auth(ownerToken));
        expect(totales.body.total_retiros).toBe(100);
    });

    test('Un movimiento de otro negocio no se ve ni se anula', async () => {
        const otro = await createTestOwner();
        const turno = (await abrirTurno()).body;
        const mov = (await movimiento(turno.id)).body;

        const lista = await request(app).get(`/api/turnos/${turno.id}/movimientos`).set(auth(otro.token));
        expect(lista.status).toBe(404);

        const anul = await request(app)
            .post(`/api/turnos/${turno.id}/movimientos/${mov.id}/anular`)
            .set(auth(otro.token))
            .send({ employee_id: cajero.id, pin: 'Pin12345' });
        expect(anul.status).toBe(404);
    });
});
