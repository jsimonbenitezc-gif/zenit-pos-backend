const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Product = sequelize.define('Product', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    name: {
        type: DataTypes.STRING,
        allowNull: false
    },
    description: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    price: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false
    },
    stock: {
        // Existencias POR UNIDADES, y solo para lo que se revende (§19.38).
        // NULL = SIN CONTROL, y es el default: un producto con receta se
        // controla por sus insumos y aquí guarda NULL. Nace en null y no en 0
        // porque un 0 significa "se acabó" y bloquearía la venta de todo lo que
        // nadie configuró — que es la mayoría.
        type: DataTypes.INTEGER,
        allowNull: true,
        defaultValue: null
    },
    category_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
            model: 'categories',
            key: 'id'
        }
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
    tableName: 'products',
    timestamps: true
});

module.exports = Product;
