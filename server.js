// Sentry primero que nada: instrumenta express/pg/http al cargarse (ver instrument.js).
// También carga dotenv, así que las variables ya están disponibles debajo.
const { Sentry, sentryActivo } = require('./instrument');

// Validar variables de entorno obligatorias antes de arrancar
const variablesObligatorias = ['JWT_SECRET', 'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'];
const faltantes = variablesObligatorias.filter(v => !process.env[v]);
if (faltantes.length > 0) {
    console.error(`[FATAL] Variables de entorno faltantes: ${faltantes.join(', ')}`);
    process.exit(1);
}

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const { syncDatabase } = require('./models');
const logger = require('./utils/logger');
const { manejadorDeErrores, LIMITE_BODY } = require('./middleware/errorHandler');

const app = express();
const PORT = process.env.PORT || 3000;

// Confiar en el proxy de Render.com (necesario para que el rate limiter funcione correctamente)
app.set('trust proxy', 1);

// Orígenes permitidos para conectarse al API
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);

// El propio backend sirve páginas HTML (reset-password, billing, kds) que hacen
// fetch al mismo dominio. El navegador manda Origin = origen del backend, así que
// hay que permitir su PROPIO origen o CORS lo rechaza con 500. Se deriva de APP_URL.
const selfOrigin = (process.env.APP_URL || 'https://zenit-pos-backend.onrender.com').replace(/\/+$/, '');
if (selfOrigin && !allowedOrigins.includes(selfOrigin)) allowedOrigins.push(selfOrigin);

app.use(cors({
    origin: (origin, callback) => {
        // Permitir requests sin origen (apps de escritorio, mobile, Postman, etc.)
        if (!origin) return callback(null, true);
        // Permitir si el origen está en la lista
        if (allowedOrigins.includes(origin)) return callback(null, true);
        callback(new Error('Origen no permitido por CORS'));
    },
    credentials: true
}));

// Headers de seguridad (helmet)
// contentSecurityPolicy desactivado porque el KDS usa inline scripts/styles
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
}));

// Billing (Stripe webhook necesita body sin parsear — DEBE ir antes de express.json)
app.use('/api/billing', require('./routes/billing'));

// (El SDK v8+ no necesita un requestHandler: la instrumentación de Express se
//  engancha sola en Sentry.init(). Solo hay que registrar el handler de errores
//  después de las rutas — más abajo.)

// Límite explícito del body: las fotos viajan como data-URI base64 y el default de
// Express (100kb) las rechazaba con un 500 genérico. Ver middleware/errorHandler.js.
app.use(express.json({ limit: LIMITE_BODY }));
app.use(express.urlencoded({ extended: true, limit: LIMITE_BODY }));

// Logging
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});

// Routes
app.get('/', (req, res) => {
    res.json({
        message: 'Zenit POS API',
        version: '1.0.0',
        status: 'running'
    });
});

// Archivos estáticos (billing pages, KDS)
app.use(express.static(path.join(__dirname, 'public')));

// Páginas de retorno de Stripe Checkout (el navegador redirige aquí tras el pago)
app.get('/billing-success', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'billing-success.html'));
});

app.get('/billing-cancel', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'billing-cancel.html'));
});

app.get('/billing-return', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'billing-return.html'));
});

// ─── GET /kds — Página web de la pantalla de cocina ──────────────────────────
// BLOQUE 13: ya NO hay token en la URL. Antes esta página exigía un JWT de 12 h
// que viajaba dentro del QR, así que el código ERA la credencial: fotografiarlo
// daba medio día de acceso y no había forma de cortarlo antes de que venciera.
//
// Ahora la página no lleva credencial ninguna —no muestra datos por sí sola— y
// la confianza vive en el DISPOSITIVO: la tablet genera su secreto, se registra
// con un código de un solo uso (`?pair=`) y no lee un solo pedido hasta que
// alguien la aprueba tecleando el PIN. Ver routes/kds.js y utils/kdsDevices.js.
//
// Servirla sin verificar nada es correcto y deliberado: lo que hay que proteger
// son los datos, y esos los pide el navegador con el secreto del dispositivo,
// que `middleware/auth.js` valida contra su estado en CADA petición.
app.get('/kds', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'kds.html'));
});

// Health check (sin autenticación)
app.get('/health', async (req, res) => {
    try {
        const sequelize = require('./config/database');
        await sequelize.query('SELECT 1');
        res.json({ status: 'ok', database: 'connected', timestamp: new Date() });
    } catch {
        res.status(503).json({ status: 'error', database: 'disconnected' });
    }
});

// ─── POST /api/sse-ticket — Ticket SSE de un solo uso (30 segundos) ──────────
const { crearTicket } = require('./utils/sse-tickets');
const { authenticate } = require('./middleware/auth');
app.post('/api/sse-ticket', authenticate, (req, res) => {
    const ticket = crearTicket(req.user.business_id);
    res.json({ ticket });
});

// API Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/products', require('./routes/products'));
app.use('/api/categories', require('./routes/categories'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/customers', require('./routes/customers'));
app.use('/api/stats', require('./routes/stats'));
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/offers', require('./routes/offers'));
// Biblioteca de modificadores de producto (BLOQUE 11)
app.use('/api/modifiers', require('./routes/modifiers'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/staff', require('./routes/staff'));
app.use('/api/alerts', require('./routes/alerts'));
app.use('/api/branches', require('./routes/branches'));
app.use('/api/tables',   require('./routes/tables'));
app.use('/api/turnos',   require('./routes/turnos'));
app.use('/api/audit',    require('./routes/audit'));
app.use('/api/push',     require('./routes/push'));
app.use('/api/exports',  require('./routes/exports'));
app.use('/api/shopping-list', require('./routes/shoppingList'));
app.use('/api/kds',      require('./routes/kds'));

// Sentry: captura de errores (después de las rutas, antes de nuestro manejador —
// `manejadorDeErrores` responde y no llama a next(), así que si Sentry fuera después
// no se enteraría de nada).
if (sentryActivo) {
    Sentry.setupExpressErrorHandler(app);
}

// Error handling (incluye el mensaje claro de "body demasiado grande" y el
// saneado de campos sensibles antes de loguear) — ver middleware/errorHandler.js
app.use(manejadorDeErrores);

// 404
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

// Sync database and start server
syncDatabase().then(() => {
    app.listen(PORT, () => {
        logger.info(`Zenit POS API running on http://localhost:${PORT}`);
        logger.info(`Environment: ${process.env.NODE_ENV}`);
        // Diagnóstico de zona horaria: en Render el offset es 0 (UTC). Los cortes de
        // día NO dependen de esto — cada negocio usa su `settings.tz` (ver utils/tz.js).
        const { ZONA_DEFAULT } = require('./utils/tz');
        logger.info(`Zona del servidor: UTC${-new Date().getTimezoneOffset() / 60 >= 0 ? '+' : ''}${-new Date().getTimezoneOffset() / 60} · zona por defecto de negocios: ${ZONA_DEFAULT}`);
        // Queda en los logs de Render para confirmar de un vistazo si el monitoreo
        // está encendido (sin esto, "no llegan errores" y "no está configurado" se ven igual).
        logger.info(sentryActivo
            ? `Sentry ACTIVO (entorno: ${process.env.NODE_ENV || 'development'})`
            : 'Sentry desactivado (falta SENTRY_DSN)');
    });
    // Las tareas programadas viven en utils/cron-jobs.js (§12.5, separado el
    // 2026-09-04). Se cargan aquí para no arrancarlas al importar la app en los
    // tests: `module.exports = app` no debe encender ningún cron.
    const { iniciarCronJobs } = require('./utils/cron-jobs');
    iniciarCronJobs();
});

module.exports = app;