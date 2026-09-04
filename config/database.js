require('dotenv').config();
const { Sequelize } = require('sequelize');

let sequelize;

/** ¿La base vive en esta misma máquina? (dev, o el Postgres desechable del §38) */
function esHostLocal(host) {
    const h = String(host || '').toLowerCase().trim();
    return h === '' || h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === 'host.docker.internal';
}

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
            // ─── TLS hacia Supabase ────────────────────────────────────────
            // 🔴 MEDIDO EL 2026-09-04, NO SUPUESTO: sin esto la conexión viajaba
            // en TEXTO PLANO (`socket.getProtocol()` devolvía null). El pooler
            // acepta las dos, así que nada fallaba y nada lo decía — la
            // contraseña de la base y todos los datos del negocio iban sin
            // cifrar entre Render y AWS. Con esto: TLSv1.3.
            //
            // ⚠️ `pg_stat_ssl` NO sirve para comprobarlo: a través del pooler
            // reporta el tramo Supavisor → Postgres, no el nuestro. Hay que
            // mirar el socket del cliente.
            //
            // `rejectUnauthorized` queda en false MIENTRAS no haya certificado:
            // Supabase firma con su propia CA ("Supabase Intermediate 2021 CA"),
            // que no está en el almacén de Node, así que verificar falla con
            // "self-signed certificate in certificate chain". Eso CIFRA pero no
            // AUTENTICA al servidor: protege de que alguien escuche por el
            // camino, no de que alguien se haga pasar por la base.
            //
            // Para cerrarlo del todo: bajar el certificado del panel de Supabase
            // (Settings → Database → SSL Configuration) y ponerlo en la variable
            // `DB_SSL_CA` de Render. Con ella, la verificación se activa sola y
            // no hay que tocar este archivo.
            //
            // Escape: `DB_SSL=false` desactiva el TLS sin desplegar código, por
            // si el pooler cambiara y el arranque dejara de conectar.
            //
            // ⚠️ Se salta en un host LOCAL, y no es un detalle: un PostgreSQL de
            // desarrollo (o el desechable del banco de pruebas, §38) no tiene TLS
            // y exigírselo deja al backend sin conectar. La primera versión de
            // esto no lo contemplaba y el banco lo cazó al instante — "el backend
            // no llegó a responder /health". Cifrar el tramo entre dos procesos
            // de la misma máquina no protege de nada.
            ...(process.env.DB_SSL === 'false' || esHostLocal(process.env.DB_HOST) ? {} : {
                dialectOptions: {
                    ssl: {
                        require: true,
                        rejectUnauthorized: !!process.env.DB_SSL_CA,
                        ...(process.env.DB_SSL_CA ? { ca: process.env.DB_SSL_CA } : {}),
                    },
                },
            }),
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