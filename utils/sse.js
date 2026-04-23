const jwt = require('jsonwebtoken');
const { consumirTicket } = require('./sse-tickets');

const MAX_CONEXIONES_SSE = 50;
const SSE_TIMEOUT_MS = 55 * 60 * 1000; // 55 minutos

/**
 * Configura una conexión SSE con protecciones contra memory leaks.
 * - Auth: Authorization header > ?ticket=UUID (un solo uso) > ?token=JWT (legacy)
 * - Timeout máximo de 55 minutos por conexión
 * - Verificación de res.writableEnded en cada heartbeat
 * - Límite de 50 conexiones simultáneas por business_id
 *
 * @param {Map<string, Set<Response>>} clientsMap
 * @param {Request} req
 * @param {Response} res
 * @returns {boolean} true si la conexión se estableció
 */
function configurarSSE(clientsMap, req, res) {
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

    if (!clientsMap.has(biz)) clientsMap.set(biz, new Set());
    if (clientsMap.get(biz).size >= MAX_CONEXIONES_SSE) {
        res.status(429).json({ error: 'Límite de conexiones SSE alcanzado' });
        return false;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const timeout = setTimeout(() => res.end(), SSE_TIMEOUT_MS);

    const heartbeat = setInterval(() => {
        if (res.writableEnded) {
            clearInterval(heartbeat);
            clearTimeout(timeout);
            clientsMap.get(biz)?.delete(res);
            return;
        }
        try { res.write(': ping\n\n'); } catch {
            clearInterval(heartbeat);
            clearTimeout(timeout);
            clientsMap.get(biz)?.delete(res);
        }
    }, 25000);

    clientsMap.get(biz).add(res);

    req.on('close', () => {
        clearInterval(heartbeat);
        clearTimeout(timeout);
        clientsMap.get(biz)?.delete(res);
    });

    return true;
}

module.exports = { configurarSSE };
