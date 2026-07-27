const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Table = sequelize.define('Table', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    business_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
    },
    // Sucursal a la que pertenece físicamente la mesa. NULL = mesa creada antes de
    // que las mesas tuvieran sucursal: se sigue viendo en todas para no esconderle
    // el comedor a nadie al desplegar (ver CLAUDE.md §24).
    branch_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
    },
    name: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    zone: {
        type: DataTypes.STRING,
        allowNull: true,
        defaultValue: 'General',
    },
    capacity: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 4,
    },
    active: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
    },
}, {
    tableName: 'tables',
    timestamps: true,
});

module.exports = Table;
