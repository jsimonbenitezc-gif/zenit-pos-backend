const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Ingredient = sequelize.define('Ingredient', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    name: {
        type: DataTypes.STRING,
        allowNull: false
    },
    unit: {
        type: DataTypes.STRING,
        allowNull: false,
        defaultValue: 'unidad'
    },
    stock: {
        type: DataTypes.DECIMAL(10, 3),
        defaultValue: 0
    },
    min_stock: {
        type: DataTypes.DECIMAL(10, 3),
        defaultValue: 0
    },
    cost_per_unit: {
        type: DataTypes.DECIMAL(10, 2),
        defaultValue: 0
    },
    notes: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    active: {
        type: DataTypes.BOOLEAN,
        defaultValue: true
    },
    business_id: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    // ⚠️ AQUÍ VIVÍA `branch_stocks` (columna TEXT con un JSON {sucursal: cantidad}).
    // Se retiró del modelo el 2026-09-04 al cerrar la deuda §12.1: el stock por
    // sucursal tiene UNA sola fuente, la tabla `branch_stocks` (modelo BranchStock),
    // y se lee y escribe SOLO por utils/branchStock.js.
    //
    // La COLUMNA sigue existiendo en Postgres, congelada con los datos del día del
    // cambio, como copia de respaldo. Quitarla del modelo es justamente lo que
    // impide que alguien vuelva a leerla o escribirla sin darse cuenta: Sequelize
    // ignora en silencio los atributos que no declara (la lección del §25).
}, {
    tableName: 'ingredients',
    timestamps: true
});

module.exports = Ingredient;
