const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const {
    Ingredient,
    Preparation,
    PreparationItem,
    Product,
    ProductRecipe,
    InventoryMovement,
    PrivilegedActionLog,
    BranchStock,
    User,
    sequelize
} = require('../models');
const { authenticate, isOwner } = require('../middleware/auth');
const { verifyEmployeePin } = require('../utils/verifyPin');
const { requirePremium } = require('../middleware/checkPlan');
const { configurarSSE } = require('../utils/sse');
const { notificarAudit } = require('./audit');
const { enviarNotificacion } = require('../utils/push');
const { evaluarHorario, avisarFueraDeHorario } = require('../utils/horarios');
const { paginate, paginatedResponse } = require('../utils/pagination');
const { convertirCantidad } = require('../utils/unidades');
const { fraccionDeTanda } = require('../utils/preparaciones');

// El stock por sucursal se lee y se escribe SOLO por utils/branchStock.js
// (deuda §12.1). Aquí vivían dos helpers de lectura dual que además no llamaba
// nadie: eran código muerto apuntando al JSON legado.
const {
    leerStockSucursal, escribirStockSucursal, lectorDeStock,
    mapaSumaTodasSucursales, respaldarJsonEnTabla,
} = require('../utils/branchStock');

// La tabla de conversión vive en utils/unidades.js (BLOQUE 12): estaba duplicada
// aquí y en routes/orders.js. Si las dos copias se desviaban, el sistema
// descontaba una cantidad del inventario y costeaba otra.
const convertUnit = convertirCantidad;

// ── SSE: notificaciones en tiempo real de cambios en inventario ────────────────
const _invClients = new Map(); // businessId (string) → Set<Response>

function _notificarInventario(businessId) {
    const clients = _invClients.get(String(businessId));
    if (!clients || clients.size === 0) return;
    const msg = `data: {}\n\n`;
    for (const res of clients) {
        if (res.writableEnded) { clients.delete(res); continue; }
        try { res.write(msg); } catch { clients.delete(res); }
    }
}

router.get('/events', (req, res) => {
    configurarSSE(_invClients, req, res);
});

// GET /api/inventory/products-stock?branch_id=X
// Calcula stock disponible de cada producto basado en niveles de ingredientes y recetas.
// Devuelve { productId: cantidad } — null significa sin receta (usar product.stock del producto).
router.get('/products-stock', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const branchId = req.query.branch_id ? String(req.query.branch_id) : null;
        const { Op } = require('sequelize');

        const products = await Product.findAll({ where: { business_id: biz, active: true }, attributes: ['id'] });
        const productIds = products.map(p => p.id);
        if (productIds.length === 0) return res.json({});

        const allRecipes = await ProductRecipe.findAll({ where: { product_id: { [Op.in]: productIds } } });

        const recipesByProduct = {};
        for (const r of allRecipes) {
            if (!recipesByProduct[r.product_id]) recipesByProduct[r.product_id] = [];
            recipesByProduct[r.product_id].push(r);
        }

        const ingIds  = [...new Set(allRecipes.filter(r => r.item_type === 'ingredient').map(r => r.item_id))];
        const prepIds = [...new Set(allRecipes.filter(r => r.item_type === 'preparation').map(r => r.item_id))];

        const ings = ingIds.length > 0
            ? await Ingredient.findAll({ where: { id: { [Op.in]: ingIds }, business_id: biz } })
            : [];
        const ingMap = {};
        for (const ing of ings) ingMap[ing.id] = ing;

        // Rinde de cada preparación: hace falta para saber qué fracción de la
        // tanda consume una receta (ver utils/preparaciones.js).
        const prepYieldMap = {};
        if (prepIds.length > 0) {
            const preps = await Preparation.findAll({
                where: { id: { [Op.in]: prepIds }, business_id: biz },
                attributes: ['id', 'yield_quantity'],
            });
            for (const pr of preps) prepYieldMap[pr.id] = pr;
        }

        const prepItemsMap = {};
        if (prepIds.length > 0) {
            const pItems = await PreparationItem.findAll({
                where: { preparation_id: { [Op.in]: prepIds } },
                include: [{ model: Ingredient, as: 'ingredient' }]
            });
            for (const pi of pItems) {
                if (!prepItemsMap[pi.preparation_id]) prepItemsMap[pi.preparation_id] = [];
                prepItemsMap[pi.preparation_id].push(pi);
            }
        }

        // Stock de todos los insumos implicados en UNA sola consulta (§12.1).
        const allIngIds = [...new Set([...ingIds, ...(Object.values(prepItemsMap).flat().map(pi => pi.ingredient_id))])];
        const getStock = await lectorDeStock(allIngIds, branchId);

        const result = {};
        for (const productId of productIds) {
            const recipeItems = recipesByProduct[productId];
            if (!recipeItems || recipeItems.length === 0) { result[productId] = null; continue; }

            let min = Infinity;
            for (const item of recipeItems) {
                if (item.item_type === 'ingredient') {
                    const ing = ingMap[item.item_id];
                    if (!ing) continue;
                    const needed = convertUnit(parseFloat(item.quantity), item.unit_recipe, ing.unit);
                    if (needed <= 0) continue;
                    const possible = Math.floor(getStock(ing) / needed);
                    if (possible < min) min = possible;
                } else if (item.item_type === 'preparation') {
                    const pItems = prepItemsMap[item.item_id] || [];
                    // El rinde manda (ver utils/preparaciones.js): sin esto, la
                    // disponibilidad decía que alcanzaba para muchos menos platos.
                    const qtyPrep = fraccionDeTanda(item.quantity, prepYieldMap[item.item_id]);
                    for (const pi of pItems) {
                        if (!pi.ingredient) continue;
                        const needed = convertUnit(parseFloat(pi.quantity), pi.unit_recipe, pi.ingredient.unit) * qtyPrep;
                        if (needed <= 0) continue;
                        const possible = Math.floor(getStock(pi.ingredient) / needed);
                        if (possible < min) min = possible;
                    }
                }
            }
            result[productId] = min === Infinity ? null : Math.max(0, min);
        }

        res.json(result);
    } catch (error) {
        logger.error('products-stock error:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
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
        const { page, limit, offset } = paginate(req.query);

        const { count, rows: ingredients } = await Ingredient.findAndCountAll({
            where: { active: true, business_id: biz },
            order: [['name', 'ASC']],
            limit,
            offset
        });
        const ingIds = ingredients.map(i => i.id);

        if (branchId) {
            const stockDe = await lectorDeStock(ingIds, branchId);
            const result = ingredients.map(ing => {
                const plain = ing.toJSON();
                plain.stock = stockDe(ing);
                return plain;
            });
            return res.json(paginatedResponse(result, count, page, limit));
        }

        // Sin sucursal: sumar el stock de todas. Un insumo que no está repartido
        // (ninguna fila en la tabla) conserva su stock global, que es su verdad.
        const sumas = await mapaSumaTodasSucursales(ingIds);
        const result = ingredients.map(ing => {
            const plain = ing.toJSON();
            if (ing.id in sumas) plain.stock = sumas[ing.id];
            return plain;
        });
        res.json(paginatedResponse(result, count, page, limit));
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
        const { ingredient_id, type, quantity, unit_cost, reason, notes, branch_id, employee_id, pin, employee_name } = req.body;
        if (!ingredient_id || !type || !quantity) {
            await t.rollback();
            return res.status(400).json({ error: 'ingredient_id, tipo y cantidad son requeridos' });
        }

        // Ajuste manual: PIN obligatorio
        let authorizedEmployee = null;
        if (type === 'ajuste') {
            if (!employee_id || !pin) {
                await t.rollback();
                return res.status(400).json({ error: 'Se requiere PIN para esta acción' });
            }
            try {
                authorizedEmployee = await verifyEmployeePin(employee_id, pin, biz);
            } catch (pinErr) {
                await t.rollback();
                return res.status(403).json({ error: pinErr.message });
            }
        }

        const ingredient = await Ingredient.findOne({ where: { id: ingredient_id, business_id: biz }, transaction: t });
        if (!ingredient) {
            await t.rollback();
            return res.status(404).json({ error: 'Insumo no encontrado' });
        }

        // Stock antes del ajuste (para auditoría). Bloquea la fila dentro de la
        // transacción: dos movimientos a la vez no pueden partir del mismo número.
        const branchKey = branch_id ? String(branch_id) : null;
        const stockAntes = await leerStockSucursal(ingredient, branchKey, t);

        const movement = await InventoryMovement.create({
            ingredient_id, type, quantity, unit_cost, reason, notes,
            user_id: req.user.id, business_id: biz,
            branch_id: branch_id || null,
        }, { transaction: t });

        const currentStock = stockAntes;

        let newStock = currentStock;
        if (type === 'entrada') {
            newStock += parseFloat(quantity);
            if (branchKey) {
                await escribirStockSucursal(ingredient, branchKey, newStock, t);
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
            await escribirStockSucursal(ingredient, branchKey, newStock, t);
        } else if (type === 'ajuste') {
            newStock = parseFloat(quantity);
            await escribirStockSucursal(ingredient, branchKey, newStock, t);
        }
        await t.commit();

        // Registrar en auditoría si fue un ajuste autorizado con PIN
        if (type === 'ajuste' && authorizedEmployee) {
            const marcaHorario = await evaluarHorario(biz);
            await PrivilegedActionLog.create({
                business_id: biz,
                branch_id: branch_id || null,
                employee_id: authorizedEmployee.id,
                employee_name: employee_name || authorizedEmployee.name,
                action_type: 'inventory_adjustment',
                target_description: `Insumo: ${ingredient.name}`,
                before_data: JSON.stringify({ ingredient_id, name: ingredient.name, stock: stockAntes }),
                after_data: JSON.stringify({ ingredient_id, name: ingredient.name, stock: parseFloat(quantity), reason: reason || null }),
                fuera_horario: marcaHorario.fuera
            });
            notificarAudit(biz);
            avisarFueraDeHorario(biz, 'inventory_adjustment', marcaHorario);
        }

        _notificarInventario(biz); // avisar a clientes SSE conectados

        // Push notification: ajuste de inventario manual
        if (type === 'ajuste' && authorizedEmployee) {
            const tipoTexto = type === 'entrada' ? 'Entrada' : type === 'salida' ? 'Salida' : 'Ajuste';
            enviarNotificacion(
                biz,
                'notif_ajuste_inventario',
                `📦 ${tipoTexto} de inventario`,
                `${authorizedEmployee.name} ajustó ${ingredient.name} → ${parseFloat(quantity)} ${ingredient.unit || ''}`
            );
        }
        const fullMovement = await InventoryMovement.findByPk(movement.id, {
            include: [{ model: Ingredient, as: 'ingredient', attributes: ['id', 'name', 'unit', 'stock'] }]
        });
        res.status(201).json(fullMovement);
    } catch (error) {
        await t.rollback();
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ============================================
// MIGRACIÓN: branch_stocks JSON → tabla BranchStock
// GET /api/inventory/migrate-branch-stocks (solo owner)
// ============================================
// Desde el 2026-09-04 el respaldo corre SOLO en cada arranque (runMigrations,
// §12.1), así que este endpoint ya no es necesario: se queda como botón manual
// para volver a pasarlo sobre un negocio concreto. Delega en el mismo código.
//
// ⚠️ Ya no pisa lo que haya en la tabla. La versión anterior hacía `upsert` de
// todo el JSON, así que re-ejecutarla podía SOBRESCRIBIR el stock real con un
// valor viejo del JSON. Ahora solo rellena los pares que faltan.
router.get('/migrate-branch-stocks', authenticate, isOwner, async (req, res) => {
    try {
        const r = await respaldarJsonEnTabla(req.user.business_id);
        res.json({
            message: 'Respaldo completado',
            pares_revisados: r.revisados,
            pares_copiados: r.copiados,
            pares_ya_en_tabla: r.omitidos
        });
    } catch (error) {
        logger.error('migrate-branch-stocks error:', error);
        res.status(500).json({ error: 'Error en la migración' });
    }
});

module.exports = router;
module.exports.notificarInventario = _notificarInventario;
