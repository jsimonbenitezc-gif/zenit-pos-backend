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
        type: DataTypes.ENUM('registrado', 'completado', 'entregado', 'cancelado', 'devuelto'),
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
    },
    branch_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
            model: 'Branches',
            key: 'id'
        },
        onDelete: 'SET NULL'
    },
    discount_amount: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: true,
        defaultValue: 0
    },
    // ── Impuesto (BLOQUE 8) ──────────────────────────────────────────────
    // Invariante: total = subtotal + tax_amount.
    //   • subtotal   = base gravable (suma de items − descuentos)
    //   • tax_rate / tax_included quedan CONGELADOS con el valor que tenía el
    //     negocio al cobrar: reimprimir un ticket viejo o recalcular una mesa
    //     abierta no debe usar la tasa de hoy si el dueño la cambió después.
    // Un pedido anterior al bloque tiene subtotal NULL: ahí el total ES lo cobrado.
    subtotal: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: true
    },
    tax_amount: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: true,
        defaultValue: 0
    },
    tax_rate: {
        type: DataTypes.DECIMAL(5, 2),
        allowNull: true
    },
    tax_included: {
        type: DataTypes.BOOLEAN,
        allowNull: true
    },
    // ── Propina (BLOQUE 9) ───────────────────────────────────────────────
    // NO entra en `total` ni paga impuesto: es dinero del cliente para el
    // empleado que solo pasa por la caja. Lo que el cliente entrega es
    // `total + tip_amount`, pero la venta del negocio sigue siendo `total`.
    // `tip_method` puede diferir del pago (cuenta con tarjeta, propina en
    // efectivo); null cuando no hubo propina. Ver utils/propinas.js.
    tip_amount: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: true,
        defaultValue: 0
    },
    tip_method: {
        type: DataTypes.STRING(20),
        allowNull: true
    },
    created_by: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
            model: 'users',
            key: 'id'
        }
    },
    // Idempotencia: uuid generado por el cliente para deduplicar reintentos.
    // La unicidad se garantiza con un índice parcial (ver runMigrations / migración).
    client_uuid: {
        type: DataTypes.STRING(36),
        allowNull: true
    }
}, {
    tableName: 'orders',
    timestamps: true
});

module.exports = Order;
