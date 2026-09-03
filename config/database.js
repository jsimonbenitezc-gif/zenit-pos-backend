require('dotenv').config();
const { Sequelize } = require('sequelize');

let sequelize;

// INTERRUPTOR: las mismas pruebas de Jest, sobre PostgreSQL de verdad.
//
// `npm test` sigue usando SQLite en memoria (rápido, sin instalar nada) y ese es
// el camino por defecto: sin `TEST_PG_HOST` NADA de esto cambia.
//
// Con `npm run test:pg` se levanta un Postgres desechable y se corren las MISMAS
// pruebas contra él. Existe porque SQLite no ve una parte del sistema: entre
// otras cosas, las 47 sentencias de `runMigrations()` están dentro de un
// `if (dialect === 'postgres')`, así que en SQLite no se ejecuta ni una — y son
// justo las que crean las columnas al desplegar. Ver CLAUDE.md §38 y §39.
const usarPostgresEnTests = process.env.NODE_ENV === 'test' && process.env.TEST_PG_HOST;

if (usarPostgresEnTests) {
    // Cinturón: estas pruebas BORRAN Y RECREAN el esquema entero
    // (`sequelize.sync({ force: true })` en tests/setup.js). Apuntarlas a una base
    // alojada arrasaría con ella, así que solo se admite una local y desechable.
    // Es la misma regla del banco de pruebas (pruebas-postgres/lib/guardas.js).
    const host = String(process.env.TEST_PG_HOST).toLowerCase();
    const base = String(process.env.TEST_PG_NAME || '').toLowerCase();
    if (!['127.0.0.1', 'localhost', '::1'].includes(host) || !base.includes('prueba')) {
        throw new Error(
            `TEST_PG_HOST="${host}" / TEST_PG_NAME="${base}" no es una base local de pruebas. ` +
            'Estas pruebas BORRAN el esquema: solo se permite un PostgreSQL local cuya base ' +
            'lleve "prueba" en el nombre.'
        );
    }

    sequelize = new Sequelize(
        process.env.TEST_PG_NAME,
        process.env.TEST_PG_USER,
        process.env.TEST_PG_PASSWORD,
        {
            host: process.env.TEST_PG_HOST,
            port: process.env.TEST_PG_PORT,
            dialect: 'postgres',
            logging: false,
        }
    );
} else if (process.env.NODE_ENV === 'test') {
    // Tests: SQLite en memoria (sin necesidad de PostgreSQL)
    sequelize = new Sequelize({
        dialect: 'sqlite',
        storage: ':memory:',
        logging: false,
    });
} else {
    sequelize = new Sequelize(
        process.env.DB_NAME,
        process.env.DB_USER,
        process.env.DB_PASSWORD,
        {
            host: process.env.DB_HOST,
            port: process.env.DB_PORT,
            dialect: 'postgres',
            logging: process.env.NODE_ENV === 'development' ? console.log : false,
            pool: {
                // Supabase pooler en session mode limita a 15 clientes.
                // Mantener max por debajo de ese tope evita EMAXCONNSESSION
                // (500 intermitentes) cuando el desktop dispara la ráfaga de sync inicial.
                max: 10,
                min: 2,
                acquire: 30000,
                idle: 10000
            }
        }
    );

    // Test connection
    sequelize.authenticate()
        .then(() => {
            console.log('✅ Database connected successfully');
        })
        .catch(err => {
            console.error('❌ Unable to connect to database:', err);
        });
}

module.exports = sequelize;