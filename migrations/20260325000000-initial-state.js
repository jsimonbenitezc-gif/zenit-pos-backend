'use strict';

/**
 * Migración inicial: captura todas las sentencias que estaban en runMigrations()
 * de models/index.js. Cada sentencia usa IF NOT EXISTS / try-catch para ser
 * idempotente — puede correr sobre una DB que ya tiene todo aplicado sin romper nada.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const qi = queryInterface;
    const sequelize = qi.sequelize;

    // ─── Parte 1: ALTER TABLE ADD COLUMN con SQL directo ─────────────────────
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
      `ALTER TYPE enum_users_plan ADD VALUE IF NOT EXISTS 'premium'`,
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

    // ─── Parte 2: safeAdd via QueryInterface ─────────────────────────────────
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

    // Columnas de sucursal en orders
    await safeAdd('orders', 'branch_id',       { type: Sequelize.INTEGER, allowNull: true });
    await safeAdd('orders', 'table_id',        { type: Sequelize.INTEGER, allowNull: true });
    await safeAdd('orders', 'guests',          { type: Sequelize.INTEGER, allowNull: true });
    await safeAdd('orders', 'discount_amount', { type: Sequelize.DECIMAL(10, 2), defaultValue: 0 });

    // Columnas adicionales en users
    await safeAdd('users', 'branch_id', { type: Sequelize.INTEGER, allowNull: true });

    // Fidelidad en customers
    await safeAdd('customers', 'loyalty_points', { type: Sequelize.INTEGER, defaultValue: 0 });
    await safeAdd('customers', 'in_loyalty',     { type: Sequelize.BOOLEAN, defaultValue: false });

    // unit_recipe
    await safeAdd('preparation_items', 'unit_recipe', { type: Sequelize.STRING, allowNull: true });
    await safeAdd('product_recipes',   'unit_recipe', { type: Sequelize.STRING, allowNull: true });

    // Turnos
    await safeAdd('turnos', 'branch_id',           { type: Sequelize.INTEGER,        allowNull: true });
    await safeAdd('turnos', 'rol',                 { type: Sequelize.STRING,         allowNull: true });
    await safeAdd('turnos', 'notas',               { type: Sequelize.TEXT,           allowNull: true });
    await safeAdd('turnos', 'total_tarjeta',       { type: Sequelize.DECIMAL(10, 2), defaultValue: 0 });
    await safeAdd('turnos', 'total_transferencia', { type: Sequelize.DECIMAL(10, 2), defaultValue: 0 });

    // Stock por sucursal
    await safeAdd('ingredients',         'branch_stocks', { type: Sequelize.TEXT, allowNull: true });
    await safeAdd('inventory_movements', 'branch_id',     { type: Sequelize.INTEGER, allowNull: true });

    // ─── Parte 3: Migrar stock global → branch_stocks ────────────────────────
    try {
      await sequelize.query(`
        UPDATE ingredients
        SET branch_stocks = (
          SELECT json_build_object(b.id::text, COALESCE(ingredients.stock::numeric, 0))::text
          FROM "Branches" b
          WHERE b.business_id = ingredients.business_id
            AND b.active = true
          ORDER BY b.id ASC
          LIMIT 1
        )
        WHERE ingredients.branch_stocks IS NULL
          AND EXISTS (
            SELECT 1 FROM "Branches" b2
            WHERE b2.business_id = ingredients.business_id AND b2.active = true
          )
      `);
      console.log('✅ Stock global migrado a branch_stocks (sucursal principal)');
    } catch (err) {
      console.error('❌ Error migrando branch_stocks:', err.message);
    }

    // Teléfono y dirección por sucursal
    await safeAdd('Branches', 'phone',   { type: Sequelize.STRING, allowNull: true });
    await safeAdd('Branches', 'address', { type: Sequelize.STRING, allowNull: true });

    // Suscripción
    await safeAdd('users', 'plan_expires_at',        { type: Sequelize.DATE,   allowNull: true });
    await safeAdd('users', 'stripe_customer_id',     { type: Sequelize.STRING, allowNull: true });
    await safeAdd('users', 'stripe_subscription_id', { type: Sequelize.STRING, allowNull: true });

    // Auditoría
    await safeAdd('discounts', 'requires_pin', { type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false });

    // Quién creó cada pedido
    await safeAdd('orders', 'created_by', { type: Sequelize.INTEGER, allowNull: true });

    // Push notifications
    await safeAdd('users', 'push_tokens', { type: Sequelize.TEXT, allowNull: true });

    // Refresh tokens
    await safeAdd('users', 'refresh_token_hash',    { type: Sequelize.STRING, allowNull: true });
    await safeAdd('users', 'refresh_token_expires', { type: Sequelize.DATE,   allowNull: true });

    // ─── Parte 4: plan ENUM ──────────────────────────────────────────────────
    try {
      await sequelize.query(`DO $$ BEGIN
        CREATE TYPE enum_users_plan AS ENUM ('free', 'trial', 'premium');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
      await sequelize.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS plan enum_users_plan DEFAULT 'free'`);
      console.log('✅ Added column users.plan');
    } catch (err) {
      if (!err.message.includes('already exists')) {
        console.error('❌ Migration users.plan:', err.message);
      }
    }

    // ─── Parte 5: UNIQUE constraint para categorías ──────────────────────────
    try {
      await sequelize.query(`
        ALTER TABLE categories ADD CONSTRAINT uq_categories_business_name UNIQUE (business_id, name)
      `);
      console.log('✅ UNIQUE constraint uq_categories_business_name creado');
    } catch (err) {
      if (err.message.includes('already exists')) {
        // Constraint ya existe
      } else if (err.message.includes('duplicate key') || err.message.includes('could not create unique index')) {
        console.log('ℹ️ Duplicados detectados, limpiando antes de crear constraint...');
        try {
          await sequelize.query(`
            DELETE FROM categories
            WHERE id NOT IN (
              SELECT MIN(id) FROM categories GROUP BY business_id, name
            )
          `);
          await sequelize.query(`
            ALTER TABLE categories ADD CONSTRAINT uq_categories_business_name UNIQUE (business_id, name)
          `);
          console.log('✅ Duplicados limpiados y UNIQUE constraint creado');
        } catch (retryErr) {
          if (!retryErr.message.includes('already exists')) {
            console.error('❌ Error creando constraint de categorías:', retryErr.message);
          }
        }
      } else {
        console.error('❌ Error en constraint de categorías:', err.message);
      }
    }

    // ─── Parte 6: Backfill de pedidos históricos ─────────────────────────────
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

    // ─── Parte 7: Backfill business_id en inventory_movements ────────────────
    try {
      await sequelize.query(`
        UPDATE inventory_movements im
        SET business_id = (
          SELECT i.business_id FROM ingredients i WHERE i.id = im.ingredient_id
        )
        WHERE im.business_id IS NULL
      `);
      console.log('✅ inventory_movements.business_id backfill completado');
    } catch (err) {
      console.error('❌ Error en backfill de inventory_movements.business_id:', err.message);
    }

    // ─── Parte 8: Índice parcial único para turnos ───────────────────────────
    try {
      await sequelize.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_turnos_one_open
        ON turnos (business_id, COALESCE(branch_id, 0))
        WHERE estado = 'abierto'
      `);
    } catch (err) {
      if (!err.message.includes('already exists')) {
        console.error('❌ Migration idx_turnos_one_open:', err.message);
      }
    }

    // ─── Parte 9: Índices de rendimiento ─────────────────────────────────────
    const indexes = [
      `CREATE INDEX IF NOT EXISTS idx_orders_biz_status     ON orders    (business_id, status)`,
      `CREATE INDEX IF NOT EXISTS idx_orders_biz_createdat  ON orders    (business_id, "createdAt" DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_customers_biz         ON customers (business_id)`,
      `CREATE INDEX IF NOT EXISTS idx_ingredients_biz       ON ingredients (business_id)`,
    ];
    for (const sql of indexes) {
      try {
        await sequelize.query(sql);
      } catch (err) {
        if (!err.message.includes('already exists')) {
          console.error('❌ Migration index:', err.message);
        }
      }
    }

    console.log('✅ Initial migration applied');
  },

  async down() {
    // No rollback para la migración base — no vale la pena revertir la estructura inicial.
    return Promise.resolve();
  },
};
