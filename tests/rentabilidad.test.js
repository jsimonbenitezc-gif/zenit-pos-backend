/**
 * BLOQUE 12 V5 — Rentabilidad por producto.
 *
 * Lo que se prueba, en orden de importancia:
 *   1. Que un producto con receta conocida dé el margen esperado (la verificación
 *      que pide el plan).
 *   2. Que un producto SIN receta salga con costo/margen en NULL y no con un
 *      margen del 100% inventado — el error que arruinaría el reporte entero.
 *   3. Que un insumo SIN precio marque el costo como no confiable y diga cuál es.
 *   4. Que el ingreso sea NETO: con impuesto INCLUIDO y con descuento, el margen
 *      no se infla.
 *   5. Que los modificadores del BLOQUE 11 sumen (y resten) costo.
 *   6. Que solo se cuenten las ventas contables, y que la ruta sea premium.
 */
jest.mock('../utils/push', () => ({
    enviarNotificacion: jest.fn(),
    getPrefs: jest.fn().mockResolvedValue({}),
}));

const request = require('supertest');
const { app, sequelize, models, initTestDb, createTestOwner } = require('./setup');
const { mapaDeCostos, costoDeModificadores } = require('../utils/costos');
const { convertirCantidad } = require('../utils/unidades');
const { limpiarCacheImpuestos } = require('../utils/impuestos');
const { limpiarCacheModificadores } = require('../utils/modificadores');

let owner, ownerToken, categoria;

const auth = (token) => ({ Authorization: `Bearer ${token}` });

/** Insumo con precio por unidad. */
function insumo(name, unit, cost, extra = {}) {
    return models.Ingredient.create({
        name, unit, cost_per_unit: cost, stock: 10000, business_id: owner.id, ...extra,
    });
}

function producto(name, price) {
    return models.Product.create({ name, price, category_id: categoria.id, business_id: owner.id });
}

/** Receta de un producto: [{tipo, id, cantidad, unidad}] */
async function receta(prod, lineas) {
    for (const l of lineas) {
        await models.ProductRecipe.create({
            product_id: prod.id,
            item_type: l.tipo || 'ingredient',
            item_id: l.id,
            quantity: l.cantidad,
            unit_recipe: l.unidad || null,
        });
    }
}

function vender(body = {}) {
    return request(app)
        .post('/api/orders')
        .set(auth(ownerToken))
        .send({ payment_method: 'efectivo', skip_stock_check: true, ...body });
}

function rentabilidad(qs = '', token = ownerToken) {
    return request(app).get(`/api/stats/profitability${qs}`).set(auth(token));
}

/** Busca una fila del reporte por id de producto. */
const fila = (body, prod) => body.productos.find(p => p.product_id === prod.id);

async function configurarImpuesto(config) {
    const actuales = owner.settings ? JSON.parse(owner.settings) : {};
    await owner.update({ settings: JSON.stringify({ ...actuales, ...config }) });
    await owner.reload();
    limpiarCacheImpuestos();
}

beforeAll(async () => {
    await initTestDb();
    const result = await createTestOwner();
    owner = result.user;
    ownerToken = result.token;
    categoria = await models.Category.create({ name: 'Comida', business_id: owner.id });
});

afterAll(async () => { await sequelize.close(); });

beforeEach(async () => {
    // Cada prueba parte de un negocio vacío de ventas y de recetas, pero con el
    // mismo dueño (crear uno nuevo por prueba reutilizaría ids y ensuciaría las
    // cachés indexadas por id).
    await models.OrderItem.destroy({ where: {} });
    await models.Order.destroy({ where: {} });
    await models.ProductRecipe.destroy({ where: {} });
    await models.ModifierOptionRecipe.destroy({ where: {} });
    await models.PreparationItem.destroy({ where: {} });
    await models.Preparation.destroy({ where: {} });
    await models.Ingredient.destroy({ where: {} });
    await models.Product.destroy({ where: {} });
    await configurarImpuesto({ tax_enabled: false, tax_rate: 0, tax_included: false });
    // El catálogo de modificadores se cachea por negocio: sin esto, una prueba
    // anterior deja cacheado un catálogo vacío y la venta con extras da 400.
    limpiarCacheModificadores();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. EL CASO QUE PIDE EL PLAN: margen esperado de una receta conocida
// ─────────────────────────────────────────────────────────────────────────────
describe('El margen de una receta conocida', () => {
    test('un producto de $100 con receta de $30 deja $70 (70%)', async () => {
        const carne = await insumo('Carne', 'kg', 200);   // $200 el kilo
        const pan = await insumo('Pan', 'pzas', 10);      // $10 la pieza
        const hamburguesa = await producto('Hamburguesa', 100);
        // 100 g de carne = $20 + 1 pan = $10 → $30
        await receta(hamburguesa, [
            { id: carne.id, cantidad: 100, unidad: 'g' },
            { id: pan.id, cantidad: 1 },
        ]);

        await vender({ items: [{ product_id: hamburguesa.id, quantity: 2 }] });

        const res = await rentabilidad();
        expect(res.status).toBe(200);
        const f = fila(res.body, hamburguesa);
        expect(f.unidades).toBe(2);
        expect(f.ingreso).toBe(200);
        expect(f.costo_unitario).toBe(30);
        expect(f.costo).toBe(60);
        expect(f.margen).toBe(140);
        expect(f.margen_pct).toBe(70);
        expect(f.costo_confiable).toBe(true);
        expect(f.sin_receta).toBe(false);
    });

    test('el resumen suma el margen de todos los productos con receta', async () => {
        const queso = await insumo('Queso', 'kg', 100);
        const a = await producto('Quesadilla', 50);
        const b = await producto('Gringa', 80);
        await receta(a, [{ id: queso.id, cantidad: 100, unidad: 'g' }]); // $10
        await receta(b, [{ id: queso.id, cantidad: 200, unidad: 'g' }]); // $20

        await vender({ items: [
            { product_id: a.id, quantity: 1 },
            { product_id: b.id, quantity: 1 },
        ] });

        const { body } = await rentabilidad();
        expect(body.resumen.ingreso).toBe(130);
        expect(body.resumen.costo).toBe(30);
        expect(body.resumen.margen).toBe(100);
        expect(body.resumen.productos_con_receta).toBe(2);
        expect(body.resumen.productos_sin_receta).toBe(0);
    });

    test('una receta con preparación cuesta lo que cuestan sus insumos', async () => {
        const tomate = await insumo('Tomate', 'kg', 40);
        const salsa = await models.Preparation.create({
            name: 'Salsa', unit: 'porcion', yield_quantity: 1, business_id: owner.id,
        });
        await models.PreparationItem.create({
            preparation_id: salsa.id, ingredient_id: tomate.id, quantity: 250, unit_recipe: 'g',
        }); // $10 la tanda
        const chilaquiles = await producto('Chilaquiles', 90);
        await receta(chilaquiles, [{ tipo: 'preparation', id: salsa.id, cantidad: 2 }]); // $20

        await vender({ items: [{ product_id: chilaquiles.id, quantity: 1 }] });

        const f = fila((await rentabilidad()).body, chilaquiles);
        expect(f.costo).toBe(20);
        expect(f.margen).toBe(70);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. SIN RECETA NO HAY COSTO: HAY NULL
//    Es la regla que decide si el reporte se puede creer o no.
// ─────────────────────────────────────────────────────────────────────────────
describe('Un producto sin receta', () => {
    test('sale con costo y margen en NULL, nunca con margen del 100%', async () => {
        const refresco = await producto('Refresco', 25);
        await vender({ items: [{ product_id: refresco.id, quantity: 4 }] });

        const { body } = await rentabilidad();
        const f = fila(body, refresco);
        expect(f.sin_receta).toBe(true);
        expect(f.costo).toBeNull();
        expect(f.margen).toBeNull();
        expect(f.margen_pct).toBeNull();
        // Vendido sí se reporta: el dueño necesita ver que se vende mucho y que
        // no sabe cuánto le deja.
        expect(f.unidades).toBe(4);
        expect(f.ingreso).toBe(100);
    });

    test('no contamina el resumen del negocio', async () => {
        const pan = await insumo('Pan', 'pzas', 10);
        const conReceta = await producto('Torta', 50);
        await receta(conReceta, [{ id: pan.id, cantidad: 1 }]);
        const sinReceta = await producto('Refresco', 25);

        await vender({ items: [
            { product_id: conReceta.id, quantity: 1 },
            { product_id: sinReceta.id, quantity: 1 },
        ] });

        const { body } = await rentabilidad();
        // El resumen ignora al refresco: sumar su ingreso sin su costo daría un
        // margen del negocio inflado en $25.
        expect(body.resumen.ingreso).toBe(50);
        expect(body.resumen.costo).toBe(10);
        expect(body.resumen.margen).toBe(40);
        expect(body.resumen.productos_sin_receta).toBe(1);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. UN INSUMO SIN PRECIO SE DENUNCIA
// ─────────────────────────────────────────────────────────────────────────────
describe('Un insumo sin costo capturado', () => {
    test('marca el costo como no confiable y dice cuál falta', async () => {
        const carne = await insumo('Carne', 'kg', 200);
        const tortilla = await insumo('Tortilla', 'pzas', 0); // sin precio
        const taco = await producto('Taco', 20);
        await receta(taco, [
            { id: carne.id, cantidad: 50, unidad: 'g' },
            { id: tortilla.id, cantidad: 1 },
        ]);

        await vender({ items: [{ product_id: taco.id, quantity: 1 }] });

        const { body } = await rentabilidad();
        const f = fila(body, taco);
        expect(f.costo).toBe(10);                 // solo la carne
        expect(f.costo_confiable).toBe(false);
        expect(f.insumos_sin_costo).toContain('Tortilla');
        expect(body.resumen.insumos_sin_costo).toContain('Tortilla');
    });

    test('una receta que apunta a un insumo borrado tampoco se da por buena', async () => {
        const fantasma = await insumo('Fantasma', 'kg', 50);
        const plato = await producto('Plato', 60);
        await receta(plato, [{ id: fantasma.id, cantidad: 1 }]);
        await fantasma.destroy();

        await vender({ items: [{ product_id: plato.id, quantity: 1 }] });

        const f = fila((await rentabilidad()).body, plato);
        expect(f.costo_confiable).toBe(false);
        expect(f.insumos_sin_costo).toContain('(insumo eliminado)');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. EL INGRESO ES NETO (impuesto y descuentos)
//    Sin esto, encender el IVA en modo INCLUIDO inflaría todos los márgenes.
// ─────────────────────────────────────────────────────────────────────────────
describe('El ingreso contra el que se compara el costo', () => {
    test('con impuesto INCLUIDO no cuenta el IVA como ingreso', async () => {
        const queso = await insumo('Queso', 'kg', 100);
        const p = await producto('Quesadilla', 116);
        await receta(p, [{ id: queso.id, cantidad: 100, unidad: 'g' }]); // $10
        await configurarImpuesto({ tax_enabled: true, tax_rate: 16, tax_included: true });

        await vender({ items: [{ product_id: p.id, quantity: 1 }] });

        const f = fila((await rentabilidad()).body, p);
        // Se cobraron $116, pero $16 son del fisco: el producto dejó $100.
        expect(f.ingreso).toBe(100);
        expect(f.margen).toBe(90);
    });

    test('con impuesto AGREGADO el ingreso es el precio de lista', async () => {
        const queso = await insumo('Queso', 'kg', 100);
        const p = await producto('Quesadilla', 100);
        await receta(p, [{ id: queso.id, cantidad: 100, unidad: 'g' }]);
        await configurarImpuesto({ tax_enabled: true, tax_rate: 16, tax_included: false });

        await vender({ items: [{ product_id: p.id, quantity: 1 }] });

        const f = fila((await rentabilidad()).body, p);
        expect(f.ingreso).toBe(100); // el IVA se sumó encima, nunca fue del producto
        expect(f.margen).toBe(90);
    });

    test('un descuento baja el ingreso del producto, no su costo', async () => {
        const queso = await insumo('Queso', 'kg', 100);
        const p = await producto('Quesadilla', 100);
        await receta(p, [{ id: queso.id, cantidad: 100, unidad: 'g' }]); // $10
        const promo = await models.Discount.create({
            name: '20%', type: 'percentage', value: 20, business_id: owner.id,
        });

        await vender({
            items: [{ product_id: p.id, quantity: 1 }],
            discount_amount: 20,
            discount_id: promo.id,
        });

        const f = fila((await rentabilidad()).body, p);
        expect(f.ingreso).toBe(80);  // se cobraron $80
        expect(f.costo).toBe(10);    // el queso costó lo mismo
        expect(f.margen).toBe(70);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. MODIFICADORES (BLOQUE 11): el extra cobra Y cuesta
// ─────────────────────────────────────────────────────────────────────────────
describe('Los modificadores en el costo', () => {
    async function extra(nombre, delta) {
        const grupo = await models.ModifierGroup.create({
            business_id: owner.id, name: 'Extras', max_select: 5,
        });
        const opcion = await models.ModifierOption.create({
            group_id: grupo.id, business_id: owner.id, name: nombre, price_delta: delta,
        });
        return { grupo, opcion };
    }

    test('"extra queso" suma su insumo al costo', async () => {
        const queso = await insumo('Queso', 'kg', 100);
        const p = await producto('Hamburguesa', 100);
        await receta(p, [{ id: queso.id, cantidad: 100, unidad: 'g' }]); // $10
        const { grupo, opcion } = await extra('Extra queso', 15);
        await models.ProductModifierGroup.create({
            product_id: p.id, group_id: grupo.id, business_id: owner.id,
        });
        await models.ModifierOptionRecipe.create({
            option_id: opcion.id, business_id: owner.id,
            item_type: 'ingredient', item_id: queso.id, quantity: 50, unit_recipe: 'g',
        }); // +$5

        await vender({ items: [
            { product_id: p.id, quantity: 1, modifiers: [{ option_id: opcion.id }] },
        ] });

        const f = fila((await rentabilidad()).body, p);
        expect(f.ingreso).toBe(115);  // 100 + 15 del extra
        expect(f.costo).toBe(15);     // 10 de la receta + 5 del queso extra
        expect(f.margen).toBe(100);
    });

    test('"sin cebolla" DEVUELVE insumo y baja el costo', async () => {
        const cebolla = await insumo('Cebolla', 'kg', 40);
        const p = await producto('Hamburguesa', 100);
        await receta(p, [{ id: cebolla.id, cantidad: 500, unidad: 'g' }]); // $20
        const { grupo, opcion } = await extra('Sin cebolla', 0);
        await models.ProductModifierGroup.create({
            product_id: p.id, group_id: grupo.id, business_id: owner.id,
        });
        await models.ModifierOptionRecipe.create({
            option_id: opcion.id, business_id: owner.id,
            item_type: 'ingredient', item_id: cebolla.id, quantity: -500, unit_recipe: 'g',
        }); // −$20: la cebolla nunca salió de la cocina

        await vender({ items: [
            { product_id: p.id, quantity: 1, modifiers: [{ option_id: opcion.id }] },
        ] });

        const f = fila((await rentabilidad()).body, p);
        expect(f.costo).toBe(0);
        expect(f.margen).toBe(100);
    });

    test('costoDeModificadores ignora un JSON corrupto en vez de reventar', () => {
        expect(costoDeModificadores('{no es json', new Map())).toEqual({ costo: 0, faltantes: [] });
        expect(costoDeModificadores(null, new Map())).toEqual({ costo: 0, faltantes: [] });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. QUÉ VENTAS CUENTAN, Y QUIÉN PUEDE VER EL REPORTE
// ─────────────────────────────────────────────────────────────────────────────
describe('Alcance del reporte', () => {
    test('una venta cancelada no cuenta', async () => {
        const queso = await insumo('Queso', 'kg', 100);
        const p = await producto('Quesadilla', 50);
        await receta(p, [{ id: queso.id, cantidad: 100, unidad: 'g' }]);

        const buena = await vender({ items: [{ product_id: p.id, quantity: 1 }] });
        const mala = await vender({ items: [{ product_id: p.id, quantity: 5 }] });
        await models.Order.update({ status: 'cancelado' }, { where: { id: mala.body.id } });
        expect(buena.status).toBe(201);

        const f = fila((await rentabilidad()).body, p);
        expect(f.unidades).toBe(1);
    });

    test('una mesa ABIERTA todavía no cuenta como venta', async () => {
        const queso = await insumo('Queso', 'kg', 100);
        const p = await producto('Quesadilla', 50);
        await receta(p, [{ id: queso.id, cantidad: 100, unidad: 'g' }]);
        const mesa = await models.Table.create({ name: 'M1', business_id: owner.id });

        await vender({ items: [{ product_id: p.id, quantity: 3 }], table_id: mesa.id });

        const { body } = await rentabilidad();
        expect(fila(body, p)).toBeUndefined();
    });

    test('un rango fuera del periodo no trae la venta', async () => {
        const p = await producto('Quesadilla', 50);
        await vender({ items: [{ product_id: p.id, quantity: 1 }] });

        const res = await rentabilidad('?date_from=2020-01-01&date_to=2020-01-31');
        expect(res.status).toBe(200);
        expect(res.body.productos).toHaveLength(0);
    });

    test('un periodo mayor a un año se rechaza con un mensaje accionable', async () => {
        const res = await rentabilidad('?date_from=2020-01-01&date_to=2026-01-01');
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/un año/i);
    });

    test('un negocio sin plan premium no puede verlo', async () => {
        const { token } = await createTestOwner({ plan: 'free', plan_expires_at: null });
        const res = await rentabilidad('', token);
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('plan_required');
    });

    test('sin sesión responde 401', async () => {
        const res = await request(app).get('/api/stats/profitability');
        expect(res.status).toBe(401);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. LA FÓRMULA DE COSTO, SUELTA
// ─────────────────────────────────────────────────────────────────────────────
describe('utils/costos y utils/unidades', () => {
    test('la conversión de unidades respeta las compatibles y deja pasar las que no lo son', () => {
        expect(convertirCantidad(500, 'g', 'kg')).toBe(0.5);
        expect(convertirCantidad(2, 'l', 'ml')).toBe(2000);
        expect(convertirCantidad(3, 'kg', 'kg')).toBe(3);
        // Sin factor conocido se devuelve tal cual: hacer fallar una venta por
        // esto sería peor que descontar una pieza por un kilo.
        expect(convertirCantidad(3, 'pzas', 'kg')).toBe(3);
        expect(convertirCantidad(3, null, 'kg')).toBe(3);
    });

    test('el mapa de costos aísla por negocio', async () => {
        const otro = await createTestOwner();
        const miInsumo = await insumo('Mío', 'kg', 100);
        const miProducto = await producto('Mío', 50);
        await receta(miProducto, [{ id: miInsumo.id, cantidad: 1 }]);

        const ajeno = await models.Product.create({
            name: 'Ajeno', price: 10, business_id: otro.user.id,
        });

        const mapa = await mapaDeCostos(owner.id);
        expect(mapa.productos.get(miProducto.id).costo).toBe(100);
        expect(mapa.productos.get(ajeno.id)).toBeUndefined();
    });
});
