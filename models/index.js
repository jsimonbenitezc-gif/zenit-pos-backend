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

// Stock por sucursal (tabla relacional)
const BranchStock = require('./BranchStock');

// Mesas
const Table = require('./Table');

// Turnos
const Turno = require('./Turno');

// Auditoría de acciones privilegiadas
const PrivilegedActionLog = require('./PrivilegedActionLog');

// Idempotencia de webhooks Stripe
const ProcessedWebhook = require('./ProcessedWebhook');

// Lista de compras
const ShoppingList = require('./ShoppingList');
const ShoppingListItem = require('./ShoppingListItem');

// Sesiones: un refresh token por dispositivo
const RefreshToken = require('./RefreshToken');

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
    Branch,
    BranchStock,
    Table,
    Turno,
    PrivilegedActionLog,
    ProcessedWebhook,
    ShoppingList,
    ShoppingListItem,
    RefreshToken,
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

    // Table <-> Order
    models.Table.hasMany(models.Order, { foreignKey: 'table_id', as: 'orders' });
    models.Order.belongsTo(models.Table, { foreignKey: 'table_id', as: 'table' });

    // Table <-> User (business)
    models.User.hasMany(models.Table, { foreignKey: 'business_id', as: 'tables' });
    models.Table.belongsTo(models.User, { foreignKey: 'business_id', as: 'business' });

    // PrivilegedActionLog <-> Branch
    models.PrivilegedActionLog.belongsTo(models.Branch, { foreignKey: 'branch_id', as: 'branch' });

    // Order -> User (quién creó el pedido)
    models.Order.belongsTo(models.User, { foreignKey: 'created_by', as: 'creator' });

    // BranchStock <-> Ingredient, Branch
    models.Ingredient.hasMany(models.BranchStock, { foreignKey: 'ingredient_id', as: 'branchStocks' });
    models.BranchStock.belongsTo(models.Ingredient, { foreignKey: 'ingredient_id', as: 'ingredient' });
    models.Branch.hasMany(models.BranchStock, { foreignKey: 'branch_id', as: 'branchStocks' });
    models.BranchStock.belongsTo(models.Branch, { foreignKey: 'branch_id', as: 'branch' });

    // ShoppingList <-> ShoppingListItem
    models.ShoppingList.hasMany(models.ShoppingListItem, { foreignKey: 'list_id', as: 'items', onDelete: 'CASCADE' });
    models.ShoppingListItem.belongsTo(models.ShoppingList, { foreignKey: 'list_id', as: 'list' });

    // ShoppingList <-> Branch
    models.ShoppingList.belongsTo(models.Branch, { foreignKey: 'branch_id', as: 'branch' });

    // User <-> RefreshToken (una fila por sesión/dispositivo)
    models.User.hasMany(models.RefreshToken, { foreignKey: 'user_id', as: 'refreshTokens', onDelete: 'CASCADE' });
    models.RefreshToken.belongsTo(models.User, { foreignKey: 'user_id', as: 'user' });
};

// Las migraciones ahora se ejecutan via sequelize-cli.
// Ver carpeta /migrations/ para el historial de cambios.
const runMigrations = async () => {
    console.log('✅ Migrations managed by sequelize-cli');

    // Garantías idempotentes en el arranque (Postgres). En producción Render
    // ejecuta `node server.js` directamente, por lo que `sequelize-cli db:migrate`
    // (definido en el script npm start) puede NO correr. Estas sentencias
    // aseguran que las columnas/índices críticos existan sin depender del CLI.
    // Solo Postgres: en tests (SQLite) las columnas las crea sequelize.sync().
    if (sequelize.getDialect() === 'postgres') {
        try {
            await sequelize.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS client_uuid VARCHAR(36)');
            await sequelize.query(
                'CREATE UNIQUE INDEX IF NOT EXISTS orders_client_uuid_uq ON orders (client_uuid) WHERE client_uuid IS NOT NULL'
            );
        } catch (err) {
            console.error('❌ Error asegurando orders.client_uuid:', err.message);
        }

        // Idempotencia de los items que se agregan a una mesa abierta. El uuid es
        // del LOTE (lo comparten las filas de un mismo envío), así que el índice
        // NO es único: solo acelera la búsqueda "¿ya guardé este envío?".
        try {
            await sequelize.query('ALTER TABLE order_items ADD COLUMN IF NOT EXISTS client_uuid VARCHAR(36)');
            await sequelize.query(
                'CREATE INDEX IF NOT EXISTS order_items_client_uuid_idx ON order_items (order_id, client_uuid)'
            );
        } catch (err) {
            console.error('❌ Error asegurando order_items.client_uuid:', err.message);
        }

        // Sucursal de las mesas. Antes las mesas eran del negocio entero: un local con
        // dos sucursales veía el MISMO mapa de mesas en ambas.
        try {
            await sequelize.query('ALTER TABLE tables ADD COLUMN IF NOT EXISTS branch_id INTEGER');
        } catch (err) {
            console.error('❌ Error asegurando tables.branch_id:', err.message);
        }

        // Sesiones por dispositivo. `sequelize.sync()` ya crea la tabla si no existe,
        // pero el índice único del hash y el de user_id se aseguran aquí porque el
        // sync no toca tablas existentes (ver CLAUDE.md §19.4).
        try {
            await sequelize.query(
                'CREATE UNIQUE INDEX IF NOT EXISTS refresh_tokens_hash_uq ON refresh_tokens (token_hash)'
            );
            await sequelize.query(
                'CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx ON refresh_tokens (user_id)'
            );
        } catch (err) {
            console.error('❌ Error asegurando índices de refresh_tokens:', err.message);
        }

        // Estado 'devuelto' (devolución de pedidos ya elaborados). El ENUM de Sequelize
        // se llama enum_<tabla>_<columna>. ADD VALUE IF NOT EXISTS es idempotente y no
        // corre dentro de una transacción (sequelize.query en autocommit), así que es
        // seguro en el arranque (ver CLAUDE.md §19.4: Render arranca con node server.js).
        try {
            await sequelize.query("ALTER TYPE \"enum_orders_status\" ADD VALUE IF NOT EXISTS 'devuelto'");
        } catch (err) {
            console.error('❌ Error asegurando estado orders.status=devuelto:', err.message);
        }

        // Verificación de correo (política suave). Se agrega con DEFAULT true para
        // "adoptar" a las cuentas ya existentes como verificadas (registradas antes
        // de esta feature — no queremos molestarlas con el aviso). Los registros
        // NUEVOS pasan por Sequelize, que fija email_verified=false explícitamente
        // (defaultValue del modelo), así que el DEFAULT true solo afecta el backfill.
        try {
            await sequelize.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT true');
            await sequelize.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_token VARCHAR(255)');
            await sequelize.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_sent_at TIMESTAMP');
            // Recuperación de contraseña
            await sequelize.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token VARCHAR(255)');
            await sequelize.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMP');
        } catch (err) {
            console.error('❌ Error asegurando columnas de verificación de correo:', err.message);
        }

        // Constraints UNIQUE duplicadas. Sequelize 6 emite un ALTER TABLE ADD CONSTRAINT
        // en cada arranque para las columnas declaradas `unique: true`, sin comprobar si
        // ya existe: tras ~60 despliegues `users` acumuló 63 constraints idénticas sobre
        // (username) y `customers` 45 sobre (phone), revalidadas en cada INSERT.
        //
        // En customers la constraint global era además INCORRECTA. El aislamiento por
        // negocio lo da `customers_business_phone_unique (business_id, phone)`. Con la
        // global, dos negocios distintos no podían tener un cliente con el mismo teléfono:
        // routes/customers.js valida el duplicado por negocio (pasa), y luego el INSERT
        // chocaba contra la constraint global → 500 genérico y cliente imposible de crear.
        // Por eso se eliminan TODAS las de (phone).
        //
        // En users la unicidad global de `username` (el email de login) SÍ es correcta:
        // se conserva exactamente una. `User.js` ya no declara `unique: true`, así que
        // sync() deja de acumularlas; esta limpieza converge a 1 aunque se re-ejecute.
        try {
            await sequelize.query(`
                DO $$
                DECLARE c record; conservar text;
                BEGIN
                    FOR c IN SELECT conname FROM pg_constraint
                             WHERE contype = 'u' AND conrelid = 'customers'::regclass
                               AND pg_get_constraintdef(oid) = 'UNIQUE (phone)' LOOP
                        EXECUTE format('ALTER TABLE customers DROP CONSTRAINT %I', c.conname);
                    END LOOP;

                    SELECT conname INTO conservar FROM pg_constraint
                        WHERE contype = 'u' AND conrelid = 'users'::regclass
                          AND pg_get_constraintdef(oid) = 'UNIQUE (username)'
                        ORDER BY conname LIMIT 1;
                    IF conservar IS NOT NULL THEN
                        FOR c IN SELECT conname FROM pg_constraint
                                 WHERE contype = 'u' AND conrelid = 'users'::regclass
                                   AND pg_get_constraintdef(oid) = 'UNIQUE (username)'
                                   AND conname <> conservar LOOP
                            EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', c.conname);
                        END LOOP;
                    END IF;
                END $$;
            `);
        } catch (err) {
            console.error('❌ Error limpiando constraints UNIQUE duplicadas:', err.message);
        }

        // La unicidad correcta de clientes (por negocio, solo activos). En producción se
        // creó a mano; se garantiza aquí para que una instalación nueva no quede sin ella.
        try {
            await sequelize.query(
                'CREATE UNIQUE INDEX IF NOT EXISTS customers_business_phone_unique ON customers (business_id, phone) WHERE active = true'
            );
        } catch (err) {
            console.error('❌ Error asegurando customers_business_phone_unique:', err.message);
        }

        // products.image y categories.image deben ser TEXT para guardar data URIs
        // base64 (~15-40KB). Sin esto quedan en VARCHAR(255) y el INSERT falla con
        // "value too long", perdiendo la foto. La migración CLI equivalente
        // (20260709000000) no corre en Render (arranca con `node server.js`), así
        // que la garantizamos aquí. Idempotente: ALTER ... TYPE TEXT se re-ejecuta sin daño.
        for (const tabla of ['products', 'categories']) {
            try {
                await sequelize.query(`ALTER TABLE ${tabla} ALTER COLUMN image TYPE TEXT`);
            } catch (err) {
                console.error(`❌ Error asegurando ${tabla}.image TEXT:`, err.message);
            }
        }
    }
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
