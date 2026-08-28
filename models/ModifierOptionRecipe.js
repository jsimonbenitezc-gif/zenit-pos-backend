const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// Ajuste de RECETA de una opción: qué insumos agrega o quita al producto.
//
// Mismo shape que ProductRecipe (item_type + item_id) para poder reusar el
// motor de descuento de inventario tal cual.
//
// ⚠️ `quantity` puede ser NEGATIVA, y ahí está la gracia del modelo:
//   • POSITIVA  → "extra queso" CONSUME 30 g de queso además de la receta base.
//   • NEGATIVA  → "sin cebolla" DEVUELVE los 20 g que la receta base ya descontó.
// Sin la parte negativa, el inventario seguiría descontando la cebolla que
// nunca salió de la cocina.
const ModifierOptionRecipe = sequelize.define('ModifierOptionRecipe', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    option_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'modifier_options',
            key: 'id'
        }
    },
    business_id: {
        type: DataTypes.INTEGER,
        allowNull: false
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
    },
    unit_recipe: {
        type: DataTypes.STRING,
        allowNull: true
    }
}, {
    tableName: 'modifier_option_recipes',
    timestamps: false
});

module.exports = ModifierOptionRecipe;
