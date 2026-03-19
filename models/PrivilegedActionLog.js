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
    }
}, {
    tableName: 'privileged_action_logs',
    timestamps: true,
    updatedAt: false
});

module.exports = PrivilegedActionLog;
