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
    // CONTENIDO DEL PAQUETE (§45). Un insumo guardado en 'bolsas' con
    // `content_amount: 50, content_unit: 'g'` significa "una bolsa trae 50 g", y
    // es lo que permite que una receta escrita en gramos consuma la fracción de
    // bolsa que le toca en vez de una bolsa entera por gramo.
    //
    // ⚠️ El desktop MANDABA estos dos campos desde siempre (`content_amount` /
    // `content_unit` en `pos/modulo-inventario.js`) y aquí no estaban declarados,
    // así que Sequelize los descartaba EN SILENCIO: el usuario rellenaba el campo,
    // la app lo enviaba y no se guardaba nada. Es la trampa del §25 por tercera
    // vez —tras `users.refresh_token_hash` y el costo que solo se podía capturar
    // desde el mobile (§33.7)—. Si agregas una columna por SQL, decláralas TAMBIÉN
    // aquí o los `update()` sobre ella no harán nada.
    content_amount: {
        type: DataTypes.DECIMAL(10, 3),
        allowNull: true
    },
    content_unit: {
        type: DataTypes.STRING,
        allowNull: true
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
