/**
 * EL CONTENIDO DEL PAQUETE (§45, arreglo del 2026-09-05).
 *
 * Un insumo se puede guardar en unidades de PAQUETE: bolsas, latas, piezas. El
 * orégano se compra en bolsas de 50 g, pero la receta de la salsa está escrita
 * en gramos: "18 g". Eso son 18/50 = 0.36 bolsas.
 *
 * El backend descontaba **18 BOLSAS**. Cincuenta veces de más, por cada plato, y
 * sin un solo aviso.
 *
 * La causa era doble y las dos mitades importan:
 *   a) el modelo `Ingredient` NO declaraba `content_amount` / `content_unit`, así
 *      que Sequelize descartaba EN SILENCIO lo que el desktop llevaba mandando
 *      desde siempre (la trampa del §25, tercera vez); y
 *   b) `convertirCantidad` solo recibe dos CADENAS, así que aunque el dato
 *      hubiera estado, la conversión no tenía con qué usarlo.
 *
 * Lo que se prueba:
 *   1. La fórmula sola, incluida la basura que NO debe usarse.
 *   2. Que el dato se GUARDA (si no, todo lo demás es teatro).
 *   3. Vender descuenta la fracción correcta del paquete.
 *   4. Cancelar devuelve EXACTAMENTE lo mismo (la pareja del §19.28).
 *   5. El COSTO usa el mismo factor que el consumo (o el §34 vuelve a pasar).
 *   6. La disponibilidad ("cuántos puedo hacer") también.
 *   7. Un insumo SIN contenido se comporta exactamente como antes.
 */
jest.mock('../utils/push', () => ({
    enviarNotificacion: jest.fn(),
    getPrefs: jest.fn().mockResolvedValue({}),
}));

const request = require('supertest');
const { app, sequelize, models, initTestDb, createTestOwner } = require('./setup');
const { convertirParaInsumo, normalizarContenido } = require('../utils/unidades');
const { mapaDeCostos } = require('../utils/costos');

let owner, ownerToken, categoria;
const auth = (token) => ({ Authorization: `Bearer ${token}` });

/**
 * El escenario del §45, con sus números reales: orégano en BOLSAS de 50 g y una
 * receta escrita en GRAMOS.
 */
async function escenario({
    unidad = 'bolsas', contenido = 50, unidadContenido = 'g',
    cantidadEnReceta = 18, unidadReceta = 'g', stockInicial = 287, costo = 12,
} = {}) {
    const oregano = await models.Ingredient.create({
        name: 'Orégano', unit: unidad, stock: stockInicial, cost_per_unit: costo,
        content_amount: contenido, content_unit: unidadContenido,
        business_id: owner.id,
    });
    const salsa = await models.Product.create({
        name: 'Salsa verde', price: 35, category_id: categoria.id, business_id: owner.id,
    });
    await models.ProductRecipe.create({
        product_id: salsa.id, item_type: 'ingredient', item_id: oregano.id,
        quantity: cantidadEnReceta, unit_recipe: unidadReceta,
    });
    return { oregano, salsa };
}

const vender = (body = {}) => request(app)
    .post('/api/orders')
    .set(auth(ownerToken))
    .send({ payment_method: 'efectivo', skip_stock_check: true, ...body });

const stockDe = async (ing) => parseFloat((await ing.reload()).stock);

beforeAll(async () => {
    await initTestDb();
    const result = await createTestOwner();
    owner = result.user;
    ownerToken = result.token;
    categoria = await models.Category.create({ name: 'Salsas', business_id: owner.id });
});

afterAll(async () => { await sequelize.close(); });

beforeEach(async () => {
    await models.OrderItem.destroy({ where: {} });
    await models.Order.destroy({ where: {} });
    await models.ProductRecipe.destroy({ where: {} });
    await models.Ingredient.destroy({ where: {} });
    await models.Product.destroy({ where: {} });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. LA FÓRMULA
// ─────────────────────────────────────────────────────────────────────────────
describe('convertirParaInsumo', () => {
    const bolsas = { unit: 'bolsas', content_amount: 50, content_unit: 'g' };

    test('el caso del §45: 18 g de un insumo en bolsas de 50 g', () => {
        // Antes devolvía 18 (dieciocho BOLSAS).
        expect(convertirParaInsumo(18, 'g', bolsas)).toBeCloseTo(0.36, 6);
    });

    test('la receta en la misma unidad del contenido divide directo', () => {
        expect(convertirParaInsumo(100, 'g', bolsas)).toBeCloseTo(2, 6);
    });

    test('la receta en una unidad equivalente pasa primero por el factor natural', () => {
        // 1 kg = 1000 g = 20 bolsas de 50 g.
        expect(convertirParaInsumo(1, 'kg', bolsas)).toBeCloseTo(20, 6);
    });

    test('la equivalencia natural GANA al contenido cuando existe', () => {
        // Un insumo en kg que además declara "1 kg trae 1000 g": pedir 500 g son
        // 0.5 kg por la vía natural, no algo raro por la vía del paquete.
        const enKg = { unit: 'kg', content_amount: 1000, content_unit: 'g' };
        expect(convertirParaInsumo(500, 'g', enKg)).toBeCloseTo(0.5, 6);
    });

    test('sin contenido declarado se comporta como antes del arreglo', () => {
        expect(convertirParaInsumo(18, 'g', { unit: 'bolsas' })).toBe(18);
    });

    test('la receta en la unidad del propio insumo no se toca', () => {
        expect(convertirParaInsumo(3, 'bolsas', bolsas)).toBe(3);
    });

    test('un contenido de CERO no se usa: dividir entre él vaciaría el inventario', () => {
        expect(convertirParaInsumo(18, 'g', { unit: 'bolsas', content_amount: 0, content_unit: 'g' })).toBe(18);
    });

    test('un contenido negativo o basura tampoco', () => {
        expect(convertirParaInsumo(18, 'g', { unit: 'bolsas', content_amount: -50, content_unit: 'g' })).toBe(18);
        expect(convertirParaInsumo(18, 'g', { unit: 'bolsas', content_amount: 'mucho', content_unit: 'g' })).toBe(18);
    });

    test('sin unidad de receta, o sin insumo, devuelve la cantidad tal cual', () => {
        expect(convertirParaInsumo(18, null, bolsas)).toBe(18);
        expect(convertirParaInsumo(18, 'g', null)).toBe(18);
    });
});

describe('normalizarContenido', () => {
    test('acepta un contenido válido', () => {
        expect(normalizarContenido(50, 'g', 'bolsas')).toEqual({ cantidad: 50, unidad: 'g' });
    });

    test('descarta el contenido en la MISMA unidad del insumo', () => {
        // "una bolsa trae 50 bolsas" no significa nada, y dividir por ello
        // desviaría el inventario sin que nadie entienda por qué.
        expect(normalizarContenido(50, 'bolsas', 'bolsas')).toEqual({ cantidad: null, unidad: null });
    });

    test('descarta cero, negativos y basura en vez de guardarlos', () => {
        expect(normalizarContenido(0, 'g', 'bolsas').cantidad).toBeNull();
        expect(normalizarContenido(-5, 'g', 'bolsas').cantidad).toBeNull();
        expect(normalizarContenido('mucho', 'g', 'bolsas').cantidad).toBeNull();
        expect(normalizarContenido(50, '', 'bolsas').cantidad).toBeNull();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. QUE EL DATO SE GUARDE — si no, lo demás es teatro
// ─────────────────────────────────────────────────────────────────────────────
describe('El contenido se guarda de verdad', () => {
    test('POST /inventory/ingredients acepta content_amount y content_unit', async () => {
        const res = await request(app)
            .post('/api/inventory/ingredients')
            .set(auth(ownerToken))
            .send({ name: 'Orégano', unit: 'bolsas', stock: 10, content_amount: 50, content_unit: 'g' });

        expect(res.status).toBe(201);
        // Antes de declararlas en el modelo, Sequelize las tiraba en SILENCIO y
        // esto devolvía undefined sin un solo error.
        expect(parseFloat(res.body.content_amount)).toBe(50);
        expect(res.body.content_unit).toBe('g');

        const guardado = await models.Ingredient.findByPk(res.body.id);
        expect(parseFloat(guardado.content_amount)).toBe(50);
    });

    test('PUT /inventory/ingredients/:id lo actualiza', async () => {
        const ing = await models.Ingredient.create({
            name: 'Latas de chile', unit: 'latas', stock: 5, business_id: owner.id,
        });
        const res = await request(app)
            .put(`/api/inventory/ingredients/${ing.id}`)
            .set(auth(ownerToken))
            .send({ content_amount: 380, content_unit: 'g' });

        expect(res.status).toBe(200);
        expect(parseFloat((await ing.reload()).content_amount)).toBe(380);
    });

    test('un contenido inservible se guarda como NULL, no como 0', async () => {
        // Guardar un 0 dejaría en la base un dato que PARECE configurado y no
        // hace nada: el usuario ve que se guardó y sigue descontando mal.
        const res = await request(app)
            .post('/api/inventory/ingredients')
            .set(auth(ownerToken))
            .send({ name: 'Sal', unit: 'kg', content_amount: 0, content_unit: 'g' });

        expect(res.status).toBe(201);
        expect(res.body.content_amount).toBeNull();
        expect(res.body.content_unit).toBeNull();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 y 4. VENDER Y CANCELAR — la pareja tiene que ser simétrica (§19.28)
// ─────────────────────────────────────────────────────────────────────────────
describe('Vender contra un insumo en unidades de paquete', () => {
    test('LA REGRESIÓN: 18 g descuentan 0.36 bolsas, no 18', async () => {
        const { oregano, salsa } = await escenario();

        const res = await vender({ items: [{ product_id: salsa.id, quantity: 1 }] });
        expect(res.status).toBe(201);

        // Antes: 287 − 18 = 269. Ahora: 287 − 0.36 = 286.64.
        expect(await stockDe(oregano)).toBeCloseTo(286.64, 4);
    });

    test('la cantidad del pedido multiplica la fracción', async () => {
        const { oregano, salsa } = await escenario();
        await vender({ items: [{ product_id: salsa.id, quantity: 5 }] });
        expect(await stockDe(oregano)).toBeCloseTo(287 - 1.8, 4);
    });

    test('cancelar devuelve EXACTAMENTE lo mismo que se descontó', async () => {
        const { oregano, salsa } = await escenario();
        const res = await vender({ items: [{ product_id: salsa.id, quantity: 3 }] });
        expect(await stockDe(oregano)).toBeCloseTo(287 - 1.08, 4);

        await request(app)
            .put(`/api/orders/${res.body.id}/status`)
            .set(auth(ownerToken))
            .send({ status: 'cancelado', role: 'dueno' });

        // Si descontar y restaurar usaran factores distintos, el inventario se
        // desviaría solo en cada cancelación (§19.28).
        expect(await stockDe(oregano)).toBeCloseTo(287, 4);
    });

    test('un insumo SIN contenido declarado se comporta como antes', async () => {
        const { oregano, salsa } = await escenario({ contenido: null, unidadContenido: null });
        await vender({ items: [{ product_id: salsa.id, quantity: 1 }] });
        // 'g' → 'bolsas' no tiene conversión posible: se descuenta tal cual, que
        // es el comportamiento de siempre y el que no rompe a nadie al desplegar.
        expect(await stockDe(oregano)).toBeCloseTo(287 - 18, 4);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. EL COSTO usa el MISMO factor que el consumo
// ─────────────────────────────────────────────────────────────────────────────
describe('Costo de la receta', () => {
    test('cuesta la fracción de paquete, no el paquete entero', async () => {
        // Bolsa a $12 → 18 g = 0.36 bolsas = $4.32.
        const { salsa } = await escenario({ costo: 12 });
        const costos = await mapaDeCostos(owner.id);
        expect(costos.productos.get(salsa.id).costo).toBeCloseTo(4.32, 4);
    });

    test('si el costo y el consumo divergieran, el reporte dejaría de cuadrar', async () => {
        const { oregano, salsa } = await escenario({ costo: 12 });
        const costos = await mapaDeCostos(owner.id);

        const antes = await stockDe(oregano);
        await vender({ items: [{ product_id: salsa.id, quantity: 1 }] });
        const consumido = antes - (await stockDe(oregano));

        // El costo tiene que ser exactamente lo consumido por el precio unitario.
        expect(costos.productos.get(salsa.id).costo).toBeCloseTo(consumido * 12, 6);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. DISPONIBILIDAD — cuántos platos alcanzan
// ─────────────────────────────────────────────────────────────────────────────
describe('Disponibilidad de producto', () => {
    test('cuenta las fracciones de paquete', async () => {
        const { salsa } = await escenario({ stockInicial: 10 });
        // 10 bolsas de 50 g = 500 g; a 18 g por salsa → 27 salsas.
        const res = await request(app)
            .get('/api/inventory/products-stock')
            .set(auth(ownerToken));

        expect(res.status).toBe(200);
        // Antes decía 0: creía que cada salsa se comía 18 bolsas.
        expect(res.body[salsa.id]).toBe(27);
    });
});
