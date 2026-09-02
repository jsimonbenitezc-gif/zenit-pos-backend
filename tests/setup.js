/**
 * Test setup — configura entorno, app Express ligera y helpers.
 *
 * Cada archivo de test debe:
 *   1. Llamar jest.mock('../utils/push', ...) ANTES de require('./setup')
 *   2. Llamar initTestDb() en beforeAll
 *   3. Llamar sequelize.close() en afterAll
 */
process.env.JWT_SECRET = 'test-jwt-secret-zenit-pos';
process.env.NODE_ENV = 'test';

const express = require('express');
const jwt = require('jsonwebtoken');
const sequelize = require('../config/database');
const models = require('../models');

const { manejadorDeErrores, LIMITE_BODY } = require('../middleware/errorHandler');
const { limpiarCacheUsuarios } = require('../middleware/auth');
const { limpiarCacheImpuestos } = require('../utils/impuestos');
const { limpiarCachePropinas } = require('../utils/propinas');
const { limpiarCacheModificadores } = require('../utils/modificadores');
const { limpiarCacheDispositivos, limpiarCodigosEmparejamiento } = require('../utils/kdsDevices');
const { _limpiarAvisos } = require('../utils/horarios');

// ── App Express ligera (sin Sentry, CORS, helmet, cron) ──
// El límite del body y el manejador de errores son los MISMOS que en server.js,
// para poder probar el mensaje de "contenido demasiado grande".
const app = express();
app.use(express.json({ limit: LIMITE_BODY }));

app.use('/api/auth',       require('../routes/auth'));
app.use('/api/products',   require('../routes/products'));
app.use('/api/categories', require('../routes/categories'));
app.use('/api/orders',     require('../routes/orders'));
app.use('/api/customers',  require('../routes/customers'));
app.use('/api/inventory',  require('../routes/inventory'));
app.use('/api/modifiers',  require('../routes/modifiers'));
app.use('/api/staff',      require('../routes/staff'));
app.use('/api/stats',      require('../routes/stats'));
app.use('/api/settings',   require('../routes/settings'));
app.use('/api/turnos',     require('../routes/turnos'));
app.use('/api/tables',     require('../routes/tables'));
app.use('/api/kds',        require('../routes/kds'));
app.use('/api/audit',      require('../routes/audit'));

app.use(manejadorDeErrores);

// ── Inicializar DB de test ───────────────────────────────
let relationsReady = false;

async function initTestDb() {
    if (!relationsReady) {
        // syncDatabase() llama setupRelations() + sync() + runMigrations()
        // Las migraciones PostgreSQL fallan silenciosamente en SQLite (OK).
        const origLog = console.log;
        const origErr = console.error;
        console.log = () => {};
        console.error = () => {};
        try {
            await models.syncDatabase();
        } finally {
            console.log = origLog;
            console.error = origErr;
        }
        relationsReady = true;
    }
    // Limpiar todas las tablas para estado inicial limpio
    await sequelize.sync({ force: true });

    // `force: true` reinicia los autoincrement: sin esto, un id reutilizado podría
    // leer datos cacheados del usuario anterior (cachés de middleware/auth.js y
    // utils/impuestos.js y utils/propinas.js, todas indexadas por id).
    limpiarCacheUsuarios();
    limpiarCacheImpuestos();
    limpiarCachePropinas();
    limpiarCacheModificadores();
    // Los dispositivos del KDS se cachean por el hash del secreto, y los tests
    // reutilizan los mismos secretos: sin esto, un test leería el dispositivo
    // (y el negocio) del test anterior.
    limpiarCacheDispositivos();
    limpiarCodigosEmparejamiento();
    // El horario se cachea por negocio 60 s y los avisos fuera de horario se
    // agrupan en memoria: sin limpiar, un test heredaría el horario del anterior
    // (mismo id reutilizado) y contaría avisos que no provocó.
    _limpiarAvisos();
}

// ── Helper: fijar el horario de un negocio ───────────────
// Los tests necesitan un negocio "abierto" o "cerrado" AHORA MISMO sin depender
// de a qué hora se corran. Se construye la semana entera alrededor del instante
// actual del reloj del negocio.
const { normalizarZona, diaSemanaLocal, invalidarZonaNegocio } = require('../utils/tz');
const { invalidarHorarioNegocio } = require('../utils/horarios');

/**
 * Deja al negocio ABIERTO o CERRADO en este preciso instante, corra el test a la
 * hora que corra. La semana se construye alrededor del reloj actual del negocio.
 *
 * ⚠️ El día "cerrado" es SOLO el de hoy; los otros seis quedan 09:00–18:00. Poner
 * los siete cerrados no serviría: `normalizarHorario` lo interpreta —a propósito—
 * como "sin horario definido", y el test acabaría probando el caso contrario al
 * que dice probar.
 *
 * @param {'abierto'|'cerrado'} estado
 */
async function fijarHorario(user, estado, tz = 'America/Mexico_City') {
    const zona = normalizarZona(tz);
    const ahora = new Date();
    const hoy = diaSemanaLocal(zona, ahora);

    // "Abierto" se expresa como 24 h (`abre === cierra`) y no como una ventana
    // alrededor de la hora actual: una ventana tiene bordes, y un test que corra
    // a las 23:59 caería justo en uno. Un test intermitente es peor que ninguno.
    const abierto = { cerrado: false, abre: '00:00', cierra: '00:00' };
    const normal  = { cerrado: false, abre: '09:00', cierra: '18:00' };

    const semana = Array.from({ length: 7 }, (_, i) =>
        i === hoy ? (estado === 'abierto' ? abierto : { cerrado: true }) : normal
    );

    const settings = user.settings ? JSON.parse(user.settings) : {};
    settings.tz = zona;
    settings.horario_operacion = semana;
    await user.update({ settings: JSON.stringify(settings) });
    const biz = user.business_id || user.id;
    invalidarHorarioNegocio(biz);
    invalidarZonaNegocio(biz);
    return { semana, hoy };
}

// ── Helper: crear usuario owner con JWT ──────────────────
async function createTestOwner(overrides = {}) {
    const uid = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const user = await models.User.create({
        username: `owner_${uid}@test.com`,
        password: 'TestPass123',
        name: 'Test Owner',
        role: 'owner',
        plan: 'premium',
        plan_expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        ...overrides,
    });
    const bizId = user.business_id || user.id;
    const token = jwt.sign(
        { id: user.id, username: user.username, role: user.role, business_id: bizId },
        process.env.JWT_SECRET,
        { expiresIn: '1d' }
    );
    return { user, token };
}

module.exports = { app, sequelize, models, initTestDb, createTestOwner, fijarHorario };
