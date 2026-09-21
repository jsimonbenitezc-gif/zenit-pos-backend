// ============================================================================
// utils/ventanas.js — ¿este minuto cae dentro de una ventana semanal?
//
// La lógica de la MEDIANOCHE, sola y sin base de datos. Nació en
// utils/horarios.js (§37) y se sacó aquí para que las promociones con
// calendario (PLAN_OFERTAS_V1) la REUSEN en vez de reescribirla: es exactamente
// el error que ya se pagó una vez — un bar de 18:00 a 02:00 con toda su noche
// "fuera de horario" por comparar ingenuamente `abre <= ahora < cierra`.
//
// Formato de la semana: array de 7 (0 = domingo … 6 = sábado), cada día
// `{ cerrado: true }` o `{ abre: 'HH:MM', cierra: 'HH:MM' }`.
//   - `cierra < abre`  → la ventana CRUZA la medianoche: sigue viva el día
//                        siguiente hasta `cierra`.
//   - `abre === cierra` → abierto las 24 h de ese día (no se extiende al otro).
//
// Pura a propósito: la copian los clientes junto con utils/promos.js.
// ============================================================================

const RE_HORA = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** 'HH:MM' → minutos desde medianoche. null si no tiene ese formato. */
function minutosDeHora(texto) {
    const m = RE_HORA.exec(String(texto || '').trim());
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/**
 * ¿Qué ventana está viva en el día `dow` al minuto `minutos`?
 * Devuelve 'hoy' (la ventana del propio día), 'ayer' (la de ayer, que cruzó la
 * medianoche y aún no cierra) o null. Saber CUÁL importa: la promo del viernes
 * de 22:00 a 02:00 que se evalúa el sábado a la 1:30 es la del VIERNES, y es la
 * fecha del viernes la que cuenta para "entre fechas".
 */
function ventanaViva(semana, dow, minutos) {
    if (!Array.isArray(semana) || semana.length !== 7) return null;

    const hoy = semana[dow];
    if (hoy && !hoy.cerrado) {
        const abre = minutosDeHora(hoy.abre);
        const cierra = minutosDeHora(hoy.cierra);
        if (abre !== null && cierra !== null) {
            if (abre === cierra) return 'hoy';                              // 24 h
            if (cierra > abre) { if (minutos >= abre && minutos < cierra) return 'hoy'; }
            else if (minutos >= abre) return 'hoy';                        // cruza: la parte de hoy
        }
    }

    const ayer = semana[(dow + 6) % 7];
    if (ayer && !ayer.cerrado) {
        const abre = minutosDeHora(ayer.abre);
        const cierra = minutosDeHora(ayer.cierra);
        if (abre !== null && cierra !== null && cierra < abre && minutos < cierra) return 'ayer';
    }

    return null;
}

module.exports = { RE_HORA, minutosDeHora, ventanaViva };
