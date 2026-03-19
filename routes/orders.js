const express = require('express');
const router = express.Router();
const { Order, OrderItem, Product, Customer, Table, ProductRecipe, Ingredient, PreparationItem, PrivilegedActionLog, sequelize } = require('../models');
const { authenticate } = require('../middleware/auth');
const { verifyEmployeePin } = require('../utils/verifyPin');
const { Op } = require('sequelize');

// Factores de conversión entre unidades compatibles
const FACTORES_CONVERSION = {
    'g_kg': 0.001, 'kg_g': 1000,
    'ml_l': 0.001, 'l_ml': 1000,
    'ml_gal': 0.000264, 'gal_ml': 3785.41,
    'l_gal': 0.26417, 'gal_l': 3.78541,
};

function convertirUnidad(cantidad, unidadReceta, ingrediente) {
    if (!unidadReceta || unidadReceta === ingrediente.unit) return cantidad;
    const clave = `${unidadReceta}_${ingrediente.unit}`;
    if (FACTORES_CONVERSION[clave]) return cantidad * FACTORES_CONVERSION[clave];
    return cantidad;
}

// Helpers de stock por sucursal
function getBranchStock(ingredient, branchId) {
    if (!branchId) return parseFloat(ingredient.stock);
    const bs = ingredient.branch_stocks || {};
    const key = String(branchId);
    if (key in bs) return parseFloat(bs[key]);
    if (Object.keys(bs).length === 0) return parseFloat(ingredient.stock) || 0;
    return 0;
}

async function setBranchStock(ingredient, branchId, newStock, transaction) {
    if (!branchId) {
        await ingredient.update({ stock: newStock }, { transaction });
    } else {
        const bs = { ...(ingredient.branch_stocks || {}) };
        bs[String(branchId)] = newStock;
        await ingredient.update({ branch_stocks: bs }, { transaction });
    }
}

// Descuenta ingredientes según la receta del producto al registrar una venta
async function descontarIngredientesDeReceta(productId, qty, t, branchId = null) {
    const recetaItems = await ProductRecipe.findAll({ where: { product_id: productId }, transaction: t });
    if (!recetaItems.length) return;

    for (const item of recetaItems) {
        if (item.item_type === 'ingredient') {
            const ingrediente = await Ingredient.findByPk(item.item_id, { transaction: t });
            if (!ingrediente) continue;
            const cantDescontar = convertirUnidad(parseFloat(item.quantity), item.unit_recipe, ingrediente) * qty;
            const stockActual = getBranchStock(ingrediente, branchId);
            await setBranchStock(ingrediente, branchId, Math.max(0, stockActual - cantDescontar), t);

        } else if (item.item_type === 'preparation') {
            const prepItems = await PreparationItem.findAll({
                where: { preparation_id: item.item_id },
                include: [{ model: Ingredient, as: 'ingredient' }],
                transaction: t
            });
            const cantPrep = parseFloat(item.quantity) * qty;
            for (const pi of prepItems) {
                if (!pi.ingredient) continue;
                const cantDescontar = convertirUnidad(parseFloat(pi.quantity), pi.unit_recipe, pi.ingredient) * cantPrep;
                const stockActual = getBranchStock(pi.ingredient, branchId);
                await setBranchStock(pi.ingredient, branchId, Math.max(0, stockActual - cantDescontar), t);
            }
        }
    }
}

// GET /api/orders
router.get('/', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const { status, order_type, date_from, date_to, payment_method, limit = '50', page = '1' } = req.query;

        const limitNum = Math.min(Math.max(parseInt(limit) || 50, 1), 200);
        const pageNum = Math.max(parseInt(page) || 1, 1);
        const offset = (pageNum - 1) * limitNum;

        const where = { business_id: biz };
        if (status) where.status = status;
        if (order_type) where.order_type = order_type;
        if (payment_method) where.payment_method = payment_method;
        if (req.query.branch_id) where[Op.and] = [{ [Op.or]: [{ branch_id: parseInt(req.query.branch_id) }, { branch_id: null }] }];
        if (date_from || date_to) {
            where.createdAt = {};
            if (date_from) where.createdAt[Op.gte] = new Date(date_from);
            if (date_to) {
                const end = new Date(date_to);
                end.setHours(23, 59, 59, 999);
                where.createdAt[Op.lte] = end;
            }
        }

        const { count, rows } = await Order.findAndCountAll({
            where,
            include: [
                {
                    model: Customer,
                    as: 'customer',
                    attributes: ['id', 'name', 'phone'],
                    required: false
                },
                {
                    model: Table,
                    as: 'table',
                    attributes: ['id', 'name', 'zone'],
                    required: false
                },
                {
                    model: OrderItem,
                    as: 'items',
                    include: [{
                        model: Product,
                        as: 'product',
                        attributes: ['id', 'name', 'emoji', 'image']
                    }]
                }
            ],
            order: [['createdAt', 'DESC']],
            limit: limitNum,
            offset,
            distinct: true
        });

        res.json({
            data: rows,
            pagination: {
                total: count,
                page: pageNum,
                limit: limitNum,
                pages: Math.ceil(count / limitNum)
            }
        });
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// GET /api/orders/:id
router.get('/:id', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const order = await Order.findOne({
            where: { id: req.params.id, business_id: biz },
            include: [
                {
                    model: Customer,
                    as: 'customer',
                    attributes: ['id', 'name', 'phone', 'address']
                },
                {
                    model: OrderItem,
                    as: 'items',
                    include: [{
                        model: Product,
                        as: 'product',
                        attributes: ['id', 'name', 'description', 'emoji', 'image']
                    }]
                }
            ]
        });

        if (!order) {
            return res.status(404).json({ error: 'Pedido no encontrado' });
        }

        res.json(order);
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// POST /api/orders
router.post('/', authenticate, async (req, res) => {
    const t = await sequelize.transaction();

    try {
        const biz = req.user.business_id;
        const {
            customer_id, customer_temp_info, items, total,
            payment_method, order_type, reference,
            delivery_address, maps_link, notes, branch_id,
            table_id, guests,
        } = req.body;

        // Permitir pedido vacío cuando viene con table_id (mesa reservada, los items se agregan después)
        if ((!items || items.length === 0) && !table_id) {
            await t.rollback();
            return res.status(400).json({ error: 'El pedido debe tener al menos un producto' });
        }

        // Si viene table_id, verificar que la mesa no tenga ya un pedido abierto
        if (table_id) {
            const mesaOcupada = await Order.findOne({
                where: { table_id, status: 'registrado', business_id: biz },
                transaction: t,
            });
            if (mesaOcupada) {
                await t.rollback();
                return res.status(409).json({ error: 'La mesa ya tiene un pedido abierto' });
            }
        }

        // Calcular total en el servidor (no confiar en el cliente)
        // y validar que cada producto pertenezca al negocio
        let calculatedTotal = 0;
        const resolvedItems = [];

        for (const item of items) {
            const productId = item.product_id || item.id;
            const product = await Product.findOne({
                where: { id: productId, business_id: biz },
                transaction: t
            });

            if (!product) {
                await t.rollback();
                return res.status(404).json({ error: `Producto ${productId} no encontrado en este negocio` });
            }

            const qty = Math.max(1, parseInt(item.quantity) || 1);
            const unitPrice = parseFloat(product.price);
            const subtotal = parseFloat((qty * unitPrice).toFixed(2));
            calculatedTotal += subtotal;

            resolvedItems.push({ product, qty, unitPrice, subtotal, notes: item.notes || item.nota || '' });
        }

        calculatedTotal = parseFloat(calculatedTotal.toFixed(2));

        const order = await Order.create({
            customer_id,
            customer_temp_info,
            total: calculatedTotal,
            status: 'registrado',
            payment_method: payment_method || 'efectivo',
            order_type: order_type || 'comer',
            reference,
            delivery_address,
            maps_link,
            notes,
            business_id: biz,
            branch_id: branch_id || null,
            table_id: table_id || null,
            guests: guests ? parseInt(guests) : null,
        }, { transaction: t });

        for (const { product, qty, unitPrice, subtotal, notes: itemNotes } of resolvedItems) {
            await OrderItem.create({
                order_id: order.id,
                product_id: product.id,
                quantity: qty,
                unit_price: unitPrice,
                subtotal,
                notes: itemNotes
            }, { transaction: t });

            await product.update({
                stock: product.stock - qty
            }, { transaction: t });

            await descontarIngredientesDeReceta(product.id, qty, t, branch_id || null);
        }

        await t.commit();

        const fullOrder = await Order.findByPk(order.id, {
            include: [
                { model: Customer, as: 'customer', attributes: ['id', 'name', 'phone'] },
                {
                    model: OrderItem,
                    as: 'items',
                    include: [{ model: Product, as: 'product', attributes: ['id', 'name', 'emoji', 'image'] }]
                }
            ]
        });

        res.status(201).json(fullOrder);
    } catch (error) {
        await t.rollback();
        console.error('Create order error:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// POST /api/orders/:id/items  — agregar productos a un pedido abierto (para mesas)
router.post('/:id/items', authenticate, async (req, res) => {
    const t = await sequelize.transaction();
    try {
        const biz = req.user.business_id;
        const { items } = req.body;

        if (!items || items.length === 0) {
            await t.rollback();
            return res.status(400).json({ error: 'Se requiere al menos un producto' });
        }

        const order = await Order.findOne({
            where: { id: req.params.id, business_id: biz, status: 'registrado' },
            transaction: t,
        });
        if (!order) {
            await t.rollback();
            return res.status(404).json({ error: 'Pedido no encontrado o ya cerrado' });
        }

        let additionalTotal = 0;
        for (const item of items) {
            const productId = item.product_id || item.id;
            const product = await Product.findOne({
                where: { id: productId, business_id: biz },
                transaction: t,
            });
            if (!product) {
                await t.rollback();
                return res.status(404).json({ error: `Producto ${productId} no encontrado` });
            }
            const qty = Math.max(1, parseInt(item.quantity) || 1);
            const unitPrice = parseFloat(product.price);
            const subtotal = parseFloat((qty * unitPrice).toFixed(2));
            additionalTotal += subtotal;

            await OrderItem.create({
                order_id: order.id,
                product_id: product.id,
                quantity: qty,
                unit_price: unitPrice,
                subtotal,
                notes: item.notes || '',
            }, { transaction: t });

            await product.update({ stock: product.stock - qty }, { transaction: t });
            await descontarIngredientesDeReceta(product.id, qty, t, order.branch_id || null);
        }

        const newTotal = parseFloat((parseFloat(order.total) + additionalTotal).toFixed(2));
        await order.update({ total: newTotal }, { transaction: t });

        await t.commit();

        const updated = await Order.findByPk(order.id, {
            include: [{
                model: OrderItem, as: 'items',
                include: [{ model: Product, as: 'product', attributes: ['id', 'name', 'emoji', 'price'] }],
            }],
        });
        res.json(updated);
    } catch (error) {
        await t.rollback();
        console.error('Add items to order error:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// DELETE /api/orders/:id/items/:itemId — eliminar un producto de un pedido abierto
router.delete('/:id/items/:itemId', authenticate, async (req, res) => {
    const t = await sequelize.transaction();
    try {
        const biz = req.user.business_id;

        const order = await Order.findOne({
            where: { id: req.params.id, business_id: biz, status: 'registrado' },
            transaction: t,
        });
        if (!order) {
            await t.rollback();
            return res.status(404).json({ error: 'Pedido no encontrado o ya cerrado' });
        }

        const item = await OrderItem.findOne({
            where: { id: req.params.itemId, order_id: order.id },
            transaction: t,
        });
        if (!item) {
            await t.rollback();
            return res.status(404).json({ error: 'Item no encontrado' });
        }

        // Restaurar stock
        const product = await Product.findByPk(item.product_id, { transaction: t });
        if (product) {
            await product.update({ stock: product.stock + item.quantity }, { transaction: t });
        }

        await item.destroy({ transaction: t });

        const newTotal = parseFloat((parseFloat(order.total) - parseFloat(item.subtotal)).toFixed(2));
        await order.update({ total: Math.max(0, newTotal) }, { transaction: t });

        await t.commit();

        const updated = await Order.findByPk(order.id, {
            include: [{
                model: OrderItem, as: 'items',
                include: [{ model: Product, as: 'product', attributes: ['id', 'name', 'emoji', 'price'] }],
            }],
        });
        res.json(updated);
    } catch (error) {
        await t.rollback();
        console.error('Delete order item error:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// PUT /api/orders/:id/status
// Si status='cancelado', body puede incluir { employee_id, pin } para registrar en auditoría
router.put('/:id/status', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const { status, employee_id, pin } = req.body;

        if (!['registrado', 'completado', 'entregado', 'cancelado'].includes(status)) {
            return res.status(400).json({ error: 'Estado inválido. Use: registrado, completado, entregado o cancelado' });
        }

        const order = await Order.findOne({ where: { id: req.params.id, business_id: biz } });
        if (!order) {
            return res.status(404).json({ error: 'Pedido no encontrado' });
        }

        // Si se está cancelando con PIN: verificar y registrar en auditoría
        let authorizedEmployee = null;
        if (status === 'cancelado' && employee_id && pin) {
            try {
                authorizedEmployee = await verifyEmployeePin(employee_id, pin, biz);
            } catch (pinErr) {
                return res.status(403).json({ error: pinErr.message });
            }
        }

        const beforeStatus = order.status;
        await order.update({ status });

        if (authorizedEmployee && status === 'cancelado') {
            await PrivilegedActionLog.create({
                business_id: biz,
                branch_id: order.branch_id || null,
                employee_id: authorizedEmployee.id,
                employee_name: authorizedEmployee.name,
                action_type: 'cancel_order',
                target_description: `Pedido #${order.id}`,
                before_data: JSON.stringify({ id: order.id, status: beforeStatus, total: order.total }),
                after_data: JSON.stringify({ id: order.id, status: 'cancelado', total: order.total })
            });
        }

        res.json(order);
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// PUT /api/orders/:id
router.put('/:id', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const order = await Order.findOne({ where: { id: req.params.id, business_id: biz } });
        if (!order) {
            return res.status(404).json({ error: 'Pedido no encontrado' });
        }
        const { status, payment_method, order_type, reference, delivery_address, maps_link, notes } = req.body;
        if (status !== undefined && !['registrado', 'completado', 'entregado', 'cancelado'].includes(status)) {
            return res.status(400).json({ error: 'Estado inválido. Use: registrado, completado, entregado o cancelado' });
        }
        await order.update({ status, payment_method, order_type, reference, delivery_address, maps_link, notes });
        res.json(order);
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// DELETE /api/orders/:id
// Body opcional: { employee_id, pin } — si se proveen, se verifica el PIN y se registra en auditoría
router.delete('/:id', authenticate, async (req, res) => {
    const t = await sequelize.transaction();

    try {
        const biz = req.user.business_id;
        const { employee_id, pin } = req.body || {};

        // Verificar PIN si se proporcionó
        let authorizedEmployee = null;
        if (employee_id && pin) {
            try {
                authorizedEmployee = await verifyEmployeePin(employee_id, pin, biz);
            } catch (pinErr) {
                await t.rollback();
                return res.status(403).json({ error: pinErr.message });
            }
        }

        const order = await Order.findOne({
            where: { id: req.params.id, business_id: biz },
            include: [{ model: OrderItem, as: 'items' }],
            transaction: t
        });

        if (!order) {
            await t.rollback();
            return res.status(404).json({ error: 'Pedido no encontrado' });
        }

        // Capturar estado antes de la cancelación (para auditoría)
        const beforeData = {
            id: order.id,
            status: order.status,
            total: order.total,
            payment_method: order.payment_method,
            order_type: order.order_type
        };

        // Solo restaurar stock si el pedido no estaba ya cancelado (evita doble restauración)
        if (order.status !== 'cancelado') {
            for (const item of order.items) {
                const product = await Product.findByPk(item.product_id, { transaction: t });
                if (product) {
                    await product.update({ stock: product.stock + item.quantity }, { transaction: t });
                }
            }
        }

        await order.update({ status: 'cancelado' }, { transaction: t });

        // Registrar en auditoría si hubo autorización con PIN
        if (authorizedEmployee) {
            await PrivilegedActionLog.create({
                business_id: biz,
                branch_id: order.branch_id || null,
                employee_id: authorizedEmployee.id,
                employee_name: authorizedEmployee.name,
                action_type: 'cancel_order',
                target_description: `Pedido #${order.id}`,
                before_data: JSON.stringify(beforeData),
                after_data: JSON.stringify({ ...beforeData, status: 'cancelado' })
            }, { transaction: t });
        }

        await t.commit();
        res.json({ message: 'Pedido cancelado correctamente' });
    } catch (error) {
        await t.rollback();
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

module.exports = router;
