jest.mock('../utils/push', () => ({
    enviarNotificacion: jest.fn(),
    getPrefs: jest.fn().mockResolvedValue({}),
}));

const request = require('supertest');
const { app, sequelize, models, initTestDb, createTestOwner } = require('./setup');

let owner, ownerToken, product, ingredient;

beforeAll(async () => {
    await initTestDb();

    // Crear owner con plan premium (requerido para ver inventario)
    const result = await createTestOwner();
    owner = result.user;
    ownerToken = result.token;

    // Crear categoría
    const category = await models.Category.create({
        name: 'Comida',
        business_id: owner.id,
    });

    // Crear producto
    product = await models.Product.create({
        name: 'Hamburguesa',
        price: 100,
        category_id: category.id,
        business_id: owner.id,
    });

    // Crear ingrediente con stock
    ingredient = await models.Ingredient.create({
        name: 'Carne',
        unit: 'kg',
        stock: 10,
        min_stock: 1,
        business_id: owner.id,
    });

    // Crear receta: 1 hamburguesa = 0.2 kg de carne
    await models.ProductRecipe.create({
        product_id: product.id,
        item_type: 'ingredient',
        item_id: ingredient.id,
        quantity: 0.2,
    });
});

afterAll(async () => {
    await sequelize.close();
});

describe('Inventory — flujos críticos', () => {

    test('Crear pedido reduce stock de ingredientes', async () => {
        const stockAntes = 10;

        const res = await request(app)
            .post('/api/orders')
            .set('Authorization', `Bearer ${ownerToken}`)
            .send({
                items: [{ product_id: product.id, quantity: 3 }],
            });

        expect(res.status).toBe(201);

        // Recargar ingrediente desde la DB
        await ingredient.reload();
        const stockDespues = parseFloat(ingredient.stock);

        // 3 hamburguesas × 0.2 kg = 0.6 kg consumidos
        expect(stockDespues).toBeCloseTo(stockAntes - 0.6, 1);
    });

    test('Consultar ingredientes devuelve stock correcto', async () => {
        const res = await request(app)
            .get('/api/inventory/ingredients')
            .set('Authorization', `Bearer ${ownerToken}`);

        expect(res.status).toBe(200);

        const data = res.body.data || res.body;
        const items = Array.isArray(data) ? data : [data];
        const carne = items.find(i => i.name === 'Carne');

        expect(carne).toBeDefined();
        expect(parseFloat(carne.stock)).toBeCloseTo(9.4, 1);
    });
});
