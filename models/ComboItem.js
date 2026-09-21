const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const ComboItem = sequelize.define('ComboItem', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    combo_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'combos',
            key: 'id'
        }
    },
    // NULL cuando el hueco es "N de [categoría]" o "N de [estos productos]"
    // (PLAN_OFERTAS_V1). Un renglón con producto fijo lo sigue llenando, y es
    // el ÚNICO que viaja en `items`: un desktop viejo inserta `product_id` en
    // una columna NOT NULL (trampa 1 del plan).
    product_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
            model: 'products',
            key: 'id'
        }
    },
    category_id: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    product_ids: {
        type: DataTypes.TEXT,
        allowNull: true,
        // Lista de productos que entran en este hueco (JSON de ids).
        get() {
            const v = this.getDataValue('product_ids');
            if (v === null || v === undefined || v === '') return null;
            try { return JSON.parse(v); } catch { return null; }
        },
        set(v) {
            this.setDataValue('product_ids', v === null || v === undefined ? null : (typeof v === 'string' ? v : JSON.stringify(v)));
        }
    },
    quantity: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1
    }
}, {
    tableName: 'combo_items',
    timestamps: false
});

module.exports = ComboItem;