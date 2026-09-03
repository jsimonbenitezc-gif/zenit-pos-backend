#!/usr/bin/env node
// ============================================================================
// pruebas-postgres/correr-jest.js — LAS MISMAS PRUEBAS, SOBRE POSTGRES DE VERDAD
//
//     npm run test:pg                      # las 395 completas
//     npm run test:pg -- tests/orders      # solo unas
//
// `npm test` sigue corriendo sobre SQLite en memoria, que es rápido y no exige
// instalar nada: ese es y debe seguir siendo el camino del día a día. Esto es el
// OTRO camino, para la revisión antes de desplegar.
//
// POR QUÉ HACE FALTA. SQLite no ve una parte del sistema:
//   • las 47 sentencias de `runMigrations()` viven dentro de un
//     `if (dialect === 'postgres')`, así que en SQLite no corre NI UNA — y son
//     las que crean las columnas al desplegar;
//   • SQLite ignora `FOR UPDATE` (el bug que estuvo un mes vivo, §19.25);
//   • Postgres devuelve los DECIMAL como texto ("22.00") y SQLite como número;
//   • Postgres distingue mayúsculas en los nombres de tabla ("Branches").
//
// ⚠️ VA EN SERIE (`--runInBand`), y no es por prudencia: `tests/setup.js` hace
// `sequelize.sync({ force: true })` en cada archivo, o sea BORRA Y RECREA todas
// las tablas. Con Jest en paralelo, cuatro procesos harían eso a la vez sobre la
// misma base y se destrozarían entre ellos: los fallos serían aleatorios y no
// dirían nada. Cuesta tiempo; a cambio, lo que falla falla de verdad.
// ============================================================================

const { spawn } = require('child_process');
const path = require('path');
const { levantarPostgres } = require('./lib/postgres');

const args = process.argv.slice(2);
const VERBOSO = args.includes('--verboso');
const argsJest = args.filter((a) => a !== '--verboso');

async function principal() {
    console.log('');
    console.log('══════════════════════════════════════════════════════════════');
    console.log('  LAS PRUEBAS DE SIEMPRE, PERO SOBRE POSTGRESQL REAL');
    console.log('══════════════════════════════════════════════════════════════');

    process.stdout.write('\n· Levantando PostgreSQL desechable... ');
    // Puerto distinto al del banco (55432) para poder correr los dos a la vez.
    const pg = await levantarPostgres({ puerto: 55433, verboso: VERBOSO });
    console.log('listo (' + pg.modo + ')');
    console.log('  base "' + pg.conf.database + '" · se destruye al terminar\n');

    let salida = 0;
    try {
        salida = await new Promise((resolver) => {
            const jest = spawn(
                process.execPath,
                [
                    path.join(__dirname, '..', 'node_modules', 'jest', 'bin', 'jest.js'),
                    '--runInBand',
                    '--forceExit',
                    ...argsJest,
                ],
                {
                    cwd: path.join(__dirname, '..'),
                    env: Object.assign({}, process.env, {
                        NODE_ENV: 'test',
                        TEST_PG_HOST: pg.conf.host,
                        TEST_PG_PORT: String(pg.conf.port),
                        TEST_PG_NAME: pg.conf.database,
                        TEST_PG_USER: pg.conf.user,
                        TEST_PG_PASSWORD: pg.conf.password,
                    }),
                    stdio: 'inherit',
                }
            );
            jest.on('exit', (codigo) => resolver(codigo === 0 ? 0 : 1));
        });
    } finally {
        process.stdout.write('\n· Limpiando... ');
        try { await pg.detener(); } catch { /* da igual */ }
        console.log('base desechable destruida.');
    }

    process.exit(salida);
}

principal().catch((err) => {
    console.error('Fallo no controlado:', err.message);
    process.exit(1);
});
