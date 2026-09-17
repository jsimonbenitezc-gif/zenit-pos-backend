// ============================================================================
// scripts/lib/pg-directo.js — una conexión `pg` pelada, con el MISMO TLS
//
// Por qué no se reusa `config/database.js`: ese módulo exporta un Sequelize que
// se autoconecta al importarlo y trae un pool. El respaldo necesita UNA conexión
// y, sobre todo, un CURSOR de servidor — que Sequelize no expone. La política de
// TLS sí se copia tal cual de ahí (CLAUDE.md §42.1): cifrar siempre salvo host
// local, verificar el certificado solo si hay `DB_SSL_CA`, y `DB_SSL=false` como
// escape sin desplegar código.
// ============================================================================
require('dotenv').config();
const { Client } = require('pg');

function esHostLocal(host) {
    const h = String(host || '').toLowerCase().trim();
    return h === '' || h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === 'host.docker.internal';
}

/** Descripción legible de a qué base apunta esto, para IMPRIMIRLA antes de tocar nada. */
function describirDestino() {
    if (process.env.DATABASE_URL) {
        try {
            const u = new URL(process.env.DATABASE_URL);
            return { host: u.hostname, base: u.pathname.replace(/^\//, ''), usuario: decodeURIComponent(u.username) };
        } catch {
            return { host: '(DATABASE_URL ilegible)', base: '?', usuario: '?' };
        }
    }
    return { host: process.env.DB_HOST || '(sin DB_HOST)', base: process.env.DB_NAME || '?', usuario: process.env.DB_USER || '?' };
}

function crearCliente() {
    const destino = describirDestino();
    const ssl = (process.env.DB_SSL === 'false' || esHostLocal(destino.host))
        ? false
        : { require: true, rejectUnauthorized: !!process.env.DB_SSL_CA, ...(process.env.DB_SSL_CA ? { ca: process.env.DB_SSL_CA } : {}) };

    if (process.env.DATABASE_URL) {
        return new Client({ connectionString: process.env.DATABASE_URL, ssl });
    }
    return new Client({
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT || 5432),
        database: process.env.DB_NAME,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        ssl,
    });
}

/**
 * Las tablas de `public`, ORDENADAS POR DEPENDENCIA (las padres primero).
 *
 * El orden importa para restaurar: insertar `orders` antes que `users` choca
 * contra la llave foránea. Se saca del propio Postgres (pg_constraint) y no de
 * una lista escrita a mano, así que una tabla nueva —las `bot_*` del recepcionista,
 * por ejemplo— entra sola sin que nadie se acuerde de agregarla aquí.
 */
async function tablasEnOrdenDeDependencia(cliente) {
    const { rows: tablas } = await cliente.query(`
        SELECT c.relname AS nombre
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r'
         ORDER BY c.relname
    `);
    const nombres = tablas.map((t) => t.nombre);

    const { rows: fks } = await cliente.query(`
        SELECT src.relname AS hija, dst.relname AS padre
          FROM pg_constraint k
          JOIN pg_class src ON src.oid = k.conrelid
          JOIN pg_class dst ON dst.oid = k.confrelid
          JOIN pg_namespace n ON n.oid = src.relnamespace
         WHERE k.contype = 'f' AND n.nspname = 'public'
    `);

    const padresDe = new Map(nombres.map((n) => [n, new Set()]));
    for (const { hija, padre } of fks) {
        // Una tabla que se apunta a sí misma (users.business_id → users) no es una
        // dependencia entre tablas: se resuelve sola dentro del mismo INSERT.
        if (hija !== padre && padresDe.has(hija) && padresDe.has(padre)) padresDe.get(hija).add(padre);
    }

    const orden = [];
    const puestas = new Set();
    const ciclicas = [];

    // Kahn a mano. ⚠️ ESTE ESQUEMA SÍ TIENE UN CICLO, y no es un defecto:
    // `users.branch_id → Branches` y `Branches.business_id → users` se apuntan
    // la una a la otra. La primera versión de esto se rendía al topárselo y
    // mandaba al final las DOS tablas… y con ellas las siete que dependen de
    // ellas (mesas, stock por sucursal, movimientos…), que sí tenían un orden
    // perfectamente bueno. El respaldo salía igual, pero la restauración tenía
    // que reintentar fila por fila media base.
    //
    // Así que cuando nos atascamos NO se abandona: se rompe el ciclo a
    // propósito, colocando la tabla que menos padres pendientes tiene (con
    // empate, la que más tablas dependen de ella — meter `users` antes que
    // `Branches` desbloquea el resto). Esa sola tabla queda marcada, y sus filas
    // huérfanas las recoloca `restaurar.js` en su segunda pasada.
    const hijosDe = new Map(nombres.map((n) => [n, 0]));
    for (const t of nombres) for (const p of padresDe.get(t)) hijosDe.set(p, hijosDe.get(p) + 1);

    while (puestas.size < nombres.length) {
        let cambio = true;
        while (cambio) {
            cambio = false;
            for (const t of nombres) {
                if (puestas.has(t)) continue;
                if ([...padresDe.get(t)].every((p) => puestas.has(p))) {
                    orden.push(t); puestas.add(t); cambio = true;
                }
            }
        }
        if (puestas.size === nombres.length) break;

        const restantes = nombres.filter((t) => !puestas.has(t));
        restantes.sort((a, b) => {
            const fa = [...padresDe.get(a)].filter((p) => !puestas.has(p)).length;
            const fb = [...padresDe.get(b)].filter((p) => !puestas.has(p)).length;
            return fa !== fb ? fa - fb : hijosDe.get(b) - hijosDe.get(a);
        });
        const rota = restantes[0];
        orden.push(rota); puestas.add(rota); ciclicas.push(rota);
    }

    return { orden, ciclicas };
}

module.exports = { crearCliente, describirDestino, esHostLocal, tablasEnOrdenDeDependencia };
