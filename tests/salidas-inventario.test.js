/**
 * SALIDAS DE INVENTARIO — el motivo no es la operación (2026-09-05).
 *
 * Encontrado usando la app: el dueño tenía 287 de orégano, quiso descontar 285
 * y no pasó NADA. Eran tres fallas apiladas:
 *
 *   1. El desktop mandaba el MOTIVO "ajuste" como si fuera el TIPO de operación,
 *      y en el backend `type:'ajuste'` FIJA el stock en ese número en vez de
 *      restarlo. El modal decía "Cantidad a descontar" y hacía otra cosa.
 *   2. Esta ruta autorizaba con verifyEmployeePin() a secas, que solo entiende
 *      la contraseña de una CUENTA. En el POS el cajero teclea el PIN de su
 *      PUESTO, así que la autorización nunca podía pasar (§19.19).
 *   3. El cliente mandaba `pin: null` y se tragaba el 400 resultante.
 *
 * Lo que se prueba aquí es el backend: que una salida reste, que el PIN de
 * puesto autorice, y que 'ajuste' siga fijando (el mobile depende de eso).
 */
jest.mock('../utils/push', () => ({
    enviarNotificacion: jest.fn(),
    getPrefs: jest.fn().mockResolvedValue({}),
}));

const crypto = require('crypto');
const request = require('supertest');
const { app, sequelize, models, initTestDb, createTestOwner } = require('./setup');

let owner, ownerToken, insumo;

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

function movimiento(body = {}) {
    return request(app)
        .post('/api/inventory/movements')
        .set(auth(ownerToken))
        .send(body);
}

async function ponerPinDePuesto(hash) {
    const u = await models.User.findByPk(owner.id);
    const s = u.settings ? JSON.parse(u.settings) : {};
    s.permisos_roles = { cajero: { pin_set: true, pin: hash } };
    await u.update({ settings: JSON.stringify(s) });
}

async function stockDe(id) {
    const ing = await models.Ingredient.findByPk(id);
    return parseFloat(ing.stock);
}

beforeAll(async () => {
    await initTestDb();
    const result = await createTestOwner();
    owner = result.user;
    ownerToken = result.token;
});

beforeEach(async () => {
    insumo = await models.Ingredient.create({
        name: 'Oregano', unit: 'bolsas', stock: 287, min_stock: 0, business_id: owner.id,
    });
});

afterEach(async () => {
    await models.PrivilegedActionLog.destroy({ where: {} });
    await models.InventoryMovement.destroy({ where: {} });
    await models.Ingredient.destroy({ where: {} });
});

afterAll(async () => {
    await sequelize.close();
});

describe('Salidas de inventario', () => {

    // ── LA REGRESIÓN EXACTA ──────────────────────────────────────────────
    test('Una salida con motivo "ajuste" RESTA, no fija el stock', async () => {
        await ponerPinDePuesto(sha('1104'));

        const res = await movimiento({
            ingredient_id: insumo.id,
            type: 'salida',
            quantity: 285,
            reason: 'ajuste',
            role: 'cajero',
            pin: '1104',
            employee_name: 'Simon',
        });

        expect(res.status).toBe(201);
        // 287 − 285 = 2. Si alguien vuelve a tratar el motivo como operación,
        // aquí saldría 285 y esta prueba lo caza.
        expect(await stockDe(insumo.id)).toBe(2);
    });

    test('Los otros motivos restan igual, sin PIN', async () => {
        for (const motivo of ['merma', 'caducidad', 'accidente', 'robo', 'otro']) {
            const ing = await models.Ingredient.create({
                name: `X-${motivo}`, unit: 'kg', stock: 10, business_id: owner.id,
            });
            const res = await movimiento({
                ingredient_id: ing.id, type: 'salida', quantity: 4, reason: motivo,
            });
            expect(res.status).toBe(201);
            expect(await stockDe(ing.id)).toBe(6);
        }
    });

    // ── EL PIN DE PUESTO ─────────────────────────────────────────────────
    test('El PIN del PUESTO autoriza (antes solo servía la contraseña de cuenta)', async () => {
        await ponerPinDePuesto(sha('1104'));

        const res = await movimiento({
            ingredient_id: insumo.id, type: 'ajuste', quantity: 2,
            role: 'cajero', pin: '1104', employee_name: 'Simon',
        });

        expect(res.status).toBe(201);
        expect(await stockDe(insumo.id)).toBe(2);
    });

    test('Un PIN de puesto equivocado se rechaza con 403 y NO mueve el stock', async () => {
        await ponerPinDePuesto(sha('1104'));

        const res = await movimiento({
            ingredient_id: insumo.id, type: 'salida', quantity: 285,
            reason: 'ajuste', role: 'cajero', pin: '9999',
        });

        expect(res.status).toBe(403);
        expect(await stockDe(insumo.id)).toBe(287);
    });

    // ── EL RASTRO ────────────────────────────────────────────────────────
    test('Una salida autorizada con PIN queda AUDITADA con el stock que quedó', async () => {
        await ponerPinDePuesto(sha('1104'));

        await movimiento({
            ingredient_id: insumo.id, type: 'salida', quantity: 285,
            reason: 'ajuste', role: 'cajero', pin: '1104', employee_name: 'Simon',
        });

        const logs = await models.PrivilegedActionLog.findAll({
            where: { action_type: 'inventory_adjustment' },
        });
        expect(logs).toHaveLength(1);
        const despues = JSON.parse(logs[0].after_data);
        expect(despues.stock).toBe(2);      // el stock que quedó, no la cantidad tecleada
        expect(despues.cantidad).toBe(285);
        expect(despues.tipo).toBe('salida');
    });

    test('Una salida sin PIN no se audita (no hay nada que atribuir)', async () => {
        await movimiento({
            ingredient_id: insumo.id, type: 'salida', quantity: 5, reason: 'merma',
        });
        const logs = await models.PrivilegedActionLog.findAll({});
        expect(logs).toHaveLength(0);
    });

    // ── LO QUE NO DEBE CAMBIAR (el mobile depende de esto) ────────────────
    test('type "ajuste" sigue FIJANDO el stock, y sigue exigiendo PIN', async () => {
        const sinPin = await movimiento({
            ingredient_id: insumo.id, type: 'ajuste', quantity: 50,
        });
        expect(sinPin.status).toBe(400);
        expect(await stockDe(insumo.id)).toBe(287);

        await ponerPinDePuesto(sha('1104'));
        const conPin = await movimiento({
            ingredient_id: insumo.id, type: 'ajuste', quantity: 50,
            role: 'cajero', pin: '1104',
        });
        expect(conPin.status).toBe(201);
        expect(await stockDe(insumo.id)).toBe(50);   // FIJA, no resta
    });

    test('Una entrada sigue sumando', async () => {
        const res = await movimiento({
            ingredient_id: insumo.id, type: 'entrada', quantity: 13,
        });
        expect(res.status).toBe(201);
        expect(await stockDe(insumo.id)).toBe(300);
    });
});
