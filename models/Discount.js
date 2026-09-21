const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Discount = sequelize.define('Discount', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    name: {
        type: DataTypes.STRING,
        allowNull: false
    },
    type: {
        type: DataTypes.ENUM('percentage', 'fixed'),
        allowNull: false
    },
    value: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false
    },
    applies_to: {
        type: DataTypes.ENUM('all', 'category', 'product'),
        defaultValue: 'all'
    },
    target_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: 'ID de categoría o producto si aplica'
    },
    start_date: {
        type: DataTypes.DATE,
        allowNull: true
    },
    end_date: {
        type: DataTypes.DATE,
        allowNull: true
    },
    calendario: {
        type: DataTypes.TEXT,
        allowNull: true,
        // Días y horas en que vale ("10% los lunes"), zona del negocio. NULL = siempre.
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
    // Si true, el frontend debe pedir PIN de empleado antes de aplicar este descuento
    requires_pin: {
        type: DataTypes.BOOLEAN,
        defaultValue: false
    },
    business_id: {
        type: DataTypes.INTEGER,
        allowNull: true
    }
}, {
    tableName: 'discounts',
    timestamps: true
});

module.exports = Discount;
