const jwt = require('jsonwebtoken');
const { consumirTicket } = require('./sse-tickets');
const adaptador = require('./sse-adapter');

const SSE_TIMEOUT_MS = 55 * 60 * 1000; // 55 minutos

/**
 * Abre una conexión SSE: autentica, la registra en el adaptador y monta las
 * protecciones contra fugas de memoria.
 *
 * - Auth: Authorization header > ?ticket=UUID (un solo uso) > ?token=JWT (legacy)
 * - Tope de 50 conexiones POR CANAL y por negocio (igual que antes, ver
 *   `utils/sse-adapter.js`: un tope único compartido le habría quitado
 *   capacidad a los binarios ya instalados)
 * - Timeout máximo de 55 minutos por conexión
 * - Latido cada 25 s, comprobando `res.writableEnded`
 *
 * @param {string[]|string} canales  qué canales oye esta conexión
 * @param {Request} req
 * @param {Response} res
 * @param {{nombrado?: boolean}} opciones  `nombrado` = eventos con `event: <canal>`.
 *        Los cinco endpoints viejos lo dejan en false: el `onmessage` de un
 *        EventSource SOLO recibe los eventos sin nombre, así que ponerles nombre
 *        dejaría mudos a todos los equipos instalados.
 * @returns {boolean} true si la conexión se estableció
 */
function configurarSSE(canales, req, res, opciones = {}) {
    let businessId;

    const bearerToken = req.headers.authorization?.startsWith('Bearer ')
        && req.headers.authorization.slice(7);

    if (bearerToken) {
        try {
            const payload = jwt.verify(bearerToken, process.env.JWT_SECRET);
            businessId = payload.business_id;
        } catch {
            res.status(401).end();
            return false;
        }
    } else if (req.query.ticket) {
        businessId = consumirTicket(req.query.ticket);
        if (!businessId) { res.status(401).end(); return false; }
    } else if (req.query.token) {
        // Legacy: JWT en query param (compatibilidad con desktop/mobile existente)
        try {
            const payload = jwt.verify(req.query.token, process.env.JWT_SECRET);
            businessId = payload.business_id;
        } catch {
            res.status(401).end();
            return false;
        }
    } else {
        res.status(401).end();
        return false;
    }

    const biz = String(businessId);
    const canalesPedidos = adaptador.normalizarCanales(canales);

    // Ni un canal válido: es un cliente pidiendo algo que no existe. Se le dice,
    // en vez de dejarlo con una conexión abierta que no le va a llegar nunca.
    if (canalesPedidos.size === 0) {
        res.status(400).json({ error: 'Pide al menos un canal válido: ' + adaptador.CANALES.join(', ') });
        return false;
    }

    const lleno = adaptador.canalLleno(biz, canalesPedidos);
    if (lleno) {
        res.status(429).json({ error: 'Límite de conexiones SSE alcanzado' });
        return false;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const suscripcion = { res, canales: canalesPedidos, nombrado: !!opciones.nombrado };

    const cerrar = () => {
        clearInterval(heartbeat);
        clearTimeout(timeout);
        adaptador.quitar(biz, suscripcion);
    };

    const timeout = setTimeout(() => { try { res.end(); } catch { /* ya cerrada */ } }, SSE_TIMEOUT_MS);

    const heartbeat = setInterval(() => {
        if (res.writableEnded) { cerrar(); return; }
        try { res.write(': ping\n\n'); } catch { cerrar(); }
    }, 25000);

    adaptador.registrar(biz, suscripcion);

    req.on('close', cerrar);

    return true;
}

module.exports = { configurarSSE };
