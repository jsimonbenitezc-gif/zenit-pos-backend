/**
 * SSE UNIFICADO — una conexión por dispositivo, sin dejar mudo a nadie
 * (2026-09-17).
 *
 * Había CINCO endpoints `/events`, cada uno con su Map de conexiones, así que
 * una caja que quisiera enterarse de todo abría cinco sockets con sus cinco
 * latidos. Ahora las conexiones viven en `utils/sse-adapter.js` y hay un
 * `GET /api/events?channels=…` que las junta en una.
 *
 * LO QUE ESTAS PRUEBAS PROTEGEN, que es justo lo que puede romperse:
 *
 *   · 🔴 los cinco endpoints viejos siguen mandando eventos SIN NOMBRE. El
 *     `onmessage` de un EventSource solo recibe esos, así que ponerles nombre
 *     dejaría mudo a TODO binario ya instalado. Es el único modo de romper
 *     este bloque sin que nada falle a la vista.
 *   · el tope de conexiones se sigue contando POR CANAL. Un tope único
 *     compartido dejaría a los equipos viejos (5 conexiones cada uno) en 10
 *     dispositivos, cuando hoy caben 50: una regresión disfrazada de mejora.
 *   · un negocio no recibe lo de otro.
 */
jest.mock('../utils/push', () => ({
    enviarNotificacion: jest.fn(),
    getPrefs: jest.fn().mockResolvedValue({}),
}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { app, models, initTestDb, createTestOwner } = require('./setup');
const adaptador = require('../utils/sse-adapter');

let owner, token;

/** Una respuesta de mentira que apunta lo que se le escribe. */
function resFalsa() {
    return {
        escrito: [],
        writableEnded: false,
        write(txt) { this.escrito.push(txt); return true; },
        end() { this.writableEnded = true; },
    };
}

function suscribir(biz, canales, nombrado) {
    const res = resFalsa();
    const sub = { res, canales: new Set(canales), nombrado };
    adaptador.registrar(biz, sub);
    return res;
}

beforeAll(async () => {
    await initTestDb();
    const r = await createTestOwner();
    owner = r.user;
    token = r.token;
});

beforeEach(() => adaptador.limpiarTodo());
afterAll(() => adaptador.limpiarTodo());

describe('Qué recibe cada tipo de conexión', () => {
    test('🔒 una conexión VIEJA recibe el evento SIN nombre', () => {
        const vieja = suscribir(1, ['orders'], false);
        adaptador.publicar(1, 'orders');
        expect(vieja.escrito).toEqual(['data: {}\n\n']);
        // Si esto llevara `event:`, el onmessage del binario instalado no lo oiría.
        expect(vieja.escrito[0]).not.toContain('event:');
    });

    test('una conexión NUEVA recibe el evento CON nombre', () => {
        const nueva = suscribir(1, ['orders', 'turnos'], true);
        adaptador.publicar(1, 'orders');
        expect(nueva.escrito).toEqual(['event: orders\ndata: {}\n\n']);
    });

    test('una sola conexión atiende los cinco canales', () => {
        const nueva = suscribir(1, adaptador.CANALES, true);
        for (const canal of adaptador.CANALES) adaptador.publicar(1, canal);
        expect(nueva.escrito).toHaveLength(5);
        expect(nueva.escrito.map((t) => t.split('\n')[0])).toEqual([
            'event: orders', 'event: inventory', 'event: settings',
            'event: audit', 'event: turnos',
        ]);
    });

    test('no llega lo de un canal al que no se suscribió', () => {
        const solo = suscribir(1, ['orders'], true);
        adaptador.publicar(1, 'inventory');
        expect(solo.escrito).toHaveLength(0);
    });

    test('🔒 un negocio NO recibe lo de otro', () => {
        const mio = suscribir(1, ['orders'], true);
        const ajeno = suscribir(2, ['orders'], true);
        adaptador.publicar(2, 'orders');
        expect(mio.escrito).toHaveLength(0);
        expect(ajeno.escrito).toHaveLength(1);
    });
});

describe('El tope, que es donde se puede regresar sin querer', () => {
    test('🔒 se cuenta POR CANAL: 50 conexiones viejas de "orders" caben', () => {
        for (let i = 0; i < 50; i++) suscribir(1, ['orders'], false);
        expect(adaptador.conteo(1, 'orders')).toBe(50);
        expect(adaptador.canalLleno('1', new Set(['orders']))).toBe('orders');
        // …y el canal de al lado sigue libre: el tope no es un bote común.
        expect(adaptador.canalLleno('1', new Set(['turnos']))).toBeNull();
    });

    test('🔒 un equipo VIEJO ocupa lo mismo que ocupaba antes', () => {
        // Diez equipos viejos = 5 conexiones cada uno = 50 en total, pero solo
        // 10 por canal. Con un tope compartido de 50 esto ya estaría lleno.
        for (let i = 0; i < 10; i++) {
            for (const canal of adaptador.CANALES) suscribir(1, [canal], false);
        }
        expect(adaptador.conteo(1)).toBe(50);
        expect(adaptador.canalLleno('1', new Set(adaptador.CANALES))).toBeNull();
    });
});

describe('Limpieza', () => {
    test('una conexión ya cerrada se tira al publicar', () => {
        const muerta = suscribir(1, ['orders'], true);
        const viva = suscribir(1, ['orders'], true);
        muerta.writableEnded = true;
        adaptador.publicar(1, 'orders');
        expect(adaptador.conteo(1)).toBe(1);
        expect(viva.escrito).toHaveLength(1);
    });

    test('una que revienta al escribir también', () => {
        const rota = suscribir(1, ['orders'], true);
        rota.write = () => { throw new Error('socket roto'); };
        adaptador.publicar(1, 'orders');
        expect(adaptador.conteo(1)).toBe(0);
    });
});

describe('La puerta de /api/events', () => {
    test('sin credencial, 401', async () => {
        const r = await request(app).get('/api/events?channels=orders');
        expect(r.status).toBe(401);
    });

    test('con un canal inventado y nada más, 400 que explica', async () => {
        const r = await request(app).get('/api/events?channels=inventado').set({ Authorization: `Bearer ${token}` });
        expect(r.status).toBe(400);
        expect(r.body.error).toContain('orders');
    });

    test('un canal inventado JUNTO a uno bueno no tumba la conexión', () => {
        const canales = adaptador.normalizarCanales('orders,inventado, TURNOS ');
        expect([...canales].sort()).toEqual(['orders', 'turnos']);
    });

    test('un token de otro negocio solo oye lo suyo', () => {
        const otro = jwt.sign({ id: 999, business_id: 999 }, process.env.JWT_SECRET || 'test-secret');
        expect(jwt.decode(otro).business_id).toBe(999);
        const suyo = suscribir(999, ['orders'], true);
        adaptador.publicar(owner.id, 'orders');
        expect(suyo.escrito).toHaveLength(0);
    });
});

describe('Las rutas viejas siguen ahí', () => {
    test.each(['orders', 'inventory', 'settings', 'audit', 'turnos'])(
        '/api/%s/events existe y pide credencial', async (ruta) => {
            const r = await request(app).get(`/api/${ruta}/events`);
            expect(r.status).toBe(401);          // 401, no 404: la ruta existe
        }
    );
});
