'use strict';

/**
 * Idempotencia al agregar productos a una mesa abierta (BLOQUE 5).
 *
 * `POST /api/orders/:id/items` no tenía forma de reconocer un reenvío: un doble
 * tap con red débil duplicaba los productos de la mesa Y descontaba los insumos
 * dos veces. El cliente manda ahora un uuid por ENVÍO; todas las filas de ese
 * lote lo comparten, así que el índice NO es único (la deduplicación ocurre en
 * la ruta, dentro de la transacción y con el pedido bloqueado).
 *
 * Idempotente. En producción esto también se asegura en runMigrations()
 * (models/index.js) porque Render arranca con `node server.js` (CLAUDE.md §19.4).
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    try {
      await sequelize.query('ALTER TABLE order_items ADD COLUMN IF NOT EXISTS client_uuid VARCHAR(36)');
      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS order_items_client_uuid_idx ON order_items (order_id, client_uuid)'
      );
      console.log('✅ order_items.client_uuid + índice creados');
    } catch (err) {
      console.error('❌ Error creando order_items.client_uuid:', err.message);
    }
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    try {
      await sequelize.query('DROP INDEX IF EXISTS order_items_client_uuid_idx');
      await sequelize.query('ALTER TABLE order_items DROP COLUMN IF EXISTS client_uuid');
    } catch (err) {
      console.error('❌ Error revirtiendo order_items.client_uuid:', err.message);
    }
  },
};
