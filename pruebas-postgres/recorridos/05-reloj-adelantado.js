// ============================================================================
// RECORRIDO 5 — El equipo con el reloj adelantado no descuadra la caja
//
// Este recorrido nació ROJO. Lo escribió el banco de pruebas el 2026-09-02 para
// reproducir un defecto real que él mismo encontró, y se arregló ese mismo día;
// ahora vive como la prueba de que no vuelva.
//
// ── EL DEFECTO QUE VIGILA ───────────────────────────────────────────────────
//
// Las dos consultas que deciden cuánto vendió un turno no usan el mismo filtro
// de fechas (routes/turnos.js → `_ventasDelTurno`):
//
//     totales en vivo   (hasta = null)   →  createdAt >= apertura
//     cierre del turno  (hasta = ahora)  →  createdAt BETWEEN apertura AND ahora
//
// Y `resolverFechaVenta` acepta a propósito una venta fechada hasta 5 minutos en
// el futuro, con esta razón explícita: "margen para relojes ligeramente
// adelantados" (§26). Es una decisión correcta — rechazar la venta de un equipo
// con el reloj mal la dejaría atascada en la cola para siempre.
//
// Juntando las dos, una venta subida desde una tableta con el reloj un par de
// minutos adelantado se guardaba con `createdAt` por delante del reloj del
// servidor. Entonces el cajero la VEÍA en los totales mientras contaba el dinero
// y DESAPARECÍA al cerrar: un sobrante fantasma de su mismo importe, con el
// dinero correcto en el cajón. La misma familia de descuadre que cerraron el §28
// (gastos), el §30 (propinas) y el §31 (pagos divididos).
//
// ── CÓMO SE ARREGLÓ ─────────────────────────────────────────────────────────
//
// En `utils/ventaOffline.js`: dentro de la tolerancia, la venta se ACEPTA pero se
// le fija la hora del servidor (`motivo: 'futura_ajustada'`). Ninguna venta se
// guarda ya con fecha en el futuro, así que el hueco entre las dos consultas
// deja de existir.
//
// ⚠️ NO se ensanchó el filtro del cierre a `ahora + tolerancia`, que era lo
// primero que venía a la mente: eso habría metido la misma venta TAMBIÉN en el
// turno siguiente —cuya apertura sería anterior a la fecha de la venta—,
// cambiando un sobrante fantasma por un DOBLE CONTEO. Si alguna vez alguien
// "arregla" esto moviendo el filtro del turno, este recorrido seguirá en verde
// y el error volverá por la otra puerta: el guard de verdad es que la fecha
// nunca sea futura.
// ============================================================================

const { LibroDeCaja } = require('../lib/libro');

const FONDO_INICIAL = 400.00;

// 90 segundos de adelanto: dentro de la tolerancia de 5 minutos que el backend
// acepta a propósito, y de sobra para que el cierre ocurra antes de esa hora.
const ADELANTO_MS = 90 * 1000;

module.exports = {
    nombre: 'Reloj adelantado: la venta cuenta igual en los totales y en el cierre',
    etiqueta: 'reloj',

    async ejecutar({ af, sembrar }) {
        const t = await sembrar('reloj', { productos: ['pastor'] });
        const api = t.api;
        const libro = new LibroDeCaja(FONDO_INICIAL);

        const turno = await api.exigir('POST', '/api/turnos', {
            cajero_nombre: 'Chela',
            rol: 'cajero',
            fondo_inicial: FONDO_INICIAL,
            branch_id: t.sucursales.matriz,
        }, [200, 201]);

        // La tableta de la caja tiene el reloj 90 s adelantado y sube una venta
        // que hizo sin internet.
        const relojAdelantado = new Date(Date.now() + ADELANTO_MS);

        const venta = await api.exigir('POST', '/api/orders', {
            branch_id: t.sucursales.matriz,
            items: [{ product_id: t.productos.pastor.id, quantity: 5, unit_price: t.productos.pastor.precio }],
            payment_method: 'efectivo',
            client_uuid: 'reloj-adelantado-' + Date.now(),
            sold_at: relojAdelantado.toISOString(),
        }, [200, 201]);

        // 1. La venta NO se rechaza: para eso existe la tolerancia.
        af.dinero('la venta del equipo con el reloj adelantado se registra', venta.total, 110.00);

        // 2. Pero no se guarda en el futuro: se le fija la hora del servidor.
        const guardada = new Date(venta.createdAt).getTime();
        af.cierto(
            'y NO queda fechada en el futuro: se ajusta al reloj del servidor',
            guardada <= Date.now() + 1000,
            'createdAt quedó en ' + venta.createdAt + ', por delante del servidor. ' +
            'Ese es exactamente el hueco por el que la venta desaparecía del cierre.'
        );
        af.cierto(
            'y el ajuste es de segundos, no la tira a otro momento del día',
            Math.abs(guardada - Date.now()) < 5 * 60 * 1000,
            'la hora ajustada quedó demasiado lejos de ahora: ' + venta.createdAt
        );

        libro.venta({ pagos: [{ metodo: 'efectivo', monto: 110.00 }], concepto: 'venta con reloj adelantado' });

        // 3. Lo que el cajero ve en pantalla mientras cuenta el dinero.
        const totales = await api.exigir('GET', '/api/turnos/' + turno.id + '/totales', undefined, 200);
        af.dinero('el cajero la ve en los totales del turno', totales.total_ventas, libro.totalVentas);
        af.dinero('y el efectivo esperado la incluye', totales.efectivo_esperado, libro.efectivoEnCajon);

        // 4. Y sigue ahí al cerrar. Aquí es donde antes se evaporaba.
        const cerrado = await api.exigir('PUT', '/api/turnos/' + turno.id + '/cerrar', {
            efectivo_contado: libro.efectivoEnCajon,
            notas: 'Cierre con una venta de un equipo con el reloj adelantado',
        }, 200);

        af.dinero('la venta SIGUE contando en el turno cerrado', cerrado.total_ventas, libro.totalVentas);
        af.dinero('DIFERENCIA DEL CORTE (aquí aparecía el sobrante fantasma)', cerrado.diferencia, 0);
    },
};
