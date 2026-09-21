/**
 * EL MENÚ DESDE UNA FOTO — IDEA 1, la parte del servidor (2026-09-18).
 *
 * El negocio le saca una foto a su menú y Zenit da de alta sus productos. La
 * regla que lo hace seguro es la del bot (§52.1): EL MODELO PROPONE, EL CÓDIGO
 * Y EL USUARIO DECIDEN. Lo que se prueba aquí es justo eso:
 *
 *   · `leer` NO escribe nada en el catálogo: devuelve una propuesta;
 *   · un precio que no se leyó es NULL, nunca 0 ni el del renglón de al lado;
 *   · lo dudoso se MARCA y sale PRIMERO — incluido el `$2450` que era `$24.50`;
 *   · las categorías se MAPEAN a las que ya hay ("bebidas" = "Bebidas");
 *   · dos páginas que repiten el refresco no lo duplican;
 *   · `confirmar` vuelve a validar TODO (el cliente pudo haber tocado la
 *     propuesta) y crea en UNA transacción, sin duplicar lo que ya existe.
 *
 * El lector de Gemini se sustituye por uno de mentira: aquí se prueba el CÓDIGO,
 * que es lo que decide. Cuánto lee bien el modelo se mide aparte, con fotos de
 * menús reales (§52.5: la ficha del proveedor no es una medición).
 */
jest.mock('../utils/push', () => ({
    enviarNotificacion: jest.fn(),
    getPrefs: jest.fn().mockResolvedValue({}),
}));

const request = require('supertest');
const { app, models, initTestDb, createTestOwner } = require('./setup');
const { fijarLectorDePrueba, crearLectorGoogle, fijarEsperaDePrueba } = require('../utils/menuFoto/lector');
const { armarPropuesta, normalizarPrecio, validarConfirmacion, nombreDeCategoria } = require('../utils/menuFoto/propuesta');
const rutas = require('../routes/importarMenu');

let owner, token;
const auth = () => ({ Authorization: `Bearer ${token}` });

// Un JPEG de mentira: el lector de prueba no lo mira, pero la ruta sí revisa
// que llegue algo y que pese lo que tiene que pesar.
const FOTO = { mime: 'image/jpeg', datos: Buffer.from('foto de mentira').toString('base64') };

/** Un lector que devuelve, por orden, lo que se le diga. */
function lectorQueDevuelve(...lecturas) {
    let i = 0;
    const llamadas = [];
    return {
        llamadas,
        async leer(entrada) {
            llamadas.push(entrada);
            const r = lecturas[Math.min(i++, lecturas.length - 1)];
            return typeof r === 'function' ? r(entrada) : r;
        },
    };
}
const ok = (productos, negocio = null) => ({ ok: true, lectura: { productos, negocio }, uso: {} });
const producto = (nombre, precio, extra = {}) => ({ nombre, precio, confianza: 'alta', ...extra });

beforeAll(async () => {
    await initTestDb();
    const r = await createTestOwner();
    owner = r.user;
    token = r.token;
});

beforeEach(async () => {
    rutas._reiniciarCupos();
    await models.Product.destroy({ where: {} });
    await models.Category.destroy({ where: {} });
});

afterAll(() => fijarLectorDePrueba(undefined));

// ═══════════════════════════════════════════════════════════════════════════
describe('El validador: el código decide', () => {
    test('🔒 un precio que no se leyó es NULL, nunca 0', () => {
        const p = armarPropuesta([{ productos: [producto('Taco de lengua', null)] }]);
        expect(p.productos[0].precio).toBeNull();
        expect(p.productos[0].motivos).toContain('sin_precio');
        // Sin precio no se puede crear: nace DESMARCADO.
        expect(p.productos[0].incluir).toBe(false);
    });

    test('normalizarPrecio entiende lo que el modelo devuelve a veces como texto', () => {
        expect(normalizarPrecio('$24.50')).toBe(24.5);
        expect(normalizarPrecio('24,50')).toBe(24.5);
        expect(normalizarPrecio('1,250.00')).toBe(1250);
        expect(normalizarPrecio(0)).toBeNull();
        expect(normalizarPrecio(-5)).toBeNull();
        expect(normalizarPrecio('gratis')).toBeNull();
        expect(normalizarPrecio(9999999)).toBeNull();
    });

    test('🔴 "1,250" son MIL doscientos cincuenta, no $1.25', () => {
        // Encontrado el 2026-09-21 escribiendo el importador del bot, donde el dueño
        // TECLEA el precio ("3 1,250"). La versión anterior leía la coma siempre como
        // decimal sin punto, y un paquete de $1,250 se habría dado de alta a $1.25.
        expect(normalizarPrecio('1,250')).toBe(1250);
        expect(normalizarPrecio('$1,250')).toBe(1250);
        expect(normalizarPrecio('24,50')).toBe(24.5);      // la coma decimal sigue siendo decimal
        expect(normalizarPrecio('1,5')).toBe(1.5);
        expect(normalizarPrecio('1.250,50')).toBe(1250.5); // el último separador es el decimal
        expect(normalizarPrecio('1,250.50')).toBe(1250.5);
        expect(normalizarPrecio('24.50')).toBe(24.5);      // un solo punto es decimal (México)
    });

    test('🔒 el $2450 que era $24.50 se MARCA — y no se "corrige" solo', () => {
        const p = armarPropuesta([{ productos: [
            producto('Pastor', 22), producto('Suadero', 24.5), producto('Campechano', 26),
            producto('Gringa', 68.5), producto('Horchata', 45),
            producto('Taco de tripa', 2450),   // ← el punto que se comió el OCR
        ] }]);
        const tripa = p.productos.find((x) => x.nombre === 'Taco de tripa');
        expect(tripa.motivos).toContain('precio_raro');
        expect(tripa.precio).toBe(2450);          // se enseña lo leído; decide el dueño
        expect(tripa.mediana_del_menu).toBeGreaterThan(0);
        // Y sale PRIMERO: lo que hay que mirar no puede quedar en el renglón 47.
        expect(p.productos[0].nombre).toBe('Taco de tripa');
    });

    test('con pocos precios no se compara contra la mediana (no dice nada)', () => {
        const p = armarPropuesta([{ productos: [producto('Charola', 900), producto('Taco', 20)] }]);
        expect(p.productos.every((x) => !x.motivos.includes('precio_raro'))).toBe(true);
    });

    test('varios precios, una nota o una lectura insegura: se marca, no se elige', () => {
        const p = armarPropuesta([{ productos: [
            producto('Pizza', 120, { precios_alternos: [120, 180] }),
            producto('Alitas', 50, { nota: 'desde' }),
            producto('Torta', 55, { confianza: 'media' }),
        ] }]);
        const por = (n) => p.productos.find((x) => x.nombre === n);
        expect(por('Pizza').motivos).toContain('varios_precios');
        expect(por('Pizza').precios_alternos).toEqual([180]);
        expect(por('Alitas').motivos).toContain('nota');
        expect(por('Torta').motivos).toContain('lectura_dudosa');
        // Dudosos, pero con precio: nacen MARCADOS. El dueño tiene que verlos, no buscarlos.
        expect(p.productos.every((x) => x.incluir)).toBe(true);
        expect(p.resumen.dudosos).toBe(3);
    });

    test('🔒 dos páginas que repiten el refresco NO lo duplican', () => {
        const p = armarPropuesta([
            { productos: [producto('Refresco 600 ml', 27.5)] },
            { productos: [producto('refresco 600 ML ', 27.5), producto('Agua', 20)] },
        ]);
        expect(p.productos.map((x) => x.nombre).sort()).toEqual(['Agua', 'Refresco 600 ml']);
    });

    test('…y si la otra página trae OTRO precio, se dice', () => {
        const p = armarPropuesta([
            { productos: [producto('Refresco', 27.5)] },
            { productos: [producto('Refresco', 30)] },
        ]);
        expect(p.productos[0].motivos).toContain('duplicado_con_otro_precio');
        expect(p.productos[0].otro_precio_leido).toBe(30);
    });

    test('🔒 las categorías se MAPEAN a las que ya hay, ignorando mayúsculas y acentos', () => {
        const p = armarPropuesta(
            [{ productos: [
                producto('Horchata', 45, { categoria: 'BEBÍDAS' }),
                producto('Jamaica', 45, { categoria: 'bebidas' }),
                producto('Postre', 40, { categoria: 'Postres' }),
                producto('Flan', 40, { categoria: 'postres ' }),
            ] }],
            { categoriasExistentes: [{ id: 7, name: 'Bebidas' }] }
        );
        const por = (n) => p.productos.find((x) => x.nombre === n);
        expect(por('Horchata').categoria_id).toBe(7);
        expect(por('Jamaica').categoria_id).toBe(7);
        // Una sola categoría nueva, no dos, aunque venga escrita distinto.
        expect(p.categorias_nuevas).toEqual(['Postres']);
        expect(por('Flan').categoria_nueva).toBe('Postres');
    });

    test('lo que ya está en el catálogo nace desmarcado', () => {
        const p = armarPropuesta(
            [{ productos: [producto('Taco al pastor', 22)] }],
            { productosExistentes: [{ name: 'taco al PASTOR' }] }
        );
        expect(p.productos[0].motivos).toContain('ya_existe');
        expect(p.productos[0].incluir).toBe(false);
    });

    test('una categoría en MAYÚSCULAS se pasa a tipo oración; una sigla corta no', () => {
        // Encontrado en la primera lectura real: "TACOS" se veía a gritos en el POS.
        expect(nombreDeCategoria('TACOS')).toBe('Tacos');
        expect(nombreDeCategoria('BEBIDAS FRÍAS')).toBe('Bebidas frías');
        expect(nombreDeCategoria('Postres de la casa')).toBe('Postres de la casa');
        expect(nombreDeCategoria('BBQ')).toBe('BBQ');
    });

    test('los datos del negocio que trae la foto se proponen, no se guardan', () => {
        const p = armarPropuesta([{ productos: [producto('Taco', 20)], negocio: { nombre: 'Taquería El Güero', telefono: '998 123 4567' } }]);
        expect(p.negocio).toEqual({ nombre: 'Taquería El Güero', telefono: '998 123 4567', direccion: null });
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('POST /api/importar-menu/leer', () => {
    test('🔒 leer NO escribe nada en el catálogo', async () => {
        fijarLectorDePrueba(lectorQueDevuelve(ok([producto('Taco', 20), producto('Agua', 15)])));
        const r = await request(app).post('/api/importar-menu/leer').set(auth()).send({ archivos: [FOTO] });
        expect(r.status).toBe(200);
        expect(r.body.productos).toHaveLength(2);
        expect(await models.Product.count()).toBe(0);
    });

    test('una llamada por archivo, y el texto pegado cuenta como uno más', async () => {
        const lector = lectorQueDevuelve(ok([producto('A', 10)]), ok([producto('B', 20)]), ok([producto('C', 30)]));
        fijarLectorDePrueba(lector);
        const r = await request(app).post('/api/importar-menu/leer').set(auth())
            .send({ archivos: [FOTO, FOTO], texto: 'C ..... $30' });
        expect(r.status).toBe(200);
        expect(lector.llamadas).toHaveLength(3);
        expect(lector.llamadas[2].texto).toContain('C');
        expect(r.body.productos.map((p) => p.nombre).sort()).toEqual(['A', 'B', 'C']);
    });

    test('🔒 un archivo que falla NO tumba a los demás', async () => {
        fijarLectorDePrueba(lectorQueDevuelve(
            { ok: false, motivo: 'respuesta_ilegible' },
            ok([producto('Agua', 15)]),
        ));
        const r = await request(app).post('/api/importar-menu/leer').set(auth()).send({ archivos: [FOTO, FOTO] });
        expect(r.status).toBe(200);
        expect(r.body.productos).toHaveLength(1);
        expect(r.body.archivos[0]).toMatchObject({ ok: false, motivo: 'respuesta_ilegible' });
        expect(r.body.archivos[1]).toMatchObject({ ok: true });
    });

    test('si fallan TODOS, 502 que dice qué hacer', async () => {
        fijarLectorDePrueba(lectorQueDevuelve({ ok: false, motivo: 'red' }));
        const r = await request(app).post('/api/importar-menu/leer').set(auth()).send({ archivos: [FOTO] });
        expect(r.status).toBe(502);
        expect(r.body.error).toMatch(/texto/);
    });

    test('🔒 sin clave de Gemini, 503 — y nada más del sistema se entera', async () => {
        fijarLectorDePrueba(null);
        const r = await request(app).post('/api/importar-menu/leer').set(auth()).send({ archivos: [FOTO] });
        expect(r.status).toBe(503);
    });

    test('🔒 una foto de iPhone (HEIC) se rechaza DICIENDO qué hacer', async () => {
        fijarLectorDePrueba(lectorQueDevuelve(ok([])));
        const r = await request(app).post('/api/importar-menu/leer').set(auth())
            .send({ archivos: [{ mime: 'image/heic', datos: FOTO.datos }] });
        expect(r.status).toBe(415);
        expect(r.body.error).toMatch(/captura de pantalla/);
    });

    test('🔒 una foto de 3 MB ENTRA (el límite general de 2 MB la habría rechazado)', async () => {
        const lector = lectorQueDevuelve(ok([producto('Taco', 20)]));
        fijarLectorDePrueba(lector);
        const grande = { mime: 'image/jpeg', datos: Buffer.alloc(3 * 1024 * 1024, 7).toString('base64') };
        const r = await request(app).post('/api/importar-menu/leer').set(auth()).send({ archivos: [grande] });
        expect(r.status).toBe(200);
        expect(lector.llamadas[0].datos.length).toBe(3 * 1024 * 1024);
    });

    test('…pero el límite general de 2 MB sigue en pie para el resto del sistema', async () => {
        const r = await request(app).post('/api/products').set(auth())
            .send({ name: 'x', price: 1, image: 'a'.repeat(3 * 1024 * 1024) });
        expect(r.status).toBe(413);
    });

    test('🔒 sin sesión no se lee nada (401, antes de tragarse el cuerpo)', async () => {
        const r = await request(app).post('/api/importar-menu/leer').send({ archivos: [FOTO] });
        expect(r.status).toBe(401);
    });

    test('🔒 un empleado NO puede importar: cambia lo que se le cobra al cliente', async () => {
        const alta = await request(app).post('/api/staff').set(auth())
            .send({ name: 'Ana', username: `ana_${Date.now()}`, password: 'Pass12345', role: 'cashier' });
        expect(alta.status).toBe(201);
        const login = await request(app).post('/api/staff/login')
            .send({ username: alta.body.username || alta.body.user?.username, password: 'Pass12345', business_email: owner.username });
        const tokenEmpleado = login.body.token || login.body.accessToken;
        fijarLectorDePrueba(lectorQueDevuelve(ok([producto('Taco', 20)])));
        const r = await request(app).post('/api/importar-menu/leer')
            .set({ Authorization: `Bearer ${tokenEmpleado}` }).send({ archivos: [FOTO] });
        expect(r.status).toBe(403);
    });

    test('🔒 hay tope diario por negocio (cada lectura es una llamada pagada)', async () => {
        fijarLectorDePrueba(lectorQueDevuelve(ok([producto('Taco', 20)])));
        const seis = Array(6).fill(FOTO);
        let ultima;
        for (let i = 0; i < Math.ceil(rutas.LECTURAS_POR_DIA / 6) + 1; i++) {
            ultima = await request(app).post('/api/importar-menu/leer').set(auth()).send({ archivos: seis });
        }
        expect(ultima.status).toBe(429);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('El lector de Gemini: reintentos', () => {
    // Encontrado en la PRIMERA llamada real: Google respondió 503 "high demand".
    // Una importación que falla a la primera por algo pasajero es la peor
    // primera impresión posible, así que se reintenta — pero solo lo pasajero.
    const fetchOriginal = global.fetch;
    afterEach(() => { global.fetch = fetchOriginal; fijarEsperaDePrueba(undefined); });

    function respuestas(...lista) {
        let i = 0;
        const llamadas = { n: 0 };
        global.fetch = async () => {
            llamadas.n++;
            const r = lista[Math.min(i++, lista.length - 1)];
            return {
                ok: r.status === 200,
                status: r.status,
                text: async () => JSON.stringify(r.body || {}),
                json: async () => r.body,
            };
        };
        return llamadas;
    }
    const exito = { status: 200, body: { candidates: [{ content: { parts: [{ text: JSON.stringify({ productos: [{ nombre: 'Taco', precio: 20, confianza: 'alta' }] }) }] } }] } };

    test('🔒 un 503 pasajero se reintenta y la lectura sale', async () => {
        fijarEsperaDePrueba(0);
        const llamadas = respuestas({ status: 503 }, { status: 503 }, exito);
        const r = await crearLectorGoogle({ apiKey: 'x' }).leer({ texto: 'Taco $20' });
        expect(r.ok).toBe(true);
        expect(llamadas.n).toBe(3);
    });

    test('🔒 un 400 NO se reintenta: repetirlo no lo arregla y solo gasta', async () => {
        fijarEsperaDePrueba(0);
        const llamadas = respuestas({ status: 400, body: { error: 'schema' } }, exito);
        const r = await crearLectorGoogle({ apiKey: 'x' }).leer({ texto: 'Taco $20' });
        expect(r.ok).toBe(false);
        expect(r.estado).toBe(400);
        expect(llamadas.n).toBe(1);
    });

    test('se rinde tras dos reintentos (no se queda pidiendo para siempre)', async () => {
        fijarEsperaDePrueba(0);
        const llamadas = respuestas({ status: 503 });
        const r = await crearLectorGoogle({ apiKey: 'x' }).leer({ texto: 'Taco $20' });
        expect(r.ok).toBe(false);
        expect(llamadas.n).toBe(3);
    });

    test('sin clave, no hay lector (la ruta lo convierte en 503)', () => {
        expect(crearLectorGoogle({ apiKey: '' })).toBeNull();
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('POST /api/importar-menu/confirmar', () => {
    test('crea categorías y productos, sin control de existencias', async () => {
        const r = await request(app).post('/api/importar-menu/confirmar').set(auth()).send({ productos: [
            { nombre: 'Horchata', precio: 45, categoria_nueva: 'Bebidas' },
            { nombre: 'Jamaica', precio: 45, categoria_nueva: 'Bebidas' },
            { nombre: 'Taco al pastor', precio: 22 },
        ] });
        expect(r.status).toBe(201);
        expect(r.body.creados).toHaveLength(3);
        expect(r.body.categorias_creadas).toEqual(['Bebidas']);
        const horchata = await models.Product.findOne({ where: { name: 'Horchata' } });
        expect(Number(horchata.price)).toBe(45);
        // §19.38: una foto no sabe cuántas hay en el refri. NULL, no 0.
        expect(horchata.stock).toBeNull();
        expect(await models.Category.count()).toBe(1);
    });

    test('🔒 vuelve a validar TODO: el cliente pudo haber tocado la propuesta', async () => {
        const r = await request(app).post('/api/importar-menu/confirmar').set(auth()).send({ productos: [
            { nombre: 'Taco', precio: 20 },
            { nombre: 'Gratis', precio: 0 },
            { nombre: 'Negativo', precio: -50 },
            { nombre: '', precio: 30 },
            { nombre: 'taco ', precio: 25 },    // repetido con otro precio
        ] });
        expect(r.status).toBe(201);
        expect(r.body.creados.map((c) => c.nombre)).toEqual(['Taco']);
        expect(r.body.omitidos.map((o) => o.motivo).sort())
            .toEqual(['precio_invalido', 'precio_invalido', 'repetido', 'sin_nombre']);
    });

    test('🔒 no duplica lo que ya existe en el catálogo', async () => {
        await models.Product.create({ name: 'Taco al Pastor', price: 22, business_id: owner.id });
        const r = await request(app).post('/api/importar-menu/confirmar').set(auth())
            .send({ productos: [{ nombre: 'taco al pastor', precio: 25 }, { nombre: 'Agua', precio: 15 }] });
        expect(r.body.creados.map((c) => c.nombre)).toEqual(['Agua']);
        expect(r.body.omitidos).toEqual([{ nombre: 'taco al pastor', motivo: 'ya_existe' }]);
        expect(await models.Product.count({ where: { name: 'Taco al Pastor' } })).toBe(1);
    });

    test('🔒 una "categoría nueva" que ya existe con otra mayúscula NO se duplica', async () => {
        const cat = await models.Category.create({ name: 'Bebidas', business_id: owner.id });
        const r = await request(app).post('/api/importar-menu/confirmar').set(auth())
            .send({ productos: [{ nombre: 'Agua', precio: 15, categoria_nueva: 'BEBIDAS' }] });
        expect(r.body.categorias_creadas).toEqual([]);
        const agua = await models.Product.findOne({ where: { name: 'Agua' } });
        expect(agua.category_id).toBe(cat.id);
    });

    test('🔒 una categoría de OTRO negocio no se cruza: se ignora', async () => {
        const otro = await createTestOwner();
        const ajena = await models.Category.create({ name: 'Ajena', business_id: otro.user.id });
        const r = await request(app).post('/api/importar-menu/confirmar').set(auth())
            .send({ productos: [{ nombre: 'Agua', precio: 15, categoria_id: ajena.id }] });
        expect(r.status).toBe(201);
        const agua = await models.Product.findOne({ where: { name: 'Agua' } });
        expect(agua.category_id).toBeNull();
    });

    test('sin nada válido, 400', async () => {
        const r = await request(app).post('/api/importar-menu/confirmar').set(auth())
            .send({ productos: [{ nombre: 'x', precio: 0 }] });
        expect(r.status).toBe(400);
    });

    test('validarConfirmacion no le cree nada al cliente', () => {
        const { validos } = validarConfirmacion([{ nombre: '  Taco  ', precio: '$24.50', categoria_id: 'hack' }]);
        expect(validos).toEqual([{ nombre: 'Taco', precio: 24.5, descripcion: null, categoria_id: null, categoria_nueva: null }]);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// EL LECTOR FALSO DEL BANCO DE LA INTERFAZ, Y SU CERROJO
//
// `MENU_LECTOR_FALSO` existe para que el banco del desktop (§46) pueda recorrer
// la pantalla de importar menú sin llamar a Gemini: sin ella, cada corrida
// costaría dinero y devolvería algo distinto. Es una puerta trasera, así que lo
// que de verdad se prueba aquí es que EN PRODUCCIÓN NO SE ABRE: un lector falso
// ahí le daría al negocio un menú inventado, y es de los pocos errores que el
// usuario no podría notar.
// ═══════════════════════════════════════════════════════════════════════════
describe('El lector falso del banco: solo fuera de producción', () => {
    const envPrevio = { falso: process.env.MENU_LECTOR_FALSO, node: process.env.NODE_ENV, clave: process.env.GEMINI_API_KEY };

    beforeEach(() => {
        // `undefined` apaga el lector inyectado a mano y deja decidir a obtenerLector().
        fijarLectorDePrueba(undefined);
        delete process.env.GEMINI_API_KEY;   // sin clave, lo único que puede devolver es el falso
    });
    afterEach(() => {
        if (envPrevio.falso === undefined) delete process.env.MENU_LECTOR_FALSO; else process.env.MENU_LECTOR_FALSO = envPrevio.falso;
        if (envPrevio.node === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = envPrevio.node;
        if (envPrevio.clave === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = envPrevio.clave;
    });

    const LECTURA = JSON.stringify({ productos: [{ nombre: 'Taco del banco', precio: 24.5, confianza: 'alta' }] });

    test('fuera de producción SÍ lee, y devuelve lo que se le puso', async () => {
        process.env.NODE_ENV = 'test';
        process.env.MENU_LECTOR_FALSO = LECTURA;
        const { obtenerLector } = require('../utils/menuFoto/lector');
        const lector = obtenerLector();
        expect(lector).not.toBeNull();
        const r = await lector.leer({ texto: 'lo que sea' });
        expect(r.ok).toBe(true);
        expect(r.lectura.productos[0].nombre).toBe('Taco del banco');
    });

    test('🔴 en PRODUCCIÓN se ignora: sin clave, no hay lector y la ruta responde 503', async () => {
        process.env.NODE_ENV = 'production';
        process.env.MENU_LECTOR_FALSO = LECTURA;
        const { obtenerLector } = require('../utils/menuFoto/lector');
        expect(obtenerLector()).toBeNull();
    });

    test('un valor con basura no se usa (y no tumba nada)', () => {
        process.env.NODE_ENV = 'test';
        process.env.MENU_LECTOR_FALSO = 'esto no es json';
        const { obtenerLector } = require('../utils/menuFoto/lector');
        expect(obtenerLector()).toBeNull();
    });
});
