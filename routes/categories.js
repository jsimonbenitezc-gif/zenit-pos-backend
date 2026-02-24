const express = require('express');
const router = express.Router();
const { Category } = require('../models');
const { authenticate } = require('../middleware/auth');

// GET /api/categories
router.get('/', authenticate, async (req, res) => {
    try {
        const categories = await Category.findAll({
            order: [['name', 'ASC']]
        });
        res.json(categories);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST /api/categories
router.post('/', authenticate, async (req, res) => {
    try {
        const { name, emoji, image } = req.body;

        if (!name) {
            return res.status(400).json({ error: 'Name is required' });
        }

        const category = await Category.create({ name, emoji, image });
        res.status(201).json(category);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// PUT /api/categories/:id
router.put('/:id', authenticate, async (req, res) => {
    try {
        const category = await Category.findByPk(req.params.id);

        if (!category) {
            return res.status(404).json({ error: 'Category not found' });
        }

        const { name, emoji, image } = req.body;
        await category.update({ name, emoji, image });

        res.json(category);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// DELETE /api/categories/:id
router.delete('/:id', authenticate, async (req, res) => {
    try {
        const category = await Category.findByPk(req.params.id);

        if (!category) {
            return res.status(404).json({ error: 'Category not found' });
        }

        await category.destroy();
        res.json({ message: 'Category deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;