const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Combo = sequelize.define('Combo', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    name: {
        type: DataTypes.STRING,
        allowNull: false
    },
    description: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    emoji: {
        type: DataTypes.STRING,
        defaultValue: '🎁'
    },
    image: {
        type: DataTypes.STRING,
        allowNull: true
    },
    price: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        comment: 'Precio especial del combo'
    },
    original_price: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: true,
        comment: 'Suma de precios individuales'
    },
    // PROMO (PLAN_OFERTAS_V1, Bloque 1). Cómo se cobra: 'precio_fijo' (el combo
    // de siempre, cobra `price`) o 'regalar_mas_barato' (2x1, 3x2: lleva N,
    // paga M, se regalan los N−M más baratos). Ver utils/promos.js.
    tipo: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'precio_fijo'
    },
    lleva: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    paga: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    calendario: {
        type: DataTypes.TEXT,
        allowNull: true,
        // Cuándo está activa, en la zona del negocio. NULL = siempre.
        get() {
            const v = this.getDataValue('calendario');
            if (v === null || v === undefined || v === '') return null;
            try { return JSON.parse(v); } catch { return null; }
        },
        set(v) {
            this.setDataValue('calendario', v === null || v === undefined ? null : (typeof v === 'string' ? v : JSON.stringify(v)));
        }
    },
    active: {
        type: DataTypes.BOOLEAN,
        defaultValue: true
    },
    business_id: {
        type: DataTypes.INTEGER,
        allowNull: true
    }
}, {
    tableName: 'combos',
    timestamps: true
});

module.exports = Combo;
