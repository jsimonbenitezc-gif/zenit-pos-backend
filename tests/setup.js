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

// ── App Express ligera (sin Sentry, CORS, helmet, cron) ──
const app = express();
app.use(express.json());

app.use('/api/auth',       require('../routes/auth'));
app.use('/api/products',   require('../routes/products'));
app.use('/api/categories', require('../routes/categories'));
app.use('/api/orders',     require('../routes/orders'));
app.use('/api/customers',  require('../routes/customers'));
app.use('/api/inventory',  require('../routes/inventory'));
app.use('/api/staff',      require('../routes/staff'));
app.use('/api/stats',      require('../routes/stats'));
app.use('/api/settings',   require('../routes/settings'));
app.use('/api/turnos',     require('../routes/turnos'));

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

module.exports = { app, sequelize, models, initTestDb, createTestOwner };
