// ============================================================================
// RECORRIDO 6 — HORA PICO: lo que pasa cuando todo llega a la vez
//
// Los cinco recorridos anteriores hacen las cosas EN FILA: una venta, luego
// otra, luego el corte. Un negocio real no funciona así. A la 1:30 de la tarde
// hay tres cajas cobrando, el mesero mandando comandas desde la tablet y la red
// yendo y viniendo, así que el backend recibe peticiones SIMULTÁNEAS sobre las
// MISMAS filas.
//
// Eso abre una familia de defectos que ninguna prueba en fila puede ver, porque
// solo existen cuando dos transacciones se pisan:
//
//   · LOST UPDATE — dos ventas leen el stock a la vez (100), las dos restan 10,
//     las dos escriben 90. Se vendieron 20 y el inventario dice que salieron 10.
//     El stock se desvía solo, en silencio, y solo se nota al contar la bodega.
//
//   · IDEMPOTENCIA BAJO CARRERA — el POS no recibe respuesta y reintenta. Si los
//     dos intentos llegan a la vez, el `SELECT ... WHERE client_uuid` de ambos
//     ocurre ANTES de que cualquiera inserte: los dos creen que la venta no
//     existe y se cobra dos veces. Es el escenario para el que se diseñó el
//     `client_uuid` (§19.7), y el único que lo pone a prueba de verdad.
//
//   · DOS TURNOS ABIERTOS — dos cajeros abren caja en el mismo segundo. Con dos
//     turnos vivos, las ventas se reparten entre ellos y ninguno de los dos
//     cortes cuadra.
//
// Los tres son de DINERO y ninguno deja rastro: no hay error en el log, no hay
// 500, no hay nada que revisar después. Por eso el recorrido no comprueba que
// "no reventó" — comprueba el número exacto que tiene que quedar en la base.
//
// ⚠️ Este recorrido SOLO tiene sentido contra PostgreSQL. En SQLite las
// escrituras se serializan solas, así que pasaría en verde con los locks
// quitados. Es la misma razón por la que existe el banco entero (§38).
// ============================================================================

const VENTAS_SIMULTANEAS = 18;   // tres cajas cobrando a la vez, un rato
const REINTENTOS_MISMO_UUID = 8; // el POS reintentando una venta que sí llegó
const CAJEROS_A_LA_VEZ = 5;      // cinco intentos de abrir caja en el mismo instante

// ⚠️ 18 + 8 + 1 = 27 llamadas a POST /api/orders, por debajo del límite de 60 por
// minuto que impone `createOrderLimiter` (routes/orders.js). Si subes estos
// números, el recorrido empieza a fallar por el RATE LIMIT y no por un defecto —
// y un banco que se pone rojo por algo que no es un defecto deja de mirarse.

module.exports = {
    nombre: 'Hora pico: 18 ventas a la vez, reintentos y dos cajeros abriendo caja',
    etiqueta: 'pico',

    async ejecutar({ af, sembrar }) {
        // La gringa lleva 120 g de pastor y 60 g de queso: dos insumos en KILOS
        // contra una receta en GRAMOS, así que la conversión (§45) también entra
        // en la carrera.
        const t = await sembrar('pico', { productos: ['gringa', 'pastor'] });
        const api = t.api;
        const enMatriz = (cuerpo) => Object.assign({ branch_id: t.sucursales.matriz }, cuerpo);

        const turnoInicial = await api.exigir('POST', '/api/turnos', {
            cajero_nombre: 'Lupita', rol: 'cajero',
            fondo_inicial: 500, branch_id: t.sucursales.matriz,
        }, [200, 201]);

        // ── 1. DIECIOCHO VENTAS A LA VEZ ───────────────────────────────────────
        // Cada gringa consume 120 g de pastor. Dieciocho tienen que dejar el insumo
        // exactamente 2.16 kg más abajo. Si dos ventas se pisan al escribir el
        // stock, bajará MENOS — y esa diferencia es carne que salió de la cocina
        // sin que el inventario se entere.
        const antes = await api.exigir('GET', '/api/inventory/ingredients', undefined, 200);
        const stockPastorAntes = Number(
            (antes.data || antes).find((i) => i.id === t.insumos.pastor.id).stock
        );

        const disparos = Array.from({ length: VENTAS_SIMULTANEAS }, () =>
            api.post('/api/orders', enMatriz({
                items: [{ product_id: t.productos.gringa.id, quantity: 1, unit_price: t.productos.gringa.precio }],
                payment_method: 'efectivo',
                order_type: 'llevar',
            }))
        );
        const resultados = await Promise.all(disparos);

        const creadas = resultados.filter((r) => r.status === 200 || r.status === 201);
        af.igual(
            `las ${VENTAS_SIMULTANEAS} ventas simultáneas se registran`,
            creadas.length, VENTAS_SIMULTANEAS
        );

        const ids = new Set(creadas.map((r) => r.body.id));
        af.igual('y cada una es un pedido distinto', ids.size, VENTAS_SIMULTANEAS);

        const despues = await api.exigir('GET', '/api/inventory/ingredients', undefined, 200);
        const stockPastorDespues = Number(
            (despues.data || despues).find((i) => i.id === t.insumos.pastor.id).stock
        );

        // 18 gringas × 120 g = 2160 g = 2.16 kg
        af.dinero(
            '🔒 el pastor bajó EXACTAMENTE lo de 18 gringas (sin lost update)',
            stockPastorAntes - stockPastorDespues,
            2.16
        );

        // ── 2. EL MISMO UUID, OCHO VECES A LA VEZ ───────────────────────────
        // La red se cayó, el POS no supo si la venta entró y reintenta. Los ocho
        // intentos llegan juntos. Solo puede existir UN pedido y solo puede
        // haberse descontado UNA vez el inventario.
        const uuid = 'pico-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
        const stockAntesUuid = stockPastorDespues;

        const reintentos = await Promise.all(
            Array.from({ length: REINTENTOS_MISMO_UUID }, () =>
                api.post('/api/orders', enMatriz({
                    client_uuid: uuid,
                    items: [{ product_id: t.productos.gringa.id, quantity: 1, unit_price: t.productos.gringa.precio }],
                    payment_method: 'efectivo',
                    order_type: 'llevar',
                }))
            )
        );

        const aceptados = reintentos.filter((r) => r.status === 200 || r.status === 201);
        const idsUnicos = new Set(aceptados.map((r) => r.body.id));
        af.cierto(
            `los ${REINTENTOS_MISMO_UUID} reintentos no dan error de servidor`,
            reintentos.every((r) => r.status < 500),
            'alguno devolvió 5xx: ' + reintentos.map((r) => r.status).join(',')
        );
        af.igual('🔒 los reintentos del mismo uuid producen UN SOLO pedido', idsUnicos.size, 1);

        const trasUuid = await api.exigir('GET', '/api/inventory/ingredients', undefined, 200);
        const stockTrasUuid = Number(
            (trasUuid.data || trasUuid).find((i) => i.id === t.insumos.pastor.id).stock
        );
        af.dinero(
            '🔒 y el inventario se descontó UNA sola vez (120 g, no ocho veces)',
            stockAntesUuid - stockTrasUuid,
            0.12
        );

        // Y que de verdad haya un solo pedido en la base, no solo en la respuesta.
        const listado = await api.exigir('GET', '/api/orders?limit=200', undefined, 200);
        const conEseUuid = (listado.data || listado).filter((o) => o.client_uuid === uuid);
        af.igual('en el historial tampoco hay duplicado', conEseUuid.length, 1);

        // ── 3. CINCO CAJEROS ABRIENDO CAJA A LA VEZ ─────────────────────────
        // Ya hay un turno abierto de este recorrido. Cinco intentos simultáneos
        // de abrir otro no pueden dejar dos turnos vivos en la misma sucursal:
        // con dos, las ventas se reparten y ninguno de los cortes cuadra.
        const aperturas = await Promise.all(
            Array.from({ length: CAJEROS_A_LA_VEZ }, (_, i) =>
                api.post('/api/turnos', {
                    cajero_nombre: 'Cajero ' + i, rol: 'cajero',
                    fondo_inicial: 300, branch_id: t.sucursales.matriz,
                })
            )
        );
        af.cierto(
            'ningún intento de abrir caja revienta con 5xx',
            aperturas.every((r) => r.status < 500),
            'estados: ' + aperturas.map((r) => r.status).join(',')
        );

        const activo = await api.exigir('GET', '/api/turnos/activo', undefined, 200);
        af.cierto('sigue habiendo un turno activo', !!activo && !!activo.id, 'no hay turno activo');

        // 🔒 LA COMPROBACIÓN QUE IMPORTA: el turno abierto sigue siendo EL MISMO.
        // Si alguna de las cinco aperturas simultáneas hubiera colado un segundo
        // turno, el id cambiaría (o habría dos vivos) y las ventas del día se
        // repartirían entre los dos: ninguno de los cortes cuadraría.
        //
        // ⚠️ No se mira `/historial` para esto: esa ruta devuelve SOLO los turnos
        // ya cerrados (routes/turnos.js), así que contar "abiertos" ahí da cero
        // siempre — pasaría en verde con dos cajas abiertas.
        af.igual(
            '🔒 y es EL MISMO: ninguna apertura simultánea coló una segunda caja',
            activo.id, turnoInicial.id
        );
    },
};
