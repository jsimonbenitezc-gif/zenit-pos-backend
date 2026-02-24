const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const ComboItem = sequelize.define('ComboItem', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    combo_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'combos',
            key: 'id'
        }
    },
    product_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'products',
            key: 'id'
        }
    },
    quantity: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1
    }
}, {
    tableName: 'combo_items',
    timestamps: false
});

module.exports = ComboItem;