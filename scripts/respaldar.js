#!/usr/bin/env node
// ============================================================================
// scripts/respaldar.js — UNA COPIA DE LA BASE, EN UN ARCHIVO
//
//     npm run respaldar
//     npm run respaldar -- --salida=D:/Respaldos --conservar=30
//
// POR QUÉ EXISTE. Supabase está en plan free y el plan free NO RESPALDA NADA
// (verificado en vivo, CLAUDE.md §12). Es el único punto abierto del proyecto
// SIN VUELTA ATRÁS: cualquier otro defecto se arregla después de que ocurra;
// perder la base, no. Esto no sustituye al plan Pro (~25 USD/mes, respaldo
// diario automático y restauración a un punto en el tiempo) — es lo que hay
// mientras esa decisión no se tome, y es infinitamente mejor que nada.
//
// QUÉ GUARDA: los DATOS, no el esquema. Y no es un atajo: este backend CREA su
// propio esquema al arrancar (`syncDatabase` + `runMigrations`, CLAUDE.md §19.4),
// así que para revivir un negocio basta con levantar el backend contra una base
// vacía y volcarle esto encima. Guardar el DDL sería guardar una segunda copia
// —que se desincroniza— de algo que ya vive en el repo.
//
// CÓMO LO GUARDA: JSONL comprimido. Una línea de cabecera, y por cada tabla una
// línea que la anuncia seguida de una línea por fila. Se escribe en streaming,
// así que da igual que la base crezca, y la ÚLTIMA línea es un cierre con el
// conteo de cada tabla: un archivo cortado a la mitad no la tiene, y por eso
// `restaurar.js` puede NEGARSE a restaurar un respaldo truncado en vez de dejar
// el negocio a medias creyendo que se salvó.
//
// ⚠️ Lee una sola vez, en una transacción REPEATABLE READ y de SOLO LECTURA: las
// 31 tablas salen del MISMO instante. Sin eso, un respaldo tomado mientras el
// negocio cobra puede traer un pedido cuyo cliente todavía no existe.
// ============================================================================

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { PassThrough } = require('stream');

const { crearCliente, describirDestino, tablasEnOrdenDeDependencia } = require('./lib/pg-directo');

const args = process.argv.slice(2);
const bandera = (n, pd) => {
    const f = args.find((a) => a.startsWith('--' + n + '='));
    return f ? f.split('=').slice(1).join('=') : pd;
};

const CARPETA = bandera('salida', path.join(__dirname, '..', 'respaldos'));
const CONSERVAR = Number(bandera('conservar', 30));
const FILAS_POR_TANDA = 1000;

/** Un valor de Postgres, en algo que JSON pueda escribir y `restaurar.js` deshacer. */
function aJson(v) {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) return v.toISOString();
    if (Buffer.isBuffer(v)) return { __bytes: v.toString('base64') };
    if (typeof v === 'bigint') return v.toString();
    return v;                       // string, number, boolean, y los objetos de json/jsonb
}

function nombreDeArchivo() {
    const t = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return 'zenit-' + t + '.jsonl.gz';
}

/** Deja solo los N respaldos más recientes. Devuelve cuántos borró. */
function podar(carpeta, conservar) {
    if (!Number.isFinite(conservar) || conservar <= 0) return 0;
    const previos = fs.readdirSync(carpeta)
        .filter((f) => /^zenit-.*\.jsonl\.gz$/.test(f))
        .sort()
        .reverse();
    let borrados = 0;
    for (const viejo of previos.slice(conservar)) {
        fs.unlinkSync(path.join(carpeta, viejo));
        borrados++;
    }
    return borrados;
}

async function main() {
    const destino = describirDestino();
    console.log('\n── Respaldo de Zenit ──');
    console.log('   base:    ' + destino.base + ' en ' + destino.host);
    console.log('   carpeta: ' + CARPETA + '\n');

    fs.mkdirSync(CARPETA, { recursive: true });
    const archivo = path.join(CARPETA, nombreDeArchivo());
    const parcial = archivo + '.parcial';

    const cliente = crearCliente();
    await cliente.connect();

    const lineas = new PassThrough();
    const escrito = pipeline(lineas, zlib.createGzip({ level: 9 }), fs.createWriteStream(parcial));
    const escribir = (obj) => {
        if (!lineas.write(JSON.stringify(obj) + '\n')) {
            return new Promise((res) => lineas.once('drain', res));
        }
        return null;
    };

    const conteos = {};
    let total = 0;

    try {
        // Un solo instante para todas las tablas. READ ONLY además impide que un
        // error tonto de este script escriba algo en la base de producción.
        await cliente.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');

        const { orden, ciclicas } = await tablasEnOrdenDeDependencia(cliente);
        if (ciclicas.length) {
            // `users` y `Branches` se apuntan la una a la otra, así que una de las
            // dos tiene que ir antes que su padre por fuerza. Se dice en voz alta
            // porque es lo que hará que `restaurar.js` recoloque unas pocas filas
            // en su segunda pasada: es normal, no es un aviso de que algo falle.
            console.log('   (ciclo de llaves foráneas roto en: ' + ciclicas.join(', ') + ' — normal)');
        }

        const { rows: cols } = await cliente.query(
            "SELECT table_name, column_name, udt_name, ordinal_position " +
            "  FROM information_schema.columns " +
            " WHERE table_schema = 'public' " +
            " ORDER BY table_name, ordinal_position"
        );
        const columnasDe = new Map();
        for (const c of cols) {
            if (!columnasDe.has(c.table_name)) columnasDe.set(c.table_name, []);
            columnasDe.get(c.table_name).push({ nombre: c.column_name, tipo: c.udt_name });
        }

        // La llave primaria, para volcar cada tabla SIEMPRE en el mismo orden.
        // Dos cosas salen de ahí: dos respaldos seguidos de una base quieta son
        // idénticos (se puede comparar uno con otro), y en una tabla que se
        // apunta a sí misma —`users.business_id → users`— el dueño, que se creó
        // antes y por tanto tiene id menor, sale antes que su empleado.
        const { rows: pks } = await cliente.query(
            "SELECT c.relname AS tabla, a.attname AS col " +
            "  FROM pg_constraint con " +
            "  JOIN pg_class c ON c.oid = con.conrelid " +
            "  JOIN pg_namespace n ON n.oid = c.relnamespace " +
            "  JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true " +
            "  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum " +
            " WHERE con.contype = 'p' AND n.nspname = 'public' " +
            " ORDER BY c.relname, k.ord"
        );
        const llaveDe = new Map();
        for (const r of pks) {
            if (!llaveDe.has(r.tabla)) llaveDe.set(r.tabla, []);
            llaveDe.get(r.tabla).push('"' + r.col + '"');
        }

        await escribir({
            tipo: 'cabecera',
            formato: 1,
            generado_en: new Date().toISOString(),
            base: destino.base,
            host: destino.host,
            tablas: orden,
        });

        for (const tabla of orden) {
            const columnas = columnasDe.get(tabla) || [];
            if (!columnas.length) continue;
            await escribir({ tipo: 'tabla', nombre: tabla, columnas });

            const nombres = columnas.map((c) => '"' + c.nombre + '"').join(', ');
            const llave = llaveDe.get(tabla);
            const orderBy = llave && llave.length ? ' ORDER BY ' + llave.join(', ') : '';
            await cliente.query('DECLARE cur_respaldo NO SCROLL CURSOR FOR SELECT ' + nombres + ' FROM "' + tabla + '"' + orderBy);
            let n = 0;
            for (;;) {
                const { rows } = await cliente.query({
                    text: 'FETCH ' + FILAS_POR_TANDA + ' FROM cur_respaldo',
                    rowMode: 'array',
                });
                if (!rows.length) break;
                for (const fila of rows) {
                    const espera = escribir(fila.map(aJson));
                    if (espera) await espera;
                }
                n += rows.length;
            }
            await cliente.query('CLOSE cur_respaldo');

            conteos[tabla] = n;
            total += n;
            if (n) console.log('   ' + String(n).padStart(7) + '  ' + tabla);
        }

        // La firma de que el archivo está COMPLETO. Sin esta línea, restaurar.js
        // se niega: un respaldo truncado que se restaura en silencio es peor que
        // no tener respaldo, porque nadie vuelve a buscar el bueno.
        await escribir({ tipo: 'fin', filas: total, conteos });
        await cliente.query('COMMIT');
    } catch (e) {
        try { await cliente.query('ROLLBACK'); } catch { /* la conexión ya se cayó */ }
        lineas.end();
        await escrito.catch(() => {});
        fs.rmSync(parcial, { force: true });     // nunca dejar un .parcial que parezca un respaldo
        throw e;
    } finally {
        await cliente.end().catch(() => {});
    }

    lineas.end();
    await escrito;
    // El nombre definitivo se pone AL FINAL, así que lo que lleve extensión de
    // respaldo está siempre entero, incluso si esto se muere a media escritura.
    fs.renameSync(parcial, archivo);

    const mb = (fs.statSync(archivo).size / 1024 / 1024).toFixed(2);
    const borrados = podar(CARPETA, CONSERVAR);

    console.log('\n✅ ' + total.toLocaleString('es-MX') + ' filas de ' + Object.keys(conteos).length +
        ' tablas → ' + path.basename(archivo) + ' (' + mb + ' MB)');
    if (borrados) console.log('   ' + borrados + ' respaldo(s) viejo(s) borrado(s); se conservan los ' + CONSERVAR + ' más recientes.');
    console.log('\n   ⚠️  Un respaldo que vive en el mismo disco que se puede echar a perder no es');
    console.log('       un respaldo. Copia esta carpeta a Drive, a OneDrive o a una USB.\n');
}

main().catch((e) => {
    console.error('\n❌ El respaldo NO se completó: ' + e.message + '\n');
    process.exit(1);
});
