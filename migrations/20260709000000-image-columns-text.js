'use strict';

/**
 * Cambia products.image y categories.image de VARCHAR(255) a TEXT.
 *
 * Las imágenes de producto/categoría ahora se guardan como data URIs
 * (base64 comprimido, ~15-40KB) para que sean visibles en todos los
 * dispositivos sin necesidad de un servicio de archivos. VARCHAR(255)
 * no alcanza para eso.
 *
 * Idempotente: ALTER COLUMN ... TYPE TEXT se puede re-ejecutar sin daño.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    for (const tabla of ['products', 'categories']) {
      try {
        await sequelize.query(`ALTER TABLE ${tabla} ALTER COLUMN image TYPE TEXT`);
        console.log(`✅ ${tabla}.image ahora es TEXT`);
      } catch (err) {
        // SQLite (tests) no soporta ALTER COLUMN TYPE, pero tampoco limita
        // la longitud de los VARCHAR, así que no hace falta.
        if (!/near "ALTER"|syntax error/i.test(err.message)) {
          console.error(`❌ Error cambiando ${tabla}.image a TEXT:`, err.message);
        }
      }
    }
  },

  async down() {
    // No se revierte: truncar imágenes existentes sería destructivo.
  },
};
