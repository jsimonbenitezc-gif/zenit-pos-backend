const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// Una opción dentro de un grupo: "Grande", "Extra queso", "Sin cebolla".
//
// `price_delta` es lo que esa opción SUMA al precio unitario del producto.
// Puede ser 0 ("sin cebolla" no cuesta) y puede ser NEGATIVO ("sin queso -$5",
// "chico -$10"). Nunca se le cree el delta al cliente en una venta online: sale
// de aquí (ver utils/modificadores.js).
const ModifierOption = sequelize.define('ModifierOption', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    group_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'modifier_groups',
            key: 'id'
        }
    },
    business_id: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    name: {
        type: DataTypes.STRING,
        allowNull: false
    },
    price_delta: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0
    },
    sort_order: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0
    },
    active: {
        type: DataTypes.BOOLEAN,
        defaultValue: true
    }
}, {
    tableName: 'modifier_options',
    timestamps: true
});

module.exports = ModifierOption;
