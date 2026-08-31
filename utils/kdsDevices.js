/**
 * utils/kdsDevices.js — LA ÚNICA fórmula de confianza de las pantallas de cocina
 * (BLOQUE 13 del PLAN_ARREGLOS_V5).
 *
 * Todo lo que decide si un dispositivo de cocina puede leer algo pasa por aquí:
 * el middleware de auth, las rutas de gestión y los tests. Si cada sitio
 * decidiera por su cuenta qué secreto vale, un revocado seguiría entrando por
 * alguna puerta — que es exactamente lo que pasaba con la lista de IPs del
 * desktop, donde un equipo "eliminado" volvía a entrar con otra IP.
 *
 * LAS TRES REGLAS DEL BLOQUE:
 *
 * 1. **La identidad es un SECRETO, nunca una IP ni un QR.** La tablet genera su
 *    secreto y lo guarda en `localStorage`; aquí solo vive el SHA256 (mismo
 *    criterio que los refresh tokens, §25). Las IPs las reparte el router y
 *    rotan; un QR fotografiado sería una llave que se puede copiar.
 *
 * 2. **Nada caduca; todo se revoca.** Un pase con vencimiento molesta (re-escanear
 *    el QR en hora pico) y protege poco (la tablet perdida sigue sirviendo hasta
 *    que venza). Aquí el acceso se corta en el momento, y para eso el estado se
 *    consulta en CADA petición — con caché de 30 s que se invalida al aprobar o
 *    revocar, así que el corte es inmediato de verdad, no "en menos de medio
 *    minuto".
 *
 * 3. **El código de emparejamiento no da acceso: da derecho a PEDIRLO.** Vive 10
 *    minutos, se consume una sola vez y lo único que consigue es dejar el
 *    dispositivo en `pendiente`. Sin el PIN del negocio no lee ni un pedido.
 */
const crypto = require('crypto');
const { KdsDevice } = require('../models');

// ── Token de dispositivo ─────────────────────────────────────────────────────
// Prefijo propio para que `authenticate` lo distinga de un JWT ANTES de intentar
// verificarlo: son dos credenciales con formatos distintos, y mezclarlas es como
// nacieron los tokens del KDS que servían de llave maestra (§19.13).
const PREFIJO_TOKEN = 'zkds_';

const TTL_CACHE_MS = 30 * 1000;
const MAX_ENTRADAS_CACHE = 500;
// `ultimo_acceso` es informativo (el dueño mira "hace 3 min" para reconocer un
// equipo). Escribirlo en cada petición sería un UPDATE cada pocos segundos por
// pantalla; con 5 minutos la lista sigue siendo útil y la base no se entera.
const INTERVALO_ULTIMO_ACCESO_MS = 5 * 60 * 1000;

const _cacheDispositivos = new Map();   // secret_hash → { ...datos, expira }
const _ultimoAccesoEscrito = new Map(); // deviceId → timestamp

function esTokenDeDispositivo(token) {
    return typeof token === 'string' && token.startsWith(PREFIJO_TOKEN);
}

function tokenDeSecreto(secreto) {
    return PREFIJO_TOKEN + secreto;
}

function secretoDeToken(token) {
    return String(token).slice(PREFIJO_TOKEN.length);
}

function hashSecreto(secreto) {
    return crypto.createHash('sha256').update(String(secreto)).digest('hex');
}

/**
 * ¿Este secreto tiene forma de secreto? Lo genera el cliente (un
 * `crypto.randomUUID()` del navegador), así que el servidor no puede confiar en
 * su calidad, pero sí puede rechazar lo que claramente no sirve: un secreto de
 * tres caracteres sería adivinable a fuerza bruta.
 */
function secretoValido(secreto) {
    if (typeof secreto !== 'string') return false;
    const s = secreto.trim();
    return s.length >= 16 && s.length <= 200 && /^[A-Za-z0-9._:-]+$/.test(s);
}

function _limpiarCacheExpirado() {
    const ahora = Date.now();
    for (const [clave, valor] of _cacheDispositivos) {
        if (valor.expira <= ahora) _cacheDispositivos.delete(clave);
    }
}

/**
 * Resuelve el dispositivo dueño de un secreto.
 * Lanza si la BD falla: un error de red NO se cachea, para no dejar pegada
 * durante 30 s una respuesta equivocada (mismo criterio que el caché de usuarios
 * de `middleware/auth.js`, §23).
 *
 * @returns {Promise<{existe:boolean, id?:number, business_id?:number, branch_id?:number|null, estado?:string}>}
 */
async function resolverDispositivo(secreto) {
    const hash = hashSecreto(secreto);
    const guardado = _cacheDispositivos.get(hash);
    if (guardado && guardado.expira > Date.now()) return guardado;

    const fila = await KdsDevice.findOne({
        where: { secret_hash: hash },
        attributes: ['id', 'business_id', 'branch_id', 'estado']
    });

    const datos = fila
        ? {
            existe: true,
            id: fila.id,
            business_id: fila.business_id,
            branch_id: fila.branch_id ?? null,
            estado: fila.estado
        }
        : { existe: false };

    if (_cacheDispositivos.size >= MAX_ENTRADAS_CACHE) _limpiarCacheExpirado();
    _cacheDispositivos.set(hash, { ...datos, expira: Date.now() + TTL_CACHE_MS });
    return datos;
}

/**
 * Borra del caché a un dispositivo. LLAMAR SIEMPRE que cambie su `estado`.
 * Sin esto, "revocar corta el acceso al instante" sería mentira: la tablet
 * seguiría leyendo la cocina hasta 30 segundos más.
 */
function invalidarDispositivo(secretHash) {
    if (secretHash) _cacheDispositivos.delete(secretHash);
}

/** Vacía el caché completo (tests, o un reinicio de confianza). */
function limpiarCacheDispositivos() {
    _cacheDispositivos.clear();
    _ultimoAccesoEscrito.clear();
}

/**
 * Anota que el dispositivo sigue vivo. No se espera (`await`) a propósito: es un
 * dato informativo y no tiene por qué retrasar la cola de cocina, ni tumbarla si
 * la escritura falla.
 */
function tocarUltimoAcceso(deviceId) {
    const ahora = Date.now();
    const ultimo = _ultimoAccesoEscrito.get(deviceId) || 0;
    if (ahora - ultimo < INTERVALO_ULTIMO_ACCESO_MS) return;
    _ultimoAccesoEscrito.set(deviceId, ahora);
    KdsDevice.update({ ultimo_acceso: new Date() }, { where: { id: deviceId } })
        .catch(() => { /* informativo: que falle no puede afectar al servicio */ });
}

// ── Códigos de emparejamiento ────────────────────────────────────────────────
// En memoria, como los tickets de SSE (`utils/sse-tickets.js`): un reinicio del
// servidor los pierde y el dueño genera otro. Perder un código no rompe nada;
// guardarlos en la base sería una tabla nueva para un dato que vive 10 minutos.

// Sin I, O, 0 ni 1: el código se puede acabar tecleando a mano si la cámara de la
// tablet falla, y "0 u O" es justo la duda que hace fallar ese intento.
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LARGO_CODIGO = 8;
const TTL_CODIGO_MS = 10 * 60 * 1000;

const _codigos = new Map(); // codigo → { businessId, branchId, creadoEn }

function _generarCodigo() {
    const bytes = crypto.randomBytes(LARGO_CODIGO);
    let out = '';
    for (let i = 0; i < LARGO_CODIGO; i++) out += ALFABETO[bytes[i] % ALFABETO.length];
    return out;
}

/**
 * Crea un código de emparejamiento de un solo uso.
 * @returns {{codigo:string, expira_en_segundos:number}}
 */
function crearCodigoEmparejamiento({ businessId, branchId = null }) {
    let codigo = _generarCodigo();
    while (_codigos.has(codigo)) codigo = _generarCodigo();
    _codigos.set(codigo, {
        businessId,
        branchId: branchId ?? null,
        creadoEn: Date.now()
    });
    return { codigo, expira_en_segundos: Math.floor(TTL_CODIGO_MS / 1000) };
}

/**
 * Consume un código. Devuelve null si no existe, si ya se usó o si venció —
 * nunca se distingue cuál de los tres, para no ayudar a quien esté probando
 * códigos a ciegas.
 */
function consumirCodigoEmparejamiento(codigo) {
    if (typeof codigo !== 'string') return null;
    const clave = codigo.trim().toUpperCase();
    const datos = _codigos.get(clave);
    if (!datos) return null;
    _codigos.delete(clave);
    if (Date.now() - datos.creadoEn > TTL_CODIGO_MS) return null;
    return { businessId: datos.businessId, branchId: datos.branchId };
}

/** Solo para tests: vacía los códigos vivos. */
function limpiarCodigosEmparejamiento() {
    _codigos.clear();
}

setInterval(() => {
    const ahora = Date.now();
    for (const [codigo, datos] of _codigos) {
        if (ahora - datos.creadoEn > TTL_CODIGO_MS) _codigos.delete(codigo);
    }
}, 60 * 1000).unref();

module.exports = {
    PREFIJO_TOKEN,
    esTokenDeDispositivo,
    tokenDeSecreto,
    secretoDeToken,
    hashSecreto,
    secretoValido,
    resolverDispositivo,
    invalidarDispositivo,
    limpiarCacheDispositivos,
    tocarUltimoAcceso,
    crearCodigoEmparejamiento,
    consumirCodigoEmparejamiento,
    limpiarCodigosEmparejamiento,
};
