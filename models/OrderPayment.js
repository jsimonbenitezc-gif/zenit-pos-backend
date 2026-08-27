const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

/**
 * Pago de una venta (BLOQUE 10 V5) — cada una de las formas en que se cubrió
 * `Order.total`: "$300 en efectivo y $200 con tarjeta".
 *
 * ⚠️ LOS PAGOS NO AGREGAN DINERO A LA VENTA, LA REPARTEN:
 * `suma(amount) === Order.total`. Ver la regla completa en `utils/pagos.js`.
 *
 * Un pedido SIN filas aquí es un pedido de un solo método (todos los anteriores
 * a este bloque, y toda venta de un binario viejo): su `payment_method` sigue
 * siendo la verdad y no hay nada que migrar.
 */
const OrderPayment = sequelize.define('OrderPayment', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    order_id: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    business_id: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    // 'efectivo' | 'tarjeta' | 'transferencia'. STRING y no ENUM a propósito:
    // la validación vive en utils/pagos.js (un método inválido cae a 'efectivo'
    // en vez de tumbar la venta), y un ENUM aquí obligaría a una migración de
    // tipo cada vez que se agregue una forma de pago.
    method: {
        type: DataTypes.STRING,
        allowNull: false
    },
    // Parte de `Order.total` cubierta por este pago. NO incluye la propina.
    amount: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false
    },
    // Propina dejada EN ESTE PAGO (BLOQUE 9 + 10). Va aparte de `amount` porque
    // la propina no es venta. Lo que el cliente entrega en este pago es
    // `amount + tip_amount`. `Order.tip_amount` guarda la suma de todas.
    tip_amount: {
        type: DataTypes.DECIMAL(10, 2),
        defaultValue: 0
    },
    // Items que cubrió este pago cuando la cuenta se dividió POR ITEMS
    // ("yo pago mi pizza y mi cerveza"). Es INFORMATIVO: sirve para reimprimir
    // la división y para que el ticket de cada comensal diga qué pagó. El cuadre
    // del corte lo hace `amount`, nunca esta lista. Vacío en una división por
    // importe (mitad y mitad) y en un pago simple.
    item_ids: {
        type: DataTypes.TEXT,
        allowNull: true,
        get() {
            const raw = this.getDataValue('item_ids');
            if (!raw) return [];
            try {
                const v = JSON.parse(raw);
                return Array.isArray(v) ? v : [];
            } catch {
                return [];
            }
        },
        set(val) {
            this.setDataValue(
                'item_ids',
                Array.isArray(val) && val.length ? JSON.stringify(val) : null
            );
        }
    }
}, {
    tableName: 'order_payments',
    timestamps: true
});

module.exports = OrderPayment;
