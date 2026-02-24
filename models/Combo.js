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
    active: {
        type: DataTypes.BOOLEAN,
        defaultValue: true
    }
}, {
    tableName: 'combos',
    timestamps: true
});

module.exports = Combo;