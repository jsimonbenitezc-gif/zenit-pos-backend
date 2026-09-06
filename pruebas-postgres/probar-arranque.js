// ============================================================================
// EL ARRANQUE Y EL CIERRE DEL SERVIDOR
//
//   node pruebas-postgres/probar-arranque.js
//
// Estas dos cosas no las ve ninguna otra prueba, y las dos son de OPERACIÓN:
// solo se manifiestan al desplegar, que es cuando ya es tarde.
//
//   1. CON LA BASE BIEN → arranca, responde, y al recibir SIGTERM cierra
//      ordenadamente. Render manda SIGTERM en CADA despliegue: sin manejarlo,
//      las peticiones a medio responder se cortan y las conexiones de tiempo
//      real caen sin avisar, así que el cajero ve errores cada vez que se sube
//      una versión.
//
//   2. CON LA BASE MAL → NO arranca y sale con código 1. Antes, `syncDatabase`
//      se tragaba el error y el servidor levantaba igual respondiendo que la
//      base estaba `connected`: un despliegue roto se veía EXACTAMENTE igual
//      que uno bueno. Y como Render arranca con `node server.js` y no con
//      `npm start`, `runMigrations()` es el ÚNICO sitio donde se crean las
//      columnas nuevas, el RLS de las 31 tablas y el respaldo del stock por
//      sucursal (§19.4). Si eso falla en silencio, el síntoma llega días
//      después como un 500 opaco o como una tabla sin proteger.
//
// ⚠️ SOBRE WINDOWS. `child.kill('SIGTERM')` no entrega la señal aquí: el SO
// mata el proceso directamente (comprobado con un Node mínimo — el handler no
// llega a ejecutarse). Por eso el servidor se arranca a través de una pequeña
// envoltura que dispara `process.emit('SIGTERM')` desde dentro, que ejecuta
// EXACTAMENTE el mismo handler que la señal real en Linux. Lo único que no se
// prueba aquí es la entrega de la señal por el sistema operativo, que es cosa
// de Node y en Linux —donde corre Render— está garantizada.
// ============================================================================

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const http = require('http');

const RAIZ = path.join(__dirname, '..');
const { levantarPostgres } = require('./lib/postgres');

const PUERTO_SANO = 3097;
const PUERTO_ROTO = 3096;

function entorno(db, puerto) {
    // Entorno MÍNIMO, igual que lib/servidor.js: una variable DB_* exportada en
    // la terminal (apuntando a producción) no puede colarse.
    return {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
        NODE_ENV: 'pruebas',
        PORT: String(puerto),
        DB_HOST: db.host,
        DB_PORT: String(db.port),
        DB_NAME: db.database,
        DB_USER: db.user,
        DB_PASSWORD: db.password,
        DB_SSL: 'false',
        JWT_SECRET: 'prueba-de-arranque-zenit',
    };
}

const salud = (puerto) => new Promise((resolver) => {
    const req = http.get(
        { hostname: '127.0.0.1', port: puerto, path: '/health', timeout: 3000 },
        (res) => { res.resume(); resolver(res.statusCode); }
    );
    req.on('error', () => resolver(null));
    req.on('timeout', () => { req.destroy(); resolver(null); });
});

async function esperarSalud(puerto, intentos = 90) {
    for (let i = 0; i < intentos; i++) {
        if (await salud(puerto) === 200) return true;
        await new Promise((r) => setTimeout(r, 500));
    }
    return false;
}

async function esperarSalida(estado, ms) {
    const t0 = Date.now();
    while (estado.codigo === null && Date.now() - t0 < ms) {
        await new Promise((r) => setTimeout(r, 200));
    }
    return Date.now() - t0;
}

function lanzar(guion, conf, puerto) {
    const hijo = spawn(process.execPath, [guion], {
        cwd: RAIZ,
        env: entorno(conf, puerto),
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const estado = { log: '', codigo: null };
    hijo.stdout.on('data', (d) => { estado.log += d; });
    hijo.stderr.on('data', (d) => { estado.log += d; });
    hijo.on('exit', (c) => { estado.codigo = c; });
    return { hijo, estado };
}

(async () => {
    let fallos = 0;
    let total = 0;
    const ok = (descripcion, condicion) => {
        total++;
        console.log(`      ${condicion ? '✓' : '✗'} ${descripcion}`);
        if (!condicion) fallos++;
    };

    console.log('\n──────────────────────────────────────────────────────────────');
    console.log('  El arranque y el cierre del servidor');
    console.log('──────────────────────────────────────────────────────────────');

    const pg = await levantarPostgres({ verboso: false });

    // La envoltura que dispara el evento (ver la nota sobre Windows arriba).
    const envoltura = path.join(os.tmpdir(), `zenit-sigterm-${process.pid}.js`);
    fs.writeFileSync(envoltura,
        `require(${JSON.stringify(path.join(RAIZ, 'server.js'))});\n` +
        `setTimeout(() => process.emit('SIGTERM'), 6000);\n`
    );

    try {
        // ── 1. Base bien: arranca y cierra ordenadamente ────────────────────
        console.log('\n  Con la base BIEN — arranca, sirve y cierra ordenadamente');
        const sano = lanzar(envoltura, pg.conf, PUERTO_SANO);

        ok('el servidor arranca y responde /health', await esperarSalud(PUERTO_SANO));

        const tardo = await esperarSalida(sano.estado, 15000);
        ok('SIGTERM lo cierra: no se queda colgado', sano.estado.codigo !== null);
        ok(`cierra con código 0, no a la fuerza (fue ${sano.estado.codigo})`, sano.estado.codigo === 0);
        ok('y tarda menos de 10s (el tope del cierre ordenado)', tardo < 10000);
        ok('avisa en el log que está cerrando', /cerrando ordenadamente/i.test(sano.estado.log));
        ok('deja de aceptar peticiones antes de salir', /Servidor HTTP cerrado/i.test(sano.estado.log));
        ok('y cierra las conexiones a la base', /Conexiones a la base cerradas/i.test(sano.estado.log));

        // ── 2. Base rota: NO arranca ────────────────────────────────────────
        console.log('\n  Con la base MAL — NO arranca, y se nota');
        // Puerto 1: no hay nadie escuchando, así que la conexión falla como
        // fallaría un despliegue con las credenciales mal o la base caída.
        const roto = lanzar(path.join(RAIZ, 'server.js'), { ...pg.conf, port: 1 }, PUERTO_ROTO);

        await esperarSalida(roto.estado, 60000);
        ok('el proceso TERMINA en vez de quedarse a medias', roto.estado.codigo !== null);
        ok(`sale con código 1, así Render marca el despliegue fallido (fue ${roto.estado.codigo})`,
            roto.estado.codigo === 1);
        ok('🔒 y NO responde /health diciendo que está sano',
            await salud(PUERTO_ROTO) !== 200);
        ok('el log explica por qué no arrancó',
            /No se pudo preparar la base|arranque se ABORTA/i.test(roto.estado.log));

    } finally {
        fs.unlink(envoltura, () => {});
        await pg.detener().catch(() => {});
    }

    console.log(
        `\n  ${fallos === 0 ? '✅' : '❌'} ${total - fallos} de ${total} comprobaciones del arranque.\n`
    );
    process.exit(fallos === 0 ? 0 : 1);
})().catch((error) => {
    console.error('\n❌ La prueba del arranque no pudo completarse:', error.message);
    process.exit(1);
});
