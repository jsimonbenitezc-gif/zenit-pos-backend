const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const InventoryMovement = sequelize.define('InventoryMovement', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    ingredient_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'ingredients',
            key: 'id'
        }
    },
    type: {
        type: DataTypes.ENUM('entrada', 'salida', 'ajuste'),
        allowNull: false
    },
    quantity: {
        type: DataTypes.DECIMAL(10, 3),
        allowNull: false
    },
    unit_cost: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: true,
        comment: 'Solo para entradas'
    },
    reason: {
        type: DataTypes.STRING,
        allowNull: true
    },
    notes: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    user_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
            model: 'users',
            key: 'id'
        }
    }
}, {
    tableName: 'inventory_movements',
    timestamps: true,
    updatedAt: false
});

module.exports = InventoryMovement;