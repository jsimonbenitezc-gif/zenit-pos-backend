// ============================================================================
// utils/ventaOffline.js — fidelidad de las ventas que llegan tarde (BLOQUE 5)
//
// Una venta hecha sin internet se sube minutos, horas o días después. Si el
// backend usa la hora en que la RECIBE y el precio ACTUAL del catálogo, esa
// venta queda con datos que nunca ocurrieron: cae en el turno equivocado y
// cobra un monto distinto al que el cliente pagó.
//
// Aquí vive el criterio único para decidir qué se le cree al cliente. Regla de
// oro: **nada de esto puede hacer fallar la venta**. Una venta atascada en la
// cola del POS es peor que un dato imperfecto, así que ante cualquier valor
// sospechoso se cae al valor del servidor y se sigue adelante.
// ============================================================================

// Margen para relojes ligeramente adelantados (no existe la venta del futuro).
const TOLERANCIA_FUTURO_MS = 5 * 60 * 1000;
// Una venta más vieja que esto es un reloj mal configurado, no una venta offline:
// el desktop en modo local puro puede acumular días, pero no meses.
const MAXIMO_ATRASO_MS = 30 * 24 * 60 * 60 * 1000;
// Techo absoluto del precio unitario: DECIMAL(10,2) desborda arriba de 99,999,999.99.
const PRECIO_MAXIMO = 1000000;

/**
 * Valida la hora que declara el cliente para una venta diferida.
 * @param {string|Date} soldAt   Timestamp ISO enviado por el cliente.
 * @param {Date} [ahora]         Inyectable para tests.
 * @returns {{ fecha: Date|null, motivo: 'ok'|'ausente'|'invalida'|'futura'|'futura_ajustada'|'antigua' }}
 *          `fecha` null = usar la hora del servidor.
 */
function resolverFechaVenta(soldAt, ahora = new Date()) {
    if (soldAt === undefined || soldAt === null || soldAt === '') {
        return { fecha: null, motivo: 'ausente' };
    }
    const fecha = soldAt instanceof Date ? soldAt : new Date(soldAt);
    if (Number.isNaN(fecha.getTime())) return { fecha: null, motivo: 'invalida' };
    if (fecha.getTime() > ahora.getTime() + TOLERANCIA_FUTURO_MS) {
        return { fecha: null, motivo: 'futura' };
    }
    // ⚠️ NINGUNA VENTA SE GUARDA CON FECHA EN EL FUTURO. La tolerancia de arriba
    // existe para no RECHAZAR la venta de un equipo con el reloj adelantado, no
    // para creerle la hora: dentro de esa ventana se acepta la venta y se le fija
    // la hora del servidor.
    //
    // Sin esto, una venta fechada por delante del reloj se colaba en un hueco y
    // el corte de caja dejaba de cuadrar. Los totales en vivo del turno filtran
    // con `createdAt >= apertura` y el cierre con `BETWEEN apertura AND ahora`
    // (routes/turnos.js → `_ventasDelTurno`), así que esa venta APARECÍA en la
    // pantalla que el cajero mira al contar el dinero y DESAPARECÍA del cierre:
    // un sobrante fantasma de su mismo importe, con el dinero correcto en el
    // cajón. Lo encontró el banco de pruebas del BLOQUE 15 (CLAUDE.md §38).
    //
    // Se corrige aquí y no ensanchando el filtro del cierre a `ahora + tolerancia`,
    // que era lo primero que venía a la mente: eso habría metido la venta TAMBIÉN
    // en el turno siguiente (su `apertura` sería anterior a la fecha de la venta),
    // cambiando un sobrante fantasma por un DOBLE CONTEO, que es peor.
    //
    // Se pierden como mucho 5 minutos de precisión en la hora, y solo en un equipo
    // con el reloj mal. La venta, su precio y su trato de venta diferida quedan
    // intactos: `fecha` sigue siendo válida, así que `esVentaDiferida` no cambia.
    if (fecha.getTime() > ahora.getTime()) {
        return { fecha: new Date(ahora.getTime()), motivo: 'futura_ajustada' };
    }
    if (fecha.getTime() < ahora.getTime() - MAXIMO_ATRASO_MS) {
        return { fecha: null, motivo: 'antigua' };
    }
    return { fecha, motivo: 'ok' };
}

/**
 * Precio unitario de un item: el del catálogo, salvo en una venta diferida donde
 * el cliente declara el que REALMENTE cobró.
 *
 * ⚠️ No se acepta el precio del cliente en ventas normales (online): ahí el
 * servidor manda, igual que antes. Solo se abre la puerta cuando la venta viene
 * con `sold_at` válido, es decir, cuando el cliente afirma que ya ocurrió.
 *
 * @param {number} precioCatalogo        Precio actual del producto.
 * @param {*} precioCliente              `unit_price` del body.
 * @param {boolean} aceptarPrecioCliente Solo true en ventas diferidas.
 * @returns {{ unitPrice: number, origen: 'catalogo'|'cliente' }}
 */
function resolverPrecioUnitario(precioCatalogo, precioCliente, aceptarPrecioCliente) {
    const catalogo = parseFloat(precioCatalogo);
    if (!aceptarPrecioCliente) return { unitPrice: catalogo, origen: 'catalogo' };

    const p = parseFloat(precioCliente);
    // Anti-abuso mínimo: nada de negativos, cero ni cifras absurdas. Cualquier
    // valor raro cae al catálogo en vez de rechazar la venta.
    if (!Number.isFinite(p) || p <= 0 || p > PRECIO_MAXIMO) {
        return { unitPrice: catalogo, origen: 'catalogo' };
    }
    return { unitPrice: parseFloat(p.toFixed(2)), origen: 'cliente' };
}

/**
 * ¿Vale la pena dejar rastro de este precio? Solo cuando el cliente cobró algo
 * distinto de lo que dice el catálogo hoy. Lo normal (precio idéntico) no
 * ensucia la auditoría.
 */
function precioDifiere(precioCobrado, precioCatalogo) {
    return Math.abs(parseFloat(precioCobrado) - parseFloat(precioCatalogo)) >= 0.01;
}

module.exports = {
    resolverFechaVenta,
    resolverPrecioUnitario,
    precioDifiere,
    TOLERANCIA_FUTURO_MS,
    MAXIMO_ATRASO_MS,
    PRECIO_MAXIMO,
};
