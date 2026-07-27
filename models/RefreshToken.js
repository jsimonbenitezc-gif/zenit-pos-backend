const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// Un refresh token POR SESIÓN (por dispositivo), no por usuario.
//
// Antes vivían en `users.refresh_token_hash`: una sola columna por usuario. Como el
// login y la rotación la sobrescriben, entrar desde el celular invalidaba la sesión
// del desktop y viceversa — el segundo equipo se deslogueaba en cuanto su access
// token cumplía 15 minutos. Zenit es multi-dispositivo por diseño (caja + tablet +
// celular del dueño), así que cada sesión necesita su propia fila.
const RefreshToken = sequelize.define('RefreshToken', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    user_id: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    // SHA256 del token opaco: si se filtra la BD, los tokens no son reutilizables
    token_hash: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true
    },
    expires_at: {
        type: DataTypes.DATE,
        allowNull: false
    }
}, {
    tableName: 'refresh_tokens',
    timestamps: true,
    indexes: [
        { fields: ['user_id'] }
    ]
});

module.exports = RefreshToken;
