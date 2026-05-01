'use strict';

/**
 * Agrega foreign key constraint a orders.branch_id → "Branches".id
 * con ON DELETE SET NULL.
 *
 * Antes de aplicar la constraint, limpia branch_id huérfanos (que apunten
 * a sucursales inexistentes) seteándolos a NULL para evitar violaciones.
 *
 * Idempotente: si la constraint ya existe, no hace nada.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;

    // Paso 1: limpiar branch_id huérfanos
    try {
      await sequelize.query(`
        UPDATE orders
        SET branch_id = NULL
        WHERE branch_id IS NOT NULL
          AND branch_id NOT IN (SELECT id FROM "Branches")
      `);
    } catch (err) {
      console.error('❌ Error limpiando orders.branch_id huérfanos:', err.message);
    }

    // Paso 2: agregar la FK constraint con ON DELETE SET NULL
    try {
      await sequelize.query(`
        ALTER TABLE orders
        ADD CONSTRAINT fk_orders_branch_id
        FOREIGN KEY (branch_id)
        REFERENCES "Branches"(id)
        ON DELETE SET NULL
      `);
      console.log('✅ FK fk_orders_branch_id creada');
    } catch (err) {
      if (err.message.includes('already exists')) {
        // Constraint ya existe — idempotente
      } else {
        console.error('❌ Error creando fk_orders_branch_id:', err.message);
      }
    }
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    try {
      await sequelize.query(`
        ALTER TABLE orders DROP CONSTRAINT IF EXISTS fk_orders_branch_id
      `);
    } catch (err) {
      console.error('❌ Error eliminando fk_orders_branch_id:', err.message);
    }
  },
};
