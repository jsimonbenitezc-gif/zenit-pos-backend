#!/usr/bin/env node
// ============================================================================
// pruebas-postgres/correr.js — BANCO DE PRUEBAS CONTRA POSTGRES REAL
//
//     npm run probar:postgres
//
// Qué es: un guion DETERMINISTA (sin LLM, sin tokens, apto para CI) que levanta
// un PostgreSQL desechable, arranca el backend de verdad contra él, siembra una
// taquería y recorre un día completo de caja terminando en una afirmación sobre
// el DINERO — no en un 200.
//
// POR QUÉ EXISTE (PLAN_ARREGLOS_V5 → BLOQUE 15). Las 395 pruebas de `npm test`
// corren sobre SQLite; producción es PostgreSQL. Ese hueco costó UN MES con el
// cobro de mesas devolviendo 500 en producción mientras la suite entera pasaba
// en verde: SQLite ignora `FOR UPDATE` y Postgres lo rechaza sobre el lado
// nullable de un OUTER JOIN (CLAUDE.md §19.25, §30). Ninguna prueba de
// comportamiento podía verlo. Ésta sí.
//
// Y el segundo agujero es de dinero: un descuadre de caja solo se nota AL FINAL
// de un recorrido largo (abrir turno → vender → dividir cuentas → gastos →
// propinas → cerrar y contar). Ninguna prueba unitaria recorre eso entero.
//
// ⚠️ NUNCA CONTRA PRODUCCIÓN. Lee lib/guardas.js antes de tocar nada: el `.env`
// de este repo tiene las credenciales de la Supabase real y `node server.js`
// carga dotenv en su primera línea. Hay tres defensas y ninguna sobra.
//
// Banderas:
//   --recorrido=caja     corre solo ese (por etiqueta); admite varias con coma
//   --verboso            vuelca la salida del backend y del Postgres
//   --puerto-api=3099    puerto del backend de pruebas
//   --puerto-db=55432    puerto del Postgres desechable
// ============================================================================

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const { levantarPostgres, hayDocker, hayEmbebido } = require('./lib/postgres');
const { arrancarServidor } = require('./lib/servidor');
const { ClienteApi } = require('./lib/http');
const { Afirmador } = require('./lib/afirmar');
const { sembrarTaqueria } = require('./lib/sembrador');
const { comprobarQueEsNuestraBase, ErrorDeGuarda } = require('./lib/guardas');

// ── Banderas ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const bandera = (nombre, porDefecto) => {
    const encontrada = args.find((a) => a.startsWith('--' + nombre + '='));
    return encontrada ? encontrada.split('=').slice(1).join('=') : porDefecto;
};
const VERBOSO = args.includes('--verboso');
const PUERTO_API = parseInt(bandera('puerto-api', '3099'), 10);
const PUERTO_DB = parseInt(bandera('puerto-db', '55432'), 10);
const SOLO = bandera('recorrido', null);

function cargarRecorridos() {
    const carpeta = path.join(__dirname, 'recorridos');
    const todos = fs.readdirSync(carpeta)
        .filter((f) => f.endsWith('.js'))
        .sort()
        .map((f) => Object.assign({ archivo: f }, require(path.join(carpeta, f))));

    if (!SOLO) return todos;
    const pedidos = SOLO.split(',').map((s) => s.trim()).filter(Boolean);
    const elegidos = todos.filter((r) => pedidos.includes(r.etiqueta));
    if (!elegidos.length) {
        throw new Error(
            'Ningún recorrido con etiqueta "' + SOLO + '". Disponibles: ' +
            todos.map((r) => r.etiqueta).join(', ')
        );
    }
    return elegidos;
}

// Tablas sin las cuales el backend no puede operar. La lista es corta a
// propósito: no pretende ser el inventario del esquema, sino atrapar un arranque
// a medio construir.
// ⚠️ "Branches" va con mayúscula de verdad: es la única tabla del esquema que no
// sigue la convención en minúsculas (models/Branch.js). En Postgres eso obliga a
// entrecomillarla siempre, así que conviene no "arreglarlo" aquí pensando que es
// un dedazo. Y la de stock por sucursal es "branch_stocks", en plural — CLAUDE.md
// §5 la llama "branch_stock".
const TABLAS_CRITICAS = [
    'users', 'refresh_tokens', 'products', 'categories', 'orders', 'order_items',
    'order_payments', 'customers', 'tables', 'turnos', 'cash_movements',
    'Branches', 'branch_stocks', 'ingredients', 'product_recipes',
    'privileged_action_logs', 'discounts', 'combos', 'kds_devices',
    'modifier_groups', 'modifier_options',
];

/**
 * Comprueba que el esquema se construyó ENTERO al arrancar.
 *
 * ⚠️ Esta guarda no es teórica: la primera corrida del banco la habría necesitado.
 * `syncDatabase()` (models/index.js) atrapa el error de `sequelize.sync()` y solo
 * lo escribe en consola, así que el servidor **arranca igual** y `/health`
 * responde 200 con la base "conectada" aunque falten la mitad de las tablas. El
 * síntoma que llega al usuario es un 500 opaco en el primer registro
 * ("relation refresh_tokens does not exist"), tres pasos más adelante y sin
 * relación aparente con la causa.
 *
 * Un despliegue sobre una base VACÍA —una migración a otro proveedor, un
 * entorno de staging nuevo— es exactamente ese escenario. Aquí se detecta al
 * segundo, con el nombre de lo que falta.
 */
async function comprobarEsquema(db, servidor) {
    const { rows } = await db.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
    );
    const existen = new Set(rows.map((r) => r.table_name));
    const faltan = TABLAS_CRITICAS.filter((t) => !existen.has(t));

    if (faltan.length) {
        const registro = servidor.registro();
        const pista = (registro.match(/Error syncing database[\s\S]{0,600}/) || [''])[0];
        throw new Error(
            'EL ESQUEMA NO SE CONSTRUYÓ ENTERO sobre una base vacía.\n' +
            '   Faltan ' + faltan.length + ' tablas críticas: ' + faltan.join(', ') + '\n' +
            '   El backend arrancó igual y /health respondió 200: `syncDatabase()`\n' +
            '   se traga el error de `sequelize.sync()` (models/index.js).\n' +
            (pista ? '\n--- lo que dijo el backend ---\n' + pista + '\n' : '')
        );
    }

    console.log('  el esquema se creó solo: ' + existen.size + ' tablas, ' +
                TABLAS_CRITICAS.length + '/' + TABLAS_CRITICAS.length + ' críticas presentes');
}

async function principal() {
    console.log('');
    console.log('══════════════════════════════════════════════════════════════');
    console.log('  BANCO DE PRUEBAS DE ZENIT — contra PostgreSQL de verdad');
    console.log('══════════════════════════════════════════════════════════════');

    const recorridos = cargarRecorridos();

    // ── 1. Postgres desechable ──────────────────────────────────────────────
    process.stdout.write('\n· Levantando PostgreSQL desechable... ');
    const pg = await levantarPostgres({ puerto: PUERTO_DB, verboso: VERBOSO });
    console.log('listo (' + pg.modo + ', puerto ' + pg.conf.port + ')');
    if (pg.modo === 'embebido') {
        console.log('  (no se detectó Docker; se usó el binario embebido — mismo PostgreSQL)');
    }

    const db = new Client(pg.conf);
    let servidor = null;
    let salida = 0;

    try {
        await db.connect();
        const version = (await db.query('SHOW server_version')).rows[0].server_version;
        console.log('  PostgreSQL ' + version + ' · base "' + pg.conf.database + '"');

        // ── 2. El backend REAL ──────────────────────────────────────────────
        // `node server.js`, que es lo que ejecuta Render: así se recorre el
        // arranque de esquema de verdad (sync + runMigrations) sobre una base
        // vacía, y no el del CLI, que en producción no corre (§19.4).
        process.stdout.write('· Arrancando el backend (node server.js)... ');
        servidor = await arrancarServidor({ db: pg.conf, puerto: PUERTO_API, verboso: VERBOSO });
        console.log('listo (' + servidor.url + ')');

        await comprobarEsquema(db, servidor);

        const api = new ClienteApi(servidor.url);

        // ── 3. Recorridos ───────────────────────────────────────────────────
        let yaComprobado = false;

        // El sembrador se envuelve para colar aquí la comprobación empírica de
        // la guarda: en cuanto existe la PRIMERA cuenta, se verifica que esa fila
        // esté en NUESTRA base antes de sembrar nada más.
        const sembrar = async (etiqueta, opciones) => {
            const taqueria = await sembrarTaqueria(api, Object.assign({ etiqueta }, opciones));
            if (!yaComprobado) {
                await comprobarQueEsNuestraBase(db, taqueria.correo);
                yaComprobado = true;
            }
            return taqueria;
        };

        const resultados = [];
        for (const recorrido of recorridos) {
            console.log('\n──────────────────────────────────────────────────────────────');
            console.log('  ' + recorrido.nombre + '   [' + recorrido.etiqueta + ']');
            console.log('──────────────────────────────────────────────────────────────');

            const af = new Afirmador(recorrido.nombre);
            const inicio = Date.now();
            try {
                await recorrido.ejecutar({ api, af, sembrar, db });
            } catch (err) {
                af._fallo('el recorrido se interrumpió', err.message);
                if (VERBOSO && err.stack) console.log(err.stack);
            }
            const ms = Date.now() - inicio;
            resultados.push({ recorrido, af, ms });
            console.log(
                '\n  ' + (af.paso ? '✅ PASÓ' : '❌ FALLÓ') +
                ' · ' + af.comprobaciones + ' comprobaciones · ' + (ms / 1000).toFixed(1) + 's'
            );
        }

        // ── 4. Reporte ──────────────────────────────────────────────────────
        console.log('\n══════════════════════════════════════════════════════════════');
        console.log('  RESUMEN');
        console.log('══════════════════════════════════════════════════════════════');

        let comprobaciones = 0;
        let fallos = 0;
        let hallazgos = 0;
        for (const r of resultados) {
            comprobaciones += r.af.comprobaciones;
            const esHallazgo = Boolean(r.recorrido.hallazgoAbierto);
            if (esHallazgo) hallazgos += r.af.fallos.length;
            else fallos += r.af.fallos.length;

            const icono = r.af.paso ? '✅' : (esHallazgo ? '🔎' : '❌');
            console.log(
                '  ' + icono + '  ' + r.recorrido.nombre.padEnd(46) +
                String(r.af.comprobaciones).padStart(3) + ' comprobaciones'
            );
        }

        console.log('');
        if (fallos === 0) {
            console.log('  ' + comprobaciones + ' comprobaciones contra PostgreSQL ' + version +
                        '; ninguna REGRESIÓN.');
        } else {
            console.log('  ' + fallos + ' de ' + comprobaciones + ' comprobaciones FALLARON:');
            for (const r of resultados) {
                if (r.recorrido.hallazgoAbierto) continue;
                for (const f of r.af.fallos) {
                    console.log('    · [' + r.recorrido.etiqueta + '] ' + f.descripcion);
                    console.log('      ' + f.detalle);
                }
            }
            salida = 1;
        }

        // ── Hallazgos abiertos ──────────────────────────────────────────────
        // Un recorrido marcado con `hallazgoAbierto` reproduce un defecto REAL
        // que todavía no se ha arreglado. Se ejecuta y se reporta en TODAS las
        // corridas —para que no se olvide— pero no tumba el código de salida:
        // si lo hiciera, el banco nacería en rojo, y un banco que siempre está
        // en rojo deja de mirarse a la semana. Cuando el defecto se arregle, el
        // recorrido pasa a verde y hay que quitarle la marca.
        if (hallazgos > 0) {
            console.log('');
            console.log('  ┌─ HALLAZGOS ABIERTOS ' + '─'.repeat(38));
            for (const r of resultados) {
                if (!r.recorrido.hallazgoAbierto || r.af.paso) continue;
                console.log('  │');
                console.log('  │  🔎 ' + r.recorrido.nombre);
                console.log('  │     ' + r.recorrido.hallazgoAbierto);
                console.log('  │     Reproducir: npm run probar:postgres -- --recorrido=' + r.recorrido.etiqueta);
                console.log('  │     Detalle en: pruebas-postgres/recorridos/' + r.recorrido.archivo);
                for (const f of r.af.fallos) {
                    console.log('  │     · ' + f.descripcion + ' → ' + f.detalle);
                }
            }
            console.log('  └' + '─'.repeat(59));
            console.log('  (no tumban la corrida: son defectos conocidos, no regresiones)');
        }
        console.log('  Peticiones HTTP: ' + api.peticiones);
        console.log('');
    } catch (err) {
        console.error('\n❌ ' + (err instanceof ErrorDeGuarda ? '' : 'Error: ') + err.message);
        if (VERBOSO && err.stack) console.error(err.stack);
        salida = 1;
    } finally {
        // ── 5. Se destruye TODO ─────────────────────────────────────────────
        // No hay endpoint que borre un negocio, ni debe haberlo: un borrado en
        // cascada con el business_id equivocado se lleva un negocio real. La
        // salida limpia es tirar la base entera (BLOQUE 15).
        process.stdout.write('· Limpiando... ');
        try { await db.end(); } catch { /* ya estaba cerrada */ }
        if (servidor) { await servidor.detener(); servidor.limpiarCwd(); }
        try { await pg.detener(); } catch (err) { console.log('(aviso al detener Postgres: ' + err.message + ')'); }
        console.log('base desechable destruida.');
    }

    process.exit(salida);
}

principal().catch((err) => {
    console.error('Fallo no controlado:', err);
    process.exit(1);
});
