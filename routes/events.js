// ============================================================================
// routes/events.js — UNA SOLA CONEXIÓN EN VIVO POR DISPOSITIVO
//
//     GET /api/events?channels=orders,inventory,settings,audit,turnos
//
// Antes, para enterarse de todo, cada caja abría CINCO conexiones HTTP: una por
// `/api/<lo-que-sea>/events`. Cinco sockets, cinco latidos cada 25 s y cinco
// entradas en cinco Maps distintos, por dispositivo, en un servidor que hoy es
// uno solo. Aquí se pide lo que interese y llega por una sola.
//
// 🔴 LOS EVENTOS VAN CON NOMBRE, y de ahí sale todo lo demás:
//
//     event: orders
//     data: {}
//
// El cliente escucha con `addEventListener('orders', …)` en vez de `onmessage`.
// ⚠️ Y eso es justo lo que NO pueden hacer los cinco endpoints viejos: el
// `onmessage` de un EventSource **solo recibe los eventos SIN nombre**, así que
// ponerles nombre dejaría mudo a todo binario ya instalado. Por eso siguen
// existiendo tal cual, mandando eventos sin nombre. No son deuda: son la
// compatibilidad.
//
// Autenticación, tope de conexiones, latido y timeout son EXACTAMENTE los de
// siempre: esto no es un camino nuevo con reglas propias, es la misma puerta
// (`utils/sse.js`) pidiendo varios canales a la vez.
// ============================================================================

const express = require('express');
const router = express.Router();

const { configurarSSE } = require('../utils/sse');
const { CANALES } = require('../utils/sse-adapter');

// GET /api/events?channels=orders,inventory
//
// Sin `channels` se suscribe a TODOS, que es lo que quiere una caja. Pedir solo
// lo que se mira es una optimización del cliente, no una obligación.
router.get('/', (req, res) => {
    const pedidos = req.query.channels || req.query.canales || CANALES.join(',');
    configurarSSE(pedidos, req, res, { nombrado: true });
});

module.exports = router;
