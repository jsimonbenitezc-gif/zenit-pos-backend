// ============================================================================
// utils/sse-adapter.js — EL ÚNICO SITIO DONDE VIVEN LAS CONEXIONES EN VIVO
//
// Antes había CINCO Maps de conexiones, uno por archivo de rutas
// (`_ordersClients`, `_invClients`, `_settingsClients`, `_auditClients`,
// `_turnoClients`), cada uno con su propia copia de "recorre el Set y escribe".
// Eso obligaba a cada dispositivo a abrir CINCO conexiones HTTP para enterarse
// de todo, con sus cinco latidos cada 25 s y sus cinco sockets abiertos en un
// servidor que hoy es uno solo y pequeño.
//
// Ahora hay un solo registro y un solo `publicar()`. Encima de eso:
//
//   · `GET /api/events?channels=orders,inventory,…` → UNA conexión con eventos
//     NOMBRADOS (`event: orders`), que es lo que usan los clientes nuevos.
//   · Los cinco `/events` de siempre siguen existiendo y mandando eventos SIN
//     nombre, porque el `onmessage` de un EventSource solo recibe los que no
//     llevan nombre — y ahí están todos los binarios ya instalados. No se
//     tocan: son la compatibilidad, no deuda.
//
// 🔴 EL TOPE SE SIGUE CONTANDO POR CANAL, Y NO ES UN DETALLE. El guard viejo
// medía 50 conexiones sobre el mapa DE CADA RUTA, así que el límite real era de
// 50 por canal —o sea 50 dispositivos por negocio, no 10 como decía el §12—.
// Un tope único de 50 compartido habría dejado a los equipos ya instalados
// (5 conexiones cada uno) en DIEZ dispositivos: una regresión de capacidad
// disfrazada de mejora. Contando por canal, un cliente viejo ocupa exactamente
// lo mismo que ocupaba ayer, y uno nuevo ocupa un solo socket.
//
// ⚠️ ESTO VIVE EN MEMORIA, así que sigue siendo **UNA SOLA INSTANCIA**: con dos
// procesos en Render, un dispositivo conectado al A no recibe lo que dispara el
// B. Eso no lo arregla unificar los endpoints —lo arregla Redis—, pero ahora hay
// un único punto por el que pasar: `publicar()`. Ver §12 y §50.7.
// ============================================================================

const CANALES = ['orders', 'inventory', 'settings', 'audit', 'turnos'];
const MAX_CONEXIONES_POR_CANAL = 50;

// businessId (string) → Set<{ res, canales:Set<string>, nombrado:boolean }>
const _conexiones = new Map();

/** Los canales pedidos, saneados. Uno inventado se ignora sin tumbar nada. */
function normalizarCanales(pedidos) {
    const lista = Array.isArray(pedidos)
        ? pedidos
        : String(pedidos || '').split(',');
    const limpios = lista
        .map((c) => String(c || '').trim().toLowerCase())
        .filter((c) => CANALES.includes(c));
    return new Set(limpios);
}

function _deNegocio(biz) {
    if (!_conexiones.has(biz)) _conexiones.set(biz, new Set());
    return _conexiones.get(biz);
}

/**
 * ¿Cabe una conexión más? Se mira canal por canal, como se miraba antes.
 * Devuelve el canal que está lleno, o null si cabe.
 */
function canalLleno(biz, canales) {
    const subs = _conexiones.get(String(biz));
    if (!subs) return null;
    for (const canal of canales) {
        let n = 0;
        for (const sub of subs) if (sub.canales.has(canal)) n++;
        if (n >= MAX_CONEXIONES_POR_CANAL) return canal;
    }
    return null;
}

function registrar(biz, sub) {
    _deNegocio(String(biz)).add(sub);
}

function quitar(biz, sub) {
    const subs = _conexiones.get(String(biz));
    if (!subs) return;
    subs.delete(sub);
    if (subs.size === 0) _conexiones.delete(String(biz));
}

/**
 * EL ÚNICO SITIO QUE ESCRIBE A UNA CONEXIÓN EN VIVO.
 *
 * Al que pidió varios canales se le manda el evento CON NOMBRE, para que sepa
 * cuál de ellos se movió; al de un endpoint viejo, sin nombre, que es lo único
 * que su `onmessage` puede oír.
 */
function publicar(businessId, canal) {
    const subs = _conexiones.get(String(businessId));
    if (!subs || subs.size === 0) return 0;

    const conNombre = `event: ${canal}\ndata: {}\n\n`;
    const sinNombre = 'data: {}\n\n';
    let enviados = 0;

    for (const sub of [...subs]) {
        if (!sub.canales.has(canal)) continue;
        if (sub.res.writableEnded) { subs.delete(sub); continue; }
        try {
            sub.res.write(sub.nombrado ? conNombre : sinNombre);
            enviados++;
        } catch {
            subs.delete(sub);
        }
    }
    return enviados;
}

/** Cuántas conexiones vivas tiene un negocio (para pruebas y diagnóstico). */
function conteo(businessId, canal = null) {
    const subs = _conexiones.get(String(businessId));
    if (!subs) return 0;
    if (!canal) return subs.size;
    let n = 0;
    for (const sub of subs) if (sub.canales.has(canal)) n++;
    return n;
}

/** Solo para las pruebas: deja el registro vacío. */
function limpiarTodo() {
    for (const subs of _conexiones.values()) {
        for (const sub of subs) { try { sub.res.end(); } catch { /* ya cerrada */ } }
    }
    _conexiones.clear();
}

module.exports = {
    CANALES,
    MAX_CONEXIONES_POR_CANAL,
    normalizarCanales,
    canalLleno,
    registrar,
    quitar,
    publicar,
    conteo,
    limpiarTodo,
};
