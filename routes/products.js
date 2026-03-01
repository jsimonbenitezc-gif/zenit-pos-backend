const express = require('express');
const router = express.Router();
const { Product, Category } = require('../models');
const { authenticate, isOwner } = require('../middleware/auth');

// GET /api/products
router.get('/', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const { active, category_id } = req.query;

        const where = { business_id: biz };
        if (active !== undefined) where.active = active === 'true';
        else where.active = true;
        if (category_id) where.category_id = category_id;

        const products = await Product.findAll({
            where,
            include: [{
                model: Category,
                as: 'category',
                attributes: ['id', 'name', 'emoji']
            }],
            order: [['name', 'ASC']]
        });

        res.json(products);
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// GET /api/products/grouped
router.get('/grouped', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;

        const categories = await Category.findAll({
            where: { active: true, business_id: biz },
            include: [{
                model: Product,
                as: 'products',
                where: { active: true, business_id: biz },
                required: false
            }],
            order: [['name', 'ASC']]
        });

        const uncategorized = await Product.findAll({
            where: { category_id: null, active: true, business_id: biz }
        });

        const result = categories.map(cat => ({
            id: cat.id,
            nombre: cat.name,
            emoji: cat.emoji,
            image: cat.image,
            productos: cat.products.map(p => ({
                id: p.id,
                nombre: p.name,
                descripcion: p.description,
                precio: parseFloat(p.price),
                stock: p.stock,
                emoji: p.emoji,
                imagen: p.image,
                activo: p.active
            }))
        }));

        if (uncategorized.length > 0) {
            result.push({
                id: null,
                nombre: 'Sin categoría',
                emoji: '📦',
                productos: uncategorized.map(p => ({
                    id: p.id,
                    nombre: p.name,
                    descripcion: p.description,
                    precio: parseFloat(p.price),
                    stock: p.stock,
                    emoji: p.emoji,
                    imagen: p.image,
                    activo: p.active
                }))
            });
        }

        res.json(result);
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// GET /api/products/:id
router.get('/:id', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const product = await Product.findOne({
            where: { id: req.params.id, business_id: biz },
            include: [{
                model: Category,
                as: 'category',
                attributes: ['id', 'name', 'emoji']
            }]
        });
        if (!product) {
            return res.status(404).json({ error: 'Product not found' });
        }
        res.json(product);
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// POST /api/products
router.post('/', authenticate, isOwner, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const { name, description, price, stock, category_id, emoji, image } = req.body;
        if (!name || !price) {
            return res.status(400).json({ error: 'Name and price are required' });
        }
        const product = await Product.create({
            name,
            description,
            price,
            stock: stock || 0,
            category_id,
            emoji: emoji || '📦',
            image,
            business_id: biz
        });
        res.status(201).json(product);
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// PUT /api/products/:id
router.put('/:id', authenticate, isOwner, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const product = await Product.findOne({
            where: { id: req.params.id, business_id: biz }
        });
        if (!product) {
            return res.status(404).json({ error: 'Product not found' });
        }
        const { name, description, price, stock, category_id, emoji, image, active } = req.body;
        await product.update({
            name: name !== undefined ? name : product.name,
            description: description !== undefined ? description : product.description,
            price: price !== undefined ? price : product.price,
            stock: stock !== undefined ? stock : product.stock,
            category_id: category_id !== undefined ? category_id : product.category_id,
            emoji: emoji !== undefined ? emoji : product.emoji,
            image: image !== undefined ? image : product.image,
            active: active !== undefined ? active : product.active
        });
        res.json(product);
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// DELETE /api/products/:id
router.delete('/:id', authenticate, isOwner, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const product = await Product.findOne({
            where: { id: req.params.id, business_id: biz }
        });
        if (!product) {
            return res.status(404).json({ error: 'Product not found' });
        }
        await product.update({ active: false });
        res.json({ message: 'Product deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

module.exports = router;
