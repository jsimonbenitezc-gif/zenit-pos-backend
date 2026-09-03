// ============================================================================
// pruebas-postgres/lib/servidor.js — arranca el backend DE VERDAD
//
// Lanza `node server.js`, que es EXACTAMENTE lo que ejecuta Render (CLAUDE.md
// §19.4). Eso importa: con `npm start` correrían además las migraciones del CLI,
// que en producción NO corren, así que el banco estaría probando un esquema que
// nadie tiene. Arrancando por `node server.js` se ejercita el camino real:
// `sequelize.sync()` + `runMigrations()` sobre una base vacía.
//
// ⚠️ AQUÍ VIVE LA PRIMERA DEFENSA CONTRA PRODUCCIÓN (ver lib/guardas.js).
// `zenit-pos-backend/.env` tiene las credenciales de la Supabase real, y la
// primera línea de `server.js` carga dotenv. dotenv resuelve el archivo contra
// `process.cwd()`, así que el hijo se lanza con el cwd en una CARPETA VACÍA:
// desde ahí no existe ningún `.env` que cargar y esas credenciales no llegan
// siquiera a entrar en el proceso.
//
// Se comprobó que nada del backend depende de `process.cwd()` (las rutas usan
// `__dirname` y el logger es solo consola), así que mover el cwd no rompe nada.
// ============================================================================

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const RAIZ_BACKEND = path.join(__dirname, '..', '..');

function esperarSalud(puerto, intentos = 90, esperaMs = 500) {
    return new Promise((resolver, rechazar) => {
        let restantes = intentos;
        const probar = () => {
            const req = http.get({ host: '127.0.0.1', port: puerto, path: '/health', timeout: 2000 }, (res) => {
                let bruto = '';
                res.on('data', (c) => { bruto += c; });
                res.on('end', () => {
                    let cuerpo = {};
                    try { cuerpo = JSON.parse(bruto); } catch { /* aún no responde JSON */ }
                    if (res.statusCode === 200 && cuerpo.database === 'connected') return resolver(cuerpo);
                    reintentar();
                });
            });
            req.on('timeout', () => { req.destroy(); reintentar(); });
            req.on('error', reintentar);
        };
        const reintentar = () => {
            if (--restantes <= 0) {
                return rechazar(new Error('El backend no llegó a responder /health con la base conectada.'));
            }
            setTimeout(probar, esperaMs);
        };
        probar();
    });
}

/**
 * @param {object} opts
 * @param {object} opts.db       conf de la base desechable
 * @param {number} opts.puerto   puerto del API
 * @param {boolean} opts.verboso vuelca la salida del backend
 */
async function arrancarServidor({ db, puerto, verboso = false }) {
    // Carpeta vacía como cwd: sin `.env` que dotenv pueda encontrar.
    const cwdLimpio = fs.mkdtempSync(path.join(os.tmpdir(), 'zenit-srv-'));

    const entorno = {
        // Se parte de un entorno MÍNIMO en lugar de heredar todo: así una
        // variable DB_* que ya estuviera exportada en la terminal del
        // desarrollador (apuntando a producción) no puede colarse.
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,       // Windows lo necesita para el socket
        WINDIR: process.env.WINDIR,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,

        // NO es 'test': con NODE_ENV=test, `config/database.js` elegiría SQLite y
        // el banco entero perdería su razón de ser. Tampoco 'development', que
        // vuelca cada consulta SQL. 'pruebas' da Postgres, sin ruido, y deja
        // Sentry apagado (no hay SENTRY_DSN).
        NODE_ENV: 'pruebas',
        PORT: String(puerto),

        DB_HOST: db.host,
        DB_PORT: String(db.port),
        DB_NAME: db.database,
        DB_USER: db.user,
        DB_PASSWORD: db.password,

        JWT_SECRET: 'secreto-solo-para-el-banco-de-pruebas-de-postgres',
        APP_URL: `http://127.0.0.1:${puerto}`,
        ALLOWED_ORIGINS: `http://127.0.0.1:${puerto}`,
        // Sin RESEND_API_KEY el envío de correos se omite sin romper nada, y sin
        // STRIPE_SECRET_KEY el módulo de facturación se queda inactivo salvo
        // `start-trial`, que es justo lo que el banco necesita para el premium.
    };

    const hijo = spawn(process.execPath, [path.join(RAIZ_BACKEND, 'server.js')], {
        cwd: cwdLimpio,
        env: entorno,
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    const salida = [];
    const recoger = (flujo, etiqueta) => {
        flujo.setEncoding('utf8');
        flujo.on('data', (trozo) => {
            salida.push(trozo);
            if (salida.length > 500) salida.shift();
            if (verboso) process.stdout.write(`[backend:${etiqueta}] ${trozo}`);
        });
    };
    recoger(hijo.stdout, 'out');
    recoger(hijo.stderr, 'err');

    let murio = null;
    hijo.on('exit', (codigo) => { murio = codigo; });

    try {
        await esperarSalud(puerto);
    } catch (err) {
        const cola = salida.join('').split('\n').slice(-40).join('\n');
        throw new Error(`${err.message}\n--- salida del backend ---\n${cola}`);
    }

    if (murio !== null) {
        throw new Error(`El backend murió al arrancar (código ${murio}).\n${salida.join('')}`);
    }

    return {
        url: `http://127.0.0.1:${puerto}`,
        registro: () => salida.join(''),
        detener: () => new Promise((resolver) => {
            if (hijo.exitCode !== null || hijo.signalCode !== null) return resolver();
            hijo.once('exit', () => resolver());
            hijo.kill();
            // En Windows kill() no siempre llega: se fuerza tras un margen.
            setTimeout(() => { try { hijo.kill('SIGKILL'); } catch { /* ya murió */ } resolver(); }, 4000);
        }),
        limpiarCwd: () => { try { fs.rmSync(cwdLimpio, { recursive: true, force: true }); } catch { /* da igual */ } },
    };
}

module.exports = { arrancarServidor };
