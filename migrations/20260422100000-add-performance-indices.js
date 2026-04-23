'use strict';

/**
 * Índices compuestos para consultas frecuentes.
 * - orders(business_id, status, createdAt): filtrado de pedidos por negocio/estado/fecha
 * - customers(business_id): listado de clientes por negocio
 * - ingredients(business_id, active): listado de insumos activos por negocio
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;

    await sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_orders_biz_status_created
      ON orders (business_id, status, "createdAt")
    `);

    await sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_customers_biz
      ON customers (business_id)
    `);

    await sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_ingredients_biz_active
      ON ingredients (business_id, active)
    `);

    console.log('✅ Índices de performance creados');
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.query('DROP INDEX IF EXISTS idx_orders_biz_status_created');
    await sequelize.query('DROP INDEX IF EXISTS idx_customers_biz');
    await sequelize.query('DROP INDEX IF EXISTS idx_ingredients_biz_active');
  },
};
