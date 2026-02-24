const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const ProductRecipe = sequelize.define('ProductRecipe', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    product_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'products',
            key: 'id'
        }
    },
    item_type: {
        type: DataTypes.ENUM('ingredient', 'preparation'),
        allowNull: false
    },
    item_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: 'ID del ingrediente o preparación'
    },
    quantity: {
        type: DataTypes.DECIMAL(10, 3),
        allowNull: false
    }
}, {
    tableName: 'product_recipes',
    timestamps: false
});

module.exports = ProductRecipe;