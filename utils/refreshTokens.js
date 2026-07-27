// utils/refreshTokens.js — Sesiones por dispositivo
//
// PROBLEMA QUE RESUELVE (2026-07-27): el refresh token nunca se llegaba a guardar.
// Se escribía con `user.update({ refresh_token_hash, refresh_token_expires })`, pero
// esas dos columnas **no están declaradas en el modelo User** (solo se crearon en
// Postgres con una migración suelta). Sequelize ignora en silencio los atributos que
// no conoce, así que el UPDATE no escribía nada y la columna quedaba siempre NULL:
// `POST /auth/refresh` no encontraba a nadie y devolvía 401. Resultado en la vida
// real: la sesión moría en cuanto el access token cumplía 15 minutos ("me tardo unos
// minutos escribiendo y me pide iniciar sesión otra vez"). El síntoma parecía un
// token de vida corta; en realidad el refresh nunca funcionó.
//
// Se resuelve con una tabla propia —modelo real, no columnas fantasma— y de paso se
// arregla el segundo defecto del diseño viejo: una sola fila por usuario significaba
// una sola sesión, así que entrar desde el celular habría cerrado la del desktop.
// Ahora cada dispositivo tiene su fila.
//
// No hay nada que migrar de las columnas viejas: nunca contuvieron un valor.

const crypto = require('crypto');
const { Op } = require('sequelize');
const { RefreshToken } = require('../models');
const { User } = require('../models');

const DIAS_VIGENCIA = 30;
// Tope de sesiones simultáneas por usuario. Alto para no estorbar a un negocio con
// varias cajas + tablets, pero acotado para que la tabla no crezca sin límite.
const MAX_SESIONES = 15;

function hashDe(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Crea una sesión nueva y devuelve el refresh token opaco (el único momento en que
 * existe en claro). En BD solo queda su SHA256.
 *
 * @param {object}  user                  instancia de User
 * @param {object=} opts.transaction      transacción Sequelize en curso
 * @returns {Promise<string>} refresh token para el cliente
 */
async function emitirRefreshToken(user, { transaction = null } = {}) {
    const token = crypto.randomBytes(64).toString('hex');
    const expires = new Date(Date.now() + DIAS_VIGENCIA * 24 * 60 * 60 * 1000);

    await RefreshToken.create(
        { user_id: user.id, token_hash: hashDe(token), expires_at: expires },
        { transaction }
    );

    // Limpieza oportunista: caducadas primero, y si aún sobran, las más viejas.
    try {
        await RefreshToken.destroy({
            where: { user_id: user.id, expires_at: { [Op.lt]: new Date() } },
            transaction,
        });
        const total = await RefreshToken.count({ where: { user_id: user.id }, transaction });
        if (total > MAX_SESIONES) {
            const sobrantes = await RefreshToken.findAll({
                where: { user_id: user.id },
                order: [['createdAt', 'ASC']],
                limit: total - MAX_SESIONES,
                attributes: ['id'],
                transaction,
            });
            await RefreshToken.destroy({
                where: { id: { [Op.in]: sobrantes.map(s => s.id) } },
                transaction,
            });
        }
    } catch { /* la limpieza nunca debe tumbar un login */ }

    return token;
}

/**
 * Valida y CONSUME un refresh token (rotación: un token sirve una sola vez, así que
 * si alguien roba uno y la víctima lo usa antes, el robado ya no vale).
 *
 * @param {string}  token                 refresh token que mandó el cliente
 * @param {object=} opts.transaction
 * @returns {Promise<{user: object}|null>} null si es inválido o está vencido
 */
async function consumirRefreshToken(token, { transaction = null } = {}) {
    if (!token) return null;

    const fila = await RefreshToken.findOne({ where: { token_hash: hashDe(token) }, transaction });
    if (!fila) return null;

    await fila.destroy({ transaction });
    if (new Date(fila.expires_at) < new Date()) return null;

    const user = await User.findOne({ where: { id: fila.user_id, active: true }, transaction });
    return user ? { user } : null;
}

/**
 * Cierra TODAS las sesiones del usuario (reseteo de contraseña, baja de empleado).
 * @param {number}  userId
 * @param {object=} opts.transaction
 */
async function revocarTodasLasSesiones(userId, { transaction = null } = {}) {
    await RefreshToken.destroy({ where: { user_id: userId }, transaction });
}

module.exports = { emitirRefreshToken, consumirRefreshToken, revocarTodasLasSesiones };
