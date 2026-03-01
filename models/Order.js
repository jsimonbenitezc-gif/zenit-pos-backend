const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Order = sequelize.define('Order', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    customer_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
            model: 'customers',
            key: 'id'
        }
    },
    total: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false
    },
    status: {
        type: DataTypes.ENUM('registrado', 'completado', 'entregado', 'cancelado'),
        defaultValue: 'registrado'
    },
    payment_method: {
        type: DataTypes.ENUM('efectivo', 'tarjeta', 'transferencia'),
        defaultValue: 'efectivo'
    },
    order_type: {
        type: DataTypes.ENUM('comer', 'llevar', 'domicilio'),
        defaultValue: 'comer'
    },
    reference: {
        type: DataTypes.STRING,
        allowNull: true
    },
    delivery_address: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    maps_link: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    notes: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    customer_temp_info: {
        type: DataTypes.STRING,
        allowNull: true
    },
    business_id: {
        type: DataTypes.INTEGER,
        allowNull: true
    }
}, {
    tableName: 'orders',
    timestamps: true
});

module.exports = Order;
