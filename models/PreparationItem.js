const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PreparationItem = sequelize.define('PreparationItem', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    preparation_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'preparations',
            key: 'id'
        }
    },
    ingredient_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'ingredients',
            key: 'id'
        }
    },
    quantity: {
        type: DataTypes.DECIMAL(10, 3),
        allowNull: false
    }
}, {
    tableName: 'preparation_items',
    timestamps: false
});

module.exports = PreparationItem;