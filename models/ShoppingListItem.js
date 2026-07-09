const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// Item de una lista de compras. Puede venir del inventario (ingredient_id
// presente) o ser manual (ingredient_id NULL, solo texto libre).
const ShoppingListItem = sequelize.define('ShoppingListItem', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    list_id: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    // Nombre visible del item (del insumo o escrito a mano)
    name: {
        type: DataTypes.STRING,
        allowNull: false
    },
    // Insumo del inventario del que proviene (NULL si es manual)
    ingredient_id: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    // Texto libre de cantidad a comprar (ej: "2 kg", "media caja")
    quantity_text: {
        type: DataTypes.STRING,
        allowNull: true
    },
    // Info de contexto capturada al generar (para mostrar "hay X, mínimo Y")
    current_stock: {
        type: DataTypes.DECIMAL(10, 3),
        allowNull: true
    },
    min_stock: {
        type: DataTypes.DECIMAL(10, 3),
        allowNull: true
    },
    unit: {
        type: DataTypes.STRING,
        allowNull: true
    },
    // Marcado como comprado/conseguido
    checked: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false
    },
    // Origen del item: 'auto' (generado por bajo stock), 'inventory' (agregado
    // manualmente desde el inventario) o 'manual' (texto libre)
    source: {
        type: DataTypes.STRING,
        allowNull: false,
        defaultValue: 'manual'
    }
}, {
    tableName: 'shopping_list_items',
    timestamps: true
});

module.exports = ShoppingListItem;
