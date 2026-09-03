// ============================================================================
// RECORRIDO 5 — HALLAZGO ABIERTO: la venta con el reloj adelantado se evapora
//               entre los totales en vivo y el cierre del turno
//
// ⚠️ ESTE RECORRIDO FALLA HOY A PROPÓSITO. No es una prueba rota: es la
// reproducción mínima de un defecto REAL encontrado por este banco el
// 2026-09-02, mientras se escribía el recorrido 4. Está marcado como
// `hallazgoAbierto`, así que se ejecuta y se reporta en cada corrida pero NO
// tumba el código de salida — el banco sigue sirviendo de red de seguridad
// mientras el dueño del producto decide qué hacer. En cuanto se arregle el
// backend, esto pasa a verde y hay que quitarle la marca.
//
// ── QUÉ PASA ────────────────────────────────────────────────────────────────
//
// Las dos consultas que deciden cuánto vendió un turno NO usan el mismo filtro
// de fechas (routes/turnos.js → `_ventasDelTurno`):
//
//     totales en vivo   (hasta = null)   →  createdAt >= apertura
//     cierre del turno  (hasta = ahora)  →  createdAt BETWEEN apertura AND ahora
//
// Y por otro lado, `resolverFechaVenta` (utils/ventaOffline.js) ACEPTA a
// propósito una venta fechada hasta 5 MINUTOS EN EL FUTURO, con esta razón
// explícita: "5 min de tolerancia por relojes adelantados" (§26). Es una
// decisión correcta — rechazar la venta de un equipo con el reloj mal la
// dejaría atascada en la cola para siempre.
//
// Juntando las dos: una venta subida desde un equipo con el reloj un par de
// minutos adelantado se guarda con `createdAt` por delante del reloj del
// servidor. Entonces:
//
//   • el cajero la VE en los totales del turno (pasa el `>= apertura`);
//   • al cerrar, DESAPARECE (no pasa el `<= ahora`);
//   • el dinero sí está en el cajón.
//
// Resultado: un SOBRANTE fantasma exactamente del tamaño de esa venta. Es la
// misma familia de descuadre que el §28 (gastos), el §30 (propinas) y el §31
// (pagos divididos) vinieron a cerrar: la diferencia del corte deja de
// significar algo, que es lo único que la hace útil.
//
// ── POR QUÉ NO LO VIO NADIE ─────────────────────────────────────────────────
//
// Las pruebas unitarias comprueban los totales O el cierre, nunca los dos sobre
// el mismo turno y con una venta en ese hueco de tiempo. El hueco solo aparece
// recorriendo el día entero, que es justo lo que hace este banco.
//
// ── CÓMO SE ARREGLARÍA (a decidir por el dueño del producto) ────────────────
//
// El `hasta` del cierre existe para que no se cuelen ventas posteriores al
// corte, y eso está bien. Lo que no está bien es que su tope sea más estrecho
// que la tolerancia con la que se aceptan las ventas. La corrección natural es
// que el cierre admita la misma holgura que la entrada — es decir, acotar por
// `ahora + TOLERANCIA_FUTURO_MS` en vez de por `ahora` — o, en su defecto, que
// las dos consultas usen el MISMO filtro, que es lo que el comentario de
// `_ventasDelTurno` ya promete: "si cada uno lo calculara aparte, el cajero
// vería un número al contar el dinero y otro al confirmar el cierre".
// ============================================================================

const { LibroDeCaja } = require('../lib/libro');

const FONDO_INICIAL = 400.00;

// 90 segundos de adelanto: dentro de la tolerancia de 5 minutos que el backend
// acepta a propósito, y de sobra para que el cierre ocurra antes de esa hora.
const ADELANTO_MS = 90 * 1000;

module.exports = {
    nombre: 'Reloj adelantado: la venta se ve en los totales y no en el cierre',
    etiqueta: 'reloj',
    hallazgoAbierto: 'El cierre de turno acota por `ahora` mientras la venta se acepta con hasta ' +
                     '5 min de adelanto: esa venta aparece en los totales y desaparece del corte.',

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
        // que hizo sin internet. El backend la acepta —es lo correcto— y la
        // guarda con la hora que declara.
        const relojAdelantado = new Date(Date.now() + ADELANTO_MS);

        const venta = await api.exigir('POST', '/api/orders', {
            branch_id: t.sucursales.matriz,
            items: [{ product_id: t.productos.pastor.id, quantity: 5, unit_price: t.productos.pastor.precio }],
            payment_method: 'efectivo',
            client_uuid: 'reloj-adelantado-' + Date.now(),
            sold_at: relojAdelantado.toISOString(),
        }, [200, 201]);

        af.dinero('la venta del equipo con el reloj adelantado se registra', venta.total, 110.00);
        af.cierto(
            'y conserva su hora, por delante del reloj del servidor',
            new Date(venta.createdAt).getTime() > Date.now(),
            'createdAt no quedó en el futuro (' + venta.createdAt + '); el escenario no se reprodujo ' +
            'y las dos comprobaciones siguientes no prueban nada'
        );

        libro.venta({ pagos: [{ metodo: 'efectivo', monto: 110.00 }], concepto: 'venta con reloj adelantado' });

        // Lo que el cajero ve en pantalla mientras cuenta el dinero.
        const totales = await api.exigir('GET', '/api/turnos/' + turno.id + '/totales', undefined, 200);
        af.dinero('el cajero la VE en los totales del turno', totales.total_ventas, libro.totalVentas);
        af.dinero('y el efectivo esperado la incluye', totales.efectivo_esperado, libro.efectivoEnCajon);

        // El dinero está en el cajón: el cajero cuenta lo que los totales le dijeron.
        const cerrado = await api.exigir('PUT', '/api/turnos/' + turno.id + '/cerrar', {
            efectivo_contado: libro.efectivoEnCajon,
            notas: 'Cierre con una venta fechada por delante del reloj del servidor',
        }, 200);

        af.dinero('la venta sigue contando en el turno CERRADO', cerrado.total_ventas, libro.totalVentas);
        af.dinero('DIFERENCIA DEL CORTE (aquí aparece el sobrante fantasma)', cerrado.diferencia, 0);
    },
};
