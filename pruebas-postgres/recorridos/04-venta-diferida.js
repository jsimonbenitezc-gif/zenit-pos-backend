// ============================================================================
// RECORRIDO 4 — La venta que se hizo sin internet y sube tarde
//
// El BLOQUE 15 lo pide así: "una venta diferida (offline) que sube tarde: que
// caiga en el día y el turno correctos (§26)".
//
// El problema que esto vigila: una venta hecha sin conexión se sube después, y
// antes del BLOQUE 5 el backend la trataba como si acabara de ocurrir. La fechaba
// al RECIBIRLA y le recalculaba el precio con el catálogo de hoy. Resultado: caía
// en otro día y en otro turno —descuadrando la caja de los dos— y si el dueño
// había cambiado precios mientras tanto, quedaba registrada por un monto que
// nunca se cobró.
//
// Las cuatro reglas que se comprueban aquí, todas del §26:
//
//   1. Con `client_uuid` + `sold_at` válido, la venta conserva SU hora: cae en el
//      día y en el turno en que de verdad ocurrió. Una venta de ayer no puede
//      aparecer en el corte de hoy.
//   2. Se respeta el `unit_price` que trae el POS: es lo que el negocio cobró de
//      verdad. Y esa diferencia contra el catálogo queda AUDITADA (`offline_price`),
//      porque es dinero que salió a un precio que hoy no existe.
//   3. IDEMPOTENCIA: reintentar la misma venta no la duplica ni la cobra dos
//      veces. Es lo que hace seguro reintentar tras un timeout de red.
//   4. UN DATO SOSPECHOSO NUNCA TUMBA LA VENTA. Un `sold_at` imposible se
//      descarta y se usa la hora del servidor, pero la venta se registra igual:
//      una venta atascada para siempre en la cola del POS es peor que una fecha
//      imperfecta.
// ============================================================================

const { LibroDeCaja } = require('../lib/libro');

const FONDO_INICIAL = 500.00;

// La zona con la que el sembrador crea el negocio (lib/sembrador.js).
const TZ_NEGOCIO = 'America/Mexico_City';

/** La fecha LOCAL (YYYY-MM-DD) de un instante, en la zona del negocio. */
function _diaLocal(fecha, tz) {
    return fecha.toLocaleDateString('en-CA', { timeZone: tz });
}

/**
 * El instante que, en la zona del negocio, es el MEDIODÍA de ayer.
 *
 * Se calcula sin importar nada de `utils/`: este banco tiene que poder decir
 * que el backend se equivoca, y para eso no puede usar las cuentas del backend
 * (§38.3). Se parte del mediodía UTC del día anterior y se corrige con la hora
 * local que reporte la zona, así que funciona con cualquier huso y con horario
 * de verano.
 */
function _ayerAlMediodia(referencia, tz) {
    const ayer = _diaLocal(new Date(referencia.getTime() - 24 * 60 * 60 * 1000), tz);
    let instante = new Date(ayer + 'T12:00:00Z');
    for (let i = 0; i < 3; i++) {
        const horaLocal = Number(
            instante.toLocaleString('en-US', { timeZone: tz, hour: '2-digit', hour12: false })
        );
        if (horaLocal === 12) break;
        instante = new Date(instante.getTime() + (12 - horaLocal) * 60 * 60 * 1000);
    }
    return instante;
}

module.exports = {
    nombre: 'Ventas offline que suben tarde: día, turno y precio correctos',
    etiqueta: 'diferida',

    async ejecutar({ af, sembrar }) {
        const t = await sembrar('diferida', { productos: ['pastor', 'quesadilla'] });
        const api = t.api;
        const libro = new LibroDeCaja(FONDO_INICIAL);

        const turno = await api.exigir('POST', '/api/turnos', {
            cajero_nombre: 'Nacho',
            rol: 'cajero',
            fondo_inicial: FONDO_INICIAL,
            branch_id: t.sucursales.matriz,
        }, [200, 201]);

        const apertura = new Date(turno.apertura);
        const enMatriz = (cuerpo) => Object.assign({ branch_id: t.sucursales.matriz }, cuerpo);

        // ── 1. Una venta de AYER que sube ahora ─────────────────────────────
        //    Antes esto restaba 26 horas fijas, y era una BOMBA DE TIEMPO: si el
        //    banco se corría entre las 00:00 y las 02:00 de la zona del negocio,
        //    26 horas atrás caían en ANTEAYER y la comprobación de más abajo
        //    ("la de ayer aparece en AYER") fallaba sin que nada estuviera roto.
        //    Fallaba solo de madrugada, que es la peor clase de prueba: la que
        //    enseña a desconfiar de la suite. Ahora se fija a MEDIODÍA de ayer
        //    EN LA ZONA DEL NEGOCIO, que cae en el día correcto siempre y sigue
        //    estando muy por delante de la apertura de este turno.
        const ayer = _ayerAlMediodia(apertura, TZ_NEGOCIO);

        const ventaAyer = await api.exigir('POST', '/api/orders', enMatriz({
            items: [{ product_id: t.productos.pastor.id, quantity: 3, unit_price: t.productos.pastor.precio }],
            payment_method: 'efectivo',
            client_uuid: 'offline-ayer-' + Date.now(),
            sold_at: ayer.toISOString(),
        }), [200, 201]);

        const desfaseAyer = Math.abs(new Date(ventaAyer.createdAt).getTime() - ayer.getTime());
        af.cierto(
            'la venta de ayer conserva SU hora, no la de llegada',
            desfaseAyer < 2000,
            'createdAt quedó en ' + ventaAyer.createdAt + ' y debía ser ' + ayer.toISOString()
        );
        af.cierto(
            'y updatedAt guarda la hora en que llegó al servidor',
            new Date(ventaAyer.updatedAt).getTime() > new Date(ventaAyer.createdAt).getTime(),
            'updatedAt no es posterior a createdAt: se perdió el rastro de cuánto estuvo sin conexión'
        );
        libro.ventaQueNoCuenta('venta de ayer (fuera del turno)');

        // ── 2. Una venta de hoy, con el precio que se cobró sin internet ─────
        //    El dueño subió el pastor a $22 mientras la caja estaba sin red; el
        //    ticket que ya entregó decía $20. Manda el ticket.
        const durante = new Date(apertura.getTime() + 2000);
        const PRECIO_OFFLINE = 20.00;
        const uuidReintento = 'offline-hoy-' + Date.now();

        const ventaHoy = await api.exigir('POST', '/api/orders', enMatriz({
            items: [{ product_id: t.productos.pastor.id, quantity: 2, unit_price: PRECIO_OFFLINE }],
            payment_method: 'efectivo',
            client_uuid: uuidReintento,
            sold_at: durante.toISOString(),
        }), [200, 201]);

        af.dinero('se respeta el precio que el POS cobró sin red ($20, no $22)', ventaHoy.total, 40.00);
        libro.venta({ pagos: [{ metodo: 'efectivo', monto: 40.00 }], concepto: 'venta offline de hoy' });

        const auditoria = await api.exigir('GET', '/api/audit', undefined, 200);
        const filas = Array.isArray(auditoria) ? auditoria : (auditoria.data || []);
        af.cierto(
            'el precio distinto al catálogo quedó auditado (no bloqueado)',
            filas.some((f) => f.action_type === 'offline_price'),
            'no apareció ninguna fila offline_price: se cobró a un precio que hoy no existe y sin rastro'
        );

        // ── 3. El reintento no duplica la venta ─────────────────────────────
        //    Es el caso real: el POS mandó la venta, se cayó la red antes de la
        //    respuesta y la reintenta. Sin idempotencia, se cobra dos veces y el
        //    stock se descuenta dos veces.
        const reintento = await api.exigir('POST', '/api/orders', enMatriz({
            items: [{ product_id: t.productos.pastor.id, quantity: 2, unit_price: PRECIO_OFFLINE }],
            payment_method: 'efectivo',
            client_uuid: uuidReintento,
            sold_at: durante.toISOString(),
        }), 200);

        af.igual('reintentar la misma venta devuelve el MISMO pedido', reintento.id, ventaHoy.id);

        // ── 4. Un sold_at imposible no puede tumbar la venta ────────────────
        //    60 días atrás está fuera de la ventana admitida (§26). Se descarta la
        //    fecha —y con ella el trato de venta diferida, así que el precio vuelve
        //    a ser el del catálogo— pero la venta SE REGISTRA.
        const absurda = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
        const ventaRara = await api.exigir('POST', '/api/orders', enMatriz({
            items: [{ product_id: t.productos.quesadilla.id, quantity: 1, unit_price: 5.00 }],
            payment_method: 'efectivo',
            client_uuid: 'offline-absurda-' + Date.now(),
            sold_at: absurda.toISOString(),
        }), [200, 201]);

        af.cierto(
            'una fecha imposible NO rechaza la venta',
            Boolean(ventaRara.id),
            'la venta con sold_at absurdo fue rechazada: quedaría atascada en la cola del POS para siempre'
        );
        af.cierto(
            'la fecha absurda se descarta y se usa la del servidor',
            Math.abs(new Date(ventaRara.createdAt).getTime() - Date.now()) < 60 * 1000,
            'createdAt quedó en ' + ventaRara.createdAt + ', o sea que se aceptó una fecha de hace 60 días'
        );
        af.dinero(
            'y al no ser diferida, vale el precio del catálogo ($39, no los $5 declarados)',
            ventaRara.total,
            39.00
        );
        libro.venta({ pagos: [{ metodo: 'efectivo', monto: 39.00 }], concepto: 'venta con fecha descartada' });

        // ── El turno solo cuenta lo que ocurrió DENTRO de él ────────────────
        const totales = await api.exigir('GET', '/api/turnos/' + turno.id + '/totales', undefined, 200);

        af.igual('el turno cuenta 2 pedidos, no 3', totales.total_pedidos, libro.pedidosContables);
        af.dinero('la venta de ayer NO entró en el corte de hoy', totales.total_ventas, libro.totalVentas);
        af.dinero('ni el reintento la duplicó', totales.total_efectivo, libro.totalEfectivo);

        // ── Y el día tampoco se contamina ───────────────────────────────────
        const panel = await api.exigir('GET', '/api/stats/dashboard', undefined, 200);
        af.dinero('las ventas de HOY excluyen la de ayer', panel.ventasHoy.monto_total, libro.totalVentas);
        af.igual('y las cuenta como 2 pedidos', panel.ventasHoy.total_pedidos, libro.pedidosContables);
        af.dinero('la de ayer aparece donde le toca: en AYER', panel.ventasAyer.monto_total, 66.00);

        // ── Cierre ──────────────────────────────────────────────────────────
        // ⚠️ Se espera a que el reloj rebase la hora de la última venta antes de
        // cerrar. NO es un adorno: el cierre acota las ventas con
        // `BETWEEN apertura AND ahora`, mientras los totales en vivo usan
        // `>= apertura`. Una venta fechada por delante del reloj del servidor
        // aparece en los totales y DESAPARECE del cierre. Aquí el recorrido
        // entero dura menos de un segundo, así que sin esta espera la venta
        // fechada a apertura+2s caería en ese hueco y el descuadre sería de este
        // guion, no del backend. El hueco en sí se prueba aparte, en el
        // recorrido 05: es un defecto real y tiene su propio recorrido.
        await new Promise((r) => setTimeout(r, Math.max(0, durante.getTime() + 1500 - Date.now())));

        const cerrado = await api.exigir('PUT', '/api/turnos/' + turno.id + '/cerrar', {
            efectivo_contado: libro.efectivoEnCajon,
            notas: 'Cierre con ventas subidas tarde',
        }, 200);

        af.dinero('DIFERENCIA DEL CORTE', cerrado.diferencia, 0);
    },
};
