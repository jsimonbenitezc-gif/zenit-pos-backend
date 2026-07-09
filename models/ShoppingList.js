const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// Lista de compras. Hay una lista "activa" por sucursal (branch_id puede ser
// NULL para el negocio sin sucursales). Al enviarla pasa a status 'sent' y se
// puede crear una nueva activa.
const ShoppingList = sequelize.define('ShoppingList', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    business_id: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    branch_id: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    status: {
        type: DataTypes.STRING,
        allowNull: false,
        defaultValue: 'active' // 'active' | 'sent'
    },
    // Nombre del empleado/perfil que la envió (para que el dueño sepa quién)
    sent_by: {
        type: DataTypes.STRING,
        allowNull: true
    },
    sent_at: {
        type: DataTypes.DATE,
        allowNull: true
    }
}, {
    tableName: 'shopping_lists',
    timestamps: true
});

module.exports = ShoppingList;
