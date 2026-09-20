// ============================================================================
// utils/menuFoto/lector.js — LEER UN MENÚ CON GEMINI (una foto, un PDF o texto)
//
// Lo único de la IDEA 1 que habla con una IA. Todo lo demás —qué es dudoso, qué
// categoría es cuál, qué se crea— lo decide `propuesta.js` y después el dueño.
//
// 🔴 EL LECTOR TRANSCRIBE; NO DECIDE. Igual que el transcriptor de notas de voz
// del bot (§53.4): si este archivo "arreglara" precios o inventara categorías,
// sería un segundo camino al catálogo que no pasa por el validador. Por eso el
// prompt insiste en lo mismo que la regla: un precio que no se lee es null, y la
// duda se DICE (`confianza`), no se resuelve.
//
// Por qué JSON con esquema (`responseSchema`) y no texto libre: un menú son
// decenas de renglones, y pedirle al modelo "devuélvelo en JSON" sin esquema es
// pedirle que de vez en cuando se invente un campo o se coma una coma. Con el
// esquema, Gemini no puede devolver otra forma.
//
// ⚠️ LA CLAVE VIVE AQUÍ, EN EL SERVIDOR, y es la razón de que la función pida
// cuenta (decidido con el dueño el 2026-09-18): una clave dentro de un .exe o de
// un APK es una clave publicada. Sin `GEMINI_API_KEY`, la ruta responde 503 y lo
// dice en voz alta; nada más del backend depende de ella.
// ============================================================================

const logger = require('../logger');

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/** ¿Vale la pena reintentar? Solo lo que pasa solo: saturación, límite y red. */
function esPasajero(r) {
    if (r.motivo === 'red' || r.motivo === 'tardo_demasiado') return true;
    return r.motivo === 'rechazado' && [429, 500, 502, 503, 504].includes(r.estado);
}

// Las pruebas no esperan 5 segundos reales entre reintentos.
let esperaDePrueba;
function fijarEsperaDePrueba(ms) { esperaDePrueba = ms; }

// ⚠️ El modelo se puede cambiar por variable, y DEBE elegirse MIDIENDO con fotos
// de menús reales, no por la ficha del proveedor (§52.5: la recomendación del
// proveedor no es una medición). El default es el que ya usa el bot en
// producción, que se sabe que existe y responde con esta clave. Aquí el costo es
// lo de menos —se paga una vez por negocio—: lo que importa es que lea bien.
const MODELO_POR_DEFECTO = 'gemini-3.1-flash-lite';

const INSTRUCCION = [
    'Eres un transcriptor de menús de restaurantes y tiendas en México.',
    'Te doy UNA página de un menú (foto, PDF o texto). Devuelve cada producto que aparezca, tal como está escrito.',
    '',
    'REGLAS, sin excepción:',
    '- Copia el nombre del producto tal cual. No lo traduzcas ni lo "mejores".',
    '- El precio es el número que se ve junto al producto, en pesos, SIN el signo.',
    '- Si NO puedes leer el precio con seguridad, pon precio: null. NUNCA adivines un precio ni copies el de otro renglón.',
    '- Si un producto tiene varios precios (por tamaño, "$120/$180", chico/grande), pon el primero en precio y todos en precios_alternos.',
    '- Si el precio viene con "desde", "2x1", "promoción", tachado u otra condición, escríbelo en nota.',
    '- categoria es el título de la sección donde aparece el producto ("Tacos", "Bebidas"). Si el menú no tiene secciones, null.',
    '- confianza: "alta" si leíste nombre y precio sin dudar; "media" si algo se ve mal; "baja" si casi no se lee.',
    '- Si en la página aparece el nombre, el teléfono o la dirección del negocio, ponlos en negocio. Si no, null.',
    '- No agregues productos que no estén en la página. No agregues explicaciones.',
].join('\n');

const ESQUEMA = {
    type: 'OBJECT',
    properties: {
        negocio: {
            type: 'OBJECT',
            nullable: true,
            properties: {
                nombre: { type: 'STRING', nullable: true },
                telefono: { type: 'STRING', nullable: true },
                direccion: { type: 'STRING', nullable: true },
            },
        },
        productos: {
            type: 'ARRAY',
            items: {
                type: 'OBJECT',
                properties: {
                    nombre: { type: 'STRING' },
                    precio: { type: 'NUMBER', nullable: true },
                    precios_alternos: { type: 'ARRAY', items: { type: 'NUMBER' } },
                    categoria: { type: 'STRING', nullable: true },
                    descripcion: { type: 'STRING', nullable: true },
                    nota: { type: 'STRING', nullable: true },
                    confianza: { type: 'STRING', enum: ['alta', 'media', 'baja'] },
                },
                required: ['nombre', 'confianza'],
            },
        },
    },
    required: ['productos'],
};

function crearLectorGoogle({
    apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
    modelo = process.env.MENU_MODELO || MODELO_POR_DEFECTO,
    timeoutMs = 90000,
} = {}) {
    if (!apiKey) return null;   // la ruta lo traduce a un 503 que se entiende

    return {
        proveedor: 'google',
        modelo,

        /**
         * @param {{mime?: string, datos?: Buffer, texto?: string}} entrada
         *        una foto o PDF (mime + datos) O un texto pegado
         * @returns {{ok: true, lectura, uso} | {ok: false, motivo, detalle?}}
         *          NUNCA lanza: un archivo que falla no puede tumbar a los otros.
         */
        async leer(entrada) {
            // ⚠️ Google responde 503 "high demand" de vez en cuando, y pasa solo
            // en segundos. Encontrado en la PRIMERA llamada de verdad que se le
            // hizo a este lector. Una importación que falla a la primera por algo
            // pasajero es la peor primera impresión posible del producto, así que
            // se reintenta dos veces con espera. Un 400 (esquema, clave) NO se
            // reintenta: repetirlo no lo arregla y solo gasta.
            const ESPERAS_MS = [1500, 4000];
            let r = await this._leerUnaVez(entrada);
            for (const espera of ESPERAS_MS) {
                if (r.ok || !esPasajero(r)) break;
                await new Promise((res) => setTimeout(res, esperaDePrueba ?? espera));
                r = await this._leerUnaVez(entrada);
            }
            return r;
        },

        async _leerUnaVez({ mime, datos, texto }) {
            const parte = texto
                ? { text: 'Este es el menú, copiado como texto:\n\n' + texto }
                : { inline_data: { mime_type: mime, data: Buffer.from(datos).toString('base64') } };

            const control = new AbortController();
            const reloj = setTimeout(() => control.abort(), timeoutMs);
            let r;
            try {
                r = await fetch(`${BASE}/${encodeURIComponent(modelo)}:generateContent`, {
                    method: 'POST',
                    signal: control.signal,
                    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
                    body: JSON.stringify({
                        systemInstruction: { parts: [{ text: INSTRUCCION }] },
                        contents: [{ role: 'user', parts: [parte] }],
                        generationConfig: {
                            temperature: 0,
                            responseMimeType: 'application/json',
                            responseSchema: ESQUEMA,
                        },
                    }),
                });
            } catch (e) {
                clearTimeout(reloj);
                return { ok: false, motivo: e.name === 'AbortError' ? 'tardo_demasiado' : 'red', detalle: e.message };
            }
            clearTimeout(reloj);

            if (!r.ok) {
                const detalle = await r.text().catch(() => '');
                return { ok: false, motivo: 'rechazado', estado: r.status, detalle: detalle.slice(0, 300) };
            }

            const json = await r.json().catch(() => null);
            const crudo = (json?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
            let lectura;
            try {
                lectura = JSON.parse(crudo);
            } catch {
                return { ok: false, motivo: 'respuesta_ilegible', detalle: crudo.slice(0, 200) };
            }
            if (!lectura || !Array.isArray(lectura.productos)) {
                return { ok: false, motivo: 'respuesta_ilegible', detalle: 'sin lista de productos' };
            }

            const uso = json?.usageMetadata || {};
            return {
                ok: true,
                lectura,
                uso: {
                    tokens_entrada: uso.promptTokenCount || 0,
                    tokens_salida: uso.candidatesTokenCount || 0,
                    modelo,
                },
            };
        },
    };
}

// ── Para las pruebas: un lector que no sale a internet ──────────────────────
let _lectorDePrueba;

/** Solo las pruebas llaman a esto. `null` = "como si no hubiera clave". */
function fijarLectorDePrueba(lector) { _lectorDePrueba = lector; }

// 🔴 EL MISMO LECTOR DE MENTIRA, PERO PARA UN SERVIDOR QUE CORRE APARTE.
//
// `fijarLectorDePrueba` solo sirve dentro del proceso, así que no alcanza para el
// banco de la interfaz del desktop (§46): ése arranca `node server.js` como otro
// proceso y lo usa a clics. Sin esto, la única forma de recorrer la pantalla de
// importar menú sería llamando a Gemini de verdad — dinero por corrida y una
// respuesta distinta cada vez, que es lo contrario de una prueba.
//
// ⚠️ Es una puerta trasera, y por eso lleva cerrojo: en producción se IGNORA y se
// grita. Un lector falso en producción le daría al negocio un menú inventado, que
// es de los pocos errores de este sistema que el usuario no podría notar.
function _lectorDeBanco() {
    const crudo = process.env.MENU_LECTOR_FALSO;
    if (!crudo) return null;
    if (process.env.NODE_ENV === 'production') {
        logger.error('MENU_LECTOR_FALSO está puesta en PRODUCCIÓN: se ignora. Quítala.');
        return null;
    }
    let lectura;
    try { lectura = JSON.parse(crudo); } catch { return null; }
    if (!lectura || !Array.isArray(lectura.productos)) return null;
    logger.warn('menú desde foto: usando el LECTOR FALSO (banco de pruebas), no Gemini');
    return {
        async leer() {
            return { ok: true, lectura, uso: { tokens_entrada: 0, tokens_salida: 0, modelo: 'falso' } };
        },
    };
}

function obtenerLector() {
    if (_lectorDePrueba !== undefined) return _lectorDePrueba;
    const falso = _lectorDeBanco();
    if (falso) return falso;
    return crearLectorGoogle();
}

module.exports = { crearLectorGoogle, obtenerLector, fijarLectorDePrueba, fijarEsperaDePrueba, esPasajero, INSTRUCCION, ESQUEMA, MODELO_POR_DEFECTO };
