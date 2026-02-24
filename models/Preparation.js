const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Preparation = sequelize.define('Preparation', {
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
        defaultValue: 'porción'
    },
    yield_quantity: {
        type: DataTypes.DECIMAL(10, 3),
        allowNull: false,
        comment: 'Cantidad que produce la receta'
    },
    stock: {
        type: DataTypes.DECIMAL(10, 3),
        defaultValue: 0
    },
    cost_per_unit: {
        type: DataTypes.DECIMAL(10, 2),
        defaultValue: 0,
        comment: 'Calculado automáticamente'
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
    tableName: 'preparations',
    timestamps: true
});

module.exports = Preparation;