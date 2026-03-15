const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Turno = sequelize.define('Turno', {
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
    cajero_nombre: {
        type: DataTypes.STRING,
        allowNull: false
    },
    rol: {
        type: DataTypes.STRING,
        allowNull: true
    },
    fondo_inicial: {
        type: DataTypes.DECIMAL(10, 2),
        defaultValue: 0
    },
    apertura: {
        type: DataTypes.DATE,
        allowNull: false
    },
    cierre: {
        type: DataTypes.DATE,
        allowNull: true
    },
    efectivo_contado: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: true
    },
    diferencia: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: true
    },
    total_pedidos: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    },
    total_ventas: {
        type: DataTypes.DECIMAL(10, 2),
        defaultValue: 0
    },
    total_efectivo: {
        type: DataTypes.DECIMAL(10, 2),
        defaultValue: 0
    },
    total_tarjeta: {
        type: DataTypes.DECIMAL(10, 2),
        defaultValue: 0
    },
    total_transferencia: {
        type: DataTypes.DECIMAL(10, 2),
        defaultValue: 0
    },
    notas: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    estado: {
        type: DataTypes.STRING,
        defaultValue: 'abierto'
    }
}, {
    tableName: 'turnos',
    timestamps: true
});

module.exports = Turno;
