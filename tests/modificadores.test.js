/**
 * BLOQUE 11 V5 — Modificadores de producto con precio.
 *
 * Lo que se prueba, en orden de importancia:
 *   1. Que el modificador COBRE: "extra queso +$10" sube el total, y el delta
 *      sale SIEMPRE de la base de datos, nunca del cliente. Es el motivo del
 *      bloque: hasta ahora el extra viajaba como nota de texto y se regalaba.
 *   2. Que el INVENTARIO cuadre en los dos sentidos: un extra consume de más y
 *      un "sin cebolla" devuelve lo que la receta base descontó — y cancelar
 *      deshace exactamente eso.
 *   3. Que los invariantes de los bloques anteriores sigan intactos: el impuesto
 *      se calcula sobre el precio YA con extras (§29), y `total = subtotal +
 *      tax_amount` sigue siendo cierto.
 *   4. Que una venta DIFERIDA (offline) conserve lo que cobró, aunque la opción
 *      haya cambiado de precio o la hayan borrado. Nunca se rechaza.
 *   5. Que un pedido SIN modificadores se comporte exactamente como antes del
 *      bloque — compatibilidad con todos los binarios viejos.
 */
jest.mock('../utils/push', () => ({
    enviarNotificacion: jest.fn(),
    getPrefs: jest.fn().mockResolvedValue({}),
}));

const request = require('supertest');
const bcrypt = require('bcrypt');
const { app, sequelize, models, initTestDb, createTestOwner } = require('./setup');
const {
    deltaDeModificadores, precioConModificadores, resumenModificadores,
    normalizarSeleccion, idsDeSeleccion, normalizarDelta, leerModificadores,
    resolverModificadores, MAX_MODIFICADORES_POR_ITEM, MAX_DELTA,
} = require('../utils/modificadores');
const { invalidarImpuestoNegocio } = require('../utils/impuestos');

let owner, ownerToken, product, otroProducto, grupoExtras, opcionQueso, opcionSinCebolla;

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const PIN_CAJERO = '4321';

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

async function configurarImpuesto({ activo, tasa, incluido }) {
    const settings = JSON.parse(owner.settings || '{}');
    settings.tax_enabled = activo;
    settings.tax_rate = tasa;
    settings.tax_included = incluido;
    await owner.update({ settings: JSON.stringify(settings) });
    invalidarImpuestoNegocio(owner.id);
}

beforeAll(async () => {
    await initTestDb();
    const result = await createTestOwner();
    owner = result.user;
    ownerToken = result.token;

    const category = await models.Category.create({ name: 'Comida', business_id: owner.id });
    product = await models.Product.create({
        name: 'Hamburguesa', price: 100.00, category_id: category.id, business_id: owner.id,
    });
    otroProducto = await models.Product.create({
        name: 'Refresco', price: 25.00, category_id: category.id, business_id: owner.id,
    });

    grupoExtras = await models.ModifierGroup.create({
        business_id: owner.id, name: 'Extras', min_select: 0, max_select: null,
    });
    opcionQueso = await models.ModifierOption.create({
        group_id: grupoExtras.id, business_id: owner.id, name: 'Extra queso', price_delta: 10.00,
    });
    opcionSinCebolla = await models.ModifierOption.create({
        group_id: grupoExtras.id, business_id: owner.id, name: 'Sin cebolla', price_delta: 0,
    });
    // Puesto 'cajero' con PIN, para poder probar la cancelación (§19.19).
    const settings = JSON.parse(owner.settings || '{}');
    settings.permisos_roles = {
        cajero: { enabled: true, pin_set: true, pin_bcrypt: await bcrypt.hash(PIN_CAJERO, 10) },
    };
    await owner.update({ settings: JSON.stringify(settings) });

    // Solo la hamburguesa usa "Extras". El refresco no: sirve para probar que
    // una opción no se puede cobrar en un producto que no la ofrece.
    await models.ProductModifierGroup.create({
        product_id: product.id, group_id: grupoExtras.id, business_id: owner.id, sort_order: 0,
    });
});

afterAll(async () => {
    await sequelize.close();
});

// ── 1. LA FÓRMULA (la parte que está triplicada en desktop y mobile) ─────────

describe('La fórmula del precio con modificadores', () => {
    test('suma los deltas al precio base', () => {
        expect(precioConModificadores(100, [{ price_delta: 10 }])).toBe(110);
        expect(precioConModificadores(100, [{ price_delta: 10 }, { price_delta: 25 }])).toBe(135);
    });

    test('un delta negativo baja el precio ("chico -$10")', () => {
        expect(precioConModificadores(100, [{ price_delta: -10 }])).toBe(90);
    });

    test('un delta de cero no cambia nada ("sin cebolla")', () => {
        expect(precioConModificadores(100, [{ price_delta: 0 }])).toBe(100);
    });

    test('sin modificadores el precio es el de siempre', () => {
        expect(precioConModificadores(100, [])).toBe(100);
        expect(precioConModificadores(100, null)).toBe(100);
        expect(precioConModificadores(100, undefined)).toBe(100);
    });

    test('nunca baja de cero: una configuración absurda cobra 0, no negativo', () => {
        // Un precio negativo convertiría una venta en una devolución silenciosa.
        expect(precioConModificadores(50, [{ price_delta: -80 }])).toBe(0);
    });

    test('redondea a dos decimales', () => {
        // Cada delta es decimal(10,2) en la base, así que se redondea ANTES de
        // sumarse: 0.005 → 0.01. Es lo mismo que hace Postgres al guardarlo.
        expect(precioConModificadores(10.00, [{ price_delta: 0.005 }])).toBe(10.01);
        expect(precioConModificadores(99.99, [{ price_delta: 0.01 }])).toBe(100);
        expect(deltaDeModificadores([{ price_delta: 0.1 }, { price_delta: 0.2 }])).toBe(0.3);
    });

    test('un delta inservible se descarta en vez de romper la cuenta', () => {
        expect(normalizarDelta('abc')).toBe(null);
        expect(normalizarDelta(Infinity)).toBe(null);
        expect(normalizarDelta(MAX_DELTA + 1)).toBe(null);
        expect(normalizarDelta(null)).toBe(0);
        expect(normalizarDelta('')).toBe(0);
        // Y en la suma, simplemente no cuenta: la venta sigue.
        expect(deltaDeModificadores([{ price_delta: 10 }, { price_delta: 'abc' }])).toBe(10);
    });

    test('el resumen es lo que se imprime en el ticket y el KDS', () => {
        expect(resumenModificadores([{ name: 'Extra queso' }, { name: 'Sin cebolla' }]))
            .toBe('Extra queso, Sin cebolla');
        expect(resumenModificadores([])).toBe('');
        expect(resumenModificadores(null)).toBe('');
    });

    test('normalizarSeleccion descarta lo inservible sin fallar', () => {
        const limpio = normalizarSeleccion([
            { option_id: 1, group_id: 2, group: 'Extras', name: 'Extra queso', price_delta: 10 },
            { name: '', price_delta: 5 },        // sin nombre → fuera
            { name: 'Roto', price_delta: 'xx' }, // delta inservible → fuera
            'basura',                            // ni siquiera es objeto → fuera
        ]);
        expect(limpio).toHaveLength(1);
        expect(limpio[0]).toEqual({
            option_id: 1, group_id: 2, group: 'Extras', name: 'Extra queso', price_delta: 10,
        });
    });

    test('acepta las dos formas de mandar la selección', () => {
        expect(idsDeSeleccion([3, 7])).toEqual([3, 7]);
        expect(idsDeSeleccion([{ option_id: 3 }, { id: 7 }])).toEqual([3, 7]);
    });

    test('leerModificadores nunca revienta con un JSON roto', () => {
        expect(leerModificadores(null)).toEqual([]);
        expect(leerModificadores('{no es json')).toEqual([]);
        expect(leerModificadores('{"a":1}')).toEqual([]); // objeto, no array
        expect(leerModificadores('[{"name":"X"}]')).toEqual([{ name: 'X' }]);
    });
});

// ── 2. QUE COBRE (el motivo del bloque) ─────────────────────────────────────

describe('El modificador cobra', () => {
    test('"extra queso +$10" sube el total de la venta', async () => {
        const res = await venta({
            items: [{ product_id: product.id, quantity: 1, modifiers: [{ option_id: opcionQueso.id }] }],
        });
        expect(res.status).toBe(201);
        expect(parseFloat(res.body.total)).toBe(110);

        const item = res.body.items[0];
        expect(parseFloat(item.unit_price)).toBe(110);
        expect(parseFloat(item.base_unit_price)).toBe(100);
        expect(parseFloat(item.subtotal)).toBe(110);
    });

    test('el delta se multiplica por la cantidad', async () => {
        const res = await venta({
            items: [{ product_id: product.id, quantity: 3, modifiers: [{ option_id: opcionQueso.id }] }],
        });
        expect(res.status).toBe(201);
        expect(parseFloat(res.body.total)).toBe(330); // 3 × (100 + 10)
    });

    test('NUNCA se le cree el precio al cliente en una venta online', async () => {
        // El cliente jura que el extra queso cuesta $500. La base dice $10.
        const res = await venta({
            items: [{
                product_id: product.id, quantity: 1,
                modifiers: [{ option_id: opcionQueso.id, price_delta: 500, name: 'Extra queso GRATIS' }],
            }],
        });
        expect(res.status).toBe(201);
        expect(parseFloat(res.body.total)).toBe(110);
        const mods = JSON.parse(res.body.items[0].modifiers);
        expect(mods[0].price_delta).toBe(10);
        expect(mods[0].name).toBe('Extra queso');
    });

    test('la selección queda CONGELADA en el pedido', async () => {
        const res = await venta({
            items: [{
                product_id: product.id, quantity: 1,
                modifiers: [{ option_id: opcionQueso.id }, { option_id: opcionSinCebolla.id }],
            }],
        });
        expect(res.status).toBe(201);
        const mods = JSON.parse(res.body.items[0].modifiers);
        expect(mods).toHaveLength(2);
        expect(mods.map(m => m.name)).toEqual(['Extra queso', 'Sin cebolla']);
        expect(mods[0].group).toBe('Extras');
        expect(mods[0].group_id).toBe(grupoExtras.id);
    });

    test('subir el precio del extra NO cambia un ticket ya cobrado', async () => {
        const res = await venta({
            items: [{ product_id: product.id, quantity: 1, modifiers: [{ option_id: opcionQueso.id }] }],
        });
        const pedidoId = res.body.id;

        await opcionQueso.update({ price_delta: 40 });
        require('../utils/modificadores').invalidarCatalogoModificadores(owner.id);

        const reimpresion = await request(app).get(`/api/orders/${pedidoId}`).set(auth(ownerToken));
        expect(parseFloat(reimpresion.body.total)).toBe(110);
        expect(JSON.parse(reimpresion.body.items[0].modifiers)[0].price_delta).toBe(10);

        // La siguiente venta sí cobra el precio nuevo.
        const nueva = await venta({
            items: [{ product_id: product.id, quantity: 1, modifiers: [{ option_id: opcionQueso.id }] }],
        });
        expect(parseFloat(nueva.body.total)).toBe(140);

        await opcionQueso.update({ price_delta: 10 });
        require('../utils/modificadores').invalidarCatalogoModificadores(owner.id);
    });
});

// ── 3. LO QUE SE VALIDA Y LO QUE NO ─────────────────────────────────────────

describe('Validación de la selección', () => {
    test('una opción de otro producto se rechaza (400)', async () => {
        // El refresco no tiene enganchado el grupo "Extras".
        const res = await venta({
            items: [{ product_id: otroProducto.id, quantity: 1, modifiers: [{ option_id: opcionQueso.id }] }],
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/no es un modificador de este producto/i);
    });

    test('una opción inexistente se rechaza con un mensaje accionable', async () => {
        const res = await venta({
            items: [{ product_id: product.id, quantity: 1, modifiers: [{ option_id: 999999 }] }],
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/ya no existe/i);
    });

    test('se respeta el máximo de opciones del grupo', async () => {
        const grupoTamano = await models.ModifierGroup.create({
            business_id: owner.id, name: 'Tamaño', min_select: 1, max_select: 1,
        });
        const chico = await models.ModifierOption.create({
            group_id: grupoTamano.id, business_id: owner.id, name: 'Chico', price_delta: -10,
        });
        const grande = await models.ModifierOption.create({
            group_id: grupoTamano.id, business_id: owner.id, name: 'Grande', price_delta: 25,
        });
        await models.ProductModifierGroup.create({
            product_id: product.id, group_id: grupoTamano.id, business_id: owner.id, sort_order: 1,
        });
        require('../utils/modificadores').invalidarCatalogoModificadores(owner.id);

        const res = await venta({
            items: [{
                product_id: product.id, quantity: 1,
                modifiers: [{ option_id: chico.id }, { option_id: grande.id }],
            }],
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/solo puedes elegir 1 opción/i);

        // Una sola sí pasa, y cobra el delta negativo.
        const ok = await venta({
            items: [{ product_id: product.id, quantity: 1, modifiers: [{ option_id: grande.id }] }],
        });
        expect(ok.status).toBe(201);
        expect(parseFloat(ok.body.total)).toBe(125);
    });

    test('min_select NO se valida en el servidor, a propósito', async () => {
        // "Tamaño" quedó con min_select: 1 en el test anterior. Una venta sin
        // elegir tamaño DEBE seguir pasando: si no, un binario viejo —que nunca
        // manda modificadores— dejaría de poder vender ese producto.
        const res = await venta({ items: [{ product_id: product.id, quantity: 1 }] });
        expect(res.status).toBe(201);
        expect(parseFloat(res.body.total)).toBe(100);
    });

    test('un modificador sin identificar se rechaza online', async () => {
        const res = await venta({
            items: [{ product_id: product.id, quantity: 1, modifiers: [{ name: 'Inventado', price_delta: 5 }] }],
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/sin identificar/i);
    });

    test('se rechaza pasarse del tope por renglón', () => {
        const muchos = Array.from({ length: MAX_MODIFICADORES_POR_ITEM + 1 }, (_, i) => ({ option_id: i + 1 }));
        const r = resolverModificadores({
            seleccion: muchos, productId: product.id,
            catalogo: { grupos: new Map(), opciones: new Map(), porProducto: new Map() },
            esVentaDiferida: false,
        });
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/como máximo/i);
    });
});

// ── 4. VENTA DIFERIDA (§26): nunca se rechaza ───────────────────────────────

describe('Venta diferida (offline)', () => {
    test('respeta el delta congelado que cobró el POS', async () => {
        const res = await venta({
            client_uuid: 'uuid-offline-mods-1',
            sold_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
            items: [{
                product_id: product.id, quantity: 1, unit_price: 100,
                // El POS cobró $30 de extra: ese día la opción costaba eso.
                modifiers: [{ option_id: opcionQueso.id, name: 'Extra queso', price_delta: 30, group: 'Extras' }],
            }],
        });
        expect(res.status).toBe(201);
        expect(parseFloat(res.body.total)).toBe(130);
        expect(JSON.parse(res.body.items[0].modifiers)[0].price_delta).toBe(30);
    });

    test('acepta una opción que ya fue BORRADA de la biblioteca', async () => {
        const res = await venta({
            client_uuid: 'uuid-offline-mods-2',
            sold_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
            items: [{
                product_id: product.id, quantity: 1, unit_price: 100,
                modifiers: [{ option_id: 999999, name: 'Extra tocino', price_delta: 15 }],
            }],
        });
        expect(res.status).toBe(201);
        expect(parseFloat(res.body.total)).toBe(115);
    });

    test('un modificador basura no tumba la venta: cae a 0', async () => {
        const res = await venta({
            client_uuid: 'uuid-offline-mods-3',
            sold_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
            items: [{
                product_id: product.id, quantity: 1, unit_price: 100,
                modifiers: [{ name: 'Roto', price_delta: 'abc' }],
            }],
        });
        expect(res.status).toBe(201);
        expect(parseFloat(res.body.total)).toBe(100);
    });

    test('el extra NO se audita como precio distinto al catálogo', async () => {
        // El precio base es el del catálogo; solo cambia por los extras. Auditar
        // eso llenaría la bitácora de ruido en cada "extra queso".
        const antes = await models.PrivilegedActionLog.count({
            where: { business_id: owner.id, action_type: 'offline_price' },
        });
        await venta({
            client_uuid: 'uuid-offline-mods-4',
            sold_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
            items: [{
                product_id: product.id, quantity: 1, unit_price: 100,
                modifiers: [{ option_id: opcionQueso.id, name: 'Extra queso', price_delta: 10 }],
            }],
        });
        const despues = await models.PrivilegedActionLog.count({
            where: { business_id: owner.id, action_type: 'offline_price' },
        });
        expect(despues).toBe(antes);
    });
});

// ── 5. INVENTARIO: los dos sentidos ─────────────────────────────────────────

describe('Inventario', () => {
    let queso, cebolla, opcionExtraQueso, opcionQuitarCebolla, hamburguesa;

    beforeAll(async () => {
        queso = await models.Ingredient.create({
            name: 'Queso', unit: 'g', stock: 1000, business_id: owner.id,
        });
        cebolla = await models.Ingredient.create({
            name: 'Cebolla', unit: 'g', stock: 1000, business_id: owner.id,
        });

        hamburguesa = await models.Product.create({
            name: 'Hamburguesa con receta', price: 100, business_id: owner.id,
        });
        // Receta base: 50 g de cebolla.
        await models.ProductRecipe.create({
            product_id: hamburguesa.id, item_type: 'ingredient', item_id: cebolla.id,
            quantity: 50, unit_recipe: 'g',
        });

        const grupo = await models.ModifierGroup.create({
            business_id: owner.id, name: 'Ajustes de cocina', max_select: null,
        });
        opcionExtraQueso = await models.ModifierOption.create({
            group_id: grupo.id, business_id: owner.id, name: 'Extra queso', price_delta: 10,
        });
        opcionQuitarCebolla = await models.ModifierOption.create({
            group_id: grupo.id, business_id: owner.id, name: 'Sin cebolla', price_delta: 0,
        });
        // +30 g de queso.
        await models.ModifierOptionRecipe.create({
            option_id: opcionExtraQueso.id, business_id: owner.id,
            item_type: 'ingredient', item_id: queso.id, quantity: 30, unit_recipe: 'g',
        });
        // −50 g de cebolla: devuelve lo que la receta base descontó.
        await models.ModifierOptionRecipe.create({
            option_id: opcionQuitarCebolla.id, business_id: owner.id,
            item_type: 'ingredient', item_id: cebolla.id, quantity: -50, unit_recipe: 'g',
        });
        await models.ProductModifierGroup.create({
            product_id: hamburguesa.id, group_id: grupo.id, business_id: owner.id,
        });
        require('../utils/modificadores').invalidarCatalogoModificadores(owner.id);
    });

    test('"extra queso" descuenta el queso extra', async () => {
        await queso.reload();
        const antes = parseFloat(queso.stock);

        const res = await venta({
            items: [{ product_id: hamburguesa.id, quantity: 2, modifiers: [{ option_id: opcionExtraQueso.id }] }],
        });
        expect(res.status).toBe(201);

        await queso.reload();
        expect(parseFloat(queso.stock)).toBe(antes - 60); // 2 × 30 g
    });

    test('"sin cebolla" DEVUELVE la cebolla que la receta base descontó', async () => {
        await cebolla.reload();
        const antes = parseFloat(cebolla.stock);

        const res = await venta({
            items: [{ product_id: hamburguesa.id, quantity: 1, modifiers: [{ option_id: opcionQuitarCebolla.id }] }],
        });
        expect(res.status).toBe(201);

        await cebolla.reload();
        // La receta base quitó 50 g y el modificador los devolvió: neto 0.
        expect(parseFloat(cebolla.stock)).toBe(antes);
    });

    test('cancelar el pedido deshace el ajuste de los modificadores', async () => {
        await queso.reload();
        const antes = parseFloat(queso.stock);

        const res = await venta({
            items: [{ product_id: hamburguesa.id, quantity: 1, modifiers: [{ option_id: opcionExtraQueso.id }] }],
        });
        await queso.reload();
        expect(parseFloat(queso.stock)).toBe(antes - 30);

        const cancel = await request(app)
            .put(`/api/orders/${res.body.id}/status`)
            .set(auth(ownerToken))
            .send({ status: 'cancelado', role: 'cajero', pin: PIN_CAJERO });
        expect(cancel.status).toBe(200);

        await queso.reload();
        expect(parseFloat(queso.stock)).toBe(antes);
    });

    // ── Quitar un item de una mesa devuelve los insumos ──────────────────────
    // Hueco PREEXISTENTE (anterior al bloque): agregar el producto a la mesa
    // descontaba los insumos, pero quitarlo NO los devolvía. El stock se desviaba
    // en silencio, un plato a la vez, y nadie podía reconstruir por qué.

    test('quitar un item de la mesa DEVUELVE los insumos de su receta', async () => {
        await cebolla.update({ stock: 1000 });
        const antes = 1000;

        const mesa = await models.Table.create({ name: `Mesa devol ${Date.now()}`, business_id: owner.id });
        const abrir = await request(app)
            .post('/api/orders')
            .set(auth(ownerToken))
            .send({ table_id: mesa.id, items: [], payment_method: 'efectivo', skip_stock_check: true });

        const agregar = await request(app)
            .post(`/api/orders/${abrir.body.id}/items`)
            .set(auth(ownerToken))
            .send({ items: [{ product_id: hamburguesa.id, quantity: 2 }] });
        expect(agregar.status).toBe(200);

        await cebolla.reload();
        expect(parseFloat(cebolla.stock)).toBe(antes - 100); // 2 × 50 g

        const itemId = agregar.body.items[0].id;
        const quitar = await request(app)
            .delete(`/api/orders/${abrir.body.id}/items/${itemId}`)
            .set(auth(ownerToken));
        expect(quitar.status).toBe(200);

        await cebolla.reload();
        expect(parseFloat(cebolla.stock)).toBe(antes);
    });

    test('quitar un item DESHACE también el ajuste de sus modificadores', async () => {
        await queso.update({ stock: 1000 });
        await cebolla.update({ stock: 1000 });

        const mesa = await models.Table.create({ name: `Mesa devol mods ${Date.now()}`, business_id: owner.id });
        const abrir = await request(app)
            .post('/api/orders')
            .set(auth(ownerToken))
            .send({ table_id: mesa.id, items: [], payment_method: 'efectivo', skip_stock_check: true });

        const agregar = await request(app)
            .post(`/api/orders/${abrir.body.id}/items`)
            .set(auth(ownerToken))
            .send({
                items: [{
                    product_id: hamburguesa.id, quantity: 1,
                    modifiers: [{ option_id: opcionExtraQueso.id }, { option_id: opcionQuitarCebolla.id }],
                }],
            });
        expect(agregar.status).toBe(200);

        await queso.reload();
        await cebolla.reload();
        expect(parseFloat(queso.stock)).toBe(970);    // −30 g del extra
        expect(parseFloat(cebolla.stock)).toBe(1000); // −50 receta +50 "sin cebolla"

        const itemId = agregar.body.items[0].id;
        await request(app)
            .delete(`/api/orders/${abrir.body.id}/items/${itemId}`)
            .set(auth(ownerToken));

        await queso.reload();
        await cebolla.reload();
        // Todo vuelve a su sitio: el queso extra y la cebolla que se devolvió.
        expect(parseFloat(queso.stock)).toBe(1000);
        expect(parseFloat(cebolla.stock)).toBe(1000);
    });

    test('quitar y volver a agregar deja el stock igual que al principio', async () => {
        // La prueba que de verdad importa: el mesero se equivoca de plato, lo
        // quita y pone el correcto. Si descontar y devolver no son simétricos,
        // cada corrección deja una fuga y el inventario se desvía solo.
        await cebolla.update({ stock: 500 });

        const mesa = await models.Table.create({ name: `Mesa ida y vuelta ${Date.now()}`, business_id: owner.id });
        const abrir = await request(app)
            .post('/api/orders')
            .set(auth(ownerToken))
            .send({ table_id: mesa.id, items: [], payment_method: 'efectivo', skip_stock_check: true });

        for (let i = 0; i < 3; i++) {
            const agregar = await request(app)
                .post(`/api/orders/${abrir.body.id}/items`)
                .set(auth(ownerToken))
                .send({ items: [{ product_id: hamburguesa.id, quantity: 1 }] });
            const itemId = agregar.body.items[agregar.body.items.length - 1].id;
            await request(app)
                .delete(`/api/orders/${abrir.body.id}/items/${itemId}`)
                .set(auth(ownerToken));
        }

        await cebolla.reload();
        expect(parseFloat(cebolla.stock)).toBe(500);
    });

    test('el total de la mesa sigue cuadrando tras quitar el item', async () => {
        const mesa = await models.Table.create({ name: `Mesa total ${Date.now()}`, business_id: owner.id });
        const abrir = await request(app)
            .post('/api/orders')
            .set(auth(ownerToken))
            .send({ table_id: mesa.id, items: [], payment_method: 'efectivo', skip_stock_check: true });

        const agregar = await request(app)
            .post(`/api/orders/${abrir.body.id}/items`)
            .set(auth(ownerToken))
            .send({
                items: [
                    { product_id: hamburguesa.id, quantity: 1, modifiers: [{ option_id: opcionExtraQueso.id }] },
                    { product_id: hamburguesa.id, quantity: 1 },
                ],
            });
        expect(parseFloat(agregar.body.total)).toBe(210); // (100+10) + 100

        const conExtra = agregar.body.items.find(i => i.modifiers);
        const quitar = await request(app)
            .delete(`/api/orders/${abrir.body.id}/items/${conExtra.id}`)
            .set(auth(ownerToken));

        expect(quitar.status).toBe(200);
        expect(parseFloat(quitar.body.total)).toBe(100);
    });

    test('el aviso de stock cuenta los extras', async () => {
        await queso.update({ stock: 10 }); // solo alcanza para un tercio de un extra
        const res = await venta({
            skip_stock_check: false,
            items: [{ product_id: hamburguesa.id, quantity: 1, modifiers: [{ option_id: opcionExtraQueso.id }] }],
        });
        expect(res.status).toBe(200);
        expect(res.body.stock_warning).toBe(true);
        expect(res.body.warnings.some(w => w.ingredient === 'Queso')).toBe(true);
        await queso.update({ stock: 1000 });
    });
});

// ── 6. QUE NO SE ROMPA NADA DE LOS BLOQUES ANTERIORES ───────────────────────

describe('Convivencia con los bloques anteriores', () => {
    afterEach(async () => {
        await configurarImpuesto({ activo: false, tasa: 0, incluido: true });
    });

    test('el impuesto se calcula sobre el precio YA con extras (§29)', async () => {
        await configurarImpuesto({ activo: true, tasa: 16, incluido: false });

        const res = await venta({
            items: [{ product_id: product.id, quantity: 1, modifiers: [{ option_id: opcionQueso.id }] }],
        });
        expect(res.status).toBe(201);
        // Base gravable = 110 (100 + extra). Impuesto = 17.60. Total = 127.60.
        expect(parseFloat(res.body.subtotal)).toBe(110);
        expect(parseFloat(res.body.tax_amount)).toBe(17.60);
        expect(parseFloat(res.body.total)).toBe(127.60);
    });

    test('el invariante total = subtotal + impuesto sigue intacto', async () => {
        await configurarImpuesto({ activo: true, tasa: 16, incluido: true });

        const res = await venta({
            items: [{ product_id: product.id, quantity: 2, modifiers: [{ option_id: opcionQueso.id }] }],
        });
        expect(res.status).toBe(201);
        const { subtotal, tax_amount, total } = res.body;
        expect(parseFloat(subtotal) + parseFloat(tax_amount)).toBeCloseTo(parseFloat(total), 2);
        // Modo INCLUIDO: el precio con extra ya trae el impuesto → se cobra 220.
        expect(parseFloat(total)).toBe(220);
    });

    test('el descuento sigue bajando la base gravable, ya con extras', async () => {
        const descuento = await models.Discount.create({
            name: 'Promo', type: 'fixed', value: 10, business_id: owner.id, requires_pin: false,
        });
        const res = await venta({
            items: [{ product_id: product.id, quantity: 1, modifiers: [{ option_id: opcionQueso.id }] }],
            discount_id: descuento.id,
            discount_amount: 10,
        });
        expect(res.status).toBe(201);
        expect(parseFloat(res.body.total)).toBe(100); // 100 + 10 extra − 10 descuento
    });

    test('un pedido SIN modificadores se comporta exactamente como antes', async () => {
        const res = await venta({ items: [{ product_id: product.id, quantity: 2 }] });
        expect(res.status).toBe(201);
        expect(parseFloat(res.body.total)).toBe(200);
        expect(res.body.items[0].modifiers).toBeFalsy();
        // `base_unit_price` queda igual al unitario: no hay nada que desglosar.
        expect(parseFloat(res.body.items[0].base_unit_price)).toBe(100);
    });
});

// ── 7. AGREGAR A UNA MESA ABIERTA ───────────────────────────────────────────

describe('Mesas', () => {
    test('agregar un producto con extra a la mesa sube la cuenta', async () => {
        const mesa = await models.Table.create({ name: 'Mesa mods', business_id: owner.id });

        const abrir = await request(app)
            .post('/api/orders')
            .set(auth(ownerToken))
            .send({ table_id: mesa.id, items: [], payment_method: 'efectivo', skip_stock_check: true });
        expect(abrir.status).toBe(201);

        const agregar = await request(app)
            .post(`/api/orders/${abrir.body.id}/items`)
            .set(auth(ownerToken))
            .send({
                items: [{ product_id: product.id, quantity: 1, modifiers: [{ option_id: opcionQueso.id }] }],
                client_uuid: 'lote-mods-1',
            });
        expect(agregar.status).toBe(200);
        expect(parseFloat(agregar.body.total)).toBe(110);
        expect(JSON.parse(agregar.body.items[0].modifiers)[0].name).toBe('Extra queso');
    });

    test('reenviar el mismo lote no duplica el extra (idempotencia §26)', async () => {
        const mesa = await models.Table.create({ name: 'Mesa mods 2', business_id: owner.id });
        const abrir = await request(app)
            .post('/api/orders')
            .set(auth(ownerToken))
            .send({ table_id: mesa.id, items: [], payment_method: 'efectivo', skip_stock_check: true });

        const cuerpo = {
            items: [{ product_id: product.id, quantity: 1, modifiers: [{ option_id: opcionQueso.id }] }],
            client_uuid: 'lote-mods-repetido',
        };
        await request(app).post(`/api/orders/${abrir.body.id}/items`).set(auth(ownerToken)).send(cuerpo);
        const segundo = await request(app)
            .post(`/api/orders/${abrir.body.id}/items`).set(auth(ownerToken)).send(cuerpo);

        expect(segundo.status).toBe(200);
        expect(segundo.body.items).toHaveLength(1);
        expect(parseFloat(segundo.body.total)).toBe(110);
    });
});

// ── 8. LA BIBLIOTECA (CRUD) ─────────────────────────────────────────────────

describe('Biblioteca de modificadores', () => {
    test('el catálogo se devuelve entero en una llamada', async () => {
        const res = await request(app).get('/api/modifiers').set(auth(ownerToken));
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.groups)).toBe(true);
        expect(Array.isArray(res.body.product_groups)).toBe(true);

        const extras = res.body.groups.find(g => g.name === 'Extras');
        expect(extras).toBeTruthy();
        expect(extras.options.some(o => o.name === 'Extra queso' && o.price_delta === 10)).toBe(true);
        expect(res.body.product_groups.some(e => e.product_id === product.id && e.group_id === extras.id)).toBe(true);
    });

    test('un grupo se engancha a VARIOS productos (es una biblioteca)', async () => {
        const res = await request(app)
            .put(`/api/modifiers/products/${otroProducto.id}`)
            .set(auth(ownerToken))
            .send({ group_ids: [grupoExtras.id] });
        expect(res.status).toBe(200);

        // Ahora el refresco sí puede llevar extra queso.
        const v = await venta({
            items: [{ product_id: otroProducto.id, quantity: 1, modifiers: [{ option_id: opcionQueso.id }] }],
        });
        expect(v.status).toBe(201);
        expect(parseFloat(v.body.total)).toBe(35); // 25 + 10

        // Se deshace para no contaminar otros tests.
        await request(app).put(`/api/modifiers/products/${otroProducto.id}`)
            .set(auth(ownerToken)).send({ group_ids: [] });
    });

    test('un delta inválido se rechaza al configurarlo (400)', async () => {
        const res = await request(app)
            .post(`/api/modifiers/groups/${grupoExtras.id}/options`)
            .set(auth(ownerToken))
            .send({ name: 'Absurdo', price_delta: MAX_DELTA + 1 });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/no es válido/i);
    });

    test('no se puede enganchar un grupo de otro negocio', async () => {
        const otro = await createTestOwner();
        const grupoAjeno = await models.ModifierGroup.create({
            business_id: otro.user.id, name: 'Ajeno', max_select: 1,
        });
        const res = await request(app)
            .put(`/api/modifiers/products/${product.id}`)
            .set(auth(ownerToken))
            .send({ group_ids: [grupoAjeno.id] });
        expect(res.status).toBe(404);
    });

    test('borrar un grupo lo suelta de sus productos', async () => {
        const grupo = await models.ModifierGroup.create({
            business_id: owner.id, name: 'Temporal', max_select: 1,
        });
        await request(app).put(`/api/modifiers/products/${product.id}`)
            .set(auth(ownerToken)).send({ group_ids: [grupoExtras.id, grupo.id] });

        const del = await request(app).delete(`/api/modifiers/groups/${grupo.id}`).set(auth(ownerToken));
        expect(del.status).toBe(200);

        const enlaces = await request(app).get(`/api/modifiers/products/${product.id}`).set(auth(ownerToken));
        expect(enlaces.body.some(e => e.group_id === grupo.id)).toBe(false);
        // El grupo de siempre sigue enganchado.
        expect(enlaces.body.some(e => e.group_id === grupoExtras.id)).toBe(true);
    });

    test('un empleado no puede configurar la biblioteca (es del dueño)', async () => {
        const empleado = await models.User.create({
            username: `cajero_${Date.now()}@test.com`, password: 'TestPass123',
            name: 'Cajero', role: 'cashier', business_id: owner.id,
        });
        const jwt = require('jsonwebtoken');
        const tokenEmpleado = jwt.sign(
            { id: empleado.id, username: empleado.username, role: 'cashier', business_id: owner.id },
            process.env.JWT_SECRET, { expiresIn: '1d' }
        );

        const res = await request(app)
            .post('/api/modifiers/groups')
            .set(auth(tokenEmpleado))
            .send({ name: 'No debería' });
        expect(res.status).toBe(403);

        // Pero SÍ puede leer el catálogo: lo necesita para armar el carrito.
        const lectura = await request(app).get('/api/modifiers').set(auth(tokenEmpleado));
        expect(lectura.status).toBe(200);
    });

    test('la receta de una opción se guarda y se lee', async () => {
        const insumo = await models.Ingredient.create({
            name: 'Tocino', unit: 'g', stock: 500, business_id: owner.id,
        });
        const opcion = await models.ModifierOption.create({
            group_id: grupoExtras.id, business_id: owner.id, name: 'Extra tocino', price_delta: 20,
        });

        const guardar = await request(app)
            .post(`/api/modifiers/options/${opcion.id}/recipe`)
            .set(auth(ownerToken))
            .send({ items: [{ item_type: 'ingredient', item_id: insumo.id, quantity: 25, unit_recipe: 'g' }] });
        expect(guardar.status).toBe(200);

        const leer = await request(app)
            .get(`/api/modifiers/options/${opcion.id}/recipe`).set(auth(ownerToken));
        expect(leer.status).toBe(200);
        expect(leer.body).toHaveLength(1);
        expect(leer.body[0].name).toBe('Tocino');
        expect(leer.body[0].quantity).toBe(25);
    });
});
