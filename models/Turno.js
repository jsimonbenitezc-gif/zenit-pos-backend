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
    // Impuesto recaudado en el turno (BLOQUE 8). Se congela igual que los
    // movimientos: es la cifra que el dueño leyó en ese corte. NO cambia el
    // efectivo esperado (el impuesto se cobra dentro del total y está en el
    // cajón); es informativo para el administrador.
    total_impuesto: {
        type: DataTypes.DECIMAL(10, 2),
        defaultValue: 0
    },
    // Movimientos de caja del turno (BLOQUE 7). Se congelan al cerrar para que el
    // reporte de un turno viejo no cambie si después se anula un movimiento.
    total_depositos: {
        type: DataTypes.DECIMAL(10, 2),
        defaultValue: 0
    },
    total_retiros: {
        type: DataTypes.DECIMAL(10, 2),
        defaultValue: 0
    },
    total_gastos: {
        type: DataTypes.DECIMAL(10, 2),
        defaultValue: 0
    },
    // Propinas del turno (BLOQUE 9). Se congelan igual que lo anterior.
    // ⚠️ NO son ventas: `total_ventas` no las incluye. Se guardan separadas por
    // método porque solo la de EFECTIVO está en el cajón y por tanto es la única
    // que el efectivo esperado le exige al cajero al contar; la de tarjeta llega
    // después en la liquidación del banco. Ver utils/propinas.js.
    total_propinas: {
        type: DataTypes.DECIMAL(10, 2),
        defaultValue: 0
    },
    total_propinas_efectivo: {
        type: DataTypes.DECIMAL(10, 2),
        defaultValue: 0
    },
    total_propinas_tarjeta: {
        type: DataTypes.DECIMAL(10, 2),
        defaultValue: 0
    },
    total_propinas_transferencia: {
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
