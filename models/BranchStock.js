const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const BranchStock = sequelize.define('BranchStock', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    ingredient_id: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    branch_id: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    quantity: {
        type: DataTypes.DECIMAL(10, 3),
        defaultValue: 0
    },
    business_id: {
        type: DataTypes.INTEGER,
        allowNull: false
    }
}, {
    tableName: 'branch_stocks',
    timestamps: true,
    indexes: [
        {
            unique: true,
            fields: ['ingredient_id', 'branch_id']
        },
        {
            fields: ['business_id']
        }
    ]
});

module.exports = BranchStock;
