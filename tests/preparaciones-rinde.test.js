/**
 * EL RINDE DE UNA PREPARACIÓN (arreglo del 2026-08-27).
 *
 * Una preparación RINDE una cantidad: "Salsa, rinde 4" produce 4 porciones por
 * tanda. Una receta que pide 0.5 usa 0.5/4 = **1/8 de la tanda**.
 *
 * El sistema ignoraba el rinde y descontaba la tanda COMPLETA multiplicada por
 * la cantidad: 8 veces el insumo que debía. Era alcanzable desde el mobile, que
 * tiene un campo "Rinde" editable.
 *
 * Lo que se prueba:
 *   1. Vender descuenta la fracción correcta de la tanda.
 *   2. Cancelar restaura EXACTAMENTE lo mismo (la pareja tiene que ser simétrica
 *      o el stock se desvía solo).
 *   3. Un modificador con preparación también respeta el rinde.
 *   4. La disponibilidad ("cuántos puedo hacer") sube en la misma proporción.
 *   5. El costo del reporte de rentabilidad usa el MISMO factor que el consumo.
 *   6. Rinde 1 se comporta exactamente como antes (no hay regresión).
 *   7. Un rinde inválido (0, negativo, nulo) cae a 1 y no divide entre cero.
 */
jest.mock('../utils/push', () => ({
    enviarNotificacion: jest.fn(),
    getPrefs: jest.fn().mockResolvedValue({}),
}));

const request = require('supertest');
const { app, sequelize, models, initTestDb, createTestOwner } = require('./setup');
const { fraccionDeTanda } = require('../utils/preparaciones');
const { mapaDeCostos } = require('../utils/costos');
const { limpiarCacheModificadores } = require('../utils/modificadores');

let owner, ownerToken, categoria;

const auth = (token) => ({ Authorization: `Bearer ${token}` });

/**
 * Monta el escenario base: un insumo, una preparación que lo usa, y un producto
 * que usa la preparación.
 *
 * Tanda de la preparación = 1 kg de tomate. Con rinde N, cada "unidad" de la
 * preparación cuesta 1/N de kg.
 */
async function escenario({ rinde, cantidadEnReceta = 0.5, stockInicial = 100 }) {
    const tomate = await models.Ingredient.create({
        name: 'Tomate', unit: 'kg', cost_per_unit: 40,
        stock: stockInicial, business_id: owner.id,
    });
    const salsa = await models.Preparation.create({
        name: 'Salsa', unit: 'litro', yield_quantity: rinde, business_id: owner.id,
    });
    await models.PreparationItem.create({
        preparation_id: salsa.id, ingredient_id: tomate.id, quantity: 1, unit_recipe: 'kg',
    });
    const plato = await models.Product.create({
        name: 'Chilaquiles', price: 90, category_id: categoria.id, business_id: owner.id,
    });
    await models.ProductRecipe.create({
        product_id: plato.id, item_type: 'preparation', item_id: salsa.id,
        quantity: cantidadEnReceta, unit_recipe: null,
    });
    return { tomate, salsa, plato };
}

function vender(body = {}) {
    return request(app)
        .post('/api/orders')
        .set(auth(ownerToken))
        .send({ payment_method: 'efectivo', skip_stock_check: true, ...body });
}

const stockDe = async (ing) => parseFloat((await ing.reload()).stock);

beforeAll(async () => {
    await initTestDb();
    const result = await createTestOwner();
    owner = result.user;
    ownerToken = result.token;
    categoria = await models.Category.create({ name: 'Comida', business_id: owner.id });
});

afterAll(async () => { await sequelize.close(); });

beforeEach(async () => {
    await models.OrderItem.destroy({ where: {} });
    await models.Order.destroy({ where: {} });
    await models.ProductRecipe.destroy({ where: {} });
    await models.ModifierOptionRecipe.destroy({ where: {} });
    await models.ModifierOption.destroy({ where: {} });
    await models.ProductModifierGroup.destroy({ where: {} });
    await models.ModifierGroup.destroy({ where: {} });
    await models.PreparationItem.destroy({ where: {} });
    await models.Preparation.destroy({ where: {} });
    await models.Ingredient.destroy({ where: {} });
    await models.Product.destroy({ where: {} });
    limpiarCacheModificadores();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. LA REGRESIÓN EXACTA: vender descontaba 8 veces de más
// ─────────────────────────────────────────────────────────────────────────────
describe('Vender un producto con preparación', () => {
    test('descuenta la FRACCIÓN de la tanda, no la tanda entera', async () => {
        // 0.5 de una salsa que rinde 4 = 1/8 de la tanda = 0.125 kg de tomate.
        const { tomate, plato } = await escenario({ rinde: 4, cantidadEnReceta: 0.5 });

        const res = await vender({ items: [{ product_id: plato.id, quantity: 1 }] });
        expect(res.status).toBe(201);

        // Antes del arreglo esto daba 99.5 (media tanda entera = 0.5 kg).
        expect(await stockDe(tomate)).toBeCloseTo(99.875, 5);
    });

    test('la cantidad del pedido multiplica la fracción', async () => {
        const { tomate, plato } = await escenario({ rinde: 4, cantidadEnReceta: 0.5 });
        await vender({ items: [{ product_id: plato.id, quantity: 4 }] });
        expect(await stockDe(tomate)).toBeCloseTo(99.5, 5);
    });

    test('con rinde 1 se comporta exactamente como antes del arreglo', async () => {
        const { tomate, plato } = await escenario({ rinde: 1, cantidadEnReceta: 0.5 });
        await vender({ items: [{ product_id: plato.id, quantity: 1 }] });
        expect(await stockDe(tomate)).toBeCloseTo(99.5, 5);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. DESCONTAR Y RESTAURAR TIENEN QUE SER SIMÉTRICOS
// ─────────────────────────────────────────────────────────────────────────────
describe('Cancelar un pedido con preparación', () => {
    test('devuelve exactamente lo que la venta descontó', async () => {
        const { tomate, plato } = await escenario({ rinde: 4, cantidadEnReceta: 0.5 });

        const venta = await vender({ items: [{ product_id: plato.id, quantity: 3 }] });
        expect(venta.status).toBe(201);
        const descontado = 100 - (await stockDe(tomate));
        expect(descontado).toBeGreaterThan(0);

        const cancel = await request(app)
            .put(`/api/orders/${venta.body.id}/status`)
            .set(auth(ownerToken))
            .send({ status: 'cancelado', employee_id: owner.id, pin: 'TestPass123' });
        expect(cancel.status).toBe(200);

        // El stock vuelve al punto de partida: si descontar y restaurar usaran
        // factores distintos, el inventario se desviaría en cada cancelación.
        expect(await stockDe(tomate)).toBeCloseTo(100, 5);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. MODIFICADORES (BLOQUE 11) CON PREPARACIÓN
// ─────────────────────────────────────────────────────────────────────────────
describe('Un modificador que agrega una preparación', () => {
    test('también respeta el rinde', async () => {
        const { tomate, salsa, plato } = await escenario({ rinde: 4, cantidadEnReceta: 0.5 });

        const grupo = await models.ModifierGroup.create({
            business_id: owner.id, name: 'Extras', max_select: 3,
        });
        const opcion = await models.ModifierOption.create({
            group_id: grupo.id, business_id: owner.id, name: 'Extra salsa', price_delta: 10,
        });
        await models.ProductModifierGroup.create({
            product_id: plato.id, group_id: grupo.id, business_id: owner.id,
        });
        await models.ModifierOptionRecipe.create({
            option_id: opcion.id, business_id: owner.id,
            item_type: 'preparation', item_id: salsa.id, quantity: 1, unit_recipe: null,
        });
        limpiarCacheModificadores();

        const res = await vender({
            items: [{ product_id: plato.id, quantity: 1, modifiers: [{ option_id: opcion.id }] }],
        });
        expect(res.status).toBe(201);

        // Receta 0.5/4 = 0.125 kg + extra 1/4 = 0.25 kg → 0.375 kg
        expect(await stockDe(tomate)).toBeCloseTo(99.625, 5);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. DISPONIBILIDAD: "¿cuántos puedo hacer?"
// ─────────────────────────────────────────────────────────────────────────────
describe('La disponibilidad de un producto con preparación', () => {
    test('cuenta la fracción de tanda, no la tanda entera', async () => {
        // 1 kg de tomate en stock; cada plato usa 0.125 kg → 8 platos.
        const { plato } = await escenario({ rinde: 4, cantidadEnReceta: 0.5, stockInicial: 1 });

        const res = await request(app)
            .get('/api/inventory/products-stock')
            .set(auth(ownerToken));
        expect(res.status).toBe(200);
        // Antes del arreglo decía 2 (1 kg / 0.5 kg): el negocio creía que no le
        // alcanzaba para vender.
        expect(res.body[String(plato.id)]).toBe(8);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. EL COSTO USA EL MISMO FACTOR QUE EL CONSUMO
//    Si se separaran, el reporte de rentabilidad dejaría de cuadrar con lo que
//    salió de la bodega.
// ─────────────────────────────────────────────────────────────────────────────
describe('El costo de la rentabilidad', () => {
    test('cuesta lo que vale el inventario que la venta descontó', async () => {
        const { plato } = await escenario({ rinde: 4, cantidadEnReceta: 0.5 });

        // 0.125 kg × $40/kg = $5
        const costos = await mapaDeCostos(owner.id);
        expect(costos.productos.get(plato.id).costo).toBeCloseTo(5, 5);

        await vender({ items: [{ product_id: plato.id, quantity: 2 }] });
        const rep = await request(app)
            .get('/api/stats/profitability')
            .set(auth(ownerToken));
        expect(rep.status).toBe(200);
        const fila = rep.body.productos.find(p => p.product_id === plato.id);
        expect(fila.costo_unitario).toBe(5);
        expect(fila.costo).toBe(10);
        expect(fila.margen).toBe(170); // 180 de ingreso − 10 de costo
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. LA FÓRMULA SUELTA: ningún dato raro divide entre cero
// ─────────────────────────────────────────────────────────────────────────────
describe('fraccionDeTanda', () => {
    test('divide entre el rinde', () => {
        expect(fraccionDeTanda(0.5, { yield_quantity: 4 })).toBeCloseTo(0.125, 6);
        expect(fraccionDeTanda(2, { yield_quantity: 8 })).toBeCloseTo(0.25, 6);
    });

    test('un rinde de 1 devuelve la cantidad tal cual', () => {
        expect(fraccionDeTanda(3, { yield_quantity: 1 })).toBe(3);
    });

    test('un rinde inválido cae a 1 tanda (el comportamiento anterior)', () => {
        // Cero, negativo, texto, ausente y objeto nulo: nunca NaN ni Infinity.
        expect(fraccionDeTanda(2, { yield_quantity: 0 })).toBe(2);
        expect(fraccionDeTanda(2, { yield_quantity: -4 })).toBe(2);
        expect(fraccionDeTanda(2, { yield_quantity: 'x' })).toBe(2);
        expect(fraccionDeTanda(2, {})).toBe(2);
        expect(fraccionDeTanda(2, null)).toBe(2);
    });

    test('una cantidad no numérica no consume nada', () => {
        expect(fraccionDeTanda('x', { yield_quantity: 4 })).toBe(0);
        expect(fraccionDeTanda(null, { yield_quantity: 4 })).toBe(0);
    });

    test('un rinde inválido en una venta real no rompe el descuento', async () => {
        const { tomate, plato } = await escenario({ rinde: 1, cantidadEnReceta: 0.5 });
        // Se fuerza un rinde corrupto por SQL, como si viniera de un dato viejo.
        await models.Preparation.update(
            { yield_quantity: 0 },
            { where: { business_id: owner.id }, validate: false }
        );

        const res = await vender({ items: [{ product_id: plato.id, quantity: 1 }] });
        expect(res.status).toBe(201);
        // Cae a 1 tanda: descuenta 0.5 kg, sin NaN ni división entre cero.
        expect(await stockDe(tomate)).toBeCloseTo(99.5, 5);
    });
});
