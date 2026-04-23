const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const ProcessedWebhook = sequelize.define('ProcessedWebhook', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    event_id: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true
    }
}, {
    tableName: 'processed_webhooks',
    timestamps: true,
    updatedAt: false
});

module.exports = ProcessedWebhook;
