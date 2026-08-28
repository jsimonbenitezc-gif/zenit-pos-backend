const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// Tabla puente: qué grupos de la biblioteca usa cada producto, y en qué orden
// se le muestran al cajero.
//
// Es lo que hace que "Extras" se configure UNA vez y se enganche a 30 tacos.
// El servidor la usa además como cerrojo: una opción solo puede cobrarse en un
// producto cuyo grupo esté enganchado aquí (ver utils/modificadores.js).
const ProductModifierGroup = sequelize.define('ProductModifierGroup', {
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
    sort_order: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0
    }
}, {
    tableName: 'product_modifier_groups',
    timestamps: true
});

module.exports = ProductModifierGroup;
