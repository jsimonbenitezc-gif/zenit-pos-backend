// ============================================================================
// pruebas-postgres/lib/postgres.js — el PostgreSQL desechable
//
// Tres formas de conseguirlo, en orden de preferencia:
//
//   1. EXTERNO   — si ya hay uno levantado y se pasan las variables
//                  PRUEBAS_DB_* (útil en CI, donde el runner suele ofrecer un
//                  servicio Postgres ya listo).
//   2. DOCKER    — `docker compose -f docker-compose.pruebas.yml`. Es el camino
//                  que pide el BLOQUE 15 y el que se usa si Docker está instalado.
//   3. EMBEBIDO  — un binario real de PostgreSQL que arranca sin Docker
//                  (paquete `embedded-postgres`). Existe porque un banco de
//                  pruebas que solo corre en las máquinas con Docker acaba sin
//                  correr en ninguna: la máquina donde se escribió este bloque
//                  no tiene Docker, y con esto el recorrido se pudo verificar de
//                  verdad en lugar de quedar escrito y sin ejecutar nunca.
//
// En los tres casos es PostgreSQL DE VERDAD, que es lo único que importa: es el
// dialecto —no el motor de almacenamiento— lo que dejó pasar el `FOR UPDATE`
// sobre un OUTER JOIN durante un mes (CLAUDE.md §19.25).
//
// Al terminar se DESTRUYE. No hay endpoint que borre negocios y no debe haberlo:
// la salida limpia es tirar la base entera.
// ============================================================================

const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('pg');

const { exigirBaseDesechable } = require('./guardas');

const NOMBRE_BASE = 'zenit_pruebas';
const USUARIO = 'zenit_pruebas';
const CLAVE = 'zenit_pruebas';

function hayDocker() {
    try {
        execSync('docker info', { stdio: 'ignore', timeout: 15000 });
        return true;
    } catch {
        return false;
    }
}

function hayEmbebido() {
    try { require.resolve('embedded-postgres'); return true; } catch { return false; }
}

async function esperarConexion(conf, intentos = 60, esperaMs = 500) {
    let ultimo;
    for (let i = 0; i < intentos; i++) {
        const c = new Client({ ...conf, database: 'postgres', connectionTimeoutMillis: 3000 });
        try {
            await c.connect();
            await c.query('SELECT 1');
            await c.end();
            return true;
        } catch (err) {
            ultimo = err;
            try { await c.end(); } catch { /* ya estaba cerrado */ }
            await new Promise((r) => setTimeout(r, esperaMs));
        }
    }
    throw new Error(`El Postgres de pruebas no aceptó conexiones: ${ultimo && ultimo.message}`);
}

/** Borra y recrea la base: cada corrida empieza de cero, sin restos de la anterior. */
async function recrearBase(conf) {
    // El nombre va interpolado (Postgres no admite parámetros en DDL), así que se
    // restringe a un identificador simple. La guarda ya exige que contenga
    // "prueba"; esto cierra la puerta a que un nombre con comillas se convierta
    // en otra sentencia.
    if (!/^[a-z_][a-z0-9_]*$/.test(conf.database)) {
        throw new Error(`Nombre de base no admitido: "${conf.database}"`);
    }

    const admin = new Client({ ...conf, database: 'postgres' });
    await admin.connect();
    try {
        await admin.query(
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
             WHERE datname = $1 AND pid <> pg_backend_pid()`,
            [conf.database]
        );
        await admin.query(`DROP DATABASE IF EXISTS "${conf.database}"`);
        // ⚠️ UTF8 EXPLÍCITO, y no es un detalle cosmético.
        // En Windows, initdb crea el clúster con la configuración regional del
        // sistema y las bases heredan WIN1252 de template1. Con esa codificación,
        // "sequelize.sync()" MUERE al crear la tabla "combos": su columna "emoji"
        // tiene como valor por defecto un 🎁, que no existe en WIN1252. Y como
        // "syncDatabase()" se traga el error, el backend arranca igual con el
        // esquema a medio construir y el primer registro falla con un 500
        // ("relation refresh_tokens does not exist").
        // Producción es UTF8 y Zenit guarda emojis por todas partes, así que la
        // base desechable tiene que serlo también o no estaría probando lo mismo.
        // template0 es obligatorio para poder cambiar la codificación.
        await admin.query(
            `CREATE DATABASE "${conf.database}"` +
            " ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'"
        );
    } finally {
        await admin.end();
    }
}

/**
 * Levanta el Postgres desechable y devuelve { conf, detener, modo }.
 */
async function levantarPostgres({ puerto = 55432, verboso = false } = {}) {
    // ── 1. Externo (CI) ──────────────────────────────────────────────────────
    if (process.env.PRUEBAS_DB_HOST) {
        const conf = {
            host: process.env.PRUEBAS_DB_HOST,
            port: parseInt(process.env.PRUEBAS_DB_PORT || '5432', 10),
            user: process.env.PRUEBAS_DB_USER || USUARIO,
            password: process.env.PRUEBAS_DB_PASSWORD || CLAVE,
            database: process.env.PRUEBAS_DB_NAME || NOMBRE_BASE,
        };
        exigirBaseDesechable(conf);
        await esperarConexion(conf);
        await recrearBase(conf);
        return { conf, modo: 'externo', detener: async () => {} };
    }

    // ── 2. Docker ────────────────────────────────────────────────────────────
    if (hayDocker()) {
        const conf = { host: '127.0.0.1', port: puerto, user: USUARIO, password: CLAVE, database: NOMBRE_BASE };
        exigirBaseDesechable(conf);
        const compose = path.join(__dirname, '..', '..', 'docker-compose.pruebas.yml');
        const entorno = { ...process.env, PRUEBAS_PG_PUERTO: String(puerto) };
        execFileSync('docker', ['compose', '-f', compose, 'up', '-d'], {
            stdio: verboso ? 'inherit' : 'ignore', env: entorno,
        });
        await esperarConexion(conf);
        await recrearBase(conf);
        return {
            conf,
            modo: 'docker',
            detener: async () => {
                // `down -v` se lleva también el volumen: no queda ni rastro.
                execFileSync('docker', ['compose', '-f', compose, 'down', '-v'], {
                    stdio: verboso ? 'inherit' : 'ignore', env: entorno,
                });
            },
        };
    }

    // ── 3. Embebido ──────────────────────────────────────────────────────────
    if (!hayEmbebido()) {
        throw new Error(
            'No hay forma de levantar un PostgreSQL desechable.\n' +
            '  Opciones:\n' +
            '   • Instalar Docker Desktop (el camino previsto por el BLOQUE 15), o\n' +
            '   • npm i -D embedded-postgres   (Postgres real, sin Docker), o\n' +
            '   • exportar PRUEBAS_DB_HOST/PORT/USER/PASSWORD/NAME apuntando a uno local.'
        );
    }

    const modulo = require('embedded-postgres');
    const EmbeddedPostgres = modulo.default || modulo;

    const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), 'zenit-pg-'));
    const conf = { host: '127.0.0.1', port: puerto, user: USUARIO, password: CLAVE, database: NOMBRE_BASE };
    exigirBaseDesechable(conf);

    const pg = new EmbeddedPostgres({
        databaseDir: carpeta,
        user: USUARIO,
        password: CLAVE,
        port: puerto,
        persistent: false,
        onLog: verboso ? (m) => process.stdout.write(String(m)) : () => {},
        onError: verboso ? (m) => process.stderr.write(String(m)) : () => {},
    });

    await pg.initialise();
    await pg.start();
    await esperarConexion(conf);
    await recrearBase(conf);

    return {
        conf,
        modo: 'embebido',
        detener: async () => {
            try { await pg.stop(); } catch { /* ya estaba caído */ }
            try { fs.rmSync(carpeta, { recursive: true, force: true }); } catch { /* Windows a veces retiene el handle */ }
        },
    };
}

module.exports = { levantarPostgres, NOMBRE_BASE, hayDocker, hayEmbebido };
