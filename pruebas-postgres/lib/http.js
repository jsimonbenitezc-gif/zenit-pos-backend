// ============================================================================
// pruebas-postgres/lib/http.js — cliente HTTP mínimo
//
// A propósito NO se usa supertest. El BLOQUE 15 existe porque las pruebas que
// importan los módulos del backend no vieron un 500 que solo ocurría en
// producción: hay que atravesar el socket de verdad para ejercitar el
// middleware, el rate limit, la serialización JSON y el dialecto real.
// ============================================================================

const http = require('http');

class ClienteApi {
    constructor(baseUrl, contador) {
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.token = null;
        // El contador se COMPARTE entre el cliente raíz y sus copias con token.
        // Si cada copia llevara el suyo, el reporte final diría "1 petición"
        // mientras el banco hizo cien: casi todo el recorrido va con el token
        // del negocio, no con el cliente raíz.
        this._contador = contador || { n: 0 };
    }

    get peticiones() { return this._contador.n; }

    /** Copia del cliente con otro token (para actuar como otro usuario). */
    como(token) {
        const otro = new ClienteApi(this.baseUrl, this._contador);
        otro.token = token;
        return otro;
    }

    /**
     * Reintenta cuando el servidor responde 429.
     *
     * El banco comprime en tres segundos el trabajo de administración de varios
     * días (dar de alta cuatro negocios enteros con su catálogo), así que choca
     * con límites que ningún negocio real roza: `POST /api/products` admite 30
     * por minuto y por IP, y aquí todo sale de 127.0.0.1.
     *
     * La salida NO es quitar los limitadores del camino —el BLOQUE 15 quiere
     * justamente que el banco atraviese el middleware real—, sino esperar lo que
     * el propio servidor dice que hay que esperar (`RateLimit-Reset`) y volver a
     * intentarlo. En una corrida normal esto no llega a dispararse; existe para
     * que agregar un recorrido más no rompa el banco por un motivo que no tiene
     * nada que ver con lo que se está probando.
     */
    async _esperarPorLimite(res, intento) {
        const reset = parseInt(res.headers['ratelimit-reset'] || res.headers['retry-after'] || '', 10);
        const segundos = Number.isFinite(reset) && reset > 0 ? Math.min(reset, 70) : 5 * intento;
        console.log('      … el servidor pidió calma (429); esperando ' + segundos + 's y reintentando');
        await new Promise((r) => setTimeout(r, (segundos + 1) * 1000));
    }

    async peticion(metodo, ruta, cuerpo, opciones = {}) {
        const MAX_REINTENTOS = 2;
        for (let intento = 1; intento <= MAX_REINTENTOS; intento++) {
            const res = await this._peticionUnaVez(metodo, ruta, cuerpo, opciones);
            if (res.status !== 429 || intento === MAX_REINTENTOS || opciones.sinReintento) return res;
            await this._esperarPorLimite(res, intento);
        }
    }

    async _peticionUnaVez(metodo, ruta, cuerpo, opciones = {}) {
        const url = new URL(this.baseUrl + ruta);
        const datos = cuerpo === undefined ? null : JSON.stringify(cuerpo);

        const cabeceras = { Accept: 'application/json', ...(opciones.headers || {}) };
        if (datos) {
            cabeceras['Content-Type'] = 'application/json';
            cabeceras['Content-Length'] = Buffer.byteLength(datos);
        }
        const token = opciones.token !== undefined ? opciones.token : this.token;
        if (token) cabeceras.Authorization = `Bearer ${token}`;

        this._contador.n++;

        return new Promise((resolver, rechazar) => {
            const req = http.request(
                {
                    hostname: url.hostname,
                    port: url.port,
                    path: url.pathname + url.search,
                    method: metodo,
                    headers: cabeceras,
                    timeout: opciones.timeout || 30000,
                },
                (res) => {
                    let bruto = '';
                    res.setEncoding('utf8');
                    res.on('data', (c) => { bruto += c; });
                    res.on('end', () => {
                        let cuerpoRes = bruto;
                        try { cuerpoRes = bruto ? JSON.parse(bruto) : null; } catch { /* HTML o texto */ }
                        resolver({ status: res.statusCode, body: cuerpoRes, crudo: bruto, headers: res.headers });
                    });
                }
            );
            req.on('timeout', () => { req.destroy(new Error(`Timeout en ${metodo} ${ruta}`)); });
            req.on('error', rechazar);
            if (datos) req.write(datos);
            req.end();
        });
    }

    get(ruta, opciones)          { return this.peticion('GET', ruta, undefined, opciones); }
    post(ruta, cuerpo, opciones) { return this.peticion('POST', ruta, cuerpo ?? {}, opciones); }
    put(ruta, cuerpo, opciones)  { return this.peticion('PUT', ruta, cuerpo ?? {}, opciones); }
    del(ruta, cuerpo, opciones)  { return this.peticion('DELETE', ruta, cuerpo ?? {}, opciones); }

    /**
     * Igual que los anteriores pero EXIGE un status concreto.
     *
     * ⚠️ Esto es la mitad del valor del banco. Un recorrido que ignora el status
     * "pasa" mientras la ruta devuelve 500 — que es exactamente lo que pasó
     * durante un mes con el cobro de mesas (CLAUDE.md §19.25). Aquí un 500
     * detiene el recorrido con el cuerpo del error a la vista.
     */
    async exigir(metodo, ruta, cuerpo, esperado = [200, 201], opciones) {
        const lista = Array.isArray(esperado) ? esperado : [esperado];
        const res = await this.peticion(metodo, ruta, cuerpo, opciones);
        if (!lista.includes(res.status)) {
            const detalle = typeof res.body === 'object' ? JSON.stringify(res.body) : String(res.crudo).slice(0, 400);
            throw new Error(
                `${metodo} ${ruta} devolvió ${res.status} (se esperaba ${lista.join(' o ')}). Respuesta: ${detalle}`
            );
        }
        return res.body;
    }
}

module.exports = { ClienteApi };
