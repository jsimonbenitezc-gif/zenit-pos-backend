// ============================================================================
// RECORRIDO 7 — UNA SOLA CONEXIÓN EN VIVO, y los binarios viejos sin enterarse
//
// Los cinco `/events` se unificaron en `GET /api/events?channels=…`. Eso tiene
// exactamente dos formas de salir mal, y ninguna la ve una prueba unitaria:
//
//   1. que el evento no llegue de verdad por el socket (aquí se abre una
//      conexión HTTP REAL contra el servidor REAL y se espera a que escriba);
//   2. 🔴 que los endpoints viejos empiecen a mandar eventos CON NOMBRE. El
//      `onmessage` de un EventSource solo recibe los que NO llevan nombre, así
//      que ese cambio dejaría mudo a todo binario ya instalado —el desktop
//      v1.7.2 y el APK— sin que falle absolutamente nada en el servidor. Es el
//      fallo silencioso de este bloque, y es el que se comprueba abajo.
//
// Se leen los BYTES que salen del socket, no una abstracción: `event: orders`
// o su ausencia es literalmente lo que decide si un cliente oye o no oye.
// ============================================================================

const http = require('http');

/** Abre una conexión SSE de verdad y va guardando lo que el servidor escribe. */
function abrirSSE(baseUrl, ruta, token) {
    return new Promise((resolve, reject) => {
        const url = new URL(baseUrl + ruta);
        url.searchParams.set('token', token);

        const req = http.get(url, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(ruta + ' respondió ' + res.statusCode));
            }
            const conexion = {
                trozos: [],
                get texto() { return this.trozos.join(''); },
                cerrar() { try { req.destroy(); } catch { /* ya cerrada */ } },
                /** Espera hasta que lo escrito contenga `aguja`, o se rinde. */
                async esperar(aguja, ms = 4000) {
                    const hasta = Date.now() + ms;
                    while (Date.now() < hasta) {
                        if (this.texto.includes(aguja)) return true;
                        await new Promise((r) => setTimeout(r, 50));
                    }
                    return false;
                },
            };
            res.setEncoding('utf8');
            res.on('data', (d) => conexion.trozos.push(d));
            res.on('error', () => {});
            resolve(conexion);
        });
        req.on('error', reject);
        req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout abriendo ' + ruta)); });
    });
}

module.exports = {
    nombre: 'Tiempo real: una conexión para los cinco canales',
    etiqueta: 'sse',

    async ejecutar({ af, sembrar }) {
        const t = await sembrar('sse');
        const api = t.api;
        const base = api.baseUrl;

        // ── La conexión NUEVA: una sola, con eventos nombrados ──────────────
        const unificada = await abrirSSE(base, '/api/events?channels=orders,inventory,turnos', t.token);

        // ── Y una VIEJA, como la que abre un binario ya instalado ───────────
        const vieja = await abrirSSE(base, '/api/orders/events', t.token);

        try {
            // Una venta cualquiera: lo que dispara el aviso de `orders`.
            const venta = await api.exigir('POST', '/api/orders', {
                items: [{ product_id: t.productos.pastor.id, quantity: 2 }],
                payment_method: 'efectivo',
                type: 'takeout',
                branch_id: t.sucursales.matriz,
            }, 201);
            af.cierto('la venta se registró', !!venta.id, 'no se creó el pedido');

            const llegoNueva = await unificada.esperar('event: orders');
            af.cierto('🔒 la conexión ÚNICA recibe el evento del canal "orders"', llegoNueva,
                'no llegó nada en 4 s. Escrito: ' + JSON.stringify(unificada.texto.slice(0, 200)));

            const llegoVieja = await vieja.esperar('data: {}');
            af.cierto('🔒 el endpoint VIEJO sigue recibiendo su evento', llegoVieja,
                'no llegó nada. Escrito: ' + JSON.stringify(vieja.texto.slice(0, 200)));

            // 🔴 LA COMPROBACIÓN QUE PROTEGE A LOS BINARIOS INSTALADOS.
            af.cierto('🔒 …y SIN nombre, que es lo único que su onmessage puede oír',
                !vieja.texto.includes('event:'),
                'el endpoint viejo mandó un evento con nombre: ' + JSON.stringify(vieja.texto.slice(0, 200)));

            // ── Un canal al que la conexión nueva NO se suscribió ───────────
            // Se pidió orders, inventory y turnos: `audit` no tiene que llegar.
            const antes = unificada.texto;
            await api.exigir('POST', '/api/audit', {
                employee_name: 'Banco de pruebas',
                action_type: 'apply_discount',
            }, [200, 201]);
            await new Promise((r) => setTimeout(r, 800));
            af.cierto('no llega un canal al que no se suscribió',
                !unificada.texto.slice(antes.length).includes('event: audit'),
                'llegó audit sin pedirlo');

            // ── Y el canal de inventario, por la MISMA conexión ─────────────
            const antesInv = unificada.texto.length;
            await api.exigir('POST', '/api/inventory/movements', {
                ingredient_id: t.insumos.tortilla.id,
                type: 'entrada',
                quantity: 100,
                reason: 'compra',
            }, [200, 201]);
            const llegoInv = await (async () => {
                const hasta = Date.now() + 4000;
                while (Date.now() < hasta) {
                    if (unificada.texto.slice(antesInv).includes('event: inventory')) return true;
                    await new Promise((r) => setTimeout(r, 50));
                }
                return false;
            })();
            af.cierto('🔒 la MISMA conexión recibe también el canal "inventory"', llegoInv,
                'solo llegó: ' + JSON.stringify(unificada.texto.slice(antesInv, antesInv + 200)));

            // ── Y sin credencial no se entra ────────────────────────────────
            let sinToken = 0;
            try { await abrirSSE(base, '/api/events?channels=orders', 'basura'); }
            catch (e) { sinToken = /401/.test(e.message) ? 401 : -1; }
            af.igual('🔒 un token inválido no abre la conexión', sinToken, 401);
        } finally {
            unificada.cerrar();
            vieja.cerrar();
        }
    },
};
