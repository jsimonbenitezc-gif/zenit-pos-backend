require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { syncDatabase } = require('./models');

const app = express();
const PORT = process.env.PORT || 3000;

// Confiar en el proxy de Render.com (necesario para que el rate limiter funcione correctamente)
app.set('trust proxy', 1);

// Orígenes permitidos para conectarse al API
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);

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
// Billing (Stripe webhook necesita body sin parsear — DEBE ir antes de express.json)
app.use('/api/billing', require('./routes/billing'));

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

// Páginas de retorno de Stripe Checkout (el navegador redirige aquí tras el pago)
app.get('/billing-success', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Pago exitoso</title>
    <style>body{font-family:sans-serif;text-align:center;padding:60px;background:#f0fdf4;}
    h1{color:#16a34a;}p{color:#374151;}</style></head>
    <body><h1>¡Pago completado!</h1>
    <p>Tu plan Premium ya está activo.<br>Puedes cerrar esta ventana y volver a Zenit POS.</p>
    </body></html>`);
});

app.get('/billing-cancel', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Pago cancelado</title>
    <style>body{font-family:sans-serif;text-align:center;padding:60px;background:#fafafa;}
    h1{color:#6b7280;}p{color:#374151;}</style></head>
    <body><h1>Pago cancelado</h1>
    <p>No se realizó ningún cargo.<br>Puedes cerrar esta ventana y volver a Zenit POS.</p>
    </body></html>`);
});

app.get('/billing-return', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Portal de facturación</title>
    <style>body{font-family:sans-serif;text-align:center;padding:60px;background:#fafafa;}
    h1{color:#374151;}</style></head>
    <body><h1>Listo</h1><p>Puedes cerrar esta ventana y volver a Zenit POS.</p>
    </body></html>`);
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

// Error handling
app.use((err, req, res, next) => {
    console.error('Error:', err);
    res.status(err.status || 500).json({ error: 'Error interno del servidor' });
});

// 404
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

// Sync database and start server
syncDatabase().then(() => {
    app.listen(PORT, () => {
        console.log(`🚀 Zenit POS API running on http://localhost:${PORT}`);
        console.log(`📝 Environment: ${process.env.NODE_ENV}`);
    });
});

module.exports = app;