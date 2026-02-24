require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { syncDatabase } = require('./models');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
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

// API Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/products', require('./routes/products'));
app.use('/api/categories', require('./routes/categories'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/customers', require('./routes/customers'));
app.use('/api/stats', require('./routes/stats'));
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/offers', require('./routes/offers'));

// Error handling
app.use((err, req, res, next) => {
    console.error('Error:', err);
    res.status(err.status || 500).json({
        error: {
            message: err.message || 'Internal server error'
        }
    });
});

// 404
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

// Sync database before starting
syncDatabase().then(() => {
    app.listen(PORT, () => {
        console.log(`🚀 Zenit POS API running on http://localhost:3000`);
        console.log(`📝 Environment: ${process.env.NODE_ENV}`);
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Zenit POS API running on http://localhost:${PORT}`);
    console.log(`📝 Environment: ${process.env.NODE_ENV}`);
});

module.exports = app;