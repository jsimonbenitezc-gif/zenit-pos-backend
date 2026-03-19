const express = require('express');
const router = express.Router();
const {
    Ingredient,
    Preparation,
    PreparationItem,
    Product,
    ProductRecipe,
    InventoryMovement,
    PrivilegedActionLog,
    User,
    sequelize
} = require('../models');
const { authenticate, isOwner } = require('../middleware/auth');
const { verifyEmployeePin } = require('../utils/verifyPin');
const { requirePremium } = require('../middleware/checkPlan');
const jwt = require('jsonwebtoken');

const UNIT_CONVERSION = {
    'kg_g': 1000,
    'g_kg': 0.001,
    'l_ml': 1000,
    'ml_l': 0.001,
};

function convertUnit(qty, fromUnit, toUnit) {
    if (!fromUnit || !toUnit || fromUnit === toUnit) return qty;
    const key = `${fromUnit}_${toUnit}`;
    return UNIT_CONVERSION[key] ? qty * UNIT_CONVERSION[key] : qty;
}

// ── SSE: notificaciones en tiempo real de cambios en inventario ────────────────
const _invClients = new Map(); // businessId (string) → Set<Response>

function _notificarInventario(businessId) {
    const clients = _invClients.get(String(businessId));
    if (!clients || clients.size === 0) return;
    const msg = `data: {}\n\n`;
    for (const res of clients) {
        try { res.write(msg); } catch { /* cliente desconectado */ }
    }
}

// Este endpoint NO usa router.use(authenticate) porque EventSource no soporta headers.
// Auth via query param ?token=JWT
router.get('/events', (req, res) => {
    const token = req.query.token;
    if (!token) return res.status(401).end();
    let businessId;
    try {
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        businessId = payload.business_id;
    } catch {
        return res.status(401).end();
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // importante para Render.com / nginx
    res.flushHeaders();

    // Heartbeat cada 25s para evitar timeout en Render.com
    const heartbeat = setInterval(() => {
        try { res.write(': ping\n\n'); } catch { clearInterval(heartbeat); }
    }, 25000);

    const biz = String(businessId);
    if (!_invClients.has(biz)) _invClients.set(biz, new Set());
    _invClients.get(biz).add(res);

    req.on('close', () => {
        clearInterval(heartbeat);
        _invClients.get(biz)?.delete(res);
    });
});

// Todas las rutas de inventario requieren plan premium
router.use(authenticate, requirePremium);

// ============================================
// INSUMOS (INGREDIENTS)
// ============================================

router.get('/ingredients', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const branchId = req.query.branch_id ? String(req.query.branch_id) : null;
        const ingredients = await Ingredient.findAll({
            where: { active: true, business_id: biz },
            order: [['name', 'ASC']]
        });
        if (branchId) {
            const result = ingredients.map(ing => {
                const plain = ing.toJSON();
                const bs = ing.branch_stocks || {};
                if (branchId in bs) {
                    plain.stock = parseFloat(bs[branchId]);
                } else if (Object.keys(bs).length === 0) {
                    // Sin branch_stocks aún: usar stock global como fallback
                    plain.stock = parseFloat(ing.stock) || 0;
                } else {
                    // Otras sucursales no tienen stock propio → 0
                    plain.stock = 0;
                }
                return plain;
            });
            return res.json(result);
        }
        res.json(ingredients);
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

router.get('/ingredients/:id', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const ingredient = await Ingredient.findOne({
            where: { id: req.params.id, business_id: biz }
        });
        if (!ingredient) {
            return res.status(404).json({ error: 'Insumo no encontrado' });
        }
        res.json(ingredient);
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

router.post('/ingredients', authenticate, isOwner, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const { name, unit, stock, min_stock, cost_per_unit, notes } = req.body;
        if (!name || !unit) {
            return res.status(400).json({ error: 'Nombre y unidad son requeridos' });
        }
        const ingredient = await Ingredient.create({
            name, unit, stock: stock || 0, min_stock: min_stock || 0,
            cost_per_unit: cost_per_unit || 0, notes, business_id: biz
        });
        res.status(201).json(ingredient);
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

router.put('/ingredients/:id', authenticate, isOwner, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const ingredient = await Ingredient.findOne({ where: { id: req.params.id, business_id: biz } });
        if (!ingredient) {
            return res.status(404).json({ error: 'Insumo no encontrado' });
        }
        const { name, unit, stock, min_stock, cost_per_unit, notes, active } = req.body;
        await ingredient.update({
            name: name !== undefined ? name : ingredient.name,
            unit: unit !== undefined ? unit : ingredient.unit,
            stock: stock !== undefined ? stock : ingredient.stock,
            min_stock: min_stock !== undefined ? min_stock : ingredient.min_stock,
            cost_per_unit: cost_per_unit !== undefined ? cost_per_unit : ingredient.cost_per_unit,
            notes: notes !== undefined ? notes : ingredient.notes,
            active: active !== undefined ? active : ingredient.active
        });
        res.json(ingredient);
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

router.delete('/ingredients/:id', authenticate, isOwner, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const ingredient = await Ingredient.findOne({ where: { id: req.params.id, business_id: biz } });
        if (!ingredient) {
            return res.status(404).json({ error: 'Insumo no encontrado' });
        }
        await ingredient.update({ active: false });
        res.json({ message: 'Insumo eliminado correctamente' });
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ============================================
// PREPARACIONES
// ============================================

router.get('/preparations', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const preparations = await Preparation.findAll({
            where: { active: true, business_id: biz },
            include: [{
                model: PreparationItem,
                as: 'items',
                attributes: ['id', 'preparation_id', 'ingredient_id', 'quantity', 'unit_recipe'],
                include: [{ model: Ingredient, as: 'ingredient', attributes: ['id', 'name', 'unit'] }]
            }],
            order: [['name', 'ASC']]
        });
        res.json(preparations);
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

router.get('/preparations/:id', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const preparation = await Preparation.findOne({
            where: { id: req.params.id, business_id: biz },
            include: [{
                model: PreparationItem,
                as: 'items',
                include: [{ model: Ingredient, as: 'ingredient' }]
            }]
        });
        if (!preparation) {
            return res.status(404).json({ error: 'Preparación no encontrada' });
        }
        res.json(preparation);
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

router.post('/preparations', authenticate, isOwner, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const { name, unit, yield_quantity, notes } = req.body;
        if (!name || !unit || !yield_quantity) {
            return res.status(400).json({ error: 'Nombre, unidad y rendimiento son requeridos' });
        }
        const preparation = await Preparation.create({ name, unit, yield_quantity, notes, business_id: biz });
        _notificarInventario(biz);
        res.status(201).json(preparation);
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

router.put('/preparations/:id', authenticate, isOwner, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const preparation = await Preparation.findOne({ where: { id: req.params.id, business_id: biz } });
        if (!preparation) {
            return res.status(404).json({ error: 'Preparación no encontrada' });
        }
        const { name, unit, yield_quantity, stock, notes, active } = req.body;
        await preparation.update({
            name: name !== undefined ? name : preparation.name,
            unit: unit !== undefined ? unit : preparation.unit,
            yield_quantity: yield_quantity !== undefined ? yield_quantity : preparation.yield_quantity,
            stock: stock !== undefined ? stock : preparation.stock,
            notes: notes !== undefined ? notes : preparation.notes,
            active: active !== undefined ? active : preparation.active
        });
        res.json(preparation);
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

router.delete('/preparations/:id', authenticate, isOwner, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const preparation = await Preparation.findOne({ where: { id: req.params.id, business_id: biz } });
        if (!preparation) {
            return res.status(404).json({ error: 'Preparación no encontrada' });
        }
        await preparation.update({ active: false });
        res.json({ message: 'Preparación eliminada correctamente' });
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ============================================
// RECETAS DE PREPARACIONES
// ============================================

router.post('/preparations/:id/recipe', authenticate, isOwner, async (req, res) => {
    const t = await sequelize.transaction();
    try {
        const biz = req.user.business_id;
        const { items } = req.body;
        const preparation = await Preparation.findOne({ where: { id: req.params.id, business_id: biz }, transaction: t });
        if (!preparation) {
            await t.rollback();
            return res.status(404).json({ error: 'Preparación no encontrada' });
        }
        await PreparationItem.destroy({ where: { preparation_id: req.params.id }, transaction: t });
        let totalCost = 0;
        for (const item of items) {
            await PreparationItem.create({
                preparation_id: req.params.id,
                ingredient_id: item.ingredient_id,
                quantity: item.quantity,
                unit_recipe: item.unit_recipe || null
            }, { transaction: t });
            const ingredient = await Ingredient.findByPk(item.ingredient_id, { transaction: t });
            if (ingredient) {
                const qtyConv = convertUnit(parseFloat(item.quantity), item.unit_recipe, ingredient.unit);
                totalCost += parseFloat(ingredient.cost_per_unit) * qtyConv;
            }
        }
        const costPerUnit = totalCost / parseFloat(preparation.yield_quantity);
        await preparation.update({ cost_per_unit: costPerUnit }, { transaction: t });
        await t.commit();
        _notificarInventario(biz);
        const updatedPreparation = await Preparation.findByPk(req.params.id, {
            include: [{ model: PreparationItem, as: 'items', include: [{ model: Ingredient, as: 'ingredient' }] }]
        });
        res.json(updatedPreparation);
    } catch (error) {
        await t.rollback();
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ============================================
// RECETAS DE PRODUCTOS
// ============================================

// GET /api/inventory/all-recipes — Todas las recetas del negocio (para sync)
router.get('/all-recipes', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const products = await Product.findAll({
            where: { business_id: biz },
            attributes: ['id']
        });
        const productIds = products.map(p => p.id);
        if (productIds.length === 0) return res.json([]);
        const { Op } = require('sequelize');
        const recipes = await ProductRecipe.findAll({
            where: { product_id: { [Op.in]: productIds } }
        });
        res.json(recipes);
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

router.get('/products/:id/recipe', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const product = await Product.findOne({ where: { id: req.params.id, business_id: biz } });
        if (!product) {
            return res.status(404).json({ error: 'Producto no encontrado' });
        }
        const recipe = await ProductRecipe.findAll({ where: { product_id: req.params.id } });
        const enrichedRecipe = await Promise.all(recipe.map(async (item) => {
            if (item.item_type === 'ingredient') {
                const ingredient = await Ingredient.findByPk(item.item_id);
                return { ...item.toJSON(), item_data: ingredient };
            } else {
                const preparation = await Preparation.findByPk(item.item_id);
                return { ...item.toJSON(), item_data: preparation };
            }
        }));
        res.json(enrichedRecipe);
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

router.post('/products/:id/recipe', authenticate, isOwner, async (req, res) => {
    const t = await sequelize.transaction();
    try {
        const biz = req.user.business_id;
        const { items } = req.body;
        const product = await Product.findOne({ where: { id: req.params.id, business_id: biz }, transaction: t });
        if (!product) {
            await t.rollback();
            return res.status(404).json({ error: 'Producto no encontrado' });
        }
        await ProductRecipe.destroy({ where: { product_id: req.params.id }, transaction: t });
        for (const item of items) {
            await ProductRecipe.create({
                product_id: req.params.id,
                item_type: item.item_type,
                item_id: item.item_id,
                quantity: item.quantity,
                unit_recipe: item.unit_recipe || null
            }, { transaction: t });
        }
        await t.commit();
        _notificarInventario(biz);
        const recipe = await ProductRecipe.findAll({ where: { product_id: req.params.id } });
        res.json(recipe);
    } catch (error) {
        await t.rollback();
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

router.delete('/products/:id/recipe', authenticate, isOwner, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const product = await Product.findOne({ where: { id: req.params.id, business_id: biz } });
        if (!product) return res.status(404).json({ error: 'Producto no encontrado' });
        await ProductRecipe.destroy({ where: { product_id: req.params.id } });
        _notificarInventario(biz);
        res.json({ message: 'Receta eliminada' });
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ============================================
// MOVIMIENTOS DE INVENTARIO
// ============================================

router.get('/movements', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const { ingredient_id, type, limit } = req.query;
        const where = { business_id: biz };
        if (ingredient_id) where.ingredient_id = ingredient_id;
        if (type) where.type = type;
        const movements = await InventoryMovement.findAll({
            where,
            include: [{ model: Ingredient, as: 'ingredient', attributes: ['id', 'name', 'unit'] }],
            order: [['createdAt', 'DESC']],
            limit: limit ? parseInt(limit) : 100
        });
        res.json(movements);
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

router.post('/movements', authenticate, async (req, res) => {
    const t = await sequelize.transaction();
    try {
        const biz = req.user.business_id;
        const { ingredient_id, type, quantity, unit_cost, reason, notes, branch_id, employee_id, pin } = req.body;
        if (!ingredient_id || !type || !quantity) {
            await t.rollback();
            return res.status(400).json({ error: 'ingredient_id, tipo y cantidad son requeridos' });
        }

        // Ajuste manual: registrar en auditoría (PIN verificado en el frontend)
        let authorizedEmployee = null;
        if (type === 'ajuste' && employee_id) {
            if (pin) {
                try {
                    authorizedEmployee = await verifyEmployeePin(employee_id, pin, biz);
                } catch (pinErr) {
                    await t.rollback();
                    return res.status(403).json({ error: pinErr.message });
                }
            } else {
                authorizedEmployee = await User.findByPk(employee_id);
            }
        }

        const ingredient = await Ingredient.findOne({ where: { id: ingredient_id, business_id: biz }, transaction: t });
        if (!ingredient) {
            await t.rollback();
            return res.status(404).json({ error: 'Insumo no encontrado' });
        }

        // Stock antes del ajuste (para auditoría)
        const branchKey = branch_id ? String(branch_id) : null;
        const stockAntes = branchKey
            ? (() => {
                const bs = ingredient.branch_stocks || {};
                if (branchKey in bs) return parseFloat(bs[branchKey]);
                if (Object.keys(bs).length === 0) return parseFloat(ingredient.stock) || 0;
                return 0;
            })()
            : parseFloat(ingredient.stock);

        const movement = await InventoryMovement.create({
            ingredient_id, type, quantity, unit_cost, reason, notes,
            user_id: req.user.id, business_id: biz,
            branch_id: branch_id || null,
        }, { transaction: t });

        const currentStock = branchKey
            ? (() => {
                const bs = ingredient.branch_stocks || {};
                if (branchKey in bs) return parseFloat(bs[branchKey]);
                if (Object.keys(bs).length === 0) return parseFloat(ingredient.stock) || 0;
                return 0;
            })()
            : parseFloat(ingredient.stock);

        let newStock = currentStock;
        if (type === 'entrada') {
            newStock += parseFloat(quantity);
            if (branchKey) {
                const bs = { ...(ingredient.branch_stocks || {}), [branchKey]: newStock };
                await ingredient.update({ branch_stocks: bs }, { transaction: t });
            } else if (unit_cost) {
                const totalValue = (parseFloat(ingredient.stock) * parseFloat(ingredient.cost_per_unit)) +
                                   (parseFloat(quantity) * parseFloat(unit_cost));
                const newCostPerUnit = totalValue / newStock;
                await ingredient.update({ stock: newStock, cost_per_unit: newCostPerUnit }, { transaction: t });
            } else {
                await ingredient.update({ stock: newStock }, { transaction: t });
            }
        } else if (type === 'salida') {
            newStock -= parseFloat(quantity);
            if (branchKey) {
                const bs = { ...(ingredient.branch_stocks || {}), [branchKey]: newStock };
                await ingredient.update({ branch_stocks: bs }, { transaction: t });
            } else {
                await ingredient.update({ stock: newStock }, { transaction: t });
            }
        } else if (type === 'ajuste') {
            if (branchKey) {
                const bs = { ...(ingredient.branch_stocks || {}), [branchKey]: parseFloat(quantity) };
                await ingredient.update({ branch_stocks: bs }, { transaction: t });
            } else {
                await ingredient.update({ stock: quantity }, { transaction: t });
            }
        }
        await t.commit();

        // Registrar en auditoría si fue un ajuste autorizado con PIN
        if (type === 'ajuste' && authorizedEmployee) {
            await PrivilegedActionLog.create({
                business_id: biz,
                branch_id: branch_id || null,
                employee_id: authorizedEmployee.id,
                employee_name: authorizedEmployee.name,
                action_type: 'inventory_adjustment',
                target_description: `Insumo: ${ingredient.name}`,
                before_data: JSON.stringify({ ingredient_id, name: ingredient.name, stock: stockAntes }),
                after_data: JSON.stringify({ ingredient_id, name: ingredient.name, stock: parseFloat(quantity), reason: reason || null })
            });
        }

        _notificarInventario(biz); // avisar a clientes SSE conectados
        const fullMovement = await InventoryMovement.findByPk(movement.id, {
            include: [{ model: Ingredient, as: 'ingredient', attributes: ['id', 'name', 'unit', 'stock'] }]
        });
        res.status(201).json(fullMovement);
    } catch (error) {
        await t.rollback();
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

module.exports = router;
