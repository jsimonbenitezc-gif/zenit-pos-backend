/**
 * utils/rateLimitLogin.js — política de rate limit del login (Bloque 6 del PLAN_ARREGLOS_V5).
 *
 * El problema que resuelve: la cuenta era **10 intentos / 15 min por IP**, y un
 * negocio con varias cajas sale a internet con UNA sola IP pública (NAT). Un
 * local con 5 equipos abriendo la mañana, un empleado que escribe mal la
 * contraseña un par de veces y el POS entero se queda fuera 15 minutos — el
 * sistema castigando al cliente por usarlo con normalidad.
 *
 * La política nueva ataca las tres partes del problema:
 *  1. **La cuenta es por IP + usuario.** El cajero que se equivoca gasta SU cupo,
 *     no el del negocio. (Un atacante que rota usuarios contra una IP tampoco gana
 *     nada: probar muchos usuarios distintos con pocas contraseñas cada uno no es
 *     fuerza bruta viable contra una contraseña concreta.)
 *  2. **Los logins exitosos no cuentan** (`skipSuccessfulRequests`). Abrir turno en
 *     ocho equipos no consume presupuesto: solo los FALLOS acercan al bloqueo.
 *  3. **30 fallos en 15 minutos** en vez de 10. Sigue siendo ridículo para adivinar
 *     una contraseña y ya no alcanza a un humano que se equivoca.
 *
 * ⚠️ `ipKeyGenerator` es obligatorio al construir claves propias: normaliza IPv6 a
 * su /56 (si no, un atacante con un rango IPv6 tendría una IP nueva por intento).
 */
const { ipKeyGenerator } = require('express-rate-limit');

const LOGIN_MAX_INTENTOS = 30;
const LOGIN_VENTANA_MS = 15 * 60 * 1000; // 15 minutos

/** Clave del limitador: IP normalizada + usuario que se intenta abrir. */
function claveLoginPorIpYUsuario(req) {
    const usuario = String(req.body?.username ?? req.body?.email ?? '').trim().toLowerCase();
    return `${ipKeyGenerator(req.ip || '')}:${usuario}`;
}

module.exports = { claveLoginPorIpYUsuario, LOGIN_MAX_INTENTOS, LOGIN_VENTANA_MS };
