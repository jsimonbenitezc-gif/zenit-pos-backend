const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

/**
 * Movimiento de caja (BLOQUE 7 V5) — dinero que entra o sale del cajón durante
 * un turno por fuera de las ventas: "saqué $50 para comprar cilantro".
 *
 * Sin esto el cierre nunca cuadraba: el efectivo contado no coincidía con lo
 * esperado y la diferencia acababa siendo un número sin significado.
 *
 * NO se borran nunca. Un movimiento equivocado se ANULA (queda visible, marcado,
 * y deja de contar en el cierre): un registro de dinero que se puede borrar sin
 * rastro no sirve como control.
 */
const CashMovement = sequelize.define('CashMovement', {
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
    turno_id: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    // 'retiro'   → sale dinero de la caja (a la caja fuerte, al dueño)
    // 'gasto'    → sale dinero para pagar algo (insumos, servicio)
    // 'deposito' → entra dinero a la caja (más cambio, reposición de fondo)
    tipo: {
        type: DataTypes.STRING,
        allowNull: false
    },
    monto: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false
    },
    motivo: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    employee_id: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    employee_name: {
        type: DataTypes.STRING,
        allowNull: true
    },
    anulado: {
        type: DataTypes.BOOLEAN,
        defaultValue: false
    },
    anulado_por: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    anulado_por_nombre: {
        type: DataTypes.STRING,
        allowNull: true
    },
    anulado_at: {
        type: DataTypes.DATE,
        allowNull: true
    },
    motivo_anulacion: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    // Idempotencia: un reintento por timeout de red no debe duplicar el retiro
    // (mismo criterio que orders.client_uuid, ver CLAUDE.md §19.7).
    client_uuid: {
        type: DataTypes.STRING(36),
        allowNull: true
    }
}, {
    tableName: 'cash_movements',
    timestamps: true
});

module.exports = CashMovement;
