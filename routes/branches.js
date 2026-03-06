const express = require('express');
const router = express.Router();
const { Branch, Category, Discount, Combo, ComboItem, Ingredient } = require('../models');
const { authenticate, isOwner } = require('../middleware/auth');

// GET /api/branches — lista sucursales del negocio
router.get('/', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;
        let branches = await Branch.findAll({
            where: { business_id: biz, active: true },
            order: [['createdAt', 'ASC']]
        });
        // Si el negocio no tiene ninguna sucursal, crear la primera automáticamente
        if (branches.length === 0) {
            const primera = await Branch.create({
                business_id: biz,
                name: 'Esta sucursal',
                active: true
            });
            branches = [primera];
        }
        res.json(branches);
    } catch (error) {
        console.error('Error al obtener sucursales:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// POST /api/branches — crear sucursal (solo dueño)
// Body: { name, address, phone, clone_options: ['categories','discounts','combos','ingredients'] }
router.post('/', authenticate, isOwner, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const { name, address, phone, clone_options } = req.body;

        if (!name) {
            return res.status(400).json({ error: 'El nombre de la sucursal es requerido' });
        }

        const branch = await Branch.create({ business_id: biz, name, address, phone });

        // Clonar datos seleccionados si se pidió
        if (clone_options && clone_options.length > 0) {
            let opts = Array.isArray(clone_options) ? clone_options : [clone_options];
            // 'offers' es alias para discounts + combos
            if (opts.includes('offers')) opts = [...opts, 'discounts', 'combos'];

            if (opts.includes('categories')) {
                const cats = await Category.findAll({ where: { business_id: biz, active: true } });
                for (const c of cats) {
                    await Category.create({ name: c.name, emoji: c.emoji, image: c.image, business_id: biz });
                }
            }

            if (opts.includes('discounts')) {
                const discs = await Discount.findAll({ where: { business_id: biz, active: true } });
                for (const d of discs) {
                    await Discount.create({
                        name: d.name, type: d.type, value: d.value,
                        min_amount: d.min_amount, business_id: biz
                    });
                }
            }

            if (opts.includes('combos')) {
                const combos = await Combo.findAll({
                    where: { business_id: biz, active: true },
                    include: [{ model: ComboItem, as: 'items' }]
                });
                for (const combo of combos) {
                    const newCombo = await Combo.create({
                        name: combo.name, description: combo.description,
                        price: combo.price, image: combo.image, business_id: biz
                    });
                    for (const item of (combo.items || [])) {
                        await ComboItem.create({
                            combo_id: newCombo.id, product_id: item.product_id, quantity: item.quantity
                        });
                    }
                }
            }

            if (opts.includes('ingredients')) {
                const ingredients = await Ingredient.findAll({ where: { business_id: biz, active: true } });
                for (const ing of ingredients) {
                    await Ingredient.create({
                        name: ing.name, unit: ing.unit, stock_actual: 0,
                        stock_minimo: ing.stock_minimo, business_id: biz
                    });
                }
            }
        }

        res.status(201).json(branch);
    } catch (error) {
        console.error('Error al crear sucursal:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// PUT /api/branches/:id — editar sucursal
router.put('/:id', authenticate, isOwner, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const branch = await Branch.findOne({ where: { id: req.params.id, business_id: biz, active: true } });
        if (!branch) return res.status(404).json({ error: 'Sucursal no encontrada' });

        const { name, address, phone } = req.body;
        await branch.update({ name, address, phone });
        res.json(branch);
    } catch (error) {
        console.error('Error al actualizar sucursal:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// DELETE /api/branches/:id — desactivar sucursal
router.delete('/:id', authenticate, isOwner, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const branch = await Branch.findOne({ where: { id: req.params.id, business_id: biz, active: true } });
        if (!branch) return res.status(404).json({ error: 'Sucursal no encontrada' });

        await branch.update({ active: false });
        res.json({ message: 'Sucursal desactivada correctamente' });
    } catch (error) {
        console.error('Error al eliminar sucursal:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

module.exports = router;
