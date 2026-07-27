require('dotenv').config();

// Validar variables de entorno obligatorias antes de arrancar
const variablesObligatorias = ['JWT_SECRET', 'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'];
const faltantes = variablesObligatorias.filter(v => !process.env[v]);
if (faltantes.length > 0) {
    console.error(`[FATAL] Variables de entorno faltantes: ${faltantes.join(', ')}`);
    process.exit(1);
}

const Sentry = require('@sentry/node');
if (process.env.SENTRY_DSN) {
    Sentry.init({
        dsn: process.env.SENTRY_DSN,
        environment: process.env.NODE_ENV || 'development',
        tracesSampleRate: 0.1,
    });
}
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const { syncDatabase } = require('./models');
const logger = require('./utils/logger');

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

// Sentry request handler (debe ir antes de las rutas)
if (process.env.SENTRY_DSN) {
    app.use(Sentry.Handlers.requestHandler());
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

// ─── POST /api/kds/token — Generar token corto para KDS (2h) ─────────────────
const { authenticate } = require('./middleware/auth');
app.post('/api/kds/token', authenticate, (req, res) => {
    const jwt = require('jsonwebtoken');
    const { branch_id } = req.body;
    const kdsToken = jwt.sign(
        {
            business_id: req.user.business_id,
            branch_id: branch_id || req.user.branch_id || null,
            purpose: 'kds'
        },
        process.env.JWT_SECRET,
        { expiresIn: '2h' }
    );
    res.json({ kdsToken });
});

// ─── GET /kds?token=<kdsToken>  ───────────────────────────────────────────────
// Página web del KDS. Ahora usa un kdsToken de corta duración (2h) en vez del JWT completo.
app.get('/kds', (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(401).send('<h1>Token requerido. Escanea el QR desde la app.</h1>');
    try {
        const decoded = require('jsonwebtoken').verify(token, process.env.JWT_SECRET);
        if (decoded.purpose !== 'kds') {
            return res.status(401).send('<h1>Token inválido. Genera un nuevo QR desde la app.</h1>');
        }
    } catch {
        return res.status(401).send('<h1>Token inválido o expirado. Genera un nuevo QR desde la app.</h1>');
    }
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

// Sentry error handler (debe ir después de las rutas y antes de otros error handlers)
if (process.env.SENTRY_DSN) {
    app.use(Sentry.Handlers.errorHandler());
}

// Helper para eliminar datos sensibles antes de loguear
const camposSensibles = ['password', 'pin', 'currentPassword', 'newPassword', 'refreshToken'];
function sanitizarParaLog(body) {
    if (!body || typeof body !== 'object') return body;
    const copia = { ...body };
    for (const campo of camposSensibles) {
        if (campo in copia) copia[campo] = '[REDACTADO]';
    }
    return copia;
}

// Error handling
app.use((err, req, res, next) => {
    logger.error(`${req.method} ${req.path} → ${err.message}`, {
        stack: err.stack,
        status: err.status,
        body: req.body ? JSON.stringify(sanitizarParaLog(req.body)).substring(0, 500) : undefined,
    });
    res.status(err.status || 500).json({ error: 'Error interno del servidor' });
});

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
    });
    iniciarCronJobs();
});

// ─── Cron jobs: notificaciones programadas ─────────────────────────────────
function iniciarCronJobs() {
    const cron = require('node-cron');
    const { User, Turno, Order } = require('./models');
    const { enviarNotificacion } = require('./utils/push');
    const { Op } = require('sequelize');
    const { filtroVentaContable } = require('./utils/ordersFilter');
    const { normalizarZona, horaLocal, diaSemanaLocal, inicioDiaLocal } = require('./utils/tz');

    // Resumen diario — corre cada hora en el minuto 0
    // Envía solo a los usuarios que tienen esa hora configurada en notif_resumen_diario_hora.
    // La hora se compara en la zona del NEGOCIO (Render corre en UTC): sin esto el
    // "resumen de las 22h" llegaba a las 4pm en México y con el día ya cortado.
    cron.schedule('0 * * * *', async () => {
        const ahora = new Date();
        try {
            const owners = await User.findAll({ where: { role: 'owner', active: true }, attributes: ['id', 'settings'] });
            for (const owner of owners) {
                let prefs = {};
                try { prefs = JSON.parse(owner.settings || '{}'); } catch {}
                if (prefs.notif_resumen_diario === false) continue;
                const tz = normalizarZona(prefs.tz);
                const horaDeseada = parseInt(prefs.notif_resumen_diario_hora ?? 22);
                if (horaLocal(tz, ahora) !== horaDeseada) continue;

                const hoy = inicioDiaLocal(tz, ahora);
                const pedidos = await Order.findAll({
                    where: { business_id: owner.id, ...filtroVentaContable(), createdAt: { [Op.gte]: hoy } },
                    attributes: ['total']
                });
                const totalDia = pedidos.reduce((s, p) => s + parseFloat(p.total || 0), 0);
                enviarNotificacion(owner.id, null, '📊 Resumen del día',
                    `${pedidos.length} pedido(s) · $${totalDia.toFixed(2)} en ventas`);
            }
        } catch (err) { logger.error(`[Cron resumen diario] ${err.message}`); }
    });

    // Resumen semanal — lunes a las 8 AM LOCALES de cada negocio.
    // Corre cada hora y filtra por día+hora local (antes era '0 8 * * 1' = 8 AM UTC,
    // o sea las 2 AM del domingo en México).
    cron.schedule('0 * * * *', async () => {
        const ahora = new Date();
        try {
            const owners = await User.findAll({ where: { role: 'owner', active: true }, attributes: ['id', 'settings'] });
            for (const owner of owners) {
                let prefs = {};
                try { prefs = JSON.parse(owner.settings || '{}'); } catch {}
                if (prefs.notif_resumen_semanal === false) continue;
                const tz = normalizarZona(prefs.tz);
                if (diaSemanaLocal(tz, ahora) !== 1 || horaLocal(tz, ahora) !== 8) continue;

                const haceSiete = inicioDiaLocal(tz, ahora, -7);
                const pedidos = await Order.findAll({
                    where: { business_id: owner.id, ...filtroVentaContable(), createdAt: { [Op.gte]: haceSiete } },
                    attributes: ['total']
                });
                const total = pedidos.reduce((s, p) => s + parseFloat(p.total || 0), 0);
                enviarNotificacion(owner.id, null, '📈 Resumen semanal',
                    `${pedidos.length} pedido(s) esta semana · $${total.toFixed(2)} en ventas`);
            }
        } catch (err) { logger.error(`[Cron resumen semanal] ${err.message}`); }
    });

    // Turno abierto demasiado tiempo — corre cada hora en el minuto 30
    cron.schedule('30 * * * *', async () => {
        try {
            const owners = await User.findAll({ where: { role: 'owner', active: true }, attributes: ['id', 'settings'] });
            for (const owner of owners) {
                let prefs = {};
                try { prefs = JSON.parse(owner.settings || '{}'); } catch {}
                if (prefs.notif_turno_largo === false) continue;
                const horas = parseFloat(prefs.notif_turno_largo_horas ?? 8);
                const limite = new Date(Date.now() - horas * 60 * 60 * 1000);
                const turnosLargos = await Turno.findAll({
                    where: { business_id: owner.id, estado: 'abierto', apertura: { [Op.lte]: limite } }
                });
                for (const t of turnosLargos) {
                    const horasAbiertas = ((Date.now() - new Date(t.apertura).getTime()) / 3600000).toFixed(1);
                    enviarNotificacion(owner.id, null, '⏰ Turno abierto por mucho tiempo',
                        `${t.cajero_nombre} lleva ${horasAbiertas}h con caja abierta`);
                }
            }
        } catch (err) { logger.error(`[Cron turno largo] ${err.message}`); }
    });

    logger.info('Cron jobs de notificaciones iniciados');
}

module.exports = app;