const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');
const bcrypt = require('bcrypt');

const User = sequelize.define('User', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    username: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true
    },
    password: {
        type: DataTypes.STRING,
        allowNull: false
    },
    role: {
        type: DataTypes.ENUM('owner', 'cashier', 'waiter', 'delivery'),
        defaultValue: 'owner'
    },
    name: {
        type: DataTypes.STRING,
        allowNull: false
    },
    active: {
        type: DataTypes.BOOLEAN,
        defaultValue: true
    },
    settings: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    // ID del dueño al que pertenece este usuario staff (null si es owner)
    business_id: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    // Sucursal asignada a este usuario
    branch_id: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    // Suscripción
    plan: {
        type: DataTypes.ENUM('free', 'trial', 'premium'),
        defaultValue: 'free'
    },
    plan_expires_at: {
        type: DataTypes.DATE,
        allowNull: true
    },
    stripe_customer_id: {
        type: DataTypes.STRING,
        allowNull: true
    },
    stripe_subscription_id: {
        type: DataTypes.STRING,
        allowNull: true
    },
    // Push tokens de dispositivos móviles (JSON array de strings Expo)
    push_tokens: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    // Verificación de correo (política SUAVE: no bloquea el uso de la app,
    // solo habilita recuperación de contraseña y evita cuentas con typos).
    // false = registrado pero aún sin confirmar el correo.
    email_verified: {
        type: DataTypes.BOOLEAN,
        defaultValue: false
    },
    // Token opaco del enlace de confirmación (null una vez verificado).
    verification_token: {
        type: DataTypes.STRING,
        allowNull: true
    },
    // Cuándo se envió el último correo de verificación (para expirar el token
    // y limitar reenvíos).
    verification_sent_at: {
        type: DataTypes.DATE,
        allowNull: true
    },
    // Recuperación de contraseña ("olvidé mi contraseña").
    // Hash SHA256 del token que viaja en el enlace del correo (nunca se guarda en claro).
    reset_token: {
        type: DataTypes.STRING,
        allowNull: true
    },
    // Vencimiento del token de reseteo (1 hora).
    reset_token_expires: {
        type: DataTypes.DATE,
        allowNull: true
    }
}, {
    tableName: 'users',
    timestamps: true,
    hooks: {
        beforeCreate: async (user) => {
            if (user.password) {
                user.password = await bcrypt.hash(user.password, 10);
            }
        },
        beforeUpdate: async (user) => {
            if (user.changed('password')) {
                user.password = await bcrypt.hash(user.password, 10);
            }
        }
    }
});

User.prototype.comparePassword = async function(password) {
    return await bcrypt.compare(password, this.password);
};

module.exports = User;