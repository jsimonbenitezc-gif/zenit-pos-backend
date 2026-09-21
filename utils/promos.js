// ============================================================================
// utils/promos.js — LA PROMO ES UN PRODUCTO (PLAN_OFERTAS_V1, Bloque 1)
//
// "Martes 2x1 en tacos": la cajera toca la promo, elige dos tacos y entra al
// carrito como UN renglón. En la base se guarda un OrderItem por cada producto
// elegido, con su parte del precio (§3.1 del plan): así cocina, inventario,
// rentabilidad, impuesto y corte de caja la ven como productos normales sin
// cambiar una línea.
//
// 🔴 PARTE 1 (de aquí hasta la marca "FIN DE LA PARTE 1") VIVE EN TRES COPIAS:
// backend (este archivo), desktop (`pos/modulo-promos.js`) y celular
// (`src/utils/promos.js`). El servidor recalcula toda venta: si una copia se
// desvía, la cajera cobra un número y el ticket sale con otro. Cambia las tres.
// La PARTE 1 no toca la base ni la hora del sistema: todo entra por parámetro.
//
// LAS REGLAS:
//   - Dos formas de cobrar: PRECIO FIJO, o SE REGALA EL MÁS BARATO (2x1, 3x2).
//   - El precio se REPARTE entre los productos en proporción a su precio de
//     lista, a centavos; el residuo del redondeo va al más caro, para que la
//     suma sea EXACTA. Nunca "uno a $0": la rentabilidad (§33) enseñaría un taco
//     vendido a pérdida y otro con margen inflado.
//   - Los EXTRAS se cobran completos encima de su parte (§32.1): el taco de la
//     promo es gratis; su queso extra, no.
//   - El calendario se evalúa en la ZONA DEL NEGOCIO (§22) y reusa la lógica de
//     la medianoche de utils/ventanas.js (§37).
// ============================================================================

const { minutosDeHora, ventanaViva } = require('./ventanas');

const TIPOS = ['precio_fijo', 'regalar_mas_barato'];
const RE_FECHA = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
// Una promo de más de 20 productos no es una promo, es un error de captura.
const MAX_PRODUCTOS_PROMO = 20;

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const _centavos = (n) => Math.round((Number(n) || 0) * 100);

// ── El calendario ────────────────────────────────────────────────────────────
//
//   null                                  → siempre
//   { dias: [2],                          → 0 = domingo … 6 = sábado
//     desde: '18:00', hasta: '20:00',     → opcional; si hasta < desde, cruza la medianoche
//     fecha_inicio: '2026-10-01',         → opcional, fechas LOCALES del negocio
//     fecha_fin: '2026-10-31' }             (la fecha fin cuenta entera)

/**
 * Valida lo que llega del dueño. `{ ok, calendario }` (null = siempre) o
 * `{ ok: false, error }`. Un calendario basura se RECHAZA: caer a "siempre" en
 * silencio dejaría el 2x1 del martes cobrándose el miércoles.
 */
function normalizarCalendario(valor) {
    if (valor === null || valor === undefined || valor === '') return { ok: true, calendario: null };
    let c = valor;
    if (typeof c === 'string') {
        try { c = JSON.parse(c); } catch { return { ok: false, error: 'El calendario no tiene un formato válido' }; }
    }
    if (c === null) return { ok: true, calendario: null };
    if (typeof c !== 'object' || Array.isArray(c)) return { ok: false, error: 'El calendario no tiene un formato válido' };

    const out = {};
    if (c.dias !== undefined && c.dias !== null) {
        if (!Array.isArray(c.dias) || c.dias.length === 0) {
            return { ok: false, error: 'Elige al menos un día de la semana' };
        }
        const dias = [];
        for (const d of c.dias) {
            const n = Number(d);
            if (!Number.isInteger(n) || n < 0 || n > 6) return { ok: false, error: 'Los días van de 0 (domingo) a 6 (sábado)' };
            if (!dias.includes(n)) dias.push(n);
        }
        // Los siete días es lo mismo que no filtrar por día.
        if (dias.length < 7) out.dias = dias.sort((a, b) => a - b);
    }

    const tieneDesde = c.desde !== undefined && c.desde !== null && c.desde !== '';
    const tieneHasta = c.hasta !== undefined && c.hasta !== null && c.hasta !== '';
    if (tieneDesde !== tieneHasta) return { ok: false, error: 'El horario necesita hora de inicio y de fin' };
    if (tieneDesde) {
        if (minutosDeHora(c.desde) === null || minutosDeHora(c.hasta) === null) {
            return { ok: false, error: 'Las horas van en formato HH:MM (por ejemplo 18:00)' };
        }
        out.desde = String(c.desde).trim();
        out.hasta = String(c.hasta).trim();
    }

    for (const k of ['fecha_inicio', 'fecha_fin']) {
        if (c[k] === undefined || c[k] === null || c[k] === '') continue;
        const f = String(c[k]).trim().slice(0, 10);
        if (!RE_FECHA.test(f)) return { ok: false, error: 'Las fechas van en formato AAAA-MM-DD' };
        out[k] = f;
    }
    if (out.fecha_inicio && out.fecha_fin && out.fecha_inicio > out.fecha_fin) {
        return { ok: false, error: 'La fecha de inicio es posterior a la de fin' };
    }

    return { ok: true, calendario: Object.keys(out).length ? out : null };
}

/** Lee un calendario ya guardado (TEXT o objeto) sin lanzar nunca. */
function leerCalendario(valor) {
    const r = normalizarCalendario(valor);
    return r.ok ? r.calendario : null;
}

/**
 * ¿El calendario está vigente en este momento LOCAL?
 * `local` = { dow, minutos, fecha: 'YYYY-MM-DD', fechaAyer: 'YYYY-MM-DD' }.
 *
 * Se arma una semana con las ventanas del calendario y se le pregunta a
 * `ventanaViva`, la misma de los horarios (§37). Si la ventana viva es la de
 * AYER (un happy hour que cruzó la medianoche), la fecha que cuenta para
 * "entre fechas" es la de ayer: el 31 de octubre de 22:00 a 02:00 sigue siendo
 * del 31 a la 1 de la mañana del 1 de noviembre.
 */
function calendarioVigente(calendario, local) {
    const c = leerCalendario(calendario);
    if (!c) return true;
    if (!local) return false;

    const ventanaDelDia = c.desde ? { abre: c.desde, cierra: c.hasta } : { abre: '00:00', cierra: '00:00' };
    const semana = Array.from({ length: 7 }, (_, d) =>
        (!c.dias || c.dias.includes(d)) ? ventanaDelDia : { cerrado: true }
    );

    const cual = ventanaViva(semana, local.dow, local.minutos);
    if (!cual) return false;

    const fechaRef = cual === 'ayer' ? local.fechaAyer : local.fecha;
    if (c.fecha_inicio && fechaRef < c.fecha_inicio) return false;
    if (c.fecha_fin && fechaRef > c.fecha_fin) return false;
    return true;
}

/**
 * Las partes locales que necesita el calendario, a partir de una hora local
 * ya conocida (año, mes 1-12, día, hora, minuto). Los clientes la llaman con
 * el reloj del equipo, que ya es la hora del negocio.
 */
function localDesdePartes({ year, month, day, hour, minute }) {
    const pad = (n) => String(n).padStart(2, '0');
    const hoy = new Date(Date.UTC(year, month - 1, day));
    const ayer = new Date(Date.UTC(year, month - 1, day - 1));
    const iso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    return { dow: hoy.getUTCDay(), minutos: hour * 60 + minute, fecha: iso(hoy), fechaAyer: iso(ayer) };
}

// ── El precio y el reparto ───────────────────────────────────────────────────

/** Tipo de cobro con su default: lo viejo (combos de precio fijo) es 'precio_fijo'. */
function tipoDePromo(promo) {
    return promo && TIPOS.includes(promo.tipo) ? promo.tipo : 'precio_fijo';
}

/**
 * Lo que cuesta la promo con estos productos, ANTES de extras.
 * `precios` = precio de lista de cada producto elegido.
 *   precio fijo            → P
 *   regalar el más barato  → suma − los (lleva − paga) más baratos
 */
function precioPromo(promo, precios) {
    const lista = (precios || []).map(p => Math.max(0, r2(p)));
    if (tipoDePromo(promo) === 'precio_fijo') return Math.max(0, r2(promo.price));

    const lleva = lista.length;
    const paga = Math.max(0, Math.min(lleva, parseInt(promo.paga, 10) || 0));
    const gratis = lleva - paga;
    const ordenados = [...lista].sort((a, b) => a - b);
    const suma = lista.reduce((s, p) => s + _centavos(p), 0);
    const regalado = ordenados.slice(0, gratis).reduce((s, p) => s + _centavos(p), 0);
    return (suma - regalado) / 100;
}

/**
 * Reparte `precio` entre los productos en proporción a su precio de lista.
 * Devuelve las partes en el MISMO orden que `precios`. A centavos, con el
 * residuo del redondeo en el más caro (el primero, si hay empate): la suma de
 * las partes es exactamente `precio`.
 */
function repartir(precio, precios) {
    const n = (precios || []).length;
    if (n === 0) return [];
    const total = _centavos(Math.max(0, r2(precio)));
    const lista = precios.map(p => Math.max(0, _centavos(p)));
    const suma = lista.reduce((s, c) => s + c, 0);

    // Sin precios de lista (todo a $0): partes iguales.
    const partes = lista.map(c => suma > 0 ? Math.round(total * c / suma) : Math.floor(total / n));
    let masCaro = 0;
    for (let i = 1; i < n; i++) if (lista[i] > lista[masCaro]) masCaro = i;
    partes[masCaro] += total - partes.reduce((s, c) => s + c, 0);
    return partes.map(c => c / 100);
}

/**
 * Los renglones de una promo vendida. `elegidos` = [{ precio, delta }] con el
 * precio de lista de cada producto y la suma de sus extras.
 * Devuelve { precio, renglones: [{ parte, unit_price }], total, ahorro }.
 */
function armarPromo(promo, elegidos, precioForzado = null) {
    const precios = elegidos.map(e => e.precio);
    const precio = precioForzado !== null && precioForzado !== undefined
        ? Math.max(0, r2(precioForzado))
        : precioPromo(promo, precios);
    const partes = repartir(precio, precios);
    const renglones = elegidos.map((e, i) => ({
        parte: partes[i],
        unit_price: r2(partes[i] + (Number(e.delta) || 0)),
    }));
    const total = renglones.reduce((s, r) => s + _centavos(r.unit_price), 0) / 100;
    const lista = precios.reduce((s, p) => s + _centavos(p), 0) / 100;
    return { precio, renglones, total, ahorro: r2(lista - precio) };
}

// ── Qué se puede elegir ──────────────────────────────────────────────────────
//
// Un "hueco" (slot) de la promo es "N de [estos productos]" o "N de [esta
// categoría]". Un combo viejo —producto fijo con cantidad— es un hueco de un
// solo producto. La elección cabe si cada producto elegido se puede sentar en
// un hueco y cada hueco queda exactamente lleno.

/** ¿Este producto entra en este hueco? `producto` = { id, category_id }. */
function cabeEnHueco(hueco, producto) {
    if (!hueco || !producto) return false;
    const ids = Array.isArray(hueco.product_ids) ? hueco.product_ids.map(Number) : [];
    if (ids.length) return ids.includes(Number(producto.id));
    if (hueco.category_id !== null && hueco.category_id !== undefined) {
        return Number(hueco.category_id) === Number(producto.category_id);
    }
    return false;
}

/** Cuántos productos lleva la promo en total (suma de los huecos). */
function productosQueLleva(huecos) {
    return (huecos || []).reduce((s, h) => s + Math.max(0, parseInt(h.quantity, 10) || 0), 0);
}

/**
 * ¿La elección cabe en la promo? Asignación con vuelta atrás: dos huecos de la
 * misma categoría ("1 de Tacos + 1 de Tacos o Quesadillas") no se pueden llenar
 * a lo primero que caiga. Con 20 productos como máximo sobra.
 */
function eleccionCabe(huecos, productos) {
    const total = productosQueLleva(huecos);
    if (!Array.isArray(productos) || productos.length !== total || total === 0) return false;
    const libres = huecos.map(h => Math.max(0, parseInt(h.quantity, 10) || 0));

    const sentar = (i) => {
        if (i === productos.length) return libres.every(n => n === 0);
        for (let h = 0; h < huecos.length; h++) {
            if (libres[h] > 0 && cabeEnHueco(huecos[h], productos[i])) {
                libres[h]--;
                if (sentar(i + 1)) return true;
                libres[h]++;
            }
        }
        return false;
    };
    return sentar(0);
}

// ════════════════════════ FIN DE LA PARTE 1 ═════════════════════════════════
// Lo de abajo es solo del backend.

const _formateadores = new Map();

/** Partes locales del instante `fecha` en la zona `tz` (Intl, sin base). */
function localEnZona(tz, fecha = new Date()) {
    let f = _formateadores.get(tz);
    if (!f) {
        try {
            f = new Intl.DateTimeFormat('en-US', {
                timeZone: tz, hourCycle: 'h23',
                year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
            });
        } catch {
            f = new Intl.DateTimeFormat('en-US', {
                timeZone: 'America/Mexico_City', hourCycle: 'h23',
                year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
            });
        }
        _formateadores.set(tz, f);
    }
    const p = {};
    for (const parte of f.formatToParts(new Date(fecha))) {
        if (parte.type !== 'literal') p[parte.type] = parseInt(parte.value, 10);
    }
    return localDesdePartes({ year: p.year, month: p.month, day: p.day, hour: p.hour % 24, minute: p.minute });
}

/** ¿La promo (o el descuento) está activa en `fecha`, en la zona `tz`? */
function promoActiva(promo, tz, fecha = new Date()) {
    if (!promo || promo.active === false) return false;
    return calendarioVigente(promo.calendario, localEnZona(tz, fecha));
}

module.exports = {
    TIPOS, MAX_PRODUCTOS_PROMO,
    normalizarCalendario, leerCalendario, calendarioVigente, localDesdePartes,
    tipoDePromo, precioPromo, repartir, armarPromo,
    cabeEnHueco, productosQueLleva, eleccionCabe,
    localEnZona, promoActiva,
};
