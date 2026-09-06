const sequelize = require('../config/database');

// Importar todos los modelos
const User = require('./User');
const Product = require('./Product');
const Category = require('./Category');
const Customer = require('./Customer');
const Order = require('./Order');
const OrderItem = require('./OrderItem');
// Pagos de una venta (efectivo + tarjeta en la misma cuenta). BLOQUE 10.
const OrderPayment = require('./OrderPayment');

// Inventario
const Ingredient = require('./Ingredient');
const Preparation = require('./Preparation');
const PreparationItem = require('./PreparationItem');
const ProductRecipe = require('./ProductRecipe');
const InventoryMovement = require('./InventoryMovement');

// Modificadores de producto con precio (BLOQUE 11). Biblioteca del negocio:
// los grupos se configuran una vez y se enganchan a los productos que los usan.
const ModifierGroup = require('./ModifierGroup');
const ModifierOption = require('./ModifierOption');
const ProductModifierGroup = require('./ProductModifierGroup');
const ModifierOptionRecipe = require('./ModifierOptionRecipe');

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

// Movimientos de caja (retiros, gastos, depósitos durante el turno)
const CashMovement = require('./CashMovement');

// Auditoría de acciones privilegiadas
const PrivilegedActionLog = require('./PrivilegedActionLog');

// Idempotencia de webhooks Stripe
const ProcessedWebhook = require('./ProcessedWebhook');

// Lista de compras
const ShoppingList = require('./ShoppingList');
const ShoppingListItem = require('./ShoppingListItem');

// Sesiones: un refresh token por dispositivo
const RefreshToken = require('./RefreshToken');

// Dispositivos de cocina aprobados (BLOQUE 13). Reemplazan al pase que caducaba:
// se aprueban con PIN, quedan auditados y se revocan al instante.
const KdsDevice = require('./KdsDevice');

// Objeto con todos los modelos
const models = {
    User,
    Product,
    Category,
    Customer,
    Order,
    OrderItem,
    OrderPayment,
    Ingredient,
    Preparation,
    PreparationItem,
    ProductRecipe,
    InventoryMovement,
    ModifierGroup,
    ModifierOption,
    ProductModifierGroup,
    ModifierOptionRecipe,
    Discount,
    Combo,
    ComboItem,
    Branch,
    BranchStock,
    Table,
    Turno,
    CashMovement,
    PrivilegedActionLog,
    ProcessedWebhook,
    ShoppingList,
    ShoppingListItem,
    RefreshToken,
    KdsDevice,
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

    // Order <-> OrderPayment (BLOQUE 10 — desglose de `total` por método de pago)
    models.Order.hasMany(models.OrderPayment, { foreignKey: 'order_id', as: 'payments' });
    models.OrderPayment.belongsTo(models.Order, { foreignKey: 'order_id', as: 'order' });

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

    // Modificadores (BLOQUE 11): grupo → opciones → ajuste de receta,
    // y la puente que engancha un grupo de la biblioteca a un producto.
    models.ModifierGroup.hasMany(models.ModifierOption, { foreignKey: 'group_id', as: 'options', onDelete: 'CASCADE' });
    models.ModifierOption.belongsTo(models.ModifierGroup, { foreignKey: 'group_id', as: 'group' });

    models.ModifierOption.hasMany(models.ModifierOptionRecipe, { foreignKey: 'option_id', as: 'recipe', onDelete: 'CASCADE' });
    models.ModifierOptionRecipe.belongsTo(models.ModifierOption, { foreignKey: 'option_id', as: 'option' });

    models.Product.hasMany(models.ProductModifierGroup, { foreignKey: 'product_id', as: 'modifierLinks', onDelete: 'CASCADE' });
    models.ProductModifierGroup.belongsTo(models.Product, { foreignKey: 'product_id', as: 'product' });
    models.ModifierGroup.hasMany(models.ProductModifierGroup, { foreignKey: 'group_id', as: 'productLinks', onDelete: 'CASCADE' });
    models.ProductModifierGroup.belongsTo(models.ModifierGroup, { foreignKey: 'group_id', as: 'group' });

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

    // Turno <-> CashMovement (movimientos de caja del turno)
    models.Turno.hasMany(models.CashMovement, { foreignKey: 'turno_id', as: 'movimientos' });
    models.CashMovement.belongsTo(models.Turno, { foreignKey: 'turno_id', as: 'turno' });

    // KdsDevice: quién aprobó cada pantalla de cocina y qué sucursal ve.
    models.KdsDevice.belongsTo(models.User, { foreignKey: 'aprobado_por', as: 'aprobador' });
    models.KdsDevice.belongsTo(models.Branch, { foreignKey: 'branch_id', as: 'branch' });

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

        // Movimientos de caja (BLOQUE 7). `sequelize.sync()` crea la tabla si no
        // existe, pero no toca las tablas existentes: los totales que quedan
        // congelados en el turno cerrado y los índices se aseguran aquí
        // (ver CLAUDE.md §19.4: Render arranca con `node server.js`).
        try {
            for (const col of ['total_depositos', 'total_retiros', 'total_gastos']) {
                await sequelize.query(
                    `ALTER TABLE turnos ADD COLUMN IF NOT EXISTS ${col} NUMERIC(10,2) DEFAULT 0`
                );
            }
            await sequelize.query(
                'CREATE INDEX IF NOT EXISTS cash_movements_turno_idx ON cash_movements (turno_id)'
            );
            // Idempotencia: un reintento por timeout de red no debe duplicar el retiro.
            await sequelize.query(
                'CREATE UNIQUE INDEX IF NOT EXISTS cash_movements_client_uuid_uq ON cash_movements (client_uuid) WHERE client_uuid IS NOT NULL'
            );
        } catch (err) {
            console.error('❌ Error asegurando movimientos de caja:', err.message);
        }

        // Impuesto configurable (BLOQUE 8). `sequelize.sync()` no toca tablas
        // existentes, así que las columnas se aseguran aquí (§19.4: Render
        // arranca con `node server.js` y las migraciones CLI no corren).
        // Los pedidos ya existentes quedan con subtotal NULL a propósito: su
        // total ES lo que se cobró y nadie sabe cuánto de eso era impuesto.
        // `tax_amount` sí se rellena con 0 (DEFAULT), que es la verdad: hasta
        // Contenido del paquete (§45). Un insumo en 'bolsas' que declara que cada
        // bolsa trae 50 g deja de descontar una bolsa por gramo de receta.
        // Las dos columnas nacen NULL, que es exactamente el comportamiento
        // anterior: sin contenido declarado, la conversión cae al camino de
        // siempre y ningún negocio existente cambia de un día para otro.
        try {
            await sequelize.query('ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS content_amount NUMERIC(10,3)');
            await sequelize.query('ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS content_unit VARCHAR(20)');
        } catch (err) {
            console.error('❌ Error asegurando columnas de contenido de insumo:', err.message);
        }

        // hoy no se cobraba impuesto desglosado.
        try {
            await sequelize.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS subtotal NUMERIC(10,2)');
            await sequelize.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(10,2) DEFAULT 0');
            await sequelize.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(5,2)');
            await sequelize.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS tax_included BOOLEAN');
            await sequelize.query('ALTER TABLE turnos ADD COLUMN IF NOT EXISTS total_impuesto NUMERIC(10,2) DEFAULT 0');
        } catch (err) {
            console.error('❌ Error asegurando columnas de impuesto:', err.message);
        }

        // Propinas (BLOQUE 9). Mismas razones que arriba (§19.4). Los pedidos
        // existentes quedan en 0, que es la verdad: hasta hoy no se registraban
        // propinas. `tip_method` queda NULL y solo se llena cuando hay propina.
        try {
            await sequelize.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS tip_amount NUMERIC(10,2) DEFAULT 0');
            await sequelize.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS tip_method VARCHAR(20)');
            for (const col of ['total_propinas', 'total_propinas_efectivo',
                               'total_propinas_tarjeta', 'total_propinas_transferencia']) {
                await sequelize.query(
                    `ALTER TABLE turnos ADD COLUMN IF NOT EXISTS ${col} NUMERIC(10,2) DEFAULT 0`
                );
            }
        } catch (err) {
            console.error('❌ Error asegurando columnas de propina:', err.message);
        }

        // Pagos divididos (BLOQUE 10). `sequelize.sync()` crea `order_payments` si no
        // existe, pero no toca tablas existentes: los índices se aseguran aquí (§19.4).
        //
        // ⚠️ `orders.payment_method` es un ENUM en Postgres y necesita el valor
        // 'multiple' para las ventas repartidas entre varios métodos. `ADD VALUE IF
        // NOT EXISTS` es idempotente y no reescribe la tabla. Un pedido de un solo
        // método sigue guardando su método de siempre, así que nada existente cambia.
        try {
            await sequelize.query(
                `ALTER TYPE "enum_orders_payment_method" ADD VALUE IF NOT EXISTS 'multiple'`
            );
        } catch (err) {
            // Si la columna no es ENUM (instalaciones que la crearon como VARCHAR)
            // no hay nada que hacer y tampoco es un problema: el valor entra igual.
            console.error('ℹ️  payment_method ENUM:', err.message);
        }
        try {
            await sequelize.query(
                'CREATE INDEX IF NOT EXISTS order_payments_order_idx ON order_payments (order_id)'
            );
            await sequelize.query(
                'CREATE INDEX IF NOT EXISTS order_payments_biz_idx ON order_payments (business_id)'
            );
        } catch (err) {
            console.error('❌ Error asegurando índices de order_payments:', err.message);
        }

        // Modificadores de producto (BLOQUE 11). `sequelize.sync()` crea las
        // cuatro tablas nuevas si no existen, pero NO toca `order_items`, que ya
        // existe: sus dos columnas nuevas se aseguran aquí (§19.4).
        //
        // Los renglones ya existentes quedan con `modifiers` NULL y
        // `base_unit_price` NULL a propósito: su `unit_price` ES el precio base
        // y no hubo extras que desglosar. No hay nada que migrar.
        try {
            await sequelize.query('ALTER TABLE order_items ADD COLUMN IF NOT EXISTS modifiers TEXT');
            await sequelize.query('ALTER TABLE order_items ADD COLUMN IF NOT EXISTS base_unit_price NUMERIC(10,2)');
        } catch (err) {
            console.error('❌ Error asegurando columnas de modificadores en order_items:', err.message);
        }
        try {
            await sequelize.query(
                'CREATE INDEX IF NOT EXISTS modifier_groups_biz_idx ON modifier_groups (business_id)'
            );
            await sequelize.query(
                'CREATE INDEX IF NOT EXISTS modifier_options_group_idx ON modifier_options (group_id)'
            );
            await sequelize.query(
                'CREATE INDEX IF NOT EXISTS modifier_option_recipes_option_idx ON modifier_option_recipes (option_id)'
            );
            // La puente se consulta por producto (armar el carrito) y se limpia
            // por grupo (al borrar un grupo de la biblioteca).
            await sequelize.query(
                'CREATE INDEX IF NOT EXISTS product_modifier_groups_product_idx ON product_modifier_groups (product_id)'
            );
            await sequelize.query(
                'CREATE UNIQUE INDEX IF NOT EXISTS product_modifier_groups_uq ON product_modifier_groups (product_id, group_id)'
            );
        } catch (err) {
            console.error('❌ Error asegurando índices de modificadores:', err.message);
        }

        // Dispositivos de cocina (BLOQUE 13). `sequelize.sync()` crea la tabla si
        // no existe; aquí solo se aseguran los índices, que son los que hacen
        // barato el camino caliente: CADA petición del KDS resuelve el
        // dispositivo por su `secret_hash`.
        //
        // El índice de `secret_hash` es UNIQUE a propósito: dos dispositivos con
        // el mismo secreto serían el mismo dispositivo, y aprobar uno aprobaría
        // al otro sin que nadie lo viera.
        try {
            await sequelize.query(
                'CREATE UNIQUE INDEX IF NOT EXISTS kds_devices_secret_uq ON kds_devices (secret_hash)'
            );
            await sequelize.query(
                'CREATE INDEX IF NOT EXISTS kds_devices_biz_idx ON kds_devices (business_id)'
            );
        } catch (err) {
            console.error('❌ Error asegurando índices de kds_devices:', err.message);
        }

        // Marca de "fuera de horario" en la auditoría (BLOQUE 14). La tabla ya
        // existe, así que `sequelize.sync()` no la toca: la columna se asegura
        // aquí (§19.4). Las filas anteriores quedan en `false`, que es la verdad —
        // el horario nace SIN definir y sin horario no hay "fuera de horario".
        try {
            await sequelize.query(
                'ALTER TABLE privileged_action_logs ADD COLUMN IF NOT EXISTS fuera_horario BOOLEAN DEFAULT false'
            );
            // El dueño filtra el historial justo por esto ("enséñame lo de la
            // madrugada"), y es una minoría de las filas: el índice parcial ocupa
            // casi nada y evita el escaneo completo de la tabla.
            await sequelize.query(
                'CREATE INDEX IF NOT EXISTS pal_fuera_horario_idx ON privileged_action_logs (business_id, "createdAt") WHERE fuera_horario'
            );
        } catch (err) {
            console.error('❌ Error asegurando fuera_horario en privileged_action_logs:', err.message);
        }

        // ── CERRAR LA BASE A LOS ROLES PÚBLICOS (auditoría 2026-07-27) ──────
        // Zenit NO usa PostgREST: se conecta con Sequelize por el pooler como
        // `postgres`, que es DUEÑO de las tablas y tiene `rolbypassrls = true`.
        // Por eso ni el REVOKE ni el RLS pueden afectarlo — verificado en vivo.
        //
        // `anon` y `authenticated` son los roles que expone la Data API de
        // Supabase. Esa API ya está apagada, pero si alguien la vuelve a encender
        // desde el panel (por error o por probar algo), sin esto la puerta se
        // reabriría entera: lectura Y escritura anónimas sobre producción,
        // incluida `users.password`. Esto es lo que hace que ese error deje de
        // ser catastrófico.
        //
        // Va aquí y no en un SQL suelto a propósito: `sequelize.sync()` crea las
        // tablas nuevas y Supabase les concede permisos por defecto, así que un
        // REVOKE de una sola vez se filtraría en la siguiente tabla. Aquí se
        // re-aplica en cada arranque (§19.4) y además cubre lo que venga.
        // Es idempotente: revocar lo ya revocado y encender RLS ya encendido no
        // hace nada.
        try {
            await sequelize.query(`
                DO $$
                DECLARE t record;
                BEGIN
                  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
                    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t.tablename);
                    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
                  END LOOP;
                END $$;
            `);
            await sequelize.query('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated');
            await sequelize.query('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated');
            // Y que lo que se cree a futuro nazca igual de cerrado.
            await sequelize.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated');
            await sequelize.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated');
            await sequelize.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated');
        } catch (err) {
            // Nunca tumbar el arranque por esto: si falla, el backend sigue
            // funcionando y queda el rastro para revisarlo.
            console.error('❌ Error cerrando permisos públicos de la base:', err.message);
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

    // ── STOCK POR SUCURSAL: respaldar el JSON legado en la tabla (deuda §12.1) ──
    // Va FUERA del bloque de Postgres a propósito: está escrito con Sequelize, no
    // con SQL de un dialecto, así que también corre en los tests (SQLite) y ahí se
    // puede probar. Es idempotente: en cuanto la tabla tiene el par, no hace nada.
    //
    // 🔴 De esto depende que no se borre un inventario. La columna JSON dejó de
    // leerse en este mismo despliegue, así que un par que solo estuviera en el JSON
    // pasaría a leer 0. En producción eran 10 de 17 pares, la sucursal 3 entera.
    //
    // El require es perezoso porque utils/branchStock.js importa este mismo módulo:
    // pedirlo arriba sería una dependencia circular y llegaría a medio construir.
    try {
        const { respaldarJsonEnTabla } = require('../utils/branchStock');
        const r = await respaldarJsonEnTabla();
        if (r.copiados > 0) {
            console.log(`✅ Stock por sucursal: ${r.copiados} pares respaldados del JSON legado a branch_stocks`);
        }
    } catch (err) {
        // Ruidoso a propósito: si esto falla, el inventario por sucursal de un
        // negocio que aún dependiera del JSON leería mal, y hay que enterarse.
        console.error('❌ ERROR respaldando branch_stocks (revisar inventario por sucursal):', err.message);
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
