// ============================================================================
// utils/descuentos.js — cuánto puede descontar un descuento configurado
// (PLAN_OFERTAS_V1, Bloque 0)
//
// EL HUECO QUE CIERRA: `POST /orders` usaba el `discount_id` solo para saber si
// el descuento pedía PIN, y el MONTO lo tomaba de `discount_amount`, que manda
// el cliente. Un descuento configurado de 5% servía para regalar la cuenta
// entera sin PIN, y uno desactivado seguía sirviendo. Quedaba auditado, pero
// nada lo frenaba.
//
// Aquí vive la regla: el máximo que ESE descuento puede quitar a ESA venta, y
// si está vigente. La ruta decide qué hacer con la diferencia (online se
// rechaza; una venta diferida se registra igual y se audita, §26).
//
// ⚠️ La base es la MISMA que usan los dos clientes: el porcentaje se calcula
// sobre la suma de los renglones (precio + extras), antes de impuesto, sin
// importar `applies_to`. El desktop (`_aplicarDescuentoFinal`) y el celular
// (`_aplicarDescuentoFinal` de NuevaVentaScreen) lo aplican al ticket entero,
// así que si el servidor usara otra base, cada venta con descuento parecería
// sospechosa. Cuando los clientes respeten `applies_to`, se cambia aquí y allá.
// ============================================================================

const { Op } = require('sequelize');

// Un centavo de holgura: el desktop no redondea el porcentaje antes de
// guardarlo y el servidor sí, así que pueden diferir en el último centavo.
const TOLERANCIA = 0.01;

const _r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * ¿El descuento se puede usar en `fecha`? Activo y dentro de sus fechas.
 * Cada fecha es opcional POR SEPARADO: uno con solo fecha de inicio vale desde
 * ese día y para siempre (el filtro viejo exigía las dos o ninguna, y ese
 * descuento no salía nunca como activo).
 */
function descuentoVigente(descuento, fecha = new Date()) {
    if (!descuento || !descuento.active) return false;
    const t = new Date(fecha).getTime();
    if (descuento.start_date && new Date(descuento.start_date).getTime() > t) return false;
    if (descuento.end_date && new Date(descuento.end_date).getTime() < t) return false;
    return true;
}

/** El mismo criterio, como `where` de Sequelize, para las rutas que listan. */
function whereVigente(fecha = new Date()) {
    return {
        active: true,
        [Op.and]: [
            { [Op.or]: [{ start_date: null }, { start_date: { [Op.lte]: fecha } }] },
            { [Op.or]: [{ end_date: null }, { end_date: { [Op.gte]: fecha } }] },
        ],
    };
}

/** Lo máximo que este descuento puede quitar a una venta de `base` pesos. */
function montoMaximo(descuento, base) {
    const b = Math.max(0, Number(base) || 0);
    const valor = Math.max(0, parseFloat(descuento.value) || 0);
    const monto = descuento.type === 'percentage' ? _r2(b * valor / 100) : _r2(valor);
    return Math.min(monto, _r2(b));
}

/**
 * Revisa un descuento pedido contra el configurado.
 * Devuelve `{ ok: true }` o `{ ok: false, motivo, maximo }`, con motivo
 * 'inactivo' (desactivado o fuera de fechas) o 'excede'.
 */
function revisarDescuento(descuento, montoPedido, base, fecha = new Date()) {
    const maximo = montoMaximo(descuento, base);
    if (!descuentoVigente(descuento, fecha)) return { ok: false, motivo: 'inactivo', maximo };
    if (_r2(montoPedido - maximo) > TOLERANCIA) return { ok: false, motivo: 'excede', maximo };
    return { ok: true, maximo };
}

module.exports = { descuentoVigente, whereVigente, montoMaximo, revisarDescuento, TOLERANCIA };
