const express = require('express');
const router = express.Router();
const { Discount, Combo, ComboItem, Product, Category, sequelize } = require('../models');
const { Op } = require('sequelize');
const { authenticate, isOwner } = require('../middleware/auth');

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
        const now = new Date();
        const discounts = await Discount.findAll({
            where: {
                active: true,
                business_id: biz,
                [Op.or]: [
                    { start_date: { [Op.lte]: now }, end_date: { [Op.gte]: now } },
                    { start_date: null, end_date: null }
                ]
            }
        });
        res.json(discounts);
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

router.get('/discounts/:id', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const discount = await Discount.findOne({ where: { id: req.params.id, business_id: biz } });
        if (!discount) {
            return res.status(404).json({ error: 'Discount not found' });
        }
        res.json(discount);
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

router.post('/discounts', authenticate, isOwner, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const { name, type, value, applies_to, target_id, start_date, end_date, active } = req.body;
        if (!name || !type || value === undefined) {
            return res.status(400).json({ error: 'Name, type and value are required' });
        }
        if (!['percentage', 'fixed'].includes(type)) {
            return res.status(400).json({ error: 'Type must be percentage or fixed' });
        }
        if (!['all', 'category', 'product'].includes(applies_to)) {
            return res.status(400).json({ error: 'applies_to must be all, category or product' });
        }
        if (type === 'percentage' && (value < 0 || value > 100)) {
            return res.status(400).json({ error: 'Percentage must be between 0 and 100' });
        }
        const discount = await Discount.create({
            name, type, value, applies_to: applies_to || 'all',
            target_id, start_date, end_date,
            active: active !== undefined ? active : true,
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
            return res.status(404).json({ error: 'Discount not found' });
        }
        const { name, type, value, applies_to, target_id, start_date, end_date, active } = req.body;
        await discount.update({
            name: name !== undefined ? name : discount.name,
            type: type !== undefined ? type : discount.type,
            value: value !== undefined ? value : discount.value,
            applies_to: applies_to !== undefined ? applies_to : discount.applies_to,
            target_id: target_id !== undefined ? target_id : discount.target_id,
            start_date: start_date !== undefined ? start_date : discount.start_date,
            end_date: end_date !== undefined ? end_date : discount.end_date,
            active: active !== undefined ? active : discount.active
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
            return res.status(404).json({ error: 'Discount not found' });
        }
        await discount.update({ active: false });
        res.json({ message: 'Discount deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

router.post('/discounts/calculate', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const { product_id, category_id, amount } = req.body;
        if (!amount) {
            return res.status(400).json({ error: 'Amount is required' });
        }
        const now = new Date();
        const dateFilter = [
            { start_date: { [Op.lte]: now }, end_date: { [Op.gte]: now } },
            { start_date: null, end_date: null }
        ];
        let discount = null;
        if (product_id) {
            discount = await Discount.findOne({
                where: { active: true, business_id: biz, applies_to: 'product', target_id: product_id, [Op.or]: dateFilter }
            });
        }
        if (!discount && category_id) {
            discount = await Discount.findOne({
                where: { active: true, business_id: biz, applies_to: 'category', target_id: category_id, [Op.or]: dateFilter }
            });
        }
        if (!discount) {
            discount = await Discount.findOne({
                where: { active: true, business_id: biz, applies_to: 'all', [Op.or]: dateFilter }
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
// COMBOS
// ============================================

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
                include: [{ model: Product, as: 'product', attributes: ['id', 'name', 'price', 'emoji', 'image'] }]
            }],
            order: [['name', 'ASC']]
        });
        res.json(combos);
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
            return res.status(404).json({ error: 'Combo not found' });
        }
        res.json(combo);
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

router.post('/combos', authenticate, isOwner, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const { name, description, emoji, image, price, active } = req.body;
        if (!name || !price) {
            return res.status(400).json({ error: 'Name and price are required' });
        }
        const combo = await Combo.create({
            name, description, emoji: emoji || '🎁', image, price,
            active: active !== undefined ? active : true, business_id: biz
        });
        res.status(201).json(combo);
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

router.put('/combos/:id', authenticate, isOwner, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const combo = await Combo.findOne({ where: { id: req.params.id, business_id: biz } });
        if (!combo) {
            return res.status(404).json({ error: 'Combo not found' });
        }
        const { name, description, emoji, image, price, original_price, active } = req.body;
        await combo.update({
            name: name !== undefined ? name : combo.name,
            description: description !== undefined ? description : combo.description,
            emoji: emoji !== undefined ? emoji : combo.emoji,
            image: image !== undefined ? image : combo.image,
            price: price !== undefined ? price : combo.price,
            original_price: original_price !== undefined ? original_price : combo.original_price,
            active: active !== undefined ? active : combo.active
        });
        res.json(combo);
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

router.delete('/combos/:id', authenticate, isOwner, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const combo = await Combo.findOne({ where: { id: req.params.id, business_id: biz } });
        if (!combo) {
            return res.status(404).json({ error: 'Combo not found' });
        }
        await combo.update({ active: false });
        res.json({ message: 'Combo deleted successfully' });
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
            return res.status(404).json({ error: 'Combo not found' });
        }
        await ComboItem.destroy({ where: { combo_id: req.params.id }, transaction: t });
        let originalPrice = 0;
        for (const item of items) {
            await ComboItem.create({
                combo_id: req.params.id, product_id: item.product_id, quantity: item.quantity || 1
            }, { transaction: t });
            const product = await Product.findByPk(item.product_id, { transaction: t });
            if (product) {
                originalPrice += parseFloat(product.price) * (item.quantity || 1);
            }
        }
        await combo.update({ original_price: originalPrice }, { transaction: t });
        await t.commit();
        const updatedCombo = await Combo.findByPk(req.params.id, {
            include: [{ model: ComboItem, as: 'items', include: [{ model: Product, as: 'product' }] }]
        });
        res.json(updatedCombo);
    } catch (error) {
        await t.rollback();
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

module.exports = router;
