// ============================================================================
// pruebas-postgres/lib/guardas.js — LO QUE IMPIDE QUE ESTO TOQUE PRODUCCIÓN
//
// ⚠️ LÉEME ANTES DE TOCAR NADA DE ESTA CARPETA.
//
// El banco de pruebas registra negocios, vende, cobra y cierra cajas. Si por un
// descuido apuntara a la base real, sembraría negocios falsos DENTRO de los datos
// de clientes reales — y no habría forma de borrarlos: Zenit no tiene (ni debe
// tener) un endpoint que borre un negocio en cascada. Ver PLAN_ARREGLOS_V5.md
// → BLOQUE 15.
//
// EL PELIGRO CONCRETO, Y NO ES HIPOTÉTICO: `zenit-pos-backend/.env` contiene las
// credenciales de la Supabase de PRODUCCIÓN, y la primera línea de `server.js`
// carga dotenv (instrument.js → config/database.js). Arrancar el servidor sin
// cuidado es arrancarlo contra producción.
//
// Por eso hay TRES defensas independientes, y ninguna sustituye a las otras:
//
//   1. ESTRUCTURAL (lib/servidor.js) — el servidor se lanza con el `cwd` en una
//      carpeta temporal vacía. dotenv resuelve `.env` contra `process.cwd()`,
//      así que desde ahí NO ENCUENTRA NINGUNO y las credenciales de producción
//      no llegan a existir en el proceso hijo. Se comprobó que nada del backend
//      usa `process.cwd()` (las rutas van por `__dirname` y el logger es solo
//      consola), así que mover el cwd no rompe nada. Además el hijo recibe un
//      entorno MÍNIMO, no una copia del actual.
//
//   2. DECLARATIVA (este archivo) — antes de conectarse se exige que el host sea
//      local y que el nombre de la base diga "prueba". Cualquier cosa que huela
//      a Supabase, Render o AWS aborta.
//
//   3. EMPÍRICA (comprobarQueEsNuestraBase) — después de arrancar, se busca con
//      NUESTRA conexión la primera cuenta que el banco registró por HTTP. Si no
//      aparece, el servidor está hablando con otra base y todo se detiene antes
//      de sembrar nada más. Es la única defensa que no depende de suponer cómo
//      se comporta dotenv.
//
// Las tres son baratas. La consecuencia de que fallen las tres, no.
// ============================================================================

// Fragmentos que delatan una base que NO es desechable. La lista es de rechazo,
// no de permiso: acertar con un host prohibido es fácil, adivinar todos los
// permitidos no.
const HOSTS_PROHIBIDOS = [
    'supabase', 'pooler', 'amazonaws', 'render.com', 'onrender',
    'neon.tech', 'heroku', 'azure', 'rds.', 'gcp', 'googleapis',
];

const HOSTS_LOCALES = ['127.0.0.1', 'localhost', '::1', '0.0.0.0'];

class ErrorDeGuarda extends Error {}

/**
 * Aborta si la conexión no es inequívocamente local y desechable.
 * Se llama ANTES de arrancar el servidor y ANTES de conectarse.
 */
function exigirBaseDesechable(conf) {
    const host = String(conf.host || '').trim().toLowerCase();

    if (!host) {
        throw new ErrorDeGuarda('No se indicó el host de la base de pruebas.');
    }

    const prohibido = HOSTS_PROHIBIDOS.find((f) => host.includes(f));
    if (prohibido) {
        throw new ErrorDeGuarda(
            'ABORTADO: el host "' + host + '" contiene "' + prohibido + '", que es de una base ALOJADA.\n' +
            '   El banco de pruebas siembra negocios y NO existe forma de borrarlos.\n' +
            '   Solo se permite un PostgreSQL local y desechable.'
        );
    }

    if (!HOSTS_LOCALES.includes(host)) {
        throw new ErrorDeGuarda(
            'ABORTADO: "' + host + '" no es un host local.\n' +
            '   Permitidos: ' + HOSTS_LOCALES.join(', ') + '.\n' +
            '   Levanta el Postgres desechable (Docker o embebido) en lugar de apuntar afuera.'
        );
    }

    // El nombre de la base es la última señal barata: si alguien apunta a su
    // Postgres local de desarrollo, que al menos tenga que decirlo con todas sus
    // letras en el nombre — el banco BORRA y RECREA el esquema en cada corrida.
    const nombre = String(conf.database || '').trim().toLowerCase();
    if (!nombre.includes('prueba')) {
        throw new ErrorDeGuarda(
            'ABORTADO: la base "' + nombre + '" no lleva "prueba" en el nombre.\n' +
            '   El banco BORRA y RECREA el esquema; exigirlo en el nombre evita\n' +
            '   arrasar por accidente una base local que sí importaba.'
        );
    }

    return true;
}

/**
 * Tercera defensa: comprobar EMPÍRICAMENTE que el servidor que acabamos de
 * arrancar escribe en la base que nosotros levantamos.
 *
 * No se fía de la configuración: busca con NUESTRA propia conexión la cuenta que
 * el banco acaba de registrar por HTTP.
 *
 * ⚠️ Verifica una cuenta YA registrada en vez de crear un señuelo propio, y no
 * por elegancia: `POST /api/auth/register` está topado a **5 por hora por IP**
 * (`registerLimiter` en routes/auth.js). Gastar un cupo en un señuelo dejaría al
 * banco con sitio para tres recorridos. Como ese límite vive en la memoria del
 * proceso del backend —que este banco arranca y mata en cada corrida— el
 * contador empieza en cero cada vez: el tope real es de 5 negocios POR CORRIDA.
 *
 * @param {import('pg').Client} cliente  conexión directa a la base desechable
 * @param {string} correo  usuario recién registrado por HTTP
 */
async function comprobarQueEsNuestraBase(cliente, correo) {
    const { rows } = await cliente.query('SELECT id FROM users WHERE username = $1', [correo]);

    if (rows.length !== 1) {
        throw new ErrorDeGuarda(
            'ABORTADO — EL SERVIDOR NO ESTA HABLANDO CON LA BASE DESECHABLE.\n' +
            '   Se registro "' + correo + '" por HTTP y esa fila NO aparece en la base de pruebas.\n' +
            '   Eso significa que el backend esta escribiendo en OTRA base, posiblemente\n' +
            '   la de produccion. Se detiene todo antes de sembrar nada mas.'
        );
    }
    return rows[0].id;
}

module.exports = {
    exigirBaseDesechable,
    comprobarQueEsNuestraBase,
    ErrorDeGuarda,
    HOSTS_PROHIBIDOS,
    HOSTS_LOCALES,
};
