// ============================================================================
// RECORRIDO 8 — Una mesa cobrada POR PARTES (PLAN_CUENTAS_V1)
//
// El mesero va comensal por comensal: "¿qué pagas tú?" → cobra → "¿y tú?".
// Cada parte es una VENTA APARTE (`POST /api/orders/:id/separar`) y la mesa
// sigue abierta con lo que queda.
//
// Con IVA AGREGADO (el modo donde el total cambia) y una promo 2x1:
//   Mesa: 3 refrescos ($82.50) + 2x1 pastor/suadero ($24.50) = base $107 → $124.12
//   Parte 1: 1 refresco, efectivo + $5 de propina      → $31.90
//   Parte 2: la promo (se toca UN taco, sale entera), tarjeta → $28.42
//   Resto:   2 refrescos, efectivo, con el cobro de siempre  → $63.80
//
// Lo que se comprueba, sobre POSTGRES (SQLite ignora `FOR UPDATE`):
//   1. La suma de las 3 ventas es EXACTO lo que se le dijo a la mesa.
//   2. La caja cuadra: diferencia del corte = 0, con la propina de la parte.
//   3. El inventario NO se mueve al separar (se descontó al agregar a la mesa).
//   4. EL CANDADO: dos meseros cobrando a la vez el último refresco de más no
//      pueden dejar la mesa abierta sin nada. Uno cobra; el otro oye "usa Cobrar".
//   5. Un reintento con el mismo client_uuid, en paralelo, cobra UNA vez.
// ============================================================================

const { LibroDeCaja } = require('../lib/libro');

const FONDO_INICIAL = 1000.00;

module.exports = {
    nombre: 'Mesa cobrada por partes: suma exacta, caja cuadra, inventario quieto',
    etiqueta: 'partes',

    async ejecutar({ af, sembrar }) {
        const t = await sembrar('partes', { productos: ['pastor', 'suadero', 'refresco'] });
        const api = t.api;
        const libro = new LibroDeCaja(FONDO_INICIAL);
        const enMatriz = (cuerpo) => Object.assign({ branch_id: t.sucursales.matriz }, cuerpo);

        await api.exigir('PUT', '/api/settings', {
            tax_enabled: true, tax_rate: 16, tax_included: false, tax_name: 'IVA',
            propinas_activas: true,
        });

        const promo = await api.exigir('POST', '/api/offers/combos', { name: '2x1 Tacos', tipo: 'regalar_mas_barato', paga: 1 }, 201);
        await api.exigir('POST', '/api/offers/combos/' + promo.id + '/items', {
            items: [{ category_id: t.categorias['Tacos'], quantity: 2 }],
        }, 200);

        const turno = await api.exigir('POST', '/api/turnos', {
            cajero_nombre: 'Rosa', rol: 'cajero', fondo_inicial: FONDO_INICIAL, branch_id: t.sucursales.matriz,
        }, [200, 201]);

        // ── La mesa ─────────────────────────────────────────────────────────
        const abierta = await api.exigir('POST', '/api/orders', enMatriz({
            table_id: t.mesas[0].id, items: [], client_uuid: 'partes-abrir-' + Date.now(),
        }), [200, 201]);
        const mesa = await api.exigir('POST', '/api/orders/' + abierta.id + '/items', {
            client_uuid: 'partes-items-' + Date.now(),
            items: [
                { product_id: t.productos.refresco.id, quantity: 3 },
                { promo_id: promo.id, productos: [{ product_id: t.productos.pastor.id }, { product_id: t.productos.suadero.id }] },
            ],
        }, 200);
        af.dinero('la mesa: $107 + 16% = $124.12', mesa.total, 124.12);

        const leerCarne = async () => {
            const r = await api.exigir('GET', '/api/inventory/ingredients?branch_id=' + t.sucursales.matriz + '&limit=100', undefined, 200);
            const c = (r.data || []).find((i) => i.id === t.insumos.pastor.id);
            return c ? parseFloat(c.stock) : null;
        };
        const carneTrasAgregar = await leerCarne();
        af.cierto('agregar la promo sí descontó carne', carneTrasAgregar !== null && carneTrasAgregar < 45);

        // ── Parte 1: un refresco, efectivo + propina ────────────────────────
        const refresco = mesa.items.find((i) => i.product_id === t.productos.refresco.id);
        const p1 = await api.exigir('POST', '/api/orders/' + mesa.id + '/separar', {
            client_uuid: 'partes-p1-' + Date.now(),
            items: [{ item_id: refresco.id, quantity: 1 }],
            payment_method: 'efectivo', tip_amount: 5,
        }, 201);
        af.dinero('parte 1: 1 refresco con IVA', p1.parte.total, 31.90);
        af.invarianteImpuesto('parte 1', p1.parte);
        af.dinero('la mesa baja a $92.22', p1.mesa.total, 92.22);
        af.invarianteImpuesto('mesa tras la parte 1', p1.mesa);
        libro.venta({ pagos: [{ metodo: 'efectivo', monto: 31.90 }], propinas: [{ metodo: 'efectivo', monto: 5 }], concepto: 'parte 1' });

        // ── Parte 2: la promo, tocando UN taco ──────────────────────────────
        const unTaco = p1.mesa.items.find((i) => i.product_id === t.productos.pastor.id);
        const p2 = await api.exigir('POST', '/api/orders/' + mesa.id + '/separar', {
            client_uuid: 'partes-p2-' + Date.now(),
            items: [{ item_id: unTaco.id }],
            payment_method: 'tarjeta',
        }, 201);
        af.igual('la promo sale ENTERA (2 renglones)', p2.parte.items.length, 2);
        af.dinero('parte 2: la promo con IVA', p2.parte.total, 28.42);
        af.dinero('la mesa queda en $63.80', p2.mesa.total, 63.80);
        libro.venta({ pagos: [{ metodo: 'tarjeta', monto: 28.42 }], concepto: 'parte 2' });

        const mesas = await api.exigir('GET', '/api/tables', undefined, 200);
        const laMesa = mesas.find((m) => m.id === t.mesas[0].id);
        af.igual('"Ya pagaron" trae las 2 partes', (laMesa.open_order && laMesa.open_order.partes || []).length, 2);

        af.dinero('el inventario NO se movió al separar', await leerCarne(), carneTrasAgregar);

        // ── El resto, con el cobro de siempre ───────────────────────────────
        const resto = await api.exigir('PUT', '/api/orders/' + mesa.id + '/status', {
            status: 'completado', payment_method: 'efectivo',
        }, 200);
        af.dinero('el resto: 2 refrescos con IVA', resto.total, 63.80);
        libro.venta({ pagos: [{ metodo: 'efectivo', monto: 63.80 }], concepto: 'resto de la mesa' });
        af.dinero('SUMA de las 3 ventas = lo que se le dijo a la mesa',
            parseFloat(p1.parte.total) + parseFloat(p2.parte.total) + parseFloat(resto.total), 124.12);

        // ── El candado: dos meseros a la vez sobre la misma mesa ────────────
        // Mesa de 2 refrescos. Cada uno cobra "1 refresco". Sin candado, los dos
        // leen "quedan 2", los dos cobran, y la mesa se queda abierta vacía.
        const abierta2 = await api.exigir('POST', '/api/orders', enMatriz({
            table_id: t.mesas[1].id, items: [], client_uuid: 'partes-abrir2-' + Date.now(),
        }), [200, 201]);
        const mesa2 = await api.exigir('POST', '/api/orders/' + abierta2.id + '/items', {
            client_uuid: 'partes-items2-' + Date.now(),
            items: [{ product_id: t.productos.refresco.id, quantity: 2 }],
        }, 200);
        const renglon2 = mesa2.items[0];
        const aLaVez = await Promise.all([1, 2].map((n) => api.post('/api/orders/' + mesa2.id + '/separar', {
            client_uuid: 'partes-carrera-' + n + '-' + Date.now(),
            items: [{ item_id: renglon2.id, quantity: 1 }],
            payment_method: 'efectivo',
        })));
        const estados = aLaVez.map((r) => r.status).sort();
        af.igual('dos cobros a la vez: uno cobra (201) y el otro oye "usa Cobrar" (400)', estados.join(','), '201,400');
        const exitosa = aLaVez.find((r) => r.status === 201);
        if (exitosa) {
            libro.venta({ pagos: [{ metodo: 'efectivo', monto: parseFloat(exitosa.body.parte.total) }], concepto: 'carrera' });
        }

        // ── Reintento en paralelo con el MISMO client_uuid ──────────────────
        const abierta3 = await api.exigir('POST', '/api/orders', enMatriz({
            table_id: t.mesas[2].id, items: [], client_uuid: 'partes-abrir3-' + Date.now(),
        }), [200, 201]);
        const mesa3 = await api.exigir('POST', '/api/orders/' + abierta3.id + '/items', {
            client_uuid: 'partes-items3-' + Date.now(),
            items: [{ product_id: t.productos.refresco.id, quantity: 3 }],
        }, 200);
        const mismo = {
            client_uuid: 'partes-reintento-' + Date.now(),
            items: [{ item_id: mesa3.items[0].id, quantity: 1 }],
            payment_method: 'efectivo',
        };
        const reintentos = await Promise.all([1, 2, 3].map(() => api.post('/api/orders/' + mesa3.id + '/separar', mismo)));
        const ids = new Set(reintentos.filter((r) => r.status < 300).map((r) => r.body.parte.id));
        af.igual('3 reintentos a la vez: todos contestan bien', reintentos.every((r) => r.status < 300), true);
        af.igual('…y cobran UNA sola parte', ids.size, 1);
        const mesa3Despues = await api.exigir('GET', '/api/orders/' + mesa3.id, undefined, 200);
        af.dinero('…y la mesa bajó UNA sola vez', mesa3Despues.total, 63.80);
        libro.venta({ pagos: [{ metodo: 'efectivo', monto: 31.90 }], concepto: 'reintento' });

        // ── Corte ───────────────────────────────────────────────────────────
        const totales = await api.exigir('GET', '/api/turnos/' + turno.id + '/totales', undefined, 200);
        af.dinero('ventas del turno', totales.total_ventas, libro.totalVentas);
        af.dinero('propinas en efectivo', totales.total_propinas_efectivo, libro.propinasEfectivo);
        af.dinero('efectivo esperado', totales.efectivo_esperado, libro.efectivoEnCajon);
        const cerrado = await api.exigir('PUT', '/api/turnos/' + turno.id + '/cerrar', {
            efectivo_contado: libro.efectivoEnCajon, notas: 'Cierre con mesa por partes',
        }, 200);
        af.dinero('DIFERENCIA DEL CORTE', cerrado.diferencia, 0);
    },
};
