/**
 * utils/horarios.js — HORARIOS LABORALES COMO SEÑAL DE SEGURIDAD (Bloque 14 del PLAN_ARREGLOS_V5).
 *
 * LA REGLA DE ORO: el horario es una SEÑAL, NUNCA UN CANDADO.
 * Se evaluó bloquear accesos fuera de horario y se descartó (decisión con el dueño del
 * producto, 2026-07-27): un POS que se niega a vender hace más daño que el riesgo que
 * evita. El negocio que se queda abierto por un partido, el inventario del domingo, el
 * 31 de diciembre o el cajero que olvidó abrir turno se quedarían con la caja muerta sin
 * entender por qué. Va contra la filosofía de cero fricción (CLAUDE.md §1).
 *
 * Por eso este archivo NO tiene ninguna función que diga "no puedes". Lo que ofrece es:
 *   - `evaluarHorario()`       → ¿esto está pasando fuera del horario? (para marcar y avisar)
 *   - `avisarFueraDeHorario()` → push al dueño, agrupando ráfagas
 * y una única excepción acordada con el dueño del producto (2026-09-02): aprobar una
 * pantalla de cocina fuera de horario exige al DUEÑO (routes/kds.js). No bloquea a nadie
 * que pueda vender; bloquea que un PIN compartido dé acceso permanente a la cocina a las
 * 3 a.m., y deja salida al que instala la tablet antes de abrir.
 *
 * ⚠️ TODO se interpreta en la ZONA DEL NEGOCIO (utils/tz.js, §22), nunca con
 * `new Date().getHours()` — Render corre en UTC y eso correría el horario 6 horas.
 *
 * FORMATO (`settings.horario_operacion`):
 *   null | undefined  → SIN HORARIO DEFINIDO. Todo está "dentro de horario": ninguna
 *                       señal se dispara y el sistema se comporta como antes del bloque.
 *   array de 7 entradas, índice 0 = DOMINGO … 6 = sábado (mismo orden que
 *   `diaSemanaLocal`), cada una:
 *      { cerrado: true }                        → ese día el negocio no abre
 *      { abre: 'HH:MM', cierra: 'HH:MM' }       → ventana de ese día
 *
 * ⚠️ LA VENTANA PUEDE CRUZAR LA MEDIANOCHE, y es el caso que más importa: un bar con
 * 18:00–02:00 tendría TODA su noche marcada como "fuera de horario" si se comparara
 * ingenuamente `abre <= ahora < cierra`. Cuando `cierra < abre`, la ventana sigue viva
 * después de medianoche y hay que mirar también la del DÍA ANTERIOR — a la 1:30 del
 * martes, quien está abierto es el lunes.
 * `abre === cierra` significa ABIERTO TODO EL DÍA (24 h), y no se extiende al siguiente.
 */

const { User } = require('../models');
const { zonaDelNegocio, partesLocales, diaSemanaLocal } = require('./tz');
const { enviarNotificacion } = require('./push');

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const RE_HORA = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** 'HH:MM' → minutos desde medianoche. Devuelve null si no tiene ese formato. */
function _minutos(texto) {
    const m = RE_HORA.exec(String(texto || '').trim());
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/**
 * Valida y normaliza lo que llega del cliente.
 *
 * Devuelve `{ ok: true, horario }` (con `horario` = null cuando no hay horario definido)
 * o `{ ok: false, error }`.
 *
 * ⚠️ Un valor basura se RECHAZA (400), no se cae a un default en silencio: a diferencia
 * de los porcentajes de propina (§30), aquí un default silencioso dejaría al dueño
 * creyendo que configuró un horario que no existe, y por tanto esperando unas alertas
 * que nunca van a llegar. Una señal de seguridad que se cree activada y no lo está es
 * peor que no tenerla.
 */
function normalizarHorario(valor) {
    if (valor === null || valor === undefined || valor === '') return { ok: true, horario: null };

    let bruto = valor;
    if (typeof bruto === 'string') {
        try { bruto = JSON.parse(bruto); }
        catch { return { ok: false, error: 'El horario no tiene un formato válido' }; }
    }
    if (bruto === null) return { ok: true, horario: null };
    if (!Array.isArray(bruto)) return { ok: false, error: 'El horario debe ser una lista de 7 días' };
    if (bruto.length === 0) return { ok: true, horario: null };
    if (bruto.length !== 7) return { ok: false, error: 'El horario debe tener exactamente 7 días (domingo a sábado)' };

    const horario = [];
    for (let i = 0; i < 7; i++) {
        const dia = bruto[i];
        if (!dia || typeof dia !== 'object') {
            return { ok: false, error: `El ${DIAS[i]} no tiene un horario válido` };
        }
        if (dia.cerrado === true || dia.cerrado === 'true') {
            horario.push({ cerrado: true });
            continue;
        }
        const abre = _minutos(dia.abre);
        const cierra = _minutos(dia.cierra);
        if (abre === null || cierra === null) {
            return { ok: false, error: `El ${DIAS[i]} necesita hora de apertura y de cierre en formato HH:MM` };
        }
        horario.push({
            cerrado: false,
            abre: String(dia.abre).trim(),
            cierra: String(dia.cierra).trim(),
        });
    }

    // Siete días cerrados no es un horario: es no tener horario. Guardarlo dejaría al
    // negocio con TODA su actividad marcada como sospechosa, que es ruido puro.
    if (horario.every(d => d.cerrado)) return { ok: true, horario: null };

    return { ok: true, horario };
}

/**
 * ¿El instante `fecha` cae dentro del horario del negocio?
 * Sin horario definido → SIEMPRE true (todo permitido, comportamiento previo al bloque).
 */
function dentroDeHorario(horario, tz, fecha = new Date()) {
    if (!Array.isArray(horario) || horario.length !== 7) return true;

    const p = partesLocales(tz, fecha);
    const ahora = p.hour * 60 + p.minute;
    const dow = diaSemanaLocal(tz, fecha);

    // 1) La ventana de HOY.
    const hoy = horario[dow];
    if (hoy && !hoy.cerrado) {
        const abre = _minutos(hoy.abre);
        const cierra = _minutos(hoy.cierra);
        if (abre !== null && cierra !== null) {
            if (abre === cierra) return true;                       // 24 h
            if (cierra > abre) { if (ahora >= abre && ahora < cierra) return true; }
            else if (ahora >= abre) return true;                    // cruza medianoche: la parte de hoy
        }
    }

    // 2) La ventana de AYER, si cruzaba la medianoche y todavía no ha cerrado.
    //    Es lo que hace que la 1:30 de un bar con 18:00–02:00 sea horario normal.
    const ayer = horario[(dow + 6) % 7];
    if (ayer && !ayer.cerrado) {
        const abre = _minutos(ayer.abre);
        const cierra = _minutos(ayer.cierra);
        if (abre !== null && cierra !== null && cierra < abre && ahora < cierra) return true;
    }

    return false;
}

/** Texto corto de la ventana de hoy, para los mensajes ("09:00–18:00", "cerrado"). */
function ventanaDelDia(horario, tz, fecha = new Date()) {
    if (!Array.isArray(horario) || horario.length !== 7) return null;
    const dia = horario[diaSemanaLocal(tz, fecha)];
    if (!dia) return null;
    if (dia.cerrado) return 'cerrado';
    return `${dia.abre}–${dia.cierra}`;
}

/** Hora local del negocio en texto ("3:40 a.m."), para el cuerpo del push. */
function horaLegible(tz, fecha = new Date()) {
    const p = partesLocales(tz, fecha);
    const sufijo = p.hour < 12 ? 'a.m.' : 'p.m.';
    const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
    return `${h12}:${String(p.minute).padStart(2, '0')} ${sufijo}`;
}

// ── Horario del negocio (con caché corta, igual que la zona y el impuesto) ────

const _cache = new Map(); // businessId → { horario, expira }
const TTL_MS = 60 * 1000;

async function horarioDelNegocio(businessId) {
    const clave = String(businessId);
    const guardado = _cache.get(clave);
    if (guardado && guardado.expira > Date.now()) return guardado.horario;

    let horario = null;
    try {
        const owner = await User.findByPk(businessId, { attributes: ['settings'] });
        if (owner) {
            const prefs = JSON.parse(owner.settings || '{}');
            horario = normalizarHorario(prefs.horario_operacion).horario;
        }
    } catch {
        // Ante cualquier fallo (JSON roto, BD caída) se sigue SIN horario, o sea sin
        // señales. Es la falla segura: un error de lectura no puede convertirse en un
        // 403 al dueño ni en una lluvia de alertas falsas.
    }
    _cache.set(clave, { horario, expira: Date.now() + TTL_MS });
    return horario;
}

function invalidarHorarioNegocio(businessId) {
    _cache.delete(String(businessId));
}

/**
 * La pregunta que hacen las rutas: ¿esta acción está ocurriendo fuera de horario?
 *
 * Devuelve siempre un objeto usable, nunca lanza: si algo falla, `fuera` es false y la
 * ruta sigue su curso normal. Marcar mal una acción es un ruido menor; tumbar una
 * cancelación porque no se pudo leer el horario sería exactamente el candado que este
 * bloque existe para no construir.
 */
async function evaluarHorario(businessId, fecha = new Date()) {
    try {
        const tz = await zonaDelNegocio(businessId);
        const horario = await horarioDelNegocio(businessId);
        if (!horario) return { fuera: false, configurado: false, tz, ventana: null, hora: null };
        const fuera = !dentroDeHorario(horario, tz, fecha);
        return {
            fuera,
            configurado: true,
            tz,
            ventana: ventanaDelDia(horario, tz, fecha),
            hora: horaLegible(tz, fecha),
        };
    } catch {
        return { fuera: false, configurado: false, tz: null, ventana: null, hora: null };
    }
}

// ── Aviso al dueño, agrupando ráfagas ────────────────────────────────────────

/**
 * Las acciones sospechosas vienen en ráfaga: quien cancela a las 3 a.m. cancela varias
 * seguidas. Un push por cada una es ruido que el dueño acaba silenciando, así que se
 * juntan en una ventana corta y sale UNO solo ("3 cancelaciones a las 3:40 a.m.").
 *
 * Viven en memoria a propósito, como los códigos de emparejamiento del KDS (§35):
 * perder un aviso pendiente en un reinicio no rompe nada, y una tabla nueva para un
 * dato que dura dos minutos no se paga sola.
 */
const VENTANA_MS = 2 * 60 * 1000;
const _pendientes = new Map(); // businessId → { conteo: Map<action_type, n>, hora, ventana, timer }

const ETIQUETAS = {
    cancel_order:         ['cancelación', 'cancelaciones'],
    return_order:         ['devolución', 'devoluciones'],
    apply_discount:       ['descuento', 'descuentos'],
    inventory_adjustment: ['ajuste de inventario', 'ajustes de inventario'],
    edit_customer:        ['edición de cliente', 'ediciones de cliente'],
    approve_kds_device:   ['pantalla de cocina autorizada', 'pantallas de cocina autorizadas'],
    revoke_kds_device:    ['pantalla de cocina revocada', 'pantallas de cocina revocadas'],
    cash_movement:        ['movimiento de caja', 'movimientos de caja'],
    cash_movement_void:   ['anulación de caja', 'anulaciones de caja'],
};

function _frase(tipo, n) {
    const par = ETIQUETAS[tipo] || [tipo, tipo];
    return `${n} ${n === 1 ? par[0] : par[1]}`;
}

function _emitir(clave) {
    const pend = _pendientes.get(clave);
    _pendientes.delete(clave);
    if (!pend) return;

    const partes = [...pend.conteo.entries()].map(([tipo, n]) => _frase(tipo, n));
    const total = [...pend.conteo.values()].reduce((s, n) => s + n, 0);
    const cuerpo = partes.length === 1
        ? `${partes[0]} a las ${pend.hora}${pend.ventana ? ` · horario de hoy ${pend.ventana}` : ''}`
        : `${partes.join(', ')} desde las ${pend.hora}`;

    enviarNotificacion(
        clave,
        'notif_fuera_horario',
        total === 1 ? '🌙 Acción fuera de horario' : '🌙 Actividad fuera de horario',
        cuerpo,
        { tipo: 'fuera_horario' }
    );
}

/**
 * Encola un aviso. No espera a nada y nunca lanza: se llama DESPUÉS del commit y jamás
 * puede afectar a la acción que ya ocurrió.
 *
 * @param {number} businessId
 * @param {string} actionType  el mismo `action_type` del PrivilegedActionLog
 * @param {object} marca       lo que devolvió `evaluarHorario()`
 */
function avisarFueraDeHorario(businessId, actionType, marca = {}) {
    try {
        if (!marca || !marca.fuera) return;
        const clave = String(businessId);
        let pend = _pendientes.get(clave);
        if (!pend) {
            pend = { conteo: new Map(), hora: marca.hora, ventana: marca.ventana, timer: null };
            pend.timer = setTimeout(() => _emitir(clave), VENTANA_MS);
            // Sin unref, un aviso pendiente mantendría vivo el proceso (y colgaría Jest).
            if (pend.timer && typeof pend.timer.unref === 'function') pend.timer.unref();
            _pendientes.set(clave, pend);
        }
        pend.conteo.set(actionType, (pend.conteo.get(actionType) || 0) + 1);
    } catch { /* un aviso perdido no puede romper una venta */ }
}

/** Solo para los tests: vacía la cola y el caché sin emitir nada. */
function _limpiarAvisos() {
    for (const pend of _pendientes.values()) { try { clearTimeout(pend.timer); } catch {} }
    _pendientes.clear();
    _cache.clear();
}

/** Solo para los tests: fuerza la salida del aviso agrupado sin esperar la ventana. */
function _emitirAhora(businessId) {
    const clave = String(businessId);
    const pend = _pendientes.get(clave);
    if (pend) { try { clearTimeout(pend.timer); } catch {} }
    _emitir(clave);
}

module.exports = {
    DIAS,
    normalizarHorario,
    dentroDeHorario,
    ventanaDelDia,
    horaLegible,
    horarioDelNegocio,
    invalidarHorarioNegocio,
    evaluarHorario,
    avisarFueraDeHorario,
    _limpiarAvisos,
    _emitirAhora,
};
