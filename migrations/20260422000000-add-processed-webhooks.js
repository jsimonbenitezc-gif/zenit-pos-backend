'use strict';

/**
 * Crea la tabla processed_webhooks para idempotencia de webhooks de Stripe.
 * Evita reprocesar eventos duplicados que Stripe pueda reenviar.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const sequelize = queryInterface.sequelize;

    try {
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS processed_webhooks (
          id SERIAL PRIMARY KEY,
          event_id VARCHAR(255) NOT NULL UNIQUE,
          "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )
      `);
      console.log('✅ Tabla processed_webhooks creada');
    } catch (err) {
      if (!err.message.includes('already exists')) {
        console.error('❌ Error creando tabla processed_webhooks:', err.message);
      }
    }
  },

  async down(queryInterface) {
    await queryInterface.dropTable('processed_webhooks');
  },
};
