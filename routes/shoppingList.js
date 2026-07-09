const express = require('express');
const router = express.Router();
const { Op } = require('sequelize');
const logger = require('../utils/logger');
const {
    ShoppingList,
    ShoppingListItem,
    Ingredient,
    BranchStock,
    Branch,
    sequelize
} = require('../models');
const { authenticate } = require('../middleware/auth');
const { requirePremium } = require('../middleware/checkPlan');
const { enviarNotificacion } = require('../utils/push');

// Todas las rutas requieren sesión y plan premium (la lista de compras vive con
// el módulo de inventario, que es premium).
router.use(authenticate, requirePremium);

// Normaliza branch_id: acepta número o null (negocio sin sucursales).
function normBranch(v) {
    if (v === undefined || v === null || v === '' || v === 'null') return null;
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? null : n;
}

// Devuelve la lista activa de una sucursal (la crea vacía si no existe).
async function obtenerOCrearListaActiva(businessId, branchId) {
    let lista = await ShoppingList.findOne({
        where: {
            business_id: businessId,
            branch_id: branchId === null ? { [Op.is]: null } : branchId,
            status: 'active'
        },
        order: [['createdAt', 'DESC']]
    });
    if (!lista) {
        lista = await ShoppingList.create({
            business_id: businessId,
            branch_id: branchId,
            status: 'active'
        });
    }
    return lista;
}

// Serializa la lista con sus items ordenados.
async function serializarLista(lista) {
    const items = await ShoppingListItem.findAll({
        where: { list_id: lista.id },
        order: [['checked', 'ASC'], ['createdAt', 'ASC']]
    });
    return {
        id: lista.id,
        branch_id: lista.branch_id,
        status: lista.status,
        sent_by: lista.sent_by,
        sent_at: lista.sent_at,
        items: items.map(i => ({
            id: i.id,
            name: i.name,
            ingredient_id: i.ingredient_id,
            quantity_text: i.quantity_text,
            current_stock: i.current_stock !== null ? parseFloat(i.current_stock) : null,
            min_stock: i.min_stock !== null ? parseFloat(i.min_stock) : null,
            unit: i.unit,
            checked: i.checked,
            source: i.source
        }))
    };
}

// Lee el stock de un ingrediente en una sucursal (tabla primero, fallback JSON,
// fallback stock global).
function leerStock(ing, branchId, tableStockMap) {
    if (branchId === null) return parseFloat(ing.stock) || 0;
    if (ing.id in tableStockMap) return tableStockMap[ing.id];
    const bs = ing.branch_stocks || {};
    return Object.keys(bs).length > 0
        ? parseFloat(bs[String(branchId)] ?? 0)
        : parseFloat(ing.stock) || 0;
}

// GET /api/shopping-list?branch_id=X  → lista activa de la sucursal
router.get('/', async (req, res) => {
    try {
        const biz = req.user.business_id;
        const branchId = normBranch(req.query.branch_id);
        const lista = await obtenerOCrearListaActiva(biz, branchId);
        res.json(await serializarLista(lista));
    } catch (error) {
        logger.error('shopping-list GET error:', error);
        res.status(500).json({ error: 'Error al obtener la lista de compras' });
    }
});

// GET /api/shopping-list/inventory-options?branch_id=X
// Insumos del inventario para el botón "agregar del inventario", con su stock actual.
router.get('/inventory-options', async (req, res) => {
    try {
        const biz = req.user.business_id;
        const branchId = normBranch(req.query.branch_id);

        const ingredients = await Ingredient.findAll({
            where: { business_id: biz, active: true },
            order: [['name', 'ASC']]
        });

        const ingIds = ingredients.map(i => i.id);
        const tableStockMap = {};
        if (branchId !== null && ingIds.length > 0) {
            const records = await BranchStock.findAll({
                where: { ingredient_id: { [Op.in]: ingIds }, branch_id: branchId }
            });
            for (const r of records) tableStockMap[r.ingredient_id] = parseFloat(r.quantity);
        }

        const opciones = ingredients.map(ing => ({
            ingredient_id: ing.id,
            name: ing.name,
            unit: ing.unit,
            current_stock: leerStock(ing, branchId, tableStockMap),
            min_stock: parseFloat(ing.min_stock) || 0
        }));

        res.json(opciones);
    } catch (error) {
        logger.error('shopping-list inventory-options error:', error);
        res.status(500).json({ error: 'Error al obtener insumos' });
    }
});

// POST /api/shopping-list/generate  { branch_id }
// Rellena la lista activa con los insumos en o por debajo de su mínimo.
router.post('/generate', async (req, res) => {
    try {
        const biz = req.user.business_id;
        const branchId = normBranch(req.body.branch_id);
        const lista = await obtenerOCrearListaActiva(biz, branchId);

        const ingredients = await Ingredient.findAll({
            where: { business_id: biz, active: true }
        });
        const ingIds = ingredients.map(i => i.id);

        const tableStockMap = {};
        if (branchId !== null && ingIds.length > 0) {
            const records = await BranchStock.findAll({
                where: { ingredient_id: { [Op.in]: ingIds }, branch_id: branchId }
            });
            for (const r of records) tableStockMap[r.ingredient_id] = parseFloat(r.quantity);
        }

        // Items 'auto' que ya existen (para no duplicar por ingrediente)
        const existentes = await ShoppingListItem.findAll({
            where: { list_id: lista.id, ingredient_id: { [Op.ne]: null } }
        });
        const yaEnLista = new Set(existentes.map(i => i.ingredient_id));

        let agregados = 0;
        for (const ing of ingredients) {
            const min = parseFloat(ing.min_stock) || 0;
            if (min <= 0) continue; // sin mínimo definido no se considera "bajo"
            const actual = leerStock(ing, branchId, tableStockMap);
            if (actual > min) continue; // hay suficiente
            if (yaEnLista.has(ing.id)) continue; // ya está en la lista

            await ShoppingListItem.create({
                list_id: lista.id,
                name: ing.name,
                ingredient_id: ing.id,
                current_stock: actual,
                min_stock: min,
                unit: ing.unit,
                source: 'auto'
            });
            agregados++;
        }

        const serial = await serializarLista(lista);
        res.json({ ...serial, agregados });
    } catch (error) {
        logger.error('shopping-list generate error:', error);
        res.status(500).json({ error: 'Error al generar la lista automática' });
    }
});

// POST /api/shopping-list/items  { branch_id, name, quantity_text?, ingredient_id?, source? }
router.post('/items', async (req, res) => {
    try {
        const biz = req.user.business_id;
        const branchId = normBranch(req.body.branch_id);
        const { name, quantity_text, ingredient_id, source } = req.body;

        if (!name || !String(name).trim()) {
            return res.status(400).json({ error: 'El nombre es obligatorio' });
        }

        const lista = await obtenerOCrearListaActiva(biz, branchId);

        let current_stock = null, min_stock = null, unit = null;
        let ingId = ingredient_id || null;
        if (ingId) {
            // Validar que el insumo pertenece al negocio y capturar su contexto
            const ing = await Ingredient.findOne({ where: { id: ingId, business_id: biz } });
            if (!ing) return res.status(404).json({ error: 'Insumo no encontrado' });
            unit = ing.unit;
            min_stock = parseFloat(ing.min_stock) || 0;
            const tableStockMap = {};
            if (branchId !== null) {
                const rec = await BranchStock.findOne({ where: { ingredient_id: ingId, branch_id: branchId } });
                if (rec) tableStockMap[ingId] = parseFloat(rec.quantity);
            }
            current_stock = leerStock(ing, branchId, tableStockMap);
        }

        const item = await ShoppingListItem.create({
            list_id: lista.id,
            name: String(name).trim(),
            ingredient_id: ingId,
            quantity_text: quantity_text ? String(quantity_text).trim() : null,
            current_stock,
            min_stock,
            unit,
            source: source || (ingId ? 'inventory' : 'manual')
        });

        res.status(201).json({
            id: item.id,
            name: item.name,
            ingredient_id: item.ingredient_id,
            quantity_text: item.quantity_text,
            current_stock: item.current_stock !== null ? parseFloat(item.current_stock) : null,
            min_stock: item.min_stock !== null ? parseFloat(item.min_stock) : null,
            unit: item.unit,
            checked: item.checked,
            source: item.source
        });
    } catch (error) {
        logger.error('shopping-list add item error:', error);
        res.status(500).json({ error: 'Error al agregar el item' });
    }
});

// PUT /api/shopping-list/items/:id  { checked?, name?, quantity_text? }
router.put('/items/:id', async (req, res) => {
    try {
        const biz = req.user.business_id;
        const item = await ShoppingListItem.findByPk(req.params.id, {
            include: [{ model: ShoppingList, as: 'list' }]
        });
        if (!item || !item.list || item.list.business_id !== biz) {
            return res.status(404).json({ error: 'Item no encontrado' });
        }

        const { checked, name, quantity_text } = req.body;
        if (checked !== undefined) item.checked = !!checked;
        if (name !== undefined && String(name).trim()) item.name = String(name).trim();
        if (quantity_text !== undefined) item.quantity_text = quantity_text ? String(quantity_text).trim() : null;
        await item.save();

        res.json({ ok: true });
    } catch (error) {
        logger.error('shopping-list update item error:', error);
        res.status(500).json({ error: 'Error al actualizar el item' });
    }
});

// DELETE /api/shopping-list/items/:id
router.delete('/items/:id', async (req, res) => {
    try {
        const biz = req.user.business_id;
        const item = await ShoppingListItem.findByPk(req.params.id, {
            include: [{ model: ShoppingList, as: 'list' }]
        });
        if (!item || !item.list || item.list.business_id !== biz) {
            return res.status(404).json({ error: 'Item no encontrado' });
        }
        await item.destroy();
        res.json({ ok: true });
    } catch (error) {
        logger.error('shopping-list delete item error:', error);
        res.status(500).json({ error: 'Error al eliminar el item' });
    }
});

// POST /api/shopping-list/clear  { branch_id }  → vacía la lista activa
router.post('/clear', async (req, res) => {
    try {
        const biz = req.user.business_id;
        const branchId = normBranch(req.body.branch_id);
        const lista = await obtenerOCrearListaActiva(biz, branchId);
        await ShoppingListItem.destroy({ where: { list_id: lista.id } });
        res.json({ ok: true });
    } catch (error) {
        logger.error('shopping-list clear error:', error);
        res.status(500).json({ error: 'Error al vaciar la lista' });
    }
});

// POST /api/shopping-list/send  { branch_id, sent_by }
// Marca la lista activa como enviada, notifica al dueño y abre una lista nueva.
router.post('/send', async (req, res) => {
    try {
        const biz = req.user.business_id;
        const branchId = normBranch(req.body.branch_id);
        const sentBy = req.body.sent_by ? String(req.body.sent_by).trim() : null;

        const lista = await obtenerOCrearListaActiva(biz, branchId);
        const items = await ShoppingListItem.findAll({ where: { list_id: lista.id } });
        if (items.length === 0) {
            return res.status(400).json({ error: 'La lista está vacía' });
        }

        // Nombre de la sucursal para la notificación
        let branchName = 'el negocio';
        if (branchId !== null) {
            const br = await Branch.findByPk(branchId, { attributes: ['name'] });
            if (br) branchName = br.name;
        }

        // Marcar como enviada
        lista.status = 'sent';
        lista.sent_by = sentBy;
        lista.sent_at = new Date();
        await lista.save();

        // Notificar al dueño (usa el sistema de push existente). Sin prefKey =
        // se envía siempre; es una acción explícita del usuario.
        const pendientes = items.filter(i => !i.checked).length;
        const quien = sentBy ? `${sentBy} (${branchName})` : branchName;
        enviarNotificacion(
            biz,
            null,
            '🛒 Nueva lista de compras',
            `${quien} envió una lista con ${items.length} artículo(s), ${pendientes} por comprar.`,
            { type: 'shopping_list', list_id: lista.id, branch_id: branchId }
        ).catch(e => logger.warn('push lista de compras falló:', e?.message));

        // Abrir una lista activa nueva para la sucursal
        await ShoppingList.create({ business_id: biz, branch_id: branchId, status: 'active' });

        res.json({ ok: true, sent_items: items.length });
    } catch (error) {
        logger.error('shopping-list send error:', error);
        res.status(500).json({ error: 'Error al enviar la lista' });
    }
});

// GET /api/shopping-list/received?branch_id=X
// Para el administrador: últimas listas enviadas (todas las sucursales o una).
router.get('/received', async (req, res) => {
    try {
        const biz = req.user.business_id;
        const branchId = req.query.branch_id !== undefined ? normBranch(req.query.branch_id) : undefined;

        const where = { business_id: biz, status: 'sent' };
        if (branchId !== undefined) {
            where.branch_id = branchId === null ? { [Op.is]: null } : branchId;
        }

        const listas = await ShoppingList.findAll({
            where,
            order: [['sent_at', 'DESC']],
            limit: 20,
            include: [{ model: Branch, as: 'branch', attributes: ['name'] }]
        });

        const result = [];
        for (const l of listas) {
            const serial = await serializarLista(l);
            result.push({ ...serial, branch_name: l.branch?.name || null, sent_at: l.sent_at });
        }
        res.json(result);
    } catch (error) {
        logger.error('shopping-list received error:', error);
        res.status(500).json({ error: 'Error al obtener listas recibidas' });
    }
});

module.exports = router;
