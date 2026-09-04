/**
 * STOCK POR SUCURSAL: UNA SOLA FUENTE (deuda técnica §12.1)
 *
 * Lo que de verdad hay que probar aquí NO es que el helper lea la tabla —eso es
 * fácil y no se rompe—, sino el escalón peligroso del cambio:
 *
 *   🔴 El JSON legado dejó de leerse EN EL MISMO despliegue. Si el respaldo no
 *      copia el JSON a la tabla, un negocio cuyo stock vivía solo ahí pasa a
 *      leer 0. En la base de producción eran 10 de 17 pares — la sucursal 3
 *      entera. O sea: un inventario borrado.
 *
 * Por eso casi todos los casos empiezan sembrando la columna JSON POR SQL CRUDO
 * (el modelo ya no la declara, que es justo lo que impide volver a usarla) y
 * comprueban que después del respaldo el inventario sigue diciendo lo mismo.
 */

jest.mock('../utils/push', () => ({
    enviarNotificacion: jest.fn(),
    getPrefs: jest.fn().mockResolvedValue({}),
}));

const request = require('supertest');
const { app, sequelize, models, initTestDb, createTestOwner } = require('./setup');
const {
    leerStockSucursal, escribirStockSucursal, lectorDeStock,
    mapaPorSucursal, mapaSumaTodasSucursales, respaldarJsonEnTabla,
} = require('../utils/branchStock');

const { Ingredient, BranchStock, Branch } = models;

/**
 * Recrea la columna JSON legada. `sequelize.sync({force:true})` ya no la crea
 * (el modelo no la declara), pero en Postgres SÍ existe: sin esto los tests
 * probarían un mundo que no es el de producción.
 */
async function crearColumnaLegada() {
    try {
        await sequelize.query('ALTER TABLE ingredients ADD COLUMN branch_stocks TEXT');
    } catch {
        // Ya existe (SQLite se queja): es idempotente a propósito.
    }
}

async function sembrarJson(ingredienteId, objeto) {
    await sequelize.query(
        'UPDATE ingredients SET branch_stocks = ? WHERE id = ?',
        { replacements: [JSON.stringify(objeto), ingredienteId] }
    );
}

async function leerJson(ingredienteId) {
    const [rows] = await sequelize.query(
        'SELECT branch_stocks FROM ingredients WHERE id = ?',
        { replacements: [ingredienteId] }
    );
    return rows[0] ? rows[0].branch_stocks : null;
}

describe('Stock por sucursal — una sola fuente (§12.1)', () => {
    let owner, ownerToken, biz, sucursalA, sucursalB;

    beforeAll(async () => {
        await initTestDb();
    });

    beforeEach(async () => {
        await sequelize.sync({ force: true });
        await crearColumnaLegada();

        const t = await createTestOwner();
        owner = t.user;
        ownerToken = t.token;
        biz = owner.business_id || owner.id;

        sucursalA = await Branch.create({ name: 'Centro', business_id: biz, active: true });
        sucursalB = await Branch.create({ name: 'Norte', business_id: biz, active: true });
    });

    afterAll(async () => {
        await sequelize.close();
    });

    const crearInsumo = (extra = {}) => Ingredient.create({
        name: 'Queso', unit: 'kg', stock: 7, min_stock: 1, business_id: biz, ...extra
    });

    // ── EL RESPALDO: lo que evita borrar un inventario ────────────────────────

    describe('respaldarJsonEnTabla', () => {
        test('🔴 copia a la tabla un par que SOLO existía en el JSON', async () => {
            const ing = await crearInsumo();
            // Igual que la sucursal 3 de producción: stock real, cero filas en la tabla.
            await sembrarJson(ing.id, { [sucursalB.id]: 33 });

            expect(await BranchStock.count()).toBe(0);

            const r = await respaldarJsonEnTabla();
            expect(r.copiados).toBe(1);

            const fila = await BranchStock.findOne({
                where: { ingredient_id: ing.id, branch_id: sucursalB.id }
            });
            expect(fila).not.toBeNull();
            expect(parseFloat(fila.quantity)).toBeCloseTo(33, 3);
            expect(fila.business_id).toBe(biz);
        });

        test('🔴 sin el respaldo ese stock se leería como 0 — con él se lee bien', async () => {
            const ing = await crearInsumo({ stock: 0 });
            await sembrarJson(ing.id, { [sucursalA.id]: 10, [sucursalB.id]: 33 });

            await respaldarJsonEnTabla();

            // La lectura pasa por la cadena real, no por el JSON.
            expect(await leerStockSucursal(ing, sucursalB.id)).toBeCloseTo(33, 3);
            expect(await leerStockSucursal(ing, sucursalA.id)).toBeCloseTo(10, 3);
        });

        test('la TABLA MANDA: no pisa un par que ya existe', async () => {
            const ing = await crearInsumo();
            // La tabla tiene el valor bueno; el JSON, uno viejo y con ruido de float.
            await BranchStock.create({
                ingredient_id: ing.id, branch_id: sucursalA.id,
                quantity: 1.11, business_id: biz
            });
            await sembrarJson(ing.id, { [sucursalA.id]: 999.9999999 });

            const r = await respaldarJsonEnTabla();
            expect(r.copiados).toBe(0);

            const fila = await BranchStock.findOne({
                where: { ingredient_id: ing.id, branch_id: sucursalA.id }
            });
            expect(parseFloat(fila.quantity)).toBeCloseTo(1.11, 3);
        });

        test('es idempotente: la segunda pasada no copia nada', async () => {
            const ing = await crearInsumo();
            await sembrarJson(ing.id, { [sucursalA.id]: 5, [sucursalB.id]: 8 });

            expect((await respaldarJsonEnTabla()).copiados).toBe(2);
            expect((await respaldarJsonEnTabla()).copiados).toBe(0);
            expect(await BranchStock.count()).toBe(2);
        });

        test('NO borra el JSON: la columna queda como copia de respaldo', async () => {
            const ing = await crearInsumo();
            await sembrarJson(ing.id, { [sucursalA.id]: 5 });

            await respaldarJsonEnTabla();

            const json = await leerJson(ing.id);
            expect(json).toBeTruthy();
            expect(JSON.parse(json)[String(sucursalA.id)]).toBe(5);
        });

        test('descarta basura sin tumbar el respaldo del resto', async () => {
            const bueno = await crearInsumo({ name: 'Bueno' });
            const roto = await crearInsumo({ name: 'Roto' });
            const raro = await crearInsumo({ name: 'Raro' });

            await sembrarJson(bueno.id, { [sucursalA.id]: 12 });
            await sequelize.query(
                "UPDATE ingredients SET branch_stocks = 'no soy json' WHERE id = ?",
                { replacements: [roto.id] }
            );
            await sembrarJson(raro.id, { abc: 5, '-3': 9, [sucursalB.id]: 'hola' });

            const r = await respaldarJsonEnTabla();

            // Solo entra el par válido; nada revienta.
            expect(r.copiados).toBe(1);
            expect(await BranchStock.count()).toBe(1);
            const fila = await BranchStock.findOne({ where: { ingredient_id: bueno.id } });
            expect(parseFloat(fila.quantity)).toBeCloseTo(12, 3);
        });

        test('acotado a un negocio, no toca los insumos de otro', async () => {
            const otro = await createTestOwner();
            const bizOtro = otro.user.business_id || otro.user.id;

            const mio = await crearInsumo();
            const ajeno = await Ingredient.create({
                name: 'Ajeno', unit: 'kg', stock: 1, business_id: bizOtro
            });
            await sembrarJson(mio.id, { [sucursalA.id]: 4 });
            await sembrarJson(ajeno.id, { [sucursalA.id]: 4 });

            const r = await respaldarJsonEnTabla(biz);
            expect(r.copiados).toBe(1);
            expect(await BranchStock.count({ where: { ingredient_id: ajeno.id } })).toBe(0);
        });
    });

    // ── LA CADENA DE LECTURA: los cuatro escalones ────────────────────────────

    describe('cadena de lectura', () => {
        test('1. sin sucursal → el stock global', async () => {
            const ing = await crearInsumo({ stock: 7 });
            expect(await leerStockSucursal(ing, null)).toBeCloseTo(7, 3);
        });

        test('2. con sucursal y con fila → esa fila', async () => {
            const ing = await crearInsumo({ stock: 7 });
            await BranchStock.create({
                ingredient_id: ing.id, branch_id: sucursalA.id, quantity: 2.5, business_id: biz
            });
            expect(await leerStockSucursal(ing, sucursalA.id)).toBeCloseTo(2.5, 3);
        });

        test('3. insumo SIN repartir → el stock global, nunca 0', async () => {
            // Es el negocio que acaba de crear su segunda sucursal: su insumo no
            // está repartido todavía y vale lo mismo en las dos. Devolver 0 aquí
            // le vaciaría el inventario.
            const ing = await crearInsumo({ stock: 7 });
            expect(await leerStockSucursal(ing, sucursalA.id)).toBeCloseTo(7, 3);
        });

        test('4. insumo repartido pero no en ESTA sucursal → 0 de verdad', async () => {
            const ing = await crearInsumo({ stock: 7 });
            await BranchStock.create({
                ingredient_id: ing.id, branch_id: sucursalA.id, quantity: 4, business_id: biz
            });
            expect(await leerStockSucursal(ing, sucursalB.id)).toBe(0);
        });

        test('lectorDeStock (en bloque) da lo MISMO que leerStockSucursal', async () => {
            const repartido = await crearInsumo({ name: 'Repartido', stock: 7 });
            const sinRepartir = await crearInsumo({ name: 'Sin repartir', stock: 9 });
            const enOtra = await crearInsumo({ name: 'Solo en Norte', stock: 3 });

            await BranchStock.create({
                ingredient_id: repartido.id, branch_id: sucursalA.id, quantity: 2, business_id: biz
            });
            await BranchStock.create({
                ingredient_id: enOtra.id, branch_id: sucursalB.id, quantity: 6, business_id: biz
            });

            const ids = [repartido.id, sinRepartir.id, enOtra.id];
            const stockDe = await lectorDeStock(ids, sucursalA.id);

            for (const ing of [repartido, sinRepartir, enOtra]) {
                expect(stockDe(ing)).toBeCloseTo(await leerStockSucursal(ing, sucursalA.id), 3);
            }
            expect(stockDe(repartido)).toBeCloseTo(2, 3);
            expect(stockDe(sinRepartir)).toBeCloseTo(9, 3);
            expect(stockDe(enOtra)).toBe(0); // repartido, pero no aquí
        });

        test('lectorDeStock acepta ids que llegan como texto', async () => {
            const ing = await crearInsumo({ stock: 7 });
            await BranchStock.create({
                ingredient_id: ing.id, branch_id: sucursalA.id, quantity: 2, business_id: biz
            });
            const stockDe = await lectorDeStock([String(ing.id)], String(sucursalA.id));
            expect(stockDe(ing)).toBeCloseTo(2, 3);
        });
    });

    // ── ESCRITURA ─────────────────────────────────────────────────────────────

    describe('escribirStockSucursal', () => {
        test('con sucursal escribe la tabla y NO toca el JSON', async () => {
            const ing = await crearInsumo({ stock: 7 });
            await sembrarJson(ing.id, { [sucursalA.id]: 1 });

            await escribirStockSucursal(ing, sucursalA.id, 42);

            const fila = await BranchStock.findOne({
                where: { ingredient_id: ing.id, branch_id: sucursalA.id }
            });
            expect(parseFloat(fila.quantity)).toBeCloseTo(42, 3);

            // El JSON se queda congelado en lo que había: ya no es fuente de nada.
            expect(JSON.parse(await leerJson(ing.id))[String(sucursalA.id)]).toBe(1);
        });

        test('sin sucursal escribe el stock global', async () => {
            const ing = await crearInsumo({ stock: 7 });
            await escribirStockSucursal(ing, null, 3);
            await ing.reload();
            expect(parseFloat(ing.stock)).toBeCloseTo(3, 3);
            expect(await BranchStock.count()).toBe(0);
        });

        test('escribir y volver a leer da el mismo número', async () => {
            const ing = await crearInsumo({ stock: 7 });
            await escribirStockSucursal(ing, sucursalB.id, 12.345);
            expect(await leerStockSucursal(ing, sucursalB.id)).toBeCloseTo(12.345, 3);
        });
    });

    // ── MAPAS PARA LOS LISTADOS ───────────────────────────────────────────────

    describe('mapas', () => {
        test('mapaPorSucursal desglosa cada insumo por sucursal', async () => {
            const ing = await crearInsumo();
            await BranchStock.create({
                ingredient_id: ing.id, branch_id: sucursalA.id, quantity: 2, business_id: biz
            });
            await BranchStock.create({
                ingredient_id: ing.id, branch_id: sucursalB.id, quantity: 5, business_id: biz
            });

            const mapa = await mapaPorSucursal([ing.id]);
            expect(mapa[ing.id][String(sucursalA.id)]).toBeCloseTo(2, 3);
            expect(mapa[ing.id][String(sucursalB.id)]).toBeCloseTo(5, 3);
        });

        test('mapaSumaTodasSucursales suma el reparto', async () => {
            const ing = await crearInsumo();
            await BranchStock.create({
                ingredient_id: ing.id, branch_id: sucursalA.id, quantity: 2, business_id: biz
            });
            await BranchStock.create({
                ingredient_id: ing.id, branch_id: sucursalB.id, quantity: 5, business_id: biz
            });

            const suma = await mapaSumaTodasSucursales([ing.id]);
            expect(suma[ing.id]).toBeCloseTo(7, 3);
        });

        test('un insumo sin repartir no aparece en el mapa de sumas', async () => {
            // Y por eso el listado conserva su stock global en vez de pintar 0.
            const ing = await crearInsumo({ stock: 9 });
            const suma = await mapaSumaTodasSucursales([ing.id]);
            expect(ing.id in suma).toBe(false);
        });
    });

    // ── EL CAMINO DE LA VENTA, DE PUNTA A PUNTA ───────────────────────────────
    // Es el escenario exacto de producción: la sucursal 3 tenía su inventario SOLO
    // en el JSON. Aquí se vende contra él y se comprueba que descuenta de verdad.

    test('🔴 vender descuenta bien un insumo cuyo stock vivía SOLO en el JSON', async () => {
        const categoria = await models.Category.create({ name: 'Comida', business_id: biz });
        const producto = await models.Product.create({
            name: 'Taco', price: 30, category_id: categoria.id, business_id: biz
        });
        // stock global 0: si la venta cayera al stock global en vez de al de la
        // sucursal, este test lo vería (descontaría desde 0, no desde 33).
        const tortilla = await Ingredient.create({
            name: 'Tortilla', unit: 'pcs', stock: 0, min_stock: 0, business_id: biz
        });
        await models.ProductRecipe.create({
            product_id: producto.id, item_type: 'ingredient',
            item_id: tortilla.id, quantity: 2, unit_recipe: 'pcs'
        });

        await sembrarJson(tortilla.id, { [sucursalB.id]: 33 });
        await respaldarJsonEnTabla();

        const res = await request(app)
            .post('/api/orders')
            .set('Authorization', `Bearer ${ownerToken}`)
            .send({
                items: [{ product_id: producto.id, quantity: 3, unit_price: 30 }],
                payment_method: 'efectivo',
                branch_id: sucursalB.id,
            });

        expect(res.status).toBe(201);

        // 33 − (3 tacos × 2 tortillas) = 27
        const fila = await BranchStock.findOne({
            where: { ingredient_id: tortilla.id, branch_id: sucursalB.id }
        });
        expect(parseFloat(fila.quantity)).toBeCloseTo(27, 3);

        // Y el global sigue en 0: la venta no se fue por el camino equivocado.
        await tortilla.reload();
        expect(parseFloat(tortilla.stock)).toBeCloseTo(0, 3);
    });

    // ── EL MODELO YA NO PUEDE VOLVER A USAR EL JSON ───────────────────────────

    test('el modelo Ingredient ya NO declara branch_stocks', async () => {
        // Es el cerrojo del bloque: mientras el atributo no exista, ningún
        // `include`, `attributes` ni `update` puede resucitar la segunda fuente.
        expect(Object.keys(Ingredient.rawAttributes)).not.toContain('branch_stocks');

        const ing = await crearInsumo();
        expect(ing.toJSON().branch_stocks).toBeUndefined();
    });
});
