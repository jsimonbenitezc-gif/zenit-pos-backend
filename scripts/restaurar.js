#!/usr/bin/env node
// ============================================================================
// scripts/restaurar.js — DEVOLVER UN RESPALDO A UNA BASE
//
//     node scripts/restaurar.js respaldos/zenit-2026-09-17T22-30-00.jsonl.gz
//     node scripts/restaurar.js <archivo> --forzar      (VACÍA la base primero)
//
// Un respaldo que nunca se ha restaurado no es un respaldo: es un archivo que
// se supone que sirve. Por eso esto existe desde el primer día y por eso hay
// una prueba que lo ejercita de verdad (`npm run probar:respaldo`).
//
// EL ORDEN DE USO, el día malo:
//   1. Levantar el backend contra la base vacía → él crea el esquema solo
//      (`syncDatabase` + `runMigrations`, CLAUDE.md §19.4). Y apagarlo.
//   2. Correr esto.
//
// TRES GUARDAS, y ninguna sobra:
//   · un archivo SIN su línea de cierre se rechaza — está truncado;
//   · una base CON DATOS se rechaza salvo `--forzar` — restaurar encima de un
//     negocio vivo mezcla dos historias y no hay cómo separarlas después;
//   · al terminar se CUENTAN las filas y se comparan contra el manifiesto. Una
//     restauración que dice "listo" sin comprobar es la misma promesa vacía que
//     el respaldo que nadie probó.
// ============================================================================

const fs = require('fs');
const zlib = require('zlib');
const readline = require('readline');

const { crearCliente, describirDestino, tablasEnOrdenDeDependencia } = require('./lib/pg-directo');

const args = process.argv.slice(2);
const ARCHIVO = args.find((a) => !a.startsWith('--'));
const FORZAR = args.includes('--forzar');
const MAX_PARAMS = 60000;               // Postgres topa en 65535 por sentencia

if (!ARCHIVO) {
    console.error('\nUso: node scripts/restaurar.js <respaldo.jsonl.gz> [--forzar]\n');
    process.exit(1);
}
if (!fs.existsSync(ARCHIVO)) {
    console.error('\n❌ No existe el archivo: ' + ARCHIVO + '\n');
    process.exit(1);
}

/** Deshace lo que hizo `aJson()` del respaldo. */
function aParametro(valor, tipo) {
    if (valor === null || valor === undefined) return null;
    if (typeof valor === 'object' && valor.__bytes) return Buffer.from(valor.__bytes, 'base64');
    // Una columna json/jsonb viaja como objeto: hay que devolvérsela a Postgres
    // como TEXTO json, no como un objeto que node-pg interprete por su cuenta.
    if (tipo === 'json' || tipo === 'jsonb') return JSON.stringify(valor);
    if (typeof valor === 'object') return JSON.stringify(valor);
    return valor;
}

/** Lee el archivo entero a memoria por tabla, en tandas: {cabecera, tablas:[{nombre,columnas,filas}], fin} */
async function leerRespaldo(ruta) {
    const lector = readline.createInterface({
        input: fs.createReadStream(ruta).pipe(zlib.createGunzip()),
        crlfDelay: Infinity,
    });

    let cabecera = null, fin = null;
    const tablas = [];
    let actual = null;

    for await (const linea of lector) {
        if (!linea.trim()) continue;
        const dato = JSON.parse(linea);
        if (Array.isArray(dato)) {
            if (!actual) throw new Error('el archivo trae una fila antes de decir de qué tabla es');
            actual.filas.push(dato);
            continue;
        }
        if (dato.tipo === 'cabecera') cabecera = dato;
        else if (dato.tipo === 'tabla') { actual = { nombre: dato.nombre, columnas: dato.columnas, filas: [] }; tablas.push(actual); }
        else if (dato.tipo === 'fin') fin = dato;
    }

    if (!cabecera) throw new Error('el archivo no tiene cabecera: no es un respaldo de Zenit');
    if (!fin) throw new Error('el archivo NO tiene su línea de cierre: está TRUNCADO. No se restaura.');
    return { cabecera, tablas, fin };
}

async function main() {
    const destino = describirDestino();
    const { cabecera, tablas, fin } = await leerRespaldo(ARCHIVO);

    console.log('\n── Restaurar un respaldo de Zenit ──');
    console.log('   archivo: ' + ARCHIVO);
    console.log('   tomado:  ' + cabecera.generado_en + ' de ' + cabecera.base + ' en ' + cabecera.host);
    console.log('   filas:   ' + fin.filas.toLocaleString('es-MX'));
    console.log('   DESTINO: ' + destino.base + ' en ' + destino.host + (FORZAR ? '   ⚠️  --forzar: se VACÍA primero' : '') + '\n');

    const cliente = crearCliente();
    await cliente.connect();

    let restauradas = 0;
    const conteos = {};

    try {
        const { orden } = await tablasEnOrdenDeDependencia(cliente);
        const existentes = new Set(orden);

        // ── Guarda: no restaurar encima de un negocio vivo ───────────────────
        const conDatos = [];
        for (const t of orden) {
            const { rows } = await cliente.query('SELECT 1 FROM "' + t + '" LIMIT 1');
            if (rows.length) conDatos.push(t);
        }
        if (conDatos.length && !FORZAR) {
            throw new Error(
                'la base de destino YA TIENE DATOS (' + conDatos.slice(0, 4).join(', ') +
                (conDatos.length > 4 ? ', …' : '') + '). Restaurar encima mezclaría dos historias.\n' +
                '   Si de verdad quieres VACIARLA y dejar solo este respaldo, repite con --forzar.'
            );
        }

        await cliente.query('BEGIN');

        if (conDatos.length) {
            const lista = orden.map((t) => '"' + t + '"').join(', ');
            console.log('   Vaciando ' + orden.length + ' tablas…');
            await cliente.query('TRUNCATE ' + lista + ' RESTART IDENTITY CASCADE');
        }

        // ── Inserción, en el orden en que el respaldo las guardó ─────────────
        // (que es el de dependencias: las padres primero). Lo que aun así falle
        // por una llave foránea se aparta y se reintenta al final: cubre las
        // tablas que se apuntan a sí mismas, como `users.business_id → users`.
        const pendientes = [];

        for (const tabla of tablas) {
            if (!existentes.has(tabla.nombre)) {
                console.log('   ⚠️  "' + tabla.nombre + '" no existe en el destino: se SALTA (' + tabla.filas.length + ' filas)');
                continue;
            }
            if (!tabla.filas.length) { conteos[tabla.nombre] = 0; continue; }

            const cols = tabla.columnas.map((c) => '"' + c.nombre + '"').join(', ');
            const tipos = tabla.columnas.map((c) => c.tipo);
            const porTanda = Math.max(1, Math.floor(MAX_PARAMS / tabla.columnas.length));
            let puestas = 0;

            for (let i = 0; i < tabla.filas.length; i += porTanda) {
                const tanda = tabla.filas.slice(i, i + porTanda);
                const insertadas = await insertarTanda(cliente, tabla.nombre, cols, tipos, tanda, pendientes);
                puestas += insertadas;
            }
            conteos[tabla.nombre] = puestas;
            restauradas += puestas;
            if (puestas) console.log('   ' + String(puestas).padStart(7) + '  ' + tabla.nombre);
        }

        if (pendientes.length) {
            console.log('   ' + pendientes.length + ' fila(s) esperaban a su padre: segunda pasada…');
            for (const p of pendientes) {
                const insertadas = await insertarTanda(cliente, p.tabla, p.cols, p.tipos, [p.fila], null);
                conteos[p.tabla] = (conteos[p.tabla] || 0) + insertadas;
                restauradas += insertadas;
            }
        }

        // ── Las secuencias, o el próximo INSERT choca con un id ya usado ─────
        let secuencias = 0;
        for (const t of orden) {
            const { rows } = await cliente.query(
                "SELECT a.attname AS col, pg_get_serial_sequence($1, a.attname) AS sec " +
                "  FROM pg_attribute a " +
                " WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped",
                ['"' + t + '"']
            );
            for (const r of rows) {
                if (!r.sec) continue;
                await cliente.query(
                    'SELECT setval($1, GREATEST(COALESCE((SELECT MAX("' + r.col + '") FROM "' + t + '"), 0), 1), ' +
                    '(SELECT COUNT(*) FROM "' + t + '") > 0)',
                    [r.sec]
                );
                secuencias++;
            }
        }

        await cliente.query('COMMIT');
        console.log('   ' + secuencias + ' secuencia(s) puestas al día.');
    } catch (e) {
        try { await cliente.query('ROLLBACK'); } catch { /* ya se cayó */ }
        await cliente.end().catch(() => {});
        console.error('\n❌ NO se restauró nada (la transacción se deshizo entera): ' + e.message + '\n');
        process.exit(1);
    }

    // ── La comprobación que hace creíble todo lo anterior ────────────────────
    const diferencias = [];
    for (const [tabla, esperadas] of Object.entries(fin.conteos)) {
        const { rows } = await cliente.query('SELECT COUNT(*)::int AS n FROM "' + tabla + '"').catch(() => ({ rows: [{ n: -1 }] }));
        const hay = rows[0].n;
        if (hay !== esperadas) diferencias.push(tabla + ': esperaba ' + esperadas + ', hay ' + hay);
    }
    await cliente.end().catch(() => {});

    if (diferencias.length) {
        console.error('\n❌ La restauración NO cuadra con el respaldo:');
        for (const d of diferencias) console.error('   · ' + d);
        console.error('');
        process.exit(1);
    }

    console.log('\n✅ ' + restauradas.toLocaleString('es-MX') + ' filas restauradas, y el conteo de cada tabla CUADRA con el respaldo.\n');
}

/** Mete una tanda. Si choca por llave foránea y hay dónde apartarla, la aparta. */
async function insertarTanda(cliente, tabla, cols, tipos, filas, pendientes) {
    const valores = [];
    const marcas = [];
    let p = 1;
    for (const fila of filas) {
        marcas.push('(' + fila.map(() => '$' + p++).join(', ') + ')');
        fila.forEach((v, i) => valores.push(aParametro(v, tipos[i])));
    }
    const sql = 'INSERT INTO "' + tabla + '" (' + cols + ') VALUES ' + marcas.join(', ');

    await cliente.query('SAVEPOINT tanda');
    try {
        await cliente.query(sql, valores);
        await cliente.query('RELEASE SAVEPOINT tanda');
        return filas.length;
    } catch (e) {
        await cliente.query('ROLLBACK TO SAVEPOINT tanda');
        // 23503 = llave foránea. Solo ése se aparta: cualquier otro error es un
        // problema de verdad y tiene que tumbar la restauración entera.
        if (e.code !== '23503' || !pendientes) throw e;
        if (filas.length === 1) { pendientes.push({ tabla, cols, tipos, fila: filas[0] }); return 0; }
        // Partir la tanda para no apartar 999 filas buenas por una que falla.
        const mitad = Math.ceil(filas.length / 2);
        return (await insertarTanda(cliente, tabla, cols, tipos, filas.slice(0, mitad), pendientes))
             + (await insertarTanda(cliente, tabla, cols, tipos, filas.slice(mitad), pendientes));
    }
}

main().catch((e) => {
    console.error('\n❌ ' + e.message + '\n');
    process.exit(1);
});
