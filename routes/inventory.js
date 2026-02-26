const express = require('express');
const router = express.Router();
const { 
    Ingredient, 
    Preparation, 
    PreparationItem, 
    Product,
    ProductRecipe,
    InventoryMovement,
    sequelize 
} = require('../models');
const { authenticate, isOwner } = require('../middleware/auth');

// ============================================
// INSUMOS (INGREDIENTS)
// ============================================

// GET /api/inventory/ingredients - Obtener todos los insumos
router.get('/ingredients', authenticate, async (req, res) => {
    try {
        const ingredients = await Ingredient.findAll({
            where: { active: true },
            order: [['name', 'ASC']]
        });
        res.json(ingredients);
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// GET /api/inventory/ingredients/:id - Obtener un insumo
router.get('/ingredients/:id', authenticate, async (req, res) => {
    try {
        const ingredient = await Ingredient.findByPk(req.params.id);
        if (!ingredient) {
            return res.status(404).json({ error: 'Ingredient not found' });
        }
        res.json(ingredient);
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// POST /api/inventory/ingredients - Crear insumo
router.post('/ingredients', authenticate, isOwner, async (req, res) => {
    try {
        const { name, unit, stock, min_stock, cost_per_unit, notes } = req.body;

        if (!name || !unit) {
            return res.status(400).json({ error: 'Name and unit are required' });
        }

        const ingredient = await Ingredient.create({
            name,
            unit,
            stock: stock || 0,
            min_stock: min_stock || 0,
            cost_per_unit: cost_per_unit || 0,
            notes
        });

        res.status(201).json(ingredient);
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// PUT /api/inventory/ingredients/:id - Actualizar insumo
router.put('/ingredients/:id', authenticate, isOwner, async (req, res) => {
    try {
        const ingredient = await Ingredient.findByPk(req.params.id);
        if (!ingredient) {
            return res.status(404).json({ error: 'Ingredient not found' });
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

// DELETE /api/inventory/ingredients/:id - Eliminar insumo
router.delete('/ingredients/:id', authenticate, isOwner, async (req, res) => {
    try {
        const ingredient = await Ingredient.findByPk(req.params.id);
        if (!ingredient) {
            return res.status(404).json({ error: 'Ingredient not found' });
        }

        await ingredient.update({ active: false });
        res.json({ message: 'Ingredient deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ============================================
// PREPARACIONES
// ============================================

// GET /api/inventory/preparations - Obtener todas las preparaciones
router.get('/preparations', authenticate, async (req, res) => {
    try {
        const preparations = await Preparation.findAll({
            where: { active: true },
            include: [{
                model: PreparationItem,
                as: 'items',
                include: [{
                    model: Ingredient,
                    as: 'ingredient',
                    attributes: ['id', 'name', 'unit']
                }]
            }],
            order: [['name', 'ASC']]
        });
        res.json(preparations);
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// GET /api/inventory/preparations/:id - Obtener una preparación
router.get('/preparations/:id', authenticate, async (req, res) => {
    try {
        const preparation = await Preparation.findByPk(req.params.id, {
            include: [{
                model: PreparationItem,
                as: 'items',
                include: [{
                    model: Ingredient,
                    as: 'ingredient'
                }]
            }]
        });

        if (!preparation) {
            return res.status(404).json({ error: 'Preparation not found' });
        }

        res.json(preparation);
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// POST /api/inventory/preparations - Crear preparación
router.post('/preparations', authenticate, isOwner, async (req, res) => {
    try {
        const { name, unit, yield_quantity, notes } = req.body;

        if (!name || !unit || !yield_quantity) {
            return res.status(400).json({ error: 'Name, unit and yield_quantity are required' });
        }

        const preparation = await Preparation.create({
            name,
            unit,
            yield_quantity,
            notes
        });

        res.status(201).json(preparation);
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// PUT /api/inventory/preparations/:id - Actualizar preparación
router.put('/preparations/:id', authenticate, isOwner, async (req, res) => {
    try {
        const preparation = await Preparation.findByPk(req.params.id);
        if (!preparation) {
            return res.status(404).json({ error: 'Preparation not found' });
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

// DELETE /api/inventory/preparations/:id - Eliminar preparación
router.delete('/preparations/:id', authenticate, isOwner, async (req, res) => {
    try {
        const preparation = await Preparation.findByPk(req.params.id);
        if (!preparation) {
            return res.status(404).json({ error: 'Preparation not found' });
        }

        await preparation.update({ active: false });
        res.json({ message: 'Preparation deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ============================================
// RECETAS DE PREPARACIONES
// ============================================

// POST /api/inventory/preparations/:id/recipe - Guardar receta de preparación
router.post('/preparations/:id/recipe', authenticate, isOwner, async (req, res) => {
    const t = await sequelize.transaction();
    
    try {
        const { items } = req.body;

        const preparation = await Preparation.findByPk(req.params.id, { transaction: t });
        if (!preparation) {
            await t.rollback();
            return res.status(404).json({ error: 'Preparation not found' });
        }

        // Eliminar items anteriores
        await PreparationItem.destroy({
            where: { preparation_id: req.params.id },
            transaction: t
        });

        // Crear nuevos items y calcular costo
        let totalCost = 0;
        
        for (const item of items) {
            await PreparationItem.create({
                preparation_id: req.params.id,
                ingredient_id: item.ingredient_id,
                quantity: item.quantity
            }, { transaction: t });

            // Calcular costo
            const ingredient = await Ingredient.findByPk(item.ingredient_id, { transaction: t });
            if (ingredient) {
                totalCost += parseFloat(ingredient.cost_per_unit) * parseFloat(item.quantity);
            }
        }

        // Actualizar costo por unidad de la preparación
        const costPerUnit = totalCost / parseFloat(preparation.yield_quantity);
        await preparation.update({ cost_per_unit: costPerUnit }, { transaction: t });

        await t.commit();

        const updatedPreparation = await Preparation.findByPk(req.params.id, {
            include: [{
                model: PreparationItem,
                as: 'items',
                include: [{
                    model: Ingredient,
                    as: 'ingredient'
                }]
            }]
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

// GET /api/inventory/products/:id/recipe - Obtener receta de producto
router.get('/products/:id/recipe', authenticate, async (req, res) => {
    try {
        const recipe = await ProductRecipe.findAll({
            where: { product_id: req.params.id }
        });

        // Enriquecer con información de ingredientes/preparaciones
        const enrichedRecipe = await Promise.all(recipe.map(async (item) => {
            if (item.item_type === 'ingredient') {
                const ingredient = await Ingredient.findByPk(item.item_id);
                return {
                    ...item.toJSON(),
                    item_data: ingredient
                };
            } else {
                const preparation = await Preparation.findByPk(item.item_id);
                return {
                    ...item.toJSON(),
                    item_data: preparation
                };
            }
        }));

        res.json(enrichedRecipe);
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// POST /api/inventory/products/:id/recipe - Guardar receta de producto
router.post('/products/:id/recipe', authenticate, isOwner, async (req, res) => {
    const t = await sequelize.transaction();
    
    try {
        const { items } = req.body;

        const product = await Product.findByPk(req.params.id, { transaction: t });
        if (!product) {
            await t.rollback();
            return res.status(404).json({ error: 'Product not found' });
        }

        // Eliminar items anteriores
        await ProductRecipe.destroy({
            where: { product_id: req.params.id },
            transaction: t
        });

        // Crear nuevos items
        for (const item of items) {
            await ProductRecipe.create({
                product_id: req.params.id,
                item_type: item.item_type,
                item_id: item.item_id,
                quantity: item.quantity
            }, { transaction: t });
        }

        await t.commit();

        const recipe = await ProductRecipe.findAll({
            where: { product_id: req.params.id }
        });

        res.json(recipe);
    } catch (error) {
        await t.rollback();
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ============================================
// MOVIMIENTOS DE INVENTARIO
// ============================================

// GET /api/inventory/movements - Obtener movimientos
router.get('/movements', authenticate, async (req, res) => {
    try {
        const { ingredient_id, type, limit } = req.query;

        const where = {};
        if (ingredient_id) where.ingredient_id = ingredient_id;
        if (type) where.type = type;

        const movements = await InventoryMovement.findAll({
            where,
            include: [
                {
                    model: Ingredient,
                    as: 'ingredient',
                    attributes: ['id', 'name', 'unit']
                }
            ],
            order: [['createdAt', 'DESC']],
            limit: limit ? parseInt(limit) : 100
        });

        res.json(movements);
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// POST /api/inventory/movements - Registrar movimiento
router.post('/movements', authenticate, async (req, res) => {
    const t = await sequelize.transaction();
    
    try {
        const { ingredient_id, type, quantity, unit_cost, reason, notes } = req.body;

        if (!ingredient_id || !type || !quantity) {
            await t.rollback();
            return res.status(400).json({ error: 'ingredient_id, type and quantity are required' });
        }

        const ingredient = await Ingredient.findByPk(ingredient_id, { transaction: t });
        if (!ingredient) {
            await t.rollback();
            return res.status(404).json({ error: 'Ingredient not found' });
        }

        // Crear movimiento
        const movement = await InventoryMovement.create({
            ingredient_id,
            type,
            quantity,
            unit_cost,
            reason,
            notes,
            user_id: req.user.id
        }, { transaction: t });

        // Actualizar stock
        let newStock = parseFloat(ingredient.stock);
        
        if (type === 'entrada') {
            newStock += parseFloat(quantity);
            
            // Actualizar costo promedio si se proporciona unit_cost
            if (unit_cost) {
                const totalValue = (parseFloat(ingredient.stock) * parseFloat(ingredient.cost_per_unit)) + 
                                   (parseFloat(quantity) * parseFloat(unit_cost));
                const newCostPerUnit = totalValue / newStock;
                await ingredient.update({ 
                    stock: newStock,
                    cost_per_unit: newCostPerUnit
                }, { transaction: t });
            } else {
                await ingredient.update({ stock: newStock }, { transaction: t });
            }
        } else if (type === 'salida') {
            newStock -= parseFloat(quantity);
            await ingredient.update({ stock: newStock }, { transaction: t });
        } else if (type === 'ajuste') {
            await ingredient.update({ stock: quantity }, { transaction: t });
        }

        await t.commit();

        const fullMovement = await InventoryMovement.findByPk(movement.id, {
            include: [{
                model: Ingredient,
                as: 'ingredient',
                attributes: ['id', 'name', 'unit', 'stock']
            }]
        });

        res.status(201).json(fullMovement);
    } catch (error) {
        await t.rollback();
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

module.exports = router;