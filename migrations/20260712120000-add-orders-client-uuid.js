'use strict';

/**
 * Idempotencia de pedidos: agrega orders.client_uuid + índice UNIQUE parcial.
 *
 * El client_uuid lo genera el cliente (desktop/mobile) por cada venta. El índice
 * único parcial (WHERE client_uuid IS NOT NULL) garantiza "exactamente una vez"
 * sin afectar los pedidos antiguos que tienen client_uuid NULL.
 *
 * Idempotente: usa IF NOT EXISTS. Nota: en producción esto también se asegura en
 * runMigrations() (models/index.js) porque Render arranca con `node server.js`.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    try {
      await sequelize.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS client_uuid VARCHAR(36)');
      await sequelize.query(
        'CREATE UNIQUE INDEX IF NOT EXISTS orders_client_uuid_uq ON orders (client_uuid) WHERE client_uuid IS NOT NULL'
      );
      console.log('✅ orders.client_uuid + índice único creados');
    } catch (err) {
      console.error('❌ Error creando orders.client_uuid:', err.message);
    }
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    try {
      await sequelize.query('DROP INDEX IF EXISTS orders_client_uuid_uq');
      await sequelize.query('ALTER TABLE orders DROP COLUMN IF EXISTS client_uuid');
    } catch (err) {
      console.error('❌ Error revirtiendo orders.client_uuid:', err.message);
    }
  },
};
