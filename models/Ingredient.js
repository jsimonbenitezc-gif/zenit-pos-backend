const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Ingredient = sequelize.define('Ingredient', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    name: {
        type: DataTypes.STRING,
        allowNull: false
    },
    unit: {
        type: DataTypes.STRING,
        allowNull: false,
        defaultValue: 'unidad'
    },
    stock: {
        type: DataTypes.DECIMAL(10, 3),
        defaultValue: 0
    },
    min_stock: {
        type: DataTypes.DECIMAL(10, 3),
        defaultValue: 0
    },
    cost_per_unit: {
        type: DataTypes.DECIMAL(10, 2),
        defaultValue: 0
    },
    notes: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    active: {
        type: DataTypes.BOOLEAN,
        defaultValue: true
    }
}, {
    tableName: 'ingredients',
    timestamps: true
});

module.exports = Ingredient;