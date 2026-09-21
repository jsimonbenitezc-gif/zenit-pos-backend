const express = require('express');
const router = express.Router();
const { Discount, Combo, ComboItem, Product, Category, sequelize } = require('../models');
const { Op } = require('sequelize');
const { authenticate, isOwner } = require('../middleware/auth');
const { requirePremium } = require('../middleware/checkPlan');
const { whereVigente, descuentoVigente } = require('../utils/descuentos');
const { normalizarCalendario, promoActiva, TIPOS, productosQueLleva } = require('../utils/promos');
const { serializarCombo, huecoDeRenglon } = require('../utils/promosNegocio');
const { zonaDelNegocio } = require('../utils/tz');

// El calendario del body: `tocado: false` = no vino; si viene, se valida y un
// calendario basura es 400 — caer a "siempre" en silencio cobraría el 2x1 del
// martes también el miércoles.
function calendarioDelBody(body) {
    if (!body || !('calendario' in body)) return { tocado: false };
    const r = normalizarCalendario(body.calendario);
    return r.ok ? { tocado: true, calendario: r.calendario } : { tocado: true, error: r.error };
}

// Todas las rutas de ofertas requieren plan premium
router.use(authenticate, requirePremium);

// ============================================
// DESCUENTOS
// ============================================

router.get('/discounts', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const { active } = req.query;
        const where = { business_id: biz };
        if (active !== undefined) where.active = active === 'true';
        const discounts = await Discount.findAll({ where, order: [['createdAt', 'DESC']] });
        res.json(discounts);
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

router.get('/discounts/active', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;
        // Cada fecha es opcional por separado (utils/descuentos.js): el filtro
        // viejo exigía las dos o ninguna, y un descuento con solo fecha de
        // inicio no salía nunca como activo.
        const ahora = new Date();
        const [discounts, tz] = await Promise.all([
            Discount.findAll({ where: { business_id: biz, ...whereVigente(ahora) } }),
            zonaDelNegocio(biz),
        ]);
        // Y su calendario ("10% los lunes"), en la zona del negocio.
        res.json(discounts.filter(d => descuentoVigente(d, ahora, tz)));
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

router.get('/discounts/:id', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const discount = await Discount.findOne({ where: { id: req.params.id, business_id: biz } });
        if (!discount) {
            return res.status(404).json({ error: 'Descuento no encontrado' });
        }
        res.json(discount);
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

router.post('/discounts', authenticate, isOwner, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const { name, type, value, applies_to, target_id, start_date, end_date, active, requires_pin } = req.body;
        if (!name || !type || value === undefined) {
            return res.status(400).json({ error: 'Name, type and value are required' });
        }
        if (!['percentage', 'fixed'].includes(type)) {
            return res.status(400).json({ error: 'El tipo debe ser porcentaje o monto_fijo' });
        }
        if (!['all', 'category', 'product'].includes(applies_to)) {
            return res.status(400).json({ error: 'applies_to debe ser all, category o product' });
        }
        if (type === 'percentage' && (value < 0 || value > 100)) {
            return res.status(400).json({ error: 'El porcentaje debe estar entre 0 y 100' });
        }
        const cal = calendarioDelBody(req.body);
        if (cal.error) return res.status(400).json({ error: cal.error });
        const discount = await Discount.create({
            name, type, value, applies_to: applies_to || 'all',
            target_id, start_date, end_date,
            calendario: cal.tocado ? cal.calendario : null,
            active: active !== undefined ? active : true,
            requires_pin: requires_pin === true,
            business_id: biz
        });
        res.status(201).json(discount);
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

router.put('/discounts/:id', authenticate, isOwner, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const discount = await Discount.findOne({ where: { id: req.params.id, business_id: biz } });
        if (!discount) {
            return res.status(404).json({ error: 'Descuento no encontrado' });
        }
        const { name, type, value, applies_to, target_id, start_date, end_date, active, requires_pin } = req.body;
        const cal = calendarioDelBody(req.body);
        if (cal.error) return res.status(400).json({ error: cal.error });
        await discount.update({
            ...(cal.tocado ? { calendario: cal.calendario } : {}),
            name: name !== undefined ? name : discount.name,
            type: type !== undefined ? type : discount.type,
            value: value !== undefined ? value : discount.value,
            applies_to: applies_to !== undefined ? applies_to : discount.applies_to,
            target_id: target_id !== undefined ? target_id : discount.target_id,
            start_date: start_date !== undefined ? start_date : discount.start_date,
            end_date: end_date !== undefined ? end_date : discount.end_date,
            active: active !== undefined ? active : discount.active,
            requires_pin: requires_pin !== undefined ? requires_pin === true : discount.requires_pin
        });
        res.json(discount);
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

router.delete('/discounts/:id', authenticate, isOwner, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const discount = await Discount.findOne({ where: { id: req.params.id, business_id: biz } });
        if (!discount) {
            return res.status(404).json({ error: 'Descuento no encontrado' });
        }
        await discount.update({ active: false });
        res.json({ message: 'Descuento eliminado correctamente' });
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

router.post('/discounts/calculate', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const { product_id, category_id, amount } = req.body;
        if (!amount) {
            return res.status(400).json({ error: 'El monto es requerido' });
        }
        const vigente = whereVigente(new Date());
        let discount = null;
        if (product_id) {
            discount = await Discount.findOne({
                where: { business_id: biz, ...vigente, applies_to: 'product', target_id: product_id }
            });
        }
        if (!discount && category_id) {
            discount = await Discount.findOne({
                where: { business_id: biz, ...vigente, applies_to: 'category', target_id: category_id }
            });
        }
        if (!discount) {
            discount = await Discount.findOne({
                where: { business_id: biz, ...vigente, applies_to: 'all' }
            });
        }
        if (!discount) {
            return res.json({ discount_applied: false, original_amount: amount, discount_amount: 0, final_amount: amount });
        }
        let discountAmount = 0;
        if (discount.type === 'percentage') {
            discountAmount = (parseFloat(amount) * parseFloat(discount.value)) / 100;
        } else {
            discountAmount = parseFloat(discount.value);
        }
        res.json({
            discount_applied: true,
            discount_id: discount.id,
            discount_name: discount.name,
            discount_type: discount.type,
            discount_value: discount.value,
            original_amount: amount,
            discount_amount: discountAmount,
            final_amount: parseFloat(amount) - discountAmount
        });
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ============================================
// COMBOS = PROMOS (PLAN_OFERTAS_V1, Bloque 1)
// ============================================

// Cómo se cobra y cuándo. `actual` = el combo que se edita (null al crear).
// 'regalar_mas_barato' exige `paga` ≥ 1; que sea menor que lo que lleva se
// comprueba también al guardar los renglones, que es cuando se sabe cuánto lleva.
function reglasDePromo(body, actual) {
    const tipo = body.tipo !== undefined ? body.tipo : (actual ? actual.tipo : 'precio_fijo');
    if (!TIPOS.includes(tipo)) return { error: 'La forma de cobrar es precio fijo o regalar el más barato' };
    let paga = body.paga !== undefined ? body.paga : (actual ? actual.paga : null);
    if (tipo === 'regalar_mas_barato') {
        paga = parseInt(paga, 10);
        if (!Number.isInteger(paga) || paga < 1) return { error: 'Di cuántos productos se cobran (en un 2x1, se cobra 1)' };
        const lleva = actual ? productosQueLleva((actual.items || []).map(huecoDeRenglon)) : 0;
        if (lleva && paga >= lleva) return { error: `Esta promo lleva ${lleva}: tiene que cobrar menos que eso` };
    } else {
        paga = null;
    }
    const cal = calendarioDelBody(body);
    if (cal.error) return { error: cal.error };
    const calendario = cal.tocado ? cal.calendario : (actual ? actual.calendario : null);
    return { tipo, paga, calendario };
}

router.get('/combos', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const { active } = req.query;
        const where = { business_id: biz };
        if (active !== undefined) where.active = active === 'true';
        const combos = await Combo.findAll({
            where,
            include: [{
                model: ComboItem,
                as: 'items',
                // Sin `image`: el listado de combos arrastraba la foto base64 de cada
                // producto incluido y ningún cliente la dibuja aquí (usan el emoji).
                include: [{ model: Product, as: 'product', attributes: ['id', 'name', 'price', 'emoji'] }]
            }],
            order: [['name', 'ASC']]
        });
        // La forma nueva viaja en `slots`; `items` sigue trayendo solo los
        // renglones de producto fijo (trampa 1: el desktop publicado).
        res.json(combos.map(c => serializarCombo(c)));
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Las promos que se pueden vender AHORA: activas y dentro de su calendario, en
// la zona del negocio. El martes a las 11 p. m. en México NO es miércoles.
router.get('/combos/active', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const [combos, tz] = await Promise.all([
            Combo.findAll({
                where: { business_id: biz, active: true },
                include: [{
                    model: ComboItem, as: 'items',
                    include: [{ model: Product, as: 'product', attributes: ['id', 'name', 'price', 'emoji'] }]
                }],
                order: [['name', 'ASC']]
            }),
            zonaDelNegocio(biz),
        ]);
        const ahora = new Date();
        res.json(combos.filter(c => promoActiva(c, tz, ahora)).map(c => serializarCombo(c, { activa: true })));
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

router.get('/combos/:id', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const combo = await Combo.findOne({
            where: { id: req.params.id, business_id: biz },
            include: [{
                model: ComboItem,
                as: 'items',
                include: [{ model: Product, as: 'product' }]
            }]
        });
        if (!combo) {
            return res.status(404).json({ error: 'Combo no encontrado' });
        }
        res.json(serializarCombo(combo));
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

router.post('/combos', authenticate, isOwner, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const { name, description, emoji, image, price, active } = req.body;
        const reglas = reglasDePromo(req.body, null);
        if (reglas.error) return res.status(400).json({ error: reglas.error });
        if (!name || (reglas.tipo === 'precio_fijo' && !price)) {
            return res.status(400).json({ error: 'Nombre y precio son requeridos' });
        }
        const combo = await Combo.create({
            name, description, emoji: emoji || '🎁', image,
            // Un 2x1 no tiene precio propio: sale de los productos elegidos.
            price: reglas.tipo === 'precio_fijo' ? price : 0,
            tipo: reglas.tipo, paga: reglas.paga, calendario: reglas.calendario,
            active: active !== undefined ? active : true, business_id: biz
        });
        res.status(201).json(serializarCombo(combo));
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

router.put('/combos/:id', authenticate, isOwner, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const combo = await Combo.findOne({
            where: { id: req.params.id, business_id: biz },
            include: [{ model: ComboItem, as: 'items' }],
        });
        if (!combo) {
            return res.status(404).json({ error: 'Combo no encontrado' });
        }
        const { name, description, emoji, image, price, original_price, active } = req.body;
        const reglas = reglasDePromo(req.body, combo);
        if (reglas.error) return res.status(400).json({ error: reglas.error });
        await combo.update({
            tipo: reglas.tipo, paga: reglas.paga, calendario: reglas.calendario,
            name: name !== undefined ? name : combo.name,
            description: description !== undefined ? description : combo.description,
            emoji: emoji !== undefined ? emoji : combo.emoji,
            image: image !== undefined ? image : combo.image,
            price: price !== undefined ? price : combo.price,
            original_price: original_price !== undefined ? original_price : combo.original_price,
            active: active !== undefined ? active : combo.active
        });
        res.json(serializarCombo(combo));
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

router.delete('/combos/:id', authenticate, isOwner, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const combo = await Combo.findOne({ where: { id: req.params.id, business_id: biz } });
        if (!combo) {
            return res.status(404).json({ error: 'Combo no encontrado' });
        }
        await combo.update({ active: false });
        res.json({ message: 'Combo eliminado correctamente' });
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

router.post('/combos/:id/items', authenticate, isOwner, async (req, res) => {
    const t = await sequelize.transaction();
    try {
        const biz = req.user.business_id;
        const { items } = req.body;
        const combo = await Combo.findOne({ where: { id: req.params.id, business_id: biz }, transaction: t });
        if (!combo) {
            await t.rollback();
            return res.status(404).json({ error: 'Combo no encontrado' });
        }
        if (!Array.isArray(items) || items.length === 0 || items.length > 20) {
            await t.rollback();
            return res.status(400).json({ error: 'La promo necesita entre 1 y 20 renglones' });
        }
        // Cada renglón es un "hueco": un producto fijo (lo de siempre), una
        // lista de productos o una categoría. Todo tiene que ser del negocio.
        const renglones = [];
        for (const item of items) {
            const cantidad = parseInt(item.quantity, 10) || 1;
            if (cantidad < 1 || cantidad > 20) {
                await t.rollback();
                return res.status(400).json({ error: 'La cantidad de cada renglón va de 1 a 20' });
            }
            const ids = Array.isArray(item.product_ids) ? item.product_ids.map(Number) : [];
            if (item.product_id) ids.unshift(Number(item.product_id));
            const unicos = [...new Set(ids)].filter(Number.isInteger);
            if (unicos.length) {
                const n = await Product.count({ where: { id: unicos, business_id: biz }, transaction: t });
                if (n !== unicos.length) {
                    await t.rollback();
                    return res.status(400).json({ error: 'Uno de los productos no existe en este negocio' });
                }
                renglones.push(unicos.length === 1
                    ? { product_id: unicos[0], product_ids: null, category_id: null, quantity: cantidad }
                    : { product_id: null, product_ids: unicos, category_id: null, quantity: cantidad });
            } else if (item.category_id) {
                const cat = await Category.findOne({ where: { id: item.category_id, business_id: biz }, transaction: t });
                if (!cat) {
                    await t.rollback();
                    return res.status(400).json({ error: 'La categoría no existe en este negocio' });
                }
                renglones.push({ product_id: null, product_ids: null, category_id: cat.id, quantity: cantidad });
            } else {
                await t.rollback();
                return res.status(400).json({ error: 'Cada renglón necesita un producto, una lista de productos o una categoría' });
            }
        }
        const lleva = productosQueLleva(renglones);
        if (combo.tipo === 'regalar_mas_barato' && !(combo.paga >= 1 && combo.paga < lleva)) {
            await t.rollback();
            return res.status(400).json({ error: `Esta promo cobra ${combo.paga} y lleva ${lleva}: tiene que llevar más de los que cobra` });
        }
        await ComboItem.destroy({ where: { combo_id: req.params.id }, transaction: t });
        let originalPrice = 0;
        for (const r of renglones) {
            await ComboItem.create({ combo_id: req.params.id, ...r }, { transaction: t });
            // "Precio original" solo tiene sentido con productos fijos.
            if (r.product_id) {
                const product = await Product.findByPk(r.product_id, { transaction: t });
                if (product) originalPrice += parseFloat(product.price) * r.quantity;
            }
        }
        await combo.update({ original_price: originalPrice || null, lleva }, { transaction: t });
        await t.commit();
        const updatedCombo = await Combo.findByPk(req.params.id, {
            include: [{ model: ComboItem, as: 'items', include: [{ model: Product, as: 'product', attributes: ['id', 'name', 'price', 'emoji'] }] }]
        });
        res.json(serializarCombo(updatedCombo));
    } catch (error) {
        await t.rollback();
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

module.exports = router;
