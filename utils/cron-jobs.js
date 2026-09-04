// ============================================================================
// utils/cron-jobs.js — notificaciones programadas.
//
// Vivían dentro de `server.js` (deuda técnica §12.5). Se separaron el 2026-09-04
// para que `server.js` solo monte la app y para poder mover esto a un worker
// aparte el día que haga falta, sin tocar el arranque.
//
// ⚠️ TRES REGLAS QUE YA COSTARON UN BUG CADA UNA:
//
// 1. **La hora se compara en la zona del NEGOCIO, nunca en la del servidor**
//    (§22). Render corre en UTC: sin esto, el "resumen de las 22h" llegaba a las
//    4 de la tarde en México y con el día ya cortado.
// 2. **Los dos resúmenes corren CADA HORA y filtran por hora local.** No se puede
//    usar un cron fijo como '0 8 * * 1': eso son las 8 UTC, o sea las 2 de la
//    madrugada del domingo en México.
// 3. **Un cron nunca tumba el proceso**: cada uno atrapa su error y lo registra.
//    Un fallo enviando un push no puede tirar el servidor de un negocio.
//
// Las ventas se cuentan SIEMPRE con `filtroVentaContable()` (§19.14), el mismo
// criterio del dashboard y del corte de caja, para que los tres números cuadren.
// ============================================================================
const logger = require('./logger');

// ─── Cron jobs: notificaciones programadas ─────────────────────────────────
function iniciarCronJobs() {
    const cron = require('node-cron');
    const { User, Turno, Order } = require('../models');
    const { enviarNotificacion } = require('./push');
    const { Op } = require('sequelize');
    const { filtroVentaContable } = require('./ordersFilter');
    const { normalizarZona, horaLocal, diaSemanaLocal, inicioDiaLocal } = require('./tz');
    const { normalizarHorario, dentroDeHorario, ventanaDelDia } = require('./horarios');

    // Resumen diario — corre cada hora en el minuto 0
    // Envía solo a los usuarios que tienen esa hora configurada en notif_resumen_diario_hora.
    // La hora se compara en la zona del NEGOCIO (Render corre en UTC): sin esto el
    // "resumen de las 22h" llegaba a las 4pm en México y con el día ya cortado.
    cron.schedule('0 * * * *', async () => {
        const ahora = new Date();
        try {
            const owners = await User.findAll({ where: { role: 'owner', active: true }, attributes: ['id', 'settings'] });
            for (const owner of owners) {
                let prefs = {};
                try { prefs = JSON.parse(owner.settings || '{}'); } catch {}
                if (prefs.notif_resumen_diario === false) continue;
                const tz = normalizarZona(prefs.tz);
                const horaDeseada = parseInt(prefs.notif_resumen_diario_hora ?? 22);
                if (horaLocal(tz, ahora) !== horaDeseada) continue;

                const hoy = inicioDiaLocal(tz, ahora);
                const pedidos = await Order.findAll({
                    where: { business_id: owner.id, ...filtroVentaContable(), createdAt: { [Op.gte]: hoy } },
                    attributes: ['total']
                });
                const totalDia = pedidos.reduce((s, p) => s + parseFloat(p.total || 0), 0);
                enviarNotificacion(owner.id, null, '📊 Resumen del día',
                    `${pedidos.length} pedido(s) · $${totalDia.toFixed(2)} en ventas`);
            }
        } catch (err) { logger.error(`[Cron resumen diario] ${err.message}`); }
    });

    // Resumen semanal — lunes a las 8 AM LOCALES de cada negocio.
    // Corre cada hora y filtra por día+hora local (antes era '0 8 * * 1' = 8 AM UTC,
    // o sea las 2 AM del domingo en México).
    cron.schedule('0 * * * *', async () => {
        const ahora = new Date();
        try {
            const owners = await User.findAll({ where: { role: 'owner', active: true }, attributes: ['id', 'settings'] });
            for (const owner of owners) {
                let prefs = {};
                try { prefs = JSON.parse(owner.settings || '{}'); } catch {}
                if (prefs.notif_resumen_semanal === false) continue;
                const tz = normalizarZona(prefs.tz);
                if (diaSemanaLocal(tz, ahora) !== 1 || horaLocal(tz, ahora) !== 8) continue;

                const haceSiete = inicioDiaLocal(tz, ahora, -7);
                const pedidos = await Order.findAll({
                    where: { business_id: owner.id, ...filtroVentaContable(), createdAt: { [Op.gte]: haceSiete } },
                    attributes: ['total']
                });
                const total = pedidos.reduce((s, p) => s + parseFloat(p.total || 0), 0);
                enviarNotificacion(owner.id, null, '📈 Resumen semanal',
                    `${pedidos.length} pedido(s) esta semana · $${total.toFixed(2)} en ventas`);
            }
        } catch (err) { logger.error(`[Cron resumen semanal] ${err.message}`); }
    });

    // Turno abierto demasiado tiempo — corre cada hora en el minuto 30
    cron.schedule('30 * * * *', async () => {
        try {
            const owners = await User.findAll({ where: { role: 'owner', active: true }, attributes: ['id', 'settings'] });
            for (const owner of owners) {
                let prefs = {};
                try { prefs = JSON.parse(owner.settings || '{}'); } catch {}
                if (prefs.notif_turno_largo === false) continue;
                const horas = parseFloat(prefs.notif_turno_largo_horas ?? 8);
                const limite = new Date(Date.now() - horas * 60 * 60 * 1000);
                const turnosLargos = await Turno.findAll({
                    where: { business_id: owner.id, estado: 'abierto', apertura: { [Op.lte]: limite } }
                });
                if (!turnosLargos.length) continue;

                // BLOQUE 14 — el horario AFINA este aviso, no lo sustituye. Un turno
                // largo dentro del horario es un olvido; el mismo turno con el
                // negocio ya cerrado es una caja abierta sin nadie, que es otra
                // cosa. Se distingue el mensaje, no la cadencia: el cron ya avisaba
                // cada hora y meterle una regla nueva aquí duplicaría los avisos.
                //
                // Sin horario configurado se comporta EXACTAMENTE como antes.
                const tzTurno = normalizarZona(prefs.tz);
                const horarioNegocio = normalizarHorario(prefs.horario_operacion).horario;
                const cerrado = horarioNegocio
                    ? !dentroDeHorario(horarioNegocio, tzTurno, new Date())
                    : false;

                for (const t of turnosLargos) {
                    const horasAbiertas = ((Date.now() - new Date(t.apertura).getTime()) / 3600000).toFixed(1);
                    if (cerrado) {
                        const ventana = ventanaDelDia(horarioNegocio, tzTurno, new Date());
                        enviarNotificacion(owner.id, null, '🌙 Caja abierta con el negocio cerrado',
                            `${t.cajero_nombre} lleva ${horasAbiertas}h con caja abierta · horario de hoy ${ventana}`);
                    } else {
                        enviarNotificacion(owner.id, null, '⏰ Turno abierto por mucho tiempo',
                            `${t.cajero_nombre} lleva ${horasAbiertas}h con caja abierta`);
                    }
                }
            }
        } catch (err) { logger.error(`[Cron turno largo] ${err.message}`); }
    });

    logger.info('Cron jobs de notificaciones iniciados');
}

module.exports = { iniciarCronJobs };
