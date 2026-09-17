/**
 * EXISTENCIAS POR UNIDADES — lo que se revende y no tiene receta (2026-09-17).
 *
 * El 2026-03-20 el commit `bed4bcd` desconectó `Product.stock` entero, y con él
 * se fue la parte que sí tenía sentido: la de los productos SIN receta. Lo que
 * quedó: el formulario del desktop seguía pidiendo existencias, el número se
 * guardaba, y no se descontaba ni se validaba nunca. Una tienda de reventa —y
 * todo el plan free, que no tiene inventario— sin ningún control, y en la base
 * de producción productos marcando −20.
 *
 * LO QUE SE PRUEBA AQUÍ, y son las cuatro cosas que pueden salir mal:
 *   · que un producto SIN receta descuente, y CON receta no se toque;
 *   · que `stock = NULL` sea SIN CONTROL y no bloquee nada;
 *   · que faltar existencias AVISE y nunca impida vender (§1, §37);
 *   · que descontar y devolver sean SIMÉTRICOS (§19.28): si la venta resta con
 *     un criterio y la cancelación devuelve con otro, la cuenta se desvía sola.
 */
jest.mock('../utils/push', () => ({
    enviarNotificacion: jest.fn(),
    getPrefs: jest.fn().mockResolvedValue({}),
}));

const request = require('supertest');
const { app, sequelize, models, initTestDb, createTestOwner } = require('./setup');
const { normalizarStock } = require('../utils/stockProducto');

let owner, token, refresco, hamburguesa, insumo;

const auth = () => ({ Authorization: `Bearer ${token}` });

const stockDe = async (id) => (await models.Product.findByPk(id)).stock;

function vender(body = {}) {
    return request(app).post('/api/orders').set(auth()).send({
        type: 'takeout',
        payment_method: 'efectivo',
        ...body,
    });
}

beforeAll(async () => {
    await initTestDb();
    const r = await createTestOwner();
    owner = r.user;
    token = r.token;
});

beforeEach(async () => {
    await models.OrderItem.destroy({ where: {} });
    await models.Order.destroy({ where: {} });
    await models.ProductRecipe.destroy({ where: {} });
    await models.Product.destroy({ where: {} });

    // Reventa: sin receta, con existencias contadas.
    refresco = await models.Product.create({
        name: 'Refresco 600 ml', price: 27.50, stock: 10, business_id: owner.id,
    });

    // De cocina: con receta, así que sus existencias las mandan los insumos.
    insumo = await models.Ingredient.create({
        name: 'Carne', unit: 'kg', stock: 50, min_stock: 0, business_id: owner.id,
    });
    hamburguesa = await models.Product.create({
        name: 'Hamburguesa', price: 89.00, stock: 3, business_id: owner.id,
    });
    await models.ProductRecipe.create({
        product_id: hamburguesa.id, item_type: 'ingredient', item_id: insumo.id,
        quantity: 0.2, unit_recipe: 'kg', business_id: owner.id,
    });
});

describe('Qué descuenta y qué no', () => {
    test('un producto SIN receta descuenta las unidades vendidas', async () => {
        const r = await vender({ items: [{ product_id: refresco.id, quantity: 3 }] });
        expect(r.status).toBe(201);
        expect(await stockDe(refresco.id)).toBe(7);
    });

    test('dos renglones del MISMO producto suman: son unidades, no cuentas aparte', async () => {
        // Pasa de verdad: un refresco con hielo y otro sin son dos renglones.
        const r = await vender({
            items: [
                { product_id: refresco.id, quantity: 2, notes: 'con hielo' },
                { product_id: refresco.id, quantity: 3, notes: 'sin hielo' },
            ],
        });
        expect(r.status).toBe(201);
        expect(await stockDe(refresco.id)).toBe(5);
    });

    test('un producto CON receta NO toca su stock: mandan los insumos', async () => {
        const r = await vender({ items: [{ product_id: hamburguesa.id, quantity: 2 }] });
        expect(r.status).toBe(201);
        expect(await stockDe(hamburguesa.id)).toBe(3);          // intacto
        const ing = await models.Ingredient.findByPk(insumo.id);
        expect(parseFloat(ing.stock)).toBeCloseTo(49.6, 4);     // 50 − 2×0.2
    });

    test('stock NULL es SIN CONTROL: ni valida ni descuenta', async () => {
        const libre = await models.Product.create({
            name: 'Servicio', price: 50, stock: null, business_id: owner.id,
        });
        const r = await vender({ items: [{ product_id: libre.id, quantity: 999 }] });
        expect(r.status).toBe(201);
        expect(await stockDe(libre.id)).toBeNull();
    });
});

describe('Faltar existencias AVISA, nunca bloquea', () => {
    test('pedir más de lo que hay devuelve un aviso, no un error', async () => {
        const r = await vender({ items: [{ product_id: refresco.id, quantity: 25 }] });
        expect(r.status).toBe(200);                 // ← 200, no 400 ni 403
        expect(r.body.stock_warning).toBe(true);
        const aviso = r.body.warnings.find((w) => w.product_id === refresco.id);
        expect(aviso).toBeTruthy();
        expect(aviso.available).toBe(10);
        expect(aviso.required).toBe(25);
        // Un binario viejo pinta la lista leyendo `ingredient`: sin esto le
        // saldría "undefined" al cajero.
        expect(aviso.ingredient).toBe('Refresco 600 ml');
        // Y no se vendió nada todavía.
        expect(await stockDe(refresco.id)).toBe(10);
    });

    test('confirmando, la venta PASA y la cuenta no baja de cero', async () => {
        const r = await vender({
            items: [{ product_id: refresco.id, quantity: 25 }],
            skip_stock_check: true,
        });
        expect(r.status).toBe(201);
        expect(await stockDe(refresco.id)).toBe(0);   // nunca negativo
    });

    test('vender justo lo que hay no avisa', async () => {
        const r = await vender({ items: [{ product_id: refresco.id, quantity: 10 }] });
        expect(r.status).toBe(201);
        expect(await stockDe(refresco.id)).toBe(0);
    });
});

describe('Descontar y devolver son simétricos', () => {
    test('cancelar un pedido devuelve las unidades', async () => {
        const venta = await vender({ items: [{ product_id: refresco.id, quantity: 4 }] });
        expect(await stockDe(refresco.id)).toBe(6);

        const r = await request(app)
            .put(`/api/orders/${venta.body.id}/status`)
            .set(auth())
            .send({ status: 'cancelado', role: 'dueno' });
        expect(r.status).toBe(200);
        expect(await stockDe(refresco.id)).toBe(10);
    });

    test('el alias DELETE /:id devuelve lo mismo que PUT /:id/status', async () => {
        const venta = await vender({ items: [{ product_id: refresco.id, quantity: 4 }] });
        const r = await request(app)
            .delete(`/api/orders/${venta.body.id}`)
            .set(auth())
            .send({ role: 'dueno' });
        expect(r.status).toBe(200);
        expect(await stockDe(refresco.id)).toBe(10);
    });

    test('agregar a una mesa descuenta y quitar el renglón devuelve', async () => {
        const mesa = await models.Table.create({ name: 'Mesa 1', business_id: owner.id });
        const abierta = await vender({ items: [], table_id: mesa.id, type: 'dine_in' });
        expect([200, 201]).toContain(abierta.status);

        const agregado = await request(app)
            .post(`/api/orders/${abierta.body.id}/items`)
            .set(auth())
            .send({ items: [{ product_id: refresco.id, quantity: 2 }] });
        expect(agregado.status).toBe(200);
        expect(await stockDe(refresco.id)).toBe(8);

        const renglon = await models.OrderItem.findOne({ where: { order_id: abierta.body.id } });
        const quitado = await request(app)
            .delete(`/api/orders/${abierta.body.id}/items/${renglon.id}`)
            .set(auth());
        expect(quitado.status).toBe(200);
        expect(await stockDe(refresco.id)).toBe(10);
    });
});

describe('Lo que se guarda al dar de alta o editar', () => {
    test('sin existencias en el body, el producto nace SIN CONTROL (null, no 0)', async () => {
        const r = await request(app).post('/api/products').set(auth())
            .send({ name: 'Chicle', price: 5 });
        expect(r.status).toBe(201);
        expect(r.body.stock).toBeNull();
    });

    test('un negativo no es una cuenta: se guarda como sin control', async () => {
        const r = await request(app).post('/api/products').set(auth())
            .send({ name: 'Paleta', price: 12, stock: -20 });
        expect(r.status).toBe(201);
        expect(r.body.stock).toBeNull();
    });

    test('normalizarStock: vacío y basura → null; número → entero', () => {
        expect(normalizarStock('')).toBeNull();
        expect(normalizarStock(null)).toBeNull();
        expect(normalizarStock(undefined)).toBeNull();
        expect(normalizarStock('hola')).toBeNull();
        expect(normalizarStock(-1)).toBeNull();
        expect(normalizarStock(Infinity)).toBeNull();
        expect(normalizarStock('7')).toBe(7);
        expect(normalizarStock(7.6)).toBe(8);
        expect(normalizarStock(0)).toBe(0);      // cero SÍ es una cuenta: "se acabó"
    });
});
