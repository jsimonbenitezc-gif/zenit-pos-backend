// ============================================================================
// PLAN_OFERTAS_V1 — BLOQUE 1: la promo existe y se cobra
//
// "Martes 2x1 en tacos": la cajera toca la promo, elige pastor y arrachera, y
// entra UN renglón de $35. En la base son dos OrderItem con su parte del precio
// (14.58 + 20.42), unidos por `promo_group`. El servidor recalcula el precio
// online, respeta lo cobrado en una venta diferida (§26) y evalúa el
// calendario en la zona del negocio.
// ============================================================================
jest.mock('../utils/push', () => ({
    enviarNotificacion: jest.fn(),
    getPrefs: jest.fn().mockResolvedValue({}),
}));

const request = require('supertest');
const { app, sequelize, models, initTestDb, createTestOwner } = require('./setup');
const promos = require('../utils/promos');
const { descuentoVigente } = require('../utils/descuentos');

const TZ = 'America/Mexico_City'; // UTC−6 todo el año desde 2022

let owner, token, tacos, bebidas, pastor, arrachera, suadero, refresco, queso;
let dosPorUno;
let contador = 0;
const uuid = () => `33333333-3333-4333-8333-${String(++contador).padStart(12, '0')}`;
const auth = () => ({ Authorization: `Bearer ${token}` });

// El día de la semana LOCAL del negocio, hoy y ayer.
const hoyLocal = () => promos.localEnZona(TZ, new Date()).dow;
const otroDia = (d) => (d + 3) % 7;

function vender(items, extra = {}) {
    return request(app).post('/api/orders').set(auth())
        .send({ items, skip_stock_check: true, ...extra });
}

const promo2x1 = (a, b, extra = {}) => ({
    promo_id: dosPorUno.id,
    productos: [{ product_id: a.id }, { product_id: b.id }],
    ...extra,
});

async function crearPromo(body, items) {
    const c = await request(app).post('/api/offers/combos').set(auth()).send(body);
    expect(c.status).toBe(201);
    const r = await request(app).post(`/api/offers/combos/${c.body.id}/items`).set(auth()).send({ items });
    expect(r.status).toBe(200);
    return r.body;
}

beforeAll(async () => {
    await initTestDb();
    const r = await createTestOwner({ settings: JSON.stringify({ tz: TZ }) });
    owner = r.user;
    token = r.token;
    tacos = await models.Category.create({ name: 'Tacos', business_id: owner.id });
    bebidas = await models.Category.create({ name: 'Bebidas', business_id: owner.id });
    pastor = await models.Product.create({ name: 'Pastor', price: 25, category_id: tacos.id, business_id: owner.id });
    arrachera = await models.Product.create({ name: 'Arrachera', price: 35, category_id: tacos.id, business_id: owner.id });
    suadero = await models.Product.create({ name: 'Suadero', price: 30, category_id: tacos.id, business_id: owner.id });
    refresco = await models.Product.create({ name: 'Refresco', price: 20, category_id: bebidas.id, business_id: owner.id });

    // Extra de queso enganchado al pastor (§32).
    const grupo = await models.ModifierGroup.create({ business_id: owner.id, name: 'Extras', min_select: 0, max_select: null });
    queso = await models.ModifierOption.create({ group_id: grupo.id, business_id: owner.id, name: 'Queso', price_delta: 10 });
    await models.ProductModifierGroup.create({ product_id: pastor.id, group_id: grupo.id, business_id: owner.id });

    dosPorUno = await crearPromo(
        { name: '2x1 Tacos', tipo: 'regalar_mas_barato', paga: 1 },
        [{ category_id: tacos.id, quantity: 2 }]
    );
});

afterAll(async () => {
    await sequelize.close();
});

// ════════════════════════════════════════════════════════════════════════════
// LA REGLA, SOLA (utils/promos.js — la que se copia a los clientes)
// ════════════════════════════════════════════════════════════════════════════
describe('utils/promos — el precio y el reparto', () => {
    test('2x1: se regala el más barato', () => {
        expect(promos.precioPromo({ tipo: 'regalar_mas_barato', paga: 1 }, [25, 35])).toBe(35);
    });

    test('3x2 con precios distintos: se regala el más barato de los tres', () => {
        expect(promos.precioPromo({ tipo: 'regalar_mas_barato', paga: 2 }, [30, 20, 40])).toBe(70);
    });

    test('precio fijo', () => {
        expect(promos.precioPromo({ tipo: 'precio_fijo', price: 40 }, [25, 35])).toBe(40);
    });

    test('el reparto es proporcional y la suma es EXACTA a centavos', () => {
        expect(promos.repartir(35, [25, 35])).toEqual([14.58, 20.42]);
        // 3 × $33.33 por $50: 16.666… cada uno. Sin el residuo sumaría 50.01.
        const partes = promos.repartir(50, [33.33, 33.33, 33.33]);
        expect(Math.round(partes.reduce((s, p) => s + p, 0) * 100)).toBe(5000);
        expect(partes).toEqual([16.66, 16.67, 16.67]);
        // El residuo va al más caro.
        expect(promos.repartir(10, [1, 1, 2])).toEqual([2.5, 2.5, 5]);
        expect(promos.repartir(0.1, [1, 1, 1]).reduce((s, p) => s + p, 0)).toBeCloseTo(0.1, 10);
    });

    test('muchos precios que no dividen: la suma cuadra SIEMPRE', () => {
        for (let k = 0; k < 300; k++) {
            const n = 2 + (k % 5);
            const precios = Array.from({ length: n }, (_, i) => ((k * 7 + i * 13) % 97) + 0.33 * (i + 1));
            const precio = ((k * 11) % 150) + 0.07;
            const partes = promos.repartir(precio, precios);
            const suma = partes.reduce((s, p) => s + Math.round(p * 100), 0);
            expect(suma).toBe(Math.round(precio * 100));
            partes.forEach(p => expect(p).toBeGreaterThanOrEqual(0));
        }
    });

    test('los extras van ENCIMA de su parte, completos', () => {
        const a = promos.armarPromo({ tipo: 'regalar_mas_barato', paga: 1 },
            [{ precio: 25, delta: 10 }, { precio: 35, delta: 0 }]);
        expect(a.renglones.map(r => r.unit_price)).toEqual([24.58, 20.42]);
        expect(a.total).toBe(45);
        expect(a.ahorro).toBe(25);
    });

    test('la elección cabe con vuelta atrás (dos huecos que se pisan)', () => {
        const huecos = [
            { quantity: 1, product_ids: [1] },
            { quantity: 1, product_ids: [1, 2] },
        ];
        // Lo primero que cae mete el 1 en el segundo hueco; sin vuelta atrás, fallaría.
        expect(promos.eleccionCabe(huecos, [{ id: 2 }, { id: 1 }])).toBe(true);
        expect(promos.eleccionCabe(huecos, [{ id: 2 }, { id: 2 }])).toBe(false);
        expect(promos.eleccionCabe([{ quantity: 2, category_id: 5 }], [{ id: 9, category_id: 5 }])).toBe(false);
    });
});

describe('utils/promos — el calendario', () => {
    const martes = { dias: [2] };

    test('🔴 martes EN MÉXICO, no en UTC', () => {
        // Martes 22 de sept, 21:00 en México = miércoles 03:00 UTC.
        expect(promos.promoActiva({ calendario: martes }, TZ, new Date('2026-09-23T03:00:00Z'))).toBe(true);
        // Lunes 21, 23:00 en México = martes 05:00 UTC: todavía es lunes.
        expect(promos.promoActiva({ calendario: martes }, TZ, new Date('2026-09-22T05:00:00Z'))).toBe(false);
    });

    test('happy hour del viernes de 22:00 a 02:00: el sábado a la 1:30 sigue vivo', () => {
        const cal = { dias: [5], desde: '22:00', hasta: '02:00' };
        const en = (iso) => promos.promoActiva({ calendario: cal }, TZ, new Date(iso));
        expect(en('2026-09-26T04:30:00Z')).toBe(true);   // viernes 22:30
        expect(en('2026-09-26T07:30:00Z')).toBe(true);   // sábado 01:30
        expect(en('2026-09-26T08:30:00Z')).toBe(false);  // sábado 02:30
        expect(en('2026-09-26T03:00:00Z')).toBe(false);  // viernes 21:00
        expect(en('2026-09-27T07:30:00Z')).toBe(false);  // domingo 01:30 (el sábado no tiene)
    });

    test('la fecha fin cuenta ENTERA, y la noche que cruza pertenece a su día', () => {
        const cal = { fecha_fin: '2026-09-22' };
        expect(promos.promoActiva({ calendario: cal }, TZ, new Date('2026-09-23T05:59:00Z'))).toBe(true);  // 22, 23:59
        expect(promos.promoActiva({ calendario: cal }, TZ, new Date('2026-09-23T06:01:00Z'))).toBe(false); // 23, 00:01
        const noche = { fecha_fin: '2026-09-25', desde: '22:00', hasta: '02:00' };
        expect(promos.promoActiva({ calendario: noche }, TZ, new Date('2026-09-26T07:30:00Z'))).toBe(true);
    });

    test('un calendario basura se rechaza, no cae a "siempre"', () => {
        expect(promos.normalizarCalendario({ dias: [9] }).ok).toBe(false);
        expect(promos.normalizarCalendario({ dias: [] }).ok).toBe(false);
        expect(promos.normalizarCalendario({ desde: '18:00' }).ok).toBe(false);
        expect(promos.normalizarCalendario({ desde: '25:00', hasta: '02:00' }).ok).toBe(false);
        expect(promos.normalizarCalendario({ fecha_inicio: '2026-10-31', fecha_fin: '2026-10-01' }).ok).toBe(false);
        expect(promos.normalizarCalendario('{roto').ok).toBe(false);
        expect(promos.normalizarCalendario({ dias: [0, 1, 2, 3, 4, 5, 6] })).toEqual({ ok: true, calendario: null });
    });

    test('un descuento con calendario ("10% los lunes") usa la misma regla', () => {
        const d = { active: true, calendario: { dias: [1] } };
        expect(descuentoVigente(d, new Date('2026-09-21T18:00:00Z'), TZ)).toBe(true);   // lunes
        expect(descuentoVigente(d, new Date('2026-09-22T18:00:00Z'), TZ)).toBe(false);  // martes
    });
});

// ════════════════════════════════════════════════════════════════════════════
// LA VENTA
// ════════════════════════════════════════════════════════════════════════════
describe('POST /orders con una promo', () => {
    test('🔴 2x1 de pastor + arrachera cobra $35, repartido 14.58 + 20.42', async () => {
        const res = await vender([promo2x1(pastor, arrachera)]);
        expect(res.status).toBe(201);
        expect(parseFloat(res.body.total)).toBe(35);
        const items = res.body.items.sort((a, b) => a.product_id - b.product_id);
        expect(items).toHaveLength(2);
        expect(items.map(i => parseFloat(i.unit_price))).toEqual([14.58, 20.42]);
        expect(items[0].promo_group).toBeTruthy();
        expect(items[0].promo_group).toBe(items[1].promo_group);
        expect(items.every(i => i.promo_id === dosPorUno.id && i.promo_name === '2x1 Tacos')).toBe(true);
        expect(items.map(i => parseFloat(i.list_price))).toEqual([25, 35]);
    });

    test('online, un precio inventado por el cliente se IGNORA', async () => {
        const res = await vender([{
            promo_id: dosPorUno.id, promo_price: 1,
            productos: [{ product_id: pastor.id, list_price: 1 }, { product_id: arrachera.id, list_price: 1 }],
        }]);
        expect(res.status).toBe(201);
        expect(parseFloat(res.body.total)).toBe(35);
    });

    test('dos promos iguales son DOS grupos, aunque el cliente mande el mismo uuid', async () => {
        const g = '11111111-1111-4111-8111-111111111111';
        const res = await vender([promo2x1(pastor, arrachera, { promo_group: g }), promo2x1(suadero, pastor, { promo_group: g })]);
        expect(res.status).toBe(201);
        expect(parseFloat(res.body.total)).toBe(65);
        expect(new Set(res.body.items.map(i => i.promo_group)).size).toBe(2);
    });

    test('1 promo y 1 taco suelto: el suelto va a precio normal', async () => {
        const res = await vender([promo2x1(pastor, arrachera), { product_id: suadero.id, quantity: 1 }]);
        expect(res.status).toBe(201);
        expect(parseFloat(res.body.total)).toBe(65);
        const suelto = res.body.items.find(i => !i.promo_group);
        expect(parseFloat(suelto.unit_price)).toBe(30);
    });

    test('los extras del regalado se cobran completos', async () => {
        const res = await vender([{
            promo_id: dosPorUno.id,
            productos: [{ product_id: pastor.id, modifiers: [{ option_id: queso.id }] }, { product_id: arrachera.id }],
        }]);
        expect(res.status).toBe(201);
        expect(parseFloat(res.body.total)).toBe(45);
        const p = res.body.items.find(i => i.product_id === pastor.id);
        expect(parseFloat(p.unit_price)).toBe(24.58);
        expect(parseFloat(p.base_unit_price)).toBe(14.58);
    });

    test('un refresco no entra en el 2x1 de tacos → 400', async () => {
        const res = await vender([promo2x1(pastor, refresco)]);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('PROMO_ELECCION_INVALIDA');
    });

    test('🔴 online, una promo fuera de su día → 400 y no se registra', async () => {
        const otra = await crearPromo(
            { name: 'Otro día', tipo: 'regalar_mas_barato', paga: 1, calendario: { dias: [otroDia(hoyLocal())] } },
            [{ category_id: tacos.id, quantity: 2 }]
        );
        const antes = await models.Order.count({ where: { business_id: owner.id } });
        const res = await vender([{ promo_id: otra.id, productos: [{ product_id: pastor.id }, { product_id: arrachera.id }] }]);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('PROMO_NO_DISPONIBLE');
        expect(await models.Order.count({ where: { business_id: owner.id } })).toBe(antes);
    });

    test('una promo desactivada → 400', async () => {
        const vieja = await crearPromo({ name: 'Vieja', price: 40 }, [{ product_id: pastor.id }, { product_id: refresco.id }]);
        await request(app).delete(`/api/offers/combos/${vieja.id}`).set(auth());
        const res = await vender([{ promo_id: vieja.id, productos: [{ product_id: pastor.id }, { product_id: refresco.id }] }]);
        expect(res.status).toBe(400);
    });

    test('un combo de precio fijo con productos fijos se vende a su precio', async () => {
        const combo = await crearPromo({ name: 'Combo pastor', price: 40 }, [{ product_id: pastor.id }, { product_id: refresco.id }]);
        const res = await vender([{ promo_id: combo.id, productos: [{ product_id: refresco.id }, { product_id: pastor.id }] }]);
        expect(res.status).toBe(201);
        expect(parseFloat(res.body.total)).toBe(40);
    });

    test('un pedido SIN promos sale exactamente igual que antes', async () => {
        const res = await vender([{ product_id: refresco.id, quantity: 2 }]);
        expect(res.status).toBe(201);
        expect(parseFloat(res.body.total)).toBe(40);
        const it = res.body.items[0];
        expect([it.promo_id, it.promo_group, it.promo_name, it.list_price]).toEqual([null, null, null, null]);
        expect(parseFloat(it.unit_price)).toBe(20);
    });

    test('pagos divididos por renglón: el índice de una promo cubre sus dos productos', async () => {
        const res = await vender([promo2x1(pastor, arrachera), { product_id: refresco.id }], {
            payment_method: 'efectivo',
            payments: [
                { method: 'efectivo', amount: 35, item_indexes: [0] },
                { method: 'tarjeta', amount: 20, item_indexes: [1] },
            ],
        });
        expect(res.status).toBe(201);
        const pagos = await models.OrderPayment.findAll({ where: { order_id: res.body.id }, order: [['id', 'ASC']] });
        const crudo = pagos[0].item_ids;
        const ids = typeof crudo === 'string' ? JSON.parse(crudo) : crudo;
        expect(ids).toHaveLength(2);
        const promoIds = res.body.items.filter(i => i.promo_group).map(i => i.id).sort();
        expect([...ids].sort()).toEqual(promoIds);
    });

    test('rentabilidad: cada taco lleva su parte del descuento', async () => {
        const otro = await createTestOwner({ settings: JSON.stringify({ tz: TZ }) });
        const cat = await models.Category.create({ name: 'Tacos', business_id: otro.user.id });
        const a = await models.Product.create({ name: 'A', price: 25, category_id: cat.id, business_id: otro.user.id });
        const b = await models.Product.create({ name: 'B', price: 35, category_id: cat.id, business_id: otro.user.id });
        const c = await request(app).post('/api/offers/combos').set({ Authorization: `Bearer ${otro.token}` })
            .send({ name: '2x1', tipo: 'regalar_mas_barato', paga: 1 });
        await request(app).post(`/api/offers/combos/${c.body.id}/items`).set({ Authorization: `Bearer ${otro.token}` })
            .send({ items: [{ category_id: cat.id, quantity: 2 }] });
        const v = await request(app).post('/api/orders').set({ Authorization: `Bearer ${otro.token}` })
            .send({ items: [{ promo_id: c.body.id, productos: [{ product_id: a.id }, { product_id: b.id }] }], skip_stock_check: true });
        expect(v.status).toBe(201);
        const rent = await request(app).get('/api/stats/profitability').set({ Authorization: `Bearer ${otro.token}` });
        expect(rent.status).toBe(200);
        const fila = (p) => rent.body.productos.find(x => x.product_id === p.id);
        expect(fila(a).ingreso).toBe(14.58);
        expect(fila(b).ingreso).toBe(20.42);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// LA VENTA DIFERIDA (§26)
// ════════════════════════════════════════════════════════════════════════════
describe('Venta diferida con promo', () => {
    // Ayer a mediodía, hora del negocio (lejos de cualquier borde de día).
    function ayerAlMediodia() {
        const l = promos.localEnZona(TZ, new Date());
        const [y, m, d] = l.fechaAyer.split('-').map(Number);
        return { fecha: new Date(Date.UTC(y, m - 1, d, 18, 0, 0)), dow: (l.dow + 6) % 7 };
    }

    test('🔴 la venta del "martes" que llega el "miércoles" CONSERVA su promo', async () => {
        const ayer = ayerAlMediodia();
        const deAyer = await crearPromo(
            { name: 'Solo ayer', tipo: 'regalar_mas_barato', paga: 1, calendario: { dias: [ayer.dow] } },
            [{ category_id: tacos.id, quantity: 2 }]
        );
        const res = await vender([{
            promo_id: deAyer.id, promo_price: 35,
            productos: [{ product_id: pastor.id, list_price: 25 }, { product_id: arrachera.id, list_price: 35 }],
        }], { client_uuid: uuid(), sold_at: ayer.fecha.toISOString() });
        expect(res.status).toBe(201);
        expect(parseFloat(res.body.total)).toBe(35);
        // Sin nada raro que auditar.
        const logs = await models.PrivilegedActionLog.count({
            where: { business_id: owner.id, action_type: 'offline_price', target_description: `Pedido #${res.body.id}` },
        });
        expect(logs).toBe(0);
    });

    test('diferida fuera de horario o con otro precio: se registra igual y se audita', async () => {
        const ayer = ayerAlMediodia();
        const deOtroDia = await crearPromo(
            { name: 'Otro día diferida', tipo: 'regalar_mas_barato', paga: 1, calendario: { dias: [otroDia(ayer.dow)] } },
            [{ category_id: tacos.id, quantity: 2 }]
        );
        const res = await vender([{
            promo_id: deOtroDia.id, promo_price: 30,
            productos: [{ product_id: pastor.id }, { product_id: arrachera.id }],
        }], { client_uuid: uuid(), sold_at: ayer.fecha.toISOString() });
        expect(res.status).toBe(201);
        expect(parseFloat(res.body.total)).toBe(30);
        const log = await models.PrivilegedActionLog.findOne({
            where: { business_id: owner.id, action_type: 'offline_price', target_description: `Pedido #${res.body.id}` },
        });
        expect(log).toBeTruthy();
        expect(log.after_data).toMatch(/fuera de su horario/);
        expect(log.after_data).toMatch(/precio distinto/);
    });

    test('diferida de una promo que ya no existe: nunca se rechaza', async () => {
        const res = await vender([{
            promo_id: 999999, promo_name: 'La del mes pasado', promo_price: 40,
            productos: [{ product_id: pastor.id }, { product_id: refresco.id }],
        }], { client_uuid: uuid(), sold_at: new Date(Date.now() - 3600000).toISOString() });
        expect(res.status).toBe(201);
        expect(parseFloat(res.body.total)).toBe(40);
        expect(res.body.items[0].promo_name).toBe('La del mes pasado');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// JUNTAR OFERTAS (§3.4)
// ════════════════════════════════════════════════════════════════════════════
describe('Juntar ofertas', () => {
    let diez;
    beforeAll(async () => {
        diez = await models.Discount.create({ name: 'Frecuente', type: 'percentage', value: 10, business_id: owner.id });
    });

    test('🔴 apagado: el 10% solo alcanza a lo que NO es promo', async () => {
        const items = [promo2x1(pastor, arrachera), { product_id: refresco.id }];
        const ok = await vender(items, { discount_id: diez.id, discount_amount: 2 });
        expect(ok.status).toBe(201);
        expect(parseFloat(ok.body.total)).toBe(53);
        const mal = await vender(items, { discount_id: diez.id, discount_amount: 5.5 });
        expect(mal.status).toBe(400);
        expect(mal.body.error).toMatch(/promoción/);
    });

    test('un empleado no puede encender el interruptor', async () => {
        const emp = await models.User.create({
            username: `emp_${Date.now()}@t.com`, password: 'x12345678', name: 'Cajera', role: 'cashier', business_id: owner.id,
        });
        const jwt = require('jsonwebtoken');
        const t2 = jwt.sign({ id: emp.id, role: 'cashier', business_id: owner.id }, process.env.JWT_SECRET);
        const r = await request(app).put('/api/settings').set({ Authorization: `Bearer ${t2}` }).send({ ofertas_acumulables: true });
        expect(r.status).toBe(403);
    });

    test('encendido: el 10% alcanza a toda la cuenta', async () => {
        const r = await request(app).put('/api/settings').set(auth()).send({ ofertas_acumulables: true });
        expect(r.status).toBe(200);
        const res = await vender([promo2x1(pastor, arrachera), { product_id: refresco.id }],
            { discount_id: diez.id, discount_amount: 5.5 });
        expect(res.status).toBe(201);
        expect(parseFloat(res.body.total)).toBe(49.5);
        await request(app).put('/api/settings').set(auth()).send({ ofertas_acumulables: false });
    });
});

// ════════════════════════════════════════════════════════════════════════════
// MESAS: agregar y quitar (trampa 4)
// ════════════════════════════════════════════════════════════════════════════
describe('Promos en una mesa', () => {
    test('🔴 quitar un taco de la promo quita la promo ENTERA; el suelto se queda', async () => {
        const mesa = await models.Table.create({ name: 'M1', business_id: owner.id });
        const abierta = await request(app).post('/api/orders').set(auth()).send({ table_id: mesa.id, items: [] });
        expect(abierta.status).toBe(201);
        const conPromo = await request(app).post(`/api/orders/${abierta.body.id}/items`).set(auth())
            .send({ items: [promo2x1(pastor, arrachera), { product_id: suadero.id }] });
        expect(conPromo.status).toBe(200);
        expect(parseFloat(conPromo.body.total)).toBe(65);

        const unTacoDePromo = conPromo.body.items.find(i => i.product_id === pastor.id);
        const quitada = await request(app).delete(`/api/orders/${abierta.body.id}/items/${unTacoDePromo.id}`).set(auth());
        expect(quitada.status).toBe(200);
        expect(quitada.body.items).toHaveLength(1);
        expect(quitada.body.items[0].product_id).toBe(suadero.id);
        expect(parseFloat(quitada.body.total)).toBe(30);

        const log = await models.PrivilegedActionLog.findOne({
            where: { business_id: owner.id, action_type: 'remove_item', target_description: `Pedido #${abierta.body.id}` },
        });
        const antes = JSON.parse(log.before_data);
        expect(antes.producto).toMatch(/2x1 Tacos \(Pastor, Arrachera\)/);
        expect(antes.importe).toBe(35);
    });

    test('agregar a la mesa una promo fuera de horario → 400', async () => {
        const mesa = await models.Table.create({ name: 'M2', business_id: owner.id });
        const abierta = await request(app).post('/api/orders').set(auth()).send({ table_id: mesa.id, items: [] });
        const otra = await crearPromo(
            { name: 'Mesa otro día', tipo: 'regalar_mas_barato', paga: 1, calendario: { dias: [otroDia(hoyLocal())] } },
            [{ category_id: tacos.id, quantity: 2 }]
        );
        const r = await request(app).post(`/api/orders/${abierta.body.id}/items`).set(auth())
            .send({ items: [{ promo_id: otra.id, productos: [{ product_id: pastor.id }, { product_id: arrachera.id }] }] });
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('PROMO_NO_DISPONIBLE');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// LO QUE VIAJA A LOS CLIENTES (trampa 1)
// ════════════════════════════════════════════════════════════════════════════
describe('GET /offers/combos', () => {
    test('🔴 `items` solo trae productos fijos; la forma nueva va en `slots`', async () => {
        const res = await request(app).get('/api/offers/combos').set(auth());
        expect(res.status).toBe(200);
        const c = res.body.find(x => x.id === dosPorUno.id);
        expect(c.items).toEqual([]);               // un desktop viejo ve un combo sin productos
        expect(c.slots).toEqual([expect.objectContaining({ quantity: 2, category_id: tacos.id })]);
        expect(c.tipo).toBe('regalar_mas_barato');
        expect(c.lleva).toBe(2);
        // Todo renglón de `items` trae product_id (NOT NULL en el desktop).
        res.body.forEach(combo => combo.items.forEach(it => expect(it.product_id).toBeTruthy()));
    });

    test('/combos/active solo trae lo que se puede vender AHORA', async () => {
        const res = await request(app).get('/api/offers/combos/active').set(auth());
        expect(res.status).toBe(200);
        const nombres = res.body.map(c => c.name);
        expect(nombres).toContain('2x1 Tacos');
        expect(nombres).not.toContain('Otro día');
        expect(nombres).not.toContain('Vieja');
    });

    test('/discounts/active respeta el calendario', async () => {
        await request(app).post('/api/offers/discounts').set(auth()).send({
            name: 'Hoy no', type: 'percentage', value: 5, applies_to: 'all', calendario: { dias: [otroDia(hoyLocal())] },
        });
        await request(app).post('/api/offers/discounts').set(auth()).send({
            name: 'Hoy sí', type: 'percentage', value: 5, applies_to: 'all', calendario: { dias: [hoyLocal()] },
        });
        const res = await request(app).get('/api/offers/discounts/active').set(auth());
        const nombres = res.body.map(d => d.name);
        expect(nombres).toContain('Hoy sí');
        expect(nombres).not.toContain('Hoy no');
    });

    test('crear con un calendario basura o un 2x1 que cobra lo mismo que lleva → 400', async () => {
        const mal = await request(app).post('/api/offers/combos').set(auth())
            .send({ name: 'X', tipo: 'regalar_mas_barato', paga: 1, calendario: { dias: [8] } });
        expect(mal.status).toBe(400);
        const c = await request(app).post('/api/offers/combos').set(auth()).send({ name: 'Y', tipo: 'regalar_mas_barato', paga: 2 });
        const r = await request(app).post(`/api/offers/combos/${c.body.id}/items`).set(auth())
            .send({ items: [{ category_id: tacos.id, quantity: 2 }] });
        expect(r.status).toBe(400);
    });
});
