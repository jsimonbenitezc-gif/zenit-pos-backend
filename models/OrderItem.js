const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const OrderItem = sequelize.define('OrderItem', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    order_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'orders',
            key: 'id'
        }
    },
    product_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'products',
            key: 'id'
        }
    },
    quantity: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1
    },
    unit_price: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false
    },
    subtotal: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false
    },
    notes: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    // MODIFICADORES (BLOQUE 11). Precio del catálogo ANTES de los extras.
    // `unit_price` es lo que el cliente paga por unidad (base + deltas), así que
    // todo lo que ya existía —impuesto, descuentos, pagos, corte de caja— sigue
    // leyendo ese campo sin enterarse. Este guarda de dónde partió, para poder
    // imprimir el desglose. NULL = renglón anterior al bloque: su `unit_price`
    // ES el precio base y no hay nada que desglosar.
    base_unit_price: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: true
    },
    // JSON CONGELADO de lo que se eligió: [{option_id, group_id, group, name,
    // price_delta}]. Congelado a propósito (igual que la tasa del BLOQUE 8):
    // reimprimir un ticket de hace un mes debe mostrar lo que se cobró, aunque
    // el dueño haya cambiado el precio del extra o borrado la opción.
    modifiers: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    // Idempotencia de "agregar productos a la mesa": uuid del LOTE que envió el
    // cliente. Lo comparten todas las filas del mismo envío, así que NO lleva
    // índice único — la deduplicación la hace POST /orders/:id/items dentro de la
    // transacción, con el pedido bloqueado (ver routes/orders.js).
    client_uuid: {
        type: DataTypes.STRING(36),
        allowNull: true
    }
}, {
    tableName: 'order_items',
    timestamps: true
});

module.exports = OrderItem;