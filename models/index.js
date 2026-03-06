const sequelize = require('../config/database');

// Importar todos los modelos
const User = require('./User');
const Product = require('./Product');
const Category = require('./Category');
const Customer = require('./Customer');
const Order = require('./Order');
const OrderItem = require('./OrderItem');

// Inventario
const Ingredient = require('./Ingredient');
const Preparation = require('./Preparation');
const PreparationItem = require('./PreparationItem');
const ProductRecipe = require('./ProductRecipe');
const InventoryMovement = require('./InventoryMovement');

// Ofertas
const Discount = require('./Discount');
const Combo = require('./Combo');
const ComboItem = require('./ComboItem');

// Sucursales
const Branch = require('./Branch');

// Objeto con todos los modelos
const models = {
    User,
    Product,
    Category,
    Customer,
    Order,
    OrderItem,
    Ingredient,
    Preparation,
    PreparationItem,
    ProductRecipe,
    InventoryMovement,
    Discount,
    Combo,
    ComboItem,
    Branch
};

// Definir relaciones
const setupRelations = () => {
    // Category <-> Product
    models.Category.hasMany(models.Product, { foreignKey: 'category_id', as: 'products' });
    models.Product.belongsTo(models.Category, { foreignKey: 'category_id', as: 'category' });

    // Customer <-> Order
    models.Customer.hasMany(models.Order, { foreignKey: 'customer_id', as: 'orders' });
    models.Order.belongsTo(models.Customer, { foreignKey: 'customer_id', as: 'customer' });

    // Order <-> OrderItem
    models.Order.hasMany(models.OrderItem, { foreignKey: 'order_id', as: 'items' });
    models.OrderItem.belongsTo(models.Order, { foreignKey: 'order_id', as: 'order' });

    // Product <-> OrderItem
    models.Product.hasMany(models.OrderItem, { foreignKey: 'product_id', as: 'order_items' });
    models.OrderItem.belongsTo(models.Product, { foreignKey: 'product_id', as: 'product' });

    // Preparation <-> PreparationItem <-> Ingredient
    models.Preparation.hasMany(models.PreparationItem, { foreignKey: 'preparation_id', as: 'items' });
    models.PreparationItem.belongsTo(models.Preparation, { foreignKey: 'preparation_id', as: 'preparation' });
    models.Ingredient.hasMany(models.PreparationItem, { foreignKey: 'ingredient_id', as: 'preparation_items' });
    models.PreparationItem.belongsTo(models.Ingredient, { foreignKey: 'ingredient_id', as: 'ingredient' });

    // Product <-> ProductRecipe
    models.Product.hasMany(models.ProductRecipe, { foreignKey: 'product_id', as: 'recipe' });
    models.ProductRecipe.belongsTo(models.Product, { foreignKey: 'product_id', as: 'product' });

    // InventoryMovement <-> Ingredient
    models.Ingredient.hasMany(models.InventoryMovement, { foreignKey: 'ingredient_id', as: 'movements' });
    models.InventoryMovement.belongsTo(models.Ingredient, { foreignKey: 'ingredient_id', as: 'ingredient' });

    // InventoryMovement <-> User
    models.User.hasMany(models.InventoryMovement, { foreignKey: 'user_id', as: 'movements' });
    models.InventoryMovement.belongsTo(models.User, { foreignKey: 'user_id', as: 'user' });

    // Combo <-> ComboItem <-> Product
    models.Combo.hasMany(models.ComboItem, { foreignKey: 'combo_id', as: 'items' });
    models.ComboItem.belongsTo(models.Combo, { foreignKey: 'combo_id', as: 'combo' });
    models.Product.hasMany(models.ComboItem, { foreignKey: 'product_id', as: 'combo_items' });
    models.ComboItem.belongsTo(models.Product, { foreignKey: 'product_id', as: 'product' });

    // Branch <-> User (dueño del negocio tiene muchas sucursales)
    models.User.hasMany(models.Branch, { foreignKey: 'business_id', as: 'branches' });
    models.Branch.belongsTo(models.User, { foreignKey: 'business_id', as: 'owner' });

    // Branch <-> Order
    models.Branch.hasMany(models.Order, { foreignKey: 'branch_id', as: 'orders' });
    models.Order.belongsTo(models.Branch, { foreignKey: 'branch_id', as: 'branch' });
};

const { DataTypes } = require('sequelize');

// Agrega columnas nuevas de forma segura (si ya existen, no hace nada)
const runMigrations = async () => {
    const sqlMigrations = [
        `ALTER TABLE categories  ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE`,
        `ALTER TABLE customers   ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE`,
        `ALTER TABLE discounts   ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE`,
        `ALTER TABLE combos      ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE`,
        `UPDATE categories SET active = TRUE WHERE active IS NULL`,
        `UPDATE customers  SET active = TRUE WHERE active IS NULL`,
        `UPDATE discounts  SET active = TRUE WHERE active IS NULL`,
        `UPDATE combos     SET active = TRUE WHERE active IS NULL`,
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS business_id INTEGER REFERENCES users(id)`,
    ];

    for (const sql of sqlMigrations) {
        try {
            await sequelize.query(sql);
        } catch (err) {
            if (!err.message.includes('already exists')) {
                console.error('❌ Migration error:', err.message);
            }
        }
    }

    // Columnas de sucursal: usar QueryInterface para que Sequelize maneje el nombre de tabla correctamente
    const qi = sequelize.getQueryInterface();
    const safeAdd = async (table, column, definition) => {
        try {
            await qi.addColumn(table, column, definition);
            console.log(`✅ Added column ${table}.${column}`);
        } catch (err) {
            if (!err.message.includes('already exists')) {
                console.error(`❌ Migration ${table}.${column}:`, err.message);
            }
        }
    };
    await safeAdd('orders', 'branch_id', { type: DataTypes.INTEGER, allowNull: true });
    await safeAdd('users',  'branch_id', { type: DataTypes.INTEGER, allowNull: true });

    // Limpiar categorías duplicadas (creadas por clonación accidental de sucursales)
    // Conserva solo la de menor ID por cada combinación business_id + nombre
    try {
        await sequelize.query(`
            DELETE FROM categories
            WHERE id NOT IN (
                SELECT MIN(id) FROM categories GROUP BY business_id, name
            )
        `);
        console.log('✅ Categorías duplicadas limpiadas');
    } catch (err) {
        console.error('❌ Error limpiando categorías duplicadas:', err.message);
    }

    // Asignar pedidos históricos (branch_id=NULL) a la sucursal activa del negocio
    // Estos son pedidos creados antes de que existiera el sistema de sucursales
    try {
        await sequelize.query(`
            UPDATE orders
            SET branch_id = (
                SELECT MIN(id) FROM "Branches"
                WHERE "Branches".business_id = orders.business_id
                AND "Branches".active = true
            )
            WHERE branch_id IS NULL
        `);
        console.log('✅ Pedidos históricos asignados a sucursal activa');
    } catch (err) {
        console.error('❌ Error asignando pedidos históricos:', err.message);
    }

    console.log('✅ Migrations applied');
};

// Sincronizar base de datos
const syncDatabase = async () => {
    try {
        setupRelations();

        // Crea las tablas si no existen. No modifica tablas existentes (seguro en producción).
        await sequelize.sync();
        console.log('✅ Database synced successfully');

        // Migraciones: agrega columnas nuevas solo si no existen
        await runMigrations();

    } catch (error) {
        console.error('❌ Error syncing database:', error);
    }
};

module.exports = {
    sequelize,
    ...models,
    syncDatabase
};