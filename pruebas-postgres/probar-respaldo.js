#!/usr/bin/env node
// ============================================================================
// pruebas-postgres/probar-respaldo.js — QUE EL RESPALDO SE PUEDA RESTAURAR
//
//     npm run probar:respaldo
//
// Un respaldo que nunca se ha restaurado no es un respaldo: es un archivo que
// se SUPONE que sirve. Y el día que hace falta no hay segundo intento. Así que
// esto levanta un PostgreSQL desechable, arranca el backend de verdad contra
// él, siembra una taquería con ventas, y hace el viaje entero:
//
//     respaldar → VACIAR LA BASE → restaurar → volver a respaldar
//
// LA AFIRMACIÓN QUE SOSTIENE TODO: los dos respaldos tienen que salir
// IDÉNTICOS, línea por línea. No "el mismo número de filas" —eso lo pasaría un
// respaldo que convierta todos los decimales a 0— sino el mismo contenido en
// cada columna de cada tabla. Es lo único que demuestra que el viaje de ida y
// vuelta no deforma un `decimal(10,2)`, una fecha con zona, un JSON de ajustes
// o una imagen en base64.
//
// ⚠️ NUNCA CONTRA PRODUCCIÓN. Se apoya en las mismas guardas del banco del §38
// (lib/guardas.js + lib/postgres.js): base local, nombre con "prueba", y el
// backend arrancado con el cwd en una carpeta vacía para que dotenv no
// encuentre el `.env` con las credenciales de la Supabase real.
// ============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const { Client } = require('pg');

const { levantarPostgres } = require('./lib/postgres');
const { arrancarServidor } = require('./lib/servidor');
const { ClienteApi } = require('./lib/http');
const { Afirmador, FalloDeAfirmacion } = require('./lib/afirmar');
const { sembrarTaqueria } = require('./lib/sembrador');
const { comprobarQueEsNuestraBase, ErrorDeGuarda } = require('./lib/guardas');

const args = process.argv.slice(2);
const bandera = (n, pd) => {
    const f = args.find((a) => a.startsWith('--' + n + '='));
    return f ? f.split('=').slice(1).join('=') : pd;
};
const VERBOSO = args.includes('--verboso');
const PUERTO_API = parseInt(bandera('puerto-api', '3098'), 10);
const PUERTO_DB = parseInt(bandera('puerto-db', '55433'), 10);

const RAIZ = path.join(__dirname, '..');

/** Corre uno de los scripts de respaldo contra la base desechable. */
function correrScript(guion, argumentos, db, { esperarFallo = false } = {}) {
    // cwd en una carpeta vacía: dotenv no encontrará el `.env` de este repo, que
    // apunta a la Supabase real. Misma defensa estructural que lib/servidor.js.
    const vacia = fs.mkdtempSync(path.join(os.tmpdir(), 'zenit-resp-'));
    const r = spawnSync(process.execPath, [path.join(RAIZ, 'scripts', guion), ...argumentos], {
        cwd: vacia,
        encoding: 'utf8',
        env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            WINDIR: process.env.WINDIR,
            TEMP: process.env.TEMP,
            TMP: process.env.TMP,
            USERPROFILE: process.env.USERPROFILE,
            NODE_ENV: 'development',
            DB_HOST: db.host,
            DB_PORT: String(db.port),
            DB_NAME: db.database,
            DB_USER: db.user,
            DB_PASSWORD: db.password,
        },
    });
    fs.rmSync(vacia, { recursive: true, force: true });
    const salida = (r.stdout || '') + (r.stderr || '');
    if (VERBOSO) process.stdout.write(salida);
    if (!esperarFallo && r.status !== 0) {
        throw new Error(guion + ' salió con código ' + r.status + ':\n' + salida);
    }
    return { codigo: r.status, salida };
}

function leerLineas(archivo) {
    return zlib.gunzipSync(fs.readFileSync(archivo)).toString('utf8').split('\n').filter(Boolean);
}

async function main() {
    console.log('\n╔══════════════════════════════════════════════════════════════════╗');
    console.log('║  RESPALDO Y RESTAURACIÓN — el viaje de ida y vuelta, de verdad   ║');
    console.log('╚══════════════════════════════════════════════════════════════════╝\n');

    const af = new Afirmador('respaldo');
    const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), 'zenit-respaldos-'));
    let pg = null, servidor = null;

    try {
        pg = await levantarPostgres({ puerto: PUERTO_DB, verboso: VERBOSO });
        console.log('   PostgreSQL desechable (' + pg.modo + ') en el puerto ' + pg.conf.port);

        servidor = await arrancarServidor({ db: pg.conf, puerto: PUERTO_API, verboso: VERBOSO });
        console.log('   Backend arrancado: el esquema lo creó él solo.\n');

        const api = new ClienteApi(servidor.url);
        const taqueria = await sembrarTaqueria(api, { etiqueta: 'respaldo' });

        // La guarda EMPÍRICA del §38.2: la cuenta que se acaba de registrar por
        // HTTP tiene que aparecer en la base desechable. Si no está, el backend
        // está escribiendo en otra base y aquí se detiene todo — y este guion,
        // que VACÍA la base, es justo el que no puede equivocarse de destino.
        const guarda = new Client(pg.conf);
        await guarda.connect();
        try { await comprobarQueEsNuestraBase(guarda, taqueria.correo); }
        finally { await guarda.end().catch(() => {}); }

        // ── Unas ventas, para que haya pedidos, renglones y dinero ──────────
        const caja = taqueria.api;
        const turno = await caja.exigir('POST', '/api/turnos', {
            nombre: 'Caja 1', fondo_inicial: 500, branch_id: taqueria.sucursales.matriz,
        }, 201);
        for (let i = 0; i < 3; i++) {
            await caja.exigir('POST', '/api/orders', {
                items: [{ product_id: taqueria.productos.pastor.id, quantity: 2 + i }],
                payment_method: 'efectivo',
                type: 'takeout',
                branch_id: taqueria.sucursales.matriz,
            }, 201);
        }
        console.log('   Sembrado: taquería, turno abierto y 3 ventas.\n');

        const conectar = async () => { const c = new Client(pg.conf); await c.connect(); return c; };

        // ── 1. El respaldo ──────────────────────────────────────────────────
        correrScript('respaldar.js', ['--salida=' + carpeta], pg.conf);
        const primeros = fs.readdirSync(carpeta).filter((f) => f.endsWith('.jsonl.gz'));
        af.igual('el respaldo dejó exactamente un archivo', primeros.length, 1);
        const respaldoA = path.join(carpeta, primeros[0]);

        const lineasA = leerLineas(respaldoA);
        const cabecera = JSON.parse(lineasA[0]);
        const cierre = JSON.parse(lineasA[lineasA.length - 1]);
        af.igual('la primera línea es la cabecera', cabecera.tipo, 'cabecera');
        af.igual('la última línea es el cierre', cierre.tipo, 'fin');
        af.cierto('el respaldo trae filas de verdad', cierre.filas > 20, 'solo ' + cierre.filas);
        af.cierto('trae los pedidos', (cierre.conteos.orders || 0) >= 3, JSON.stringify(cierre.conteos.orders));
        af.cierto('trae los renglones de los pedidos', (cierre.conteos.order_items || 0) >= 3, 'ninguno');
        af.cierto('trae los ajustes del negocio (users)', (cierre.conteos.users || 0) >= 1, 'ninguno');

        // Un dato concreto de dinero, para poder exigirlo IDÉNTICO al final.
        const c1 = await conectar();
        const { rows: antes } = await c1.query('SELECT id, total, "createdAt" FROM orders ORDER BY id');
        const { rows: ajustesAntes } = await c1.query('SELECT settings FROM users ORDER BY id LIMIT 1');
        await c1.end();

        // ── 2. La guarda: no restaurar encima de un negocio vivo ────────────
        const encima = correrScript('restaurar.js', [respaldoA], pg.conf, { esperarFallo: true });
        af.igual('🔒 restaurar sobre una base CON DATOS falla', encima.codigo, 1);
        af.cierto('🔒 …y lo explica', /YA TIENE DATOS/.test(encima.salida), encima.salida.slice(-200));

        // ── 3. La guarda: un archivo truncado no se restaura ────────────────
        const truncado = path.join(carpeta, 'truncado.jsonl.gz');
        fs.writeFileSync(truncado, zlib.gzipSync(lineasA.slice(0, -1).join('\n') + '\n'));
        const cortado = correrScript('restaurar.js', [truncado, '--forzar'], pg.conf, { esperarFallo: true });
        af.igual('🔒 un respaldo TRUNCADO se rechaza', cortado.codigo, 1);
        af.cierto('🔒 …y dice que está truncado', /TRUNCADO/.test(cortado.salida), cortado.salida.slice(-200));

        // Y no lo dejó a medias: la base sigue completa.
        const c2 = await conectar();
        const { rows: siguen } = await c2.query('SELECT COUNT(*)::int AS n FROM orders');
        await c2.end();
        af.igual('🔒 …sin haber tocado la base', siguen[0].n, antes.length);

        // ── 4. EL DÍA MALO: vaciar y restaurar ──────────────────────────────
        const c3 = await conectar();
        const { rows: tablas } = await c3.query(
            "SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace " +
            " WHERE n.nspname='public' AND c.relkind='r'"
        );
        await c3.query('TRUNCATE ' + tablas.map((r) => '"' + r.t + '"').join(', ') + ' RESTART IDENTITY CASCADE');
        const { rows: vacio } = await c3.query('SELECT COUNT(*)::int AS n FROM orders');
        await c3.end();
        af.igual('la base quedó VACÍA (el desastre)', vacio[0].n, 0);

        correrScript('restaurar.js', [respaldoA], pg.conf);

        // ── 5. Lo que de verdad importa: ¿volvió IGUAL? ─────────────────────
        const c4 = await conectar();
        const { rows: despues } = await c4.query('SELECT id, total, "createdAt" FROM orders ORDER BY id');
        const { rows: ajustesDespues } = await c4.query('SELECT settings FROM users ORDER BY id LIMIT 1');
        await c4.end();

        af.igual('vuelven los mismos pedidos', despues.length, antes.length);
        af.igual('…con el MISMO total, al centavo', String(despues[0].total), String(antes[0].total));
        af.igual('…y con la MISMA fecha y hora',
            new Date(despues[0].createdAt).toISOString(), new Date(antes[0].createdAt).toISOString());
        af.igual('los ajustes del negocio (JSON) sobreviven enteros',
            JSON.stringify(ajustesDespues[0].settings), JSON.stringify(ajustesAntes[0].settings));

        // ── 6. LA AFIRMACIÓN FUERTE: respaldar otra vez da lo MISMO ─────────
        const carpeta2 = fs.mkdtempSync(path.join(os.tmpdir(), 'zenit-respaldos2-'));
        correrScript('respaldar.js', ['--salida=' + carpeta2], pg.conf);
        const respaldoB = path.join(carpeta2, fs.readdirSync(carpeta2).filter((f) => f.endsWith('.jsonl.gz'))[0]);
        const lineasB = leerLineas(respaldoB);

        // La cabecera lleva la fecha en que se tomó, así que esa línea cambia
        // siempre y es la única que se salta. Todo lo demás tiene que ser igual.
        const cuerpoA = lineasA.slice(1);
        const cuerpoB = lineasB.slice(1);
        af.igual('el respaldo de después tiene las mismas líneas', cuerpoB.length, cuerpoA.length);

        let primeraDiferencia = null;
        for (let i = 0; i < cuerpoA.length && primeraDiferencia === null; i++) {
            if (cuerpoA[i] !== cuerpoB[i]) primeraDiferencia = i;
        }
        af.cierto(
            '🔒 ida y vuelta: los dos respaldos son IDÉNTICOS línea por línea',
            primeraDiferencia === null,
            primeraDiferencia === null ? '' :
                'la línea ' + primeraDiferencia + ' cambió:\n      antes:   ' +
                cuerpoA[primeraDiferencia].slice(0, 220) + '\n      después: ' +
                cuerpoB[primeraDiferencia].slice(0, 220)
        );

        fs.rmSync(carpeta2, { recursive: true, force: true });

        // ── 7. Y las secuencias quedaron al día: se puede seguir vendiendo ──
        const nueva = await caja.exigir('POST', '/api/orders', {
            items: [{ product_id: taqueria.productos.pastor.id, quantity: 1 }],
            payment_method: 'efectivo',
            type: 'takeout',
            branch_id: taqueria.sucursales.matriz,
        }, 201);
        af.cierto('🔒 tras restaurar se puede VENDER (las secuencias quedaron al día)',
            !!nueva.id, 'la venta no se registró');

        console.log('\n  ' + (af.paso ? '✅ PASÓ' : '❌ FALLÓ') + ' · ' + af.comprobaciones + ' comprobaciones\n');
        if (!af.paso) {
            for (const f of af.fallos) console.error('   ✗ ' + f.descripcion + '\n     ' + f.detalle);
            console.error('');
            process.exitCode = 1;
        }
    } catch (e) {
        if (e instanceof ErrorDeGuarda) {
            console.error('\n🔴 GUARDA: ' + e.message + '\n');
        } else if (e instanceof FalloDeAfirmacion) {
            console.error('\n❌ ' + e.message + '\n');
        } else {
            console.error('\n❌ ' + (e && e.stack ? e.stack : e) + '\n');
        }
        process.exitCode = 1;
    } finally {
        fs.rmSync(carpeta, { recursive: true, force: true });
        if (servidor) await servidor.detener().catch(() => {});
        if (pg) await pg.detener().catch(() => {});
    }
}

main();
