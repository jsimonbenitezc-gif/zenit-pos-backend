// ============================================================================
// utils/pagos.js — Pagos divididos (BLOQUE 10 V5)
//
// Único lugar donde se decide CÓMO se repartió el dinero de una venta entre
// métodos de pago. Lo comparten la creación de la venta, el cobro de una mesa,
// los totales en vivo del turno, el cierre y las exportaciones: si cada uno lo
// resolviera aparte, el cajero contaría un número en el cajón y el corte le
// exigiría otro — el mismo problema que resolvieron el BLOQUE 7 con los gastos
// y el BLOQUE 9 con las propinas.
//
// ─── EL PROBLEMA QUE RESUELVE ────────────────────────────────────────────────
// Hasta el BLOQUE 9 una venta tenía UN método de pago. Un cliente que pagaba
// $300 en efectivo y $200 con tarjeta se registraba como si los $500 hubieran
// entrado por un solo lado, así que el corte de caja le exigía al cajero $200
// que nunca estuvieron en el cajón (o al revés). Es exactamente la misma familia
// de descuadre que el método de pago que se perdía al cobrar mesas (§30).
//
// ─── LA REGLA DE ORO ─────────────────────────────────────────────────────────
// LOS PAGOS SON EL DESGLOSE DE `Order.total`, NO UN EXTRA.
//
//   • `suma(payments.amount) === Order.total`. Siempre. Un pago no agrega dinero
//     a la venta: la reparte. El invariante del BLOQUE 8
//     (`total = subtotal + tax_amount`) queda intacto, y el del BLOQUE 9
//     (la propina va FUERA de `total`) también.
//   • La PROPINA de cada pago viaja en `payments.tip_amount`, aparte de `amount`.
//     Lo que el cliente entrega en ese pago es `amount + tip_amount`.
//   • `Order.tip_amount` sigue siendo la propina TOTAL de la venta (la suma), para
//     que nada de lo que ya lee ese campo tenga que cambiar.
//
// ─── DOS FORMAS DE PROPINA, LAS DOS VÁLIDAS ──────────────────────────────────
// 1. **Una propina para toda la venta** (lo de siempre, BLOQUE 9): llega en
//    `tip_amount` + `tip_method` y se guarda tal cual. Es el caso normal.
// 2. **Una propina por pago**: cada comensal deja la suya. Llega dentro de cada
//    entrada de `payments`. `Order.tip_amount` guarda la suma.
//
// ⚠️ Por eso el desglose de propinas por método NO puede leerse de
// `Order.tip_method` cuando hay pagos: ese campo solo alcanza para UNA propina.
// `totalesPorMetodo()` mira los pagos primero y solo cae a los campos del pedido
// cuando no hay ninguno. Si se leyera el campo a secas, una propina en efectivo
// dejada sobre una cuenta pagada con tarjeta desaparecería del efectivo esperado
// y volvería a aparecer como sobrante en el cajón.
//
// ─── COMPATIBILIDAD HACIA ATRÁS ──────────────────────────────────────────────
// Un pedido SIN pagos (todos los anteriores a este bloque, y toda venta de un
// binario viejo) se comporta exactamente como antes: su `payment_method` es la
// verdad y su total entra entero por ese método. No hay que migrar nada.
// ============================================================================

const { redondear, METODOS, normalizarMetodo, normalizarPropina } = require('./propinas');

// Un centavo. Los importes son decimal(10,2) y el cliente reparte porcentajes,
// así que la suma puede quedar a un centavo del total por redondeo. Exigir
// igualdad exacta rechazaría divisiones legítimas (una cuenta de $100 entre 3).
const TOLERANCIA = 0.01;

// Tope defensivo: una venta se divide entre comensales, no entre multitudes.
// Sin límite, un cliente con un bug podría insertar miles de filas por venta.
const MAX_PAGOS = 20;

/** Método de un pago; cae a 'efectivo' si no es uno de los tres válidos. */
function metodoDePago(valor) {
    const candidato = typeof valor === 'string' ? valor.toLowerCase().trim() : '';
    return METODOS.includes(candidato) ? candidato : 'efectivo';
}

/**
 * Resumen del método de pago que se guarda en `Order.payment_method`.
 *
 * Con varios métodos distintos devuelve 'multiple'. Se conserva el campo (en vez
 * de borrarlo en favor de los pagos) porque lo leen el historial, los filtros,
 * el ticket y los binarios viejos: quitarlo rompería medio sistema para no ganar
 * nada. Con un solo método, el valor es ese método y nada cambia.
 */
function metodoResumen(pagos) {
    if (!Array.isArray(pagos) || pagos.length === 0) return null;
    const distintos = [...new Set(pagos.map(p => metodoDePago(p.method)))];
    return distintos.length === 1 ? distintos[0] : 'multiple';
}

/**
 * Normaliza y VALIDA la lista de pagos que manda el cliente contra el total.
 *
 * @param {Array}  pagos      lo que llegó en el body
 * @param {number} total      `Order.total` ya calculado (con impuesto, sin propina)
 * @param {object} opciones
 *        - propinasActivas: si están apagadas, se descarta toda propina (§30)
 *        - metodoPorDefecto: método del pedido, para heredarlo
 *
 * @returns {{ok:true, pagos:Array, metodoResumen:string, propina:{monto,metodo}}}
 *        | {ok:false, error:string}
 *
 * NO lanza: devuelve `ok:false` con un mensaje accionable y deja que quien llama
 * decida. La venta online responde 400 (el cajero está enfrente y puede
 * corregir); la venta diferida cae a un pago único por el total (ver
 * `resolverPagos`), porque una venta atascada para siempre en la cola offline es
 * peor que un desglose imperfecto — mismo criterio del BLOQUE 5.
 */
function normalizarPagos(pagos, total, { propinasActivas = false, metodoPorDefecto = 'efectivo' } = {}) {
    if (!Array.isArray(pagos) || pagos.length === 0) {
        return { ok: false, error: 'No se recibió ningún pago.' };
    }
    if (pagos.length > MAX_PAGOS) {
        return { ok: false, error: `Una venta admite como máximo ${MAX_PAGOS} pagos.` };
    }

    const limpios = [];
    let suma = 0;
    let propinaTotal = 0;

    for (const crudo of pagos) {
        if (!crudo || typeof crudo !== 'object') {
            return { ok: false, error: 'Hay un pago con formato inválido.' };
        }
        const monto = parseFloat(crudo.amount);
        if (!Number.isFinite(monto) || monto <= 0) {
            return { ok: false, error: 'Cada pago debe tener un monto mayor a cero.' };
        }
        const metodo = metodoDePago(crudo.method);

        // La propina del pago pasa por el mismo filtro que la del pedido: un valor
        // inservible cae a 0 y no tumba la venta (§30).
        const propina = propinasActivas ? normalizarPropina(crudo.tip_amount) : 0;

        limpios.push({
            method: metodo,
            amount: redondear(monto),
            tip_amount: propina,
            // Qué items cubrió este pago, cuando la cuenta se dividió POR ITEMS.
            // Es informativo (para reimprimir la división); el cuadre lo hace el
            // monto. En una división por importe queda vacío.
            //
            // Dos formas de nombrarlos, porque el cliente no siempre tiene ids:
            //   • `item_ids`     → ids REALES de `order_items`. Es el caso de una
            //     mesa, cuyos items ya existen cuando llega el momento de cobrar.
            //   • `item_indexes` → posiciones (0-based) dentro del array `items`
            //     de la misma petición. Es el caso de una venta de mostrador que
            //     nace y se cobra a la vez: los items todavía no tienen id. La
            //     ruta las traduce a ids reales tras crear los items.
            item_ids: _enteros(crudo.item_ids),
            item_indexes: _enteros(crudo.item_indexes),
        });
        suma = redondear(suma + redondear(monto));
        propinaTotal += propina;
    }

    const objetivo = redondear(parseFloat(total) || 0);
    // El epsilon evita que la aritmética de punto flotante convierta una
    // diferencia de exactamente un centavo en 0.010000000000005 y rechace una
    // división legítima (los tres tercios de una cuenta de $100).
    if (Math.abs(suma - objetivo) > TOLERANCIA + 1e-9) {
        return {
            ok: false,
            error: `Los pagos suman ${suma.toFixed(2)} y la cuenta es ${objetivo.toFixed(2)}. `
                 + `Ajusta los montos para que cuadren.`,
        };
    }

    // Si quedó un centavo de diferencia por redondeo, se le carga al pago más
    // grande. Así `suma(payments.amount) === total` es exacto en la base y el
    // corte de caja nunca arrastra centavos huérfanos.
    const sobra = redondear(objetivo - suma);
    if (sobra !== 0) {
        let mayor = 0;
        for (let i = 1; i < limpios.length; i++) {
            if (limpios[i].amount > limpios[mayor].amount) mayor = i;
        }
        limpios[mayor].amount = redondear(limpios[mayor].amount + sobra);
    }

    return {
        ok: true,
        pagos: limpios,
        metodoResumen: metodoResumen(limpios),
        // Propina agregada de la venta. `metodo` es el del pago que más propina
        // dejó; solo se usa para pintar el ticket, porque el reparto real por
        // método sale de los pagos (ver `totalesPorMetodo`).
        propina: {
            monto: redondear(propinaTotal),
            metodo: propinaTotal > 0 ? _metodoDeLaMayorPropina(limpios, metodoPorDefecto) : null,
        },
    };
}

function _enteros(valor) {
    if (!Array.isArray(valor)) return [];
    return valor.map(n => parseInt(n)).filter(n => Number.isInteger(n) && n >= 0);
}

function _metodoDeLaMayorPropina(pagos, porDefecto) {
    let mejor = null;
    for (const p of pagos) {
        if (p.tip_amount > 0 && (!mejor || p.tip_amount > mejor.tip_amount)) mejor = p;
    }
    return mejor ? mejor.method : normalizarMetodo(null, porDefecto);
}

/**
 * Reparte el dinero de un conjunto de pedidos entre los tres métodos.
 *
 * Es LA función del bloque: la usan los totales en vivo del turno, el cierre y
 * las exportaciones. Para cada pedido:
 *   • si tiene pagos → se usa el desglose real de los pagos;
 *   • si no → su `total` entra entero por su `payment_method` y su propina por
 *     `tip_method`, exactamente como antes del bloque.
 *
 * @param {Array} pedidos  con `payments` incluido (puede venir vacío o ausente)
 */
function totalesPorMetodo(pedidos = []) {
    const ventas   = { efectivo: 0, tarjeta: 0, transferencia: 0 };
    const propinas = { efectivo: 0, tarjeta: 0, transferencia: 0 };

    for (const pedido of pedidos) {
        const pagos = pedido.payments || pedido.OrderPayments || [];

        if (Array.isArray(pagos) && pagos.length > 0) {
            for (const pago of pagos) {
                const metodo = metodoDePago(pago.method);
                ventas[metodo]   += parseFloat(pago.amount) || 0;
                propinas[metodo] += parseFloat(pago.tip_amount) || 0;
            }
            continue;
        }

        // Pedido sin pagos: el camino de siempre.
        const metodoVenta = metodoDePago(pedido.payment_method);
        ventas[metodoVenta] += parseFloat(pedido.total) || 0;

        const montoPropina = parseFloat(pedido.tip_amount) || 0;
        if (montoPropina > 0) {
            propinas[normalizarMetodo(pedido.tip_method, pedido.payment_method)] += montoPropina;
        }
    }

    return {
        total_ventas:        redondear(ventas.efectivo + ventas.tarjeta + ventas.transferencia),
        total_efectivo:      redondear(ventas.efectivo),
        total_tarjeta:       redondear(ventas.tarjeta),
        total_transferencia: redondear(ventas.transferencia),

        total_propinas:               redondear(propinas.efectivo + propinas.tarjeta + propinas.transferencia),
        total_propinas_efectivo:      redondear(propinas.efectivo),
        total_propinas_tarjeta:       redondear(propinas.tarjeta),
        total_propinas_transferencia: redondear(propinas.transferencia),
    };
}

/**
 * Decide con qué pagos se registra una venta.
 *
 * Sin `payments` en el body → no se aplica nada (venta de un solo método,
 * comportamiento de siempre; no se crea ninguna fila y el pedido queda idéntico
 * a los de antes del bloque).
 *
 * Con `payments` inválidos:
 *   • venta ONLINE → se devuelve el error para responder 400. El cajero tiene la
 *     pantalla enfrente y puede corregir el reparto en el momento.
 *   • venta DIFERIDA (offline, §26) → se descarta el desglose y la venta se
 *     registra con su método único. El total sigue siendo correcto: solo se
 *     pierde el detalle de por dónde entró. Una venta que nunca sube es peor.
 */
function resolverPagos({ payments, total, esVentaDiferida = false, propinasActivas = false, metodoPorDefecto = 'efectivo' }) {
    if (payments === undefined || payments === null) return { aplicar: false };

    const r = normalizarPagos(payments, total, { propinasActivas, metodoPorDefecto });
    if (r.ok) return { aplicar: true, ...r };

    if (esVentaDiferida) return { aplicar: false, descartado: r.error };
    return { aplicar: false, error: r.error };
}

module.exports = {
    TOLERANCIA,
    MAX_PAGOS,
    metodoDePago,
    metodoResumen,
    normalizarPagos,
    totalesPorMetodo,
    resolverPagos,
};
