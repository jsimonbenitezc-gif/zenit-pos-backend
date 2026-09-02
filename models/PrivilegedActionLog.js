const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PrivilegedActionLog = sequelize.define('PrivilegedActionLog', {
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
    employee_id: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    employee_name: {
        type: DataTypes.STRING,
        allowNull: false
    },
    // Tipo de acción: 'cancel_order', 'edit_customer', 'inventory_adjustment', 'apply_discount'
    action_type: {
        type: DataTypes.STRING,
        allowNull: false
    },
    // Descripción legible del objeto afectado: "Pedido #42", "Cliente Juan Pérez"
    target_description: {
        type: DataTypes.STRING,
        allowNull: true
    },
    // Estado del objeto ANTES de la acción (JSON como texto)
    before_data: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    // Estado del objeto DESPUÉS de la acción (JSON como texto)
    after_data: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    // BLOQUE 14 — ¿la acción ocurrió FUERA del horario del negocio?
    //
    // Es una MARCA, no un permiso: la acción ya ocurrió y se registró igual. Sirve
    // para que el dueño distinga de un vistazo la cancelación de las 2 de la tarde
    // de la de las 3 de la mañana, y para filtrar el historial por ese criterio.
    //
    // Un negocio SIN horario configurado —el default— tiene todo en `false`, que es
    // la verdad: sin horario definido no hay "fuera de horario". Las filas anteriores
    // al bloque quedan en false por la misma razón.
    fuera_horario: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false
    }
}, {
    tableName: 'privileged_action_logs',
    timestamps: true,
    updatedAt: false
});

module.exports = PrivilegedActionLog;
