const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

/**
 * Dispositivo de cocina aprobado (BLOQUE 13 V5).
 *
 * Sustituye al pase que caducaba. Antes, el QR del KDS ERA la credencial: quien
 * lo fotografiara tenía 12 h de acceso y no había forma de cortárselo — solo
 * esperar. Un pase que expira molesta (obliga a re-escanear en plena hora pico)
 * y protege poco: si la tablet se pierde, sigue sirviendo hasta que venza.
 *
 * Un dispositivo APROBADO y REVOCABLE es más seguro y más cómodo a la vez: no
 * caduca nunca, y revocarlo corta el acceso al instante.
 *
 * IDENTIDAD POR SECRETO, NUNCA POR IP. La tablet genera su propio secreto y lo
 * guarda en `localStorage`; aquí solo vive su SHA256 (mismo criterio que los
 * refresh tokens, CLAUDE.md §25). Las IPs las reparte el router y rotan: la
 * tablet aprobada pediría permiso otra vez mañana y, peor, el celular de un
 * cliente podría heredar una IP ya aprobada.
 */
const KdsDevice = sequelize.define('KdsDevice', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    business_id: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    // Sucursal cuya cola de cocina ve este dispositivo. NULL = todas las del
    // negocio (negocio de un solo local, o pantalla general).
    branch_id: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    nombre: {
        type: DataTypes.STRING,
        allowNull: true
    },
    // SHA256 del secreto que generó la tablet. El secreto en claro NUNCA llega
    // a la base: si esta tabla se filtra, no se puede suplantar a nadie.
    secret_hash: {
        type: DataTypes.STRING(64),
        allowNull: false
    },
    // 'pendiente' → se registró y espera aprobación (no puede leer NADA)
    // 'activo'    → aprobado con PIN; lee la cola de cocina y nada más
    // 'revocado'  → cortado. No se borra: el registro es la auditoría.
    estado: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'pendiente'
    },
    aprobado_por: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    aprobado_por_nombre: {
        type: DataTypes.STRING,
        allowNull: true
    },
    aprobado_en: {
        type: DataTypes.DATE,
        allowNull: true
    },
    revocado_por: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    revocado_por_nombre: {
        type: DataTypes.STRING,
        allowNull: true
    },
    revocado_en: {
        type: DataTypes.DATE,
        allowNull: true
    },
    ultimo_acceso: {
        type: DataTypes.DATE,
        allowNull: true
    },
    user_agent: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    // Informativa: sirve para que el dueño reconozca el equipo al aprobarlo
    // ("la tablet de la barra"). NO se usa para autorizar nada.
    ip_registro: {
        type: DataTypes.STRING(64),
        allowNull: true
    }
}, {
    tableName: 'kds_devices',
    timestamps: true
});

module.exports = KdsDevice;
