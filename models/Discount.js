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
