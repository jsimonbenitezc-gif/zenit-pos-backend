const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Category = sequelize.define('Category', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    name: {
        type: DataTypes.STRING,
        allowNull: false
    },
    emoji: {
        type: DataTypes.STRING,
        defaultValue: 'svg:package'
    },
    image: {
        // TEXT: guarda data URIs base64 comprimidos (imagen visible en todos los dispositivos)
        type: DataTypes.TEXT,
        allowNull: true
    },
    active: {
        type: DataTypes.BOOLEAN,
        defaultValue: true
    },
    business_id: {
        type: DataTypes.INTEGER,
        allowNull: true
    }
}, {
    tableName: 'categories',
    timestamps: true
});

module.exports = Category;
