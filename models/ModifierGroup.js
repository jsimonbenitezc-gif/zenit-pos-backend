const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// Grupo de modificadores ("Tamaño", "Extras", "Término de la carne").
//
// Es una BIBLIOTECA DEL NEGOCIO, no una propiedad del producto: se configura una
// vez y se engancha a todos los productos que lo usan (ver ProductModifierGroup).
// Una taquería define "Extras" una sola vez y se lo pone a sus 30 tacos; cambiar
// el precio de "extra queso" se hace en un solo lugar. Definirlos por producto
// obligaría a re-teclear lo mismo 30 veces — justo la fricción que Zenit evita.
const ModifierGroup = sequelize.define('ModifierGroup', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    business_id: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    name: {
        type: DataTypes.STRING,
        allowNull: false
    },
    // Cuántas opciones DEBE elegir el cliente. 0 = opcional.
    // ⚠️ Solo lo aplica la UI. El servidor NO lo valida a propósito: un binario
    // viejo no manda modificadores y empezaría a recibir 400 en cada venta de
    // ese producto (ver utils/modificadores.js).
    min_select: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0
    },
    // Cuántas opciones puede elegir COMO MÁXIMO. NULL = sin límite.
    // Este sí lo valida el servidor: elegir dos veces "extra queso" cobra doble.
    max_select: {
        type: DataTypes.INTEGER,
        allowNull: true,
        defaultValue: 1
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
    tableName: 'modifier_groups',
    timestamps: true
});

module.exports = ModifierGroup;
