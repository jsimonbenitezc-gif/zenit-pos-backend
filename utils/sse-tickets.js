const crypto = require('crypto');

// Map<ticketId, { businessId, creadoEn }>
const _tickets = new Map();
const TICKET_TTL_MS = 30 * 1000; // 30 segundos

function crearTicket(businessId) {
    const ticketId = crypto.randomUUID();
    _tickets.set(ticketId, { businessId: String(businessId), creadoEn: Date.now() });
    return ticketId;
}

function consumirTicket(ticketId) {
    const ticket = _tickets.get(ticketId);
    if (!ticket) return null;
    _tickets.delete(ticketId);
    if (Date.now() - ticket.creadoEn > TICKET_TTL_MS) return null;
    return ticket.businessId;
}

// Limpieza periódica de tickets expirados
setInterval(() => {
    const ahora = Date.now();
    for (const [id, ticket] of _tickets) {
        if (ahora - ticket.creadoEn > TICKET_TTL_MS) _tickets.delete(id);
    }
}, 60 * 1000).unref();

module.exports = { crearTicket, consumirTicket };
