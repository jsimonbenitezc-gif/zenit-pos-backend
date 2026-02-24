const express = require('express');
const router = express.Router();
const { Product, Category } = require('../models');
const { authenticate, isOwner } = require('../middleware/auth');

// GET /api/products - Obtener todos los productos
router.get('/', authenticate, async (req, res) => {
    try {
        const { active, category_id } = req.query;
        
        const where = {};
        if (active !== undefined) where.active = active === 'true';
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
        res.status(500).json({ error: error.message });
    }
});

// GET /api/products/grouped - Productos agrupados por categoría
router.get('/grouped', authenticate, async (req, res) => {
    try {
        const categories = await Category.findAll({
            include: [{
                model: Product,
                as: 'products',
                where: { active: true },
                required: false
            }],
            order: [['name', 'ASC']]
        });

        // Productos sin categoría
        const uncategorized = await Product.findAll({
            where: { category_id: null, active: true }
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
        res.status(500).json({ error: error.message });
    }
});

// GET /api/products/:id - Obtener un producto
router.get('/:id', authenticate, async (req, res) => {
    try {
        const product = await Product.findByPk(req.params.id, {
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
        res.status(500).json({ error: error.message });
    }
});

// POST /api/products - Crear producto
router.post('/', authenticate, async (req, res) => {
    try {
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
            image
        });

        res.status(201).json(product);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// PUT /api/products/:id - Actualizar producto
router.put('/:id', authenticate, async (req, res) => {
    try {
        const product = await Product.findByPk(req.params.id);

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
        res.status(500).json({ error: error.message });
    }
});

// DELETE /api/products/:id - Eliminar producto
router.delete('/:id', authenticate, isOwner, async (req, res) => {
    try {
        const product = await Product.findByPk(req.params.id);

        if (!product) {
            return res.status(404).json({ error: 'Product not found' });
        }

        // Soft delete
        await product.update({ active: false });

        res.json({ message: 'Product deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;