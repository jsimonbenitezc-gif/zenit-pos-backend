const express = require('express');
const router = express.Router();
const { Category } = require('../models');
const { authenticate, isOwner } = require('../middleware/auth');

// GET /api/categories
router.get('/', authenticate, async (req, res) => {
    try {
        const categories = await Category.findAll({
            where: { active: true },
            order: [['name', 'ASC']]
        });
        res.json(categories);
    } catch (error) {
        console.error('Error al obtener categorías:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// GET /api/categories/:id
router.get('/:id', authenticate, async (req, res) => {
    try {
        const category = await Category.findOne({
            where: { id: req.params.id, active: true }
        });

        if (!category) {
            return res.status(404).json({ error: 'Category not found' });
        }

        res.json(category);
    } catch (error) {
        console.error('Error al obtener categoría:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// POST /api/categories
router.post('/', authenticate, isOwner, async (req, res) => {
    try {
        const { name, emoji, image } = req.body;

        if (!name) {
            return res.status(400).json({ error: 'Name is required' });
        }

        const category = await Category.create({ name, emoji, image });
        res.status(201).json(category);
    } catch (error) {
        console.error('Error al crear categoría:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// PUT /api/categories/:id
router.put('/:id', authenticate, isOwner, async (req, res) => {
    try {
        const category = await Category.findOne({
            where: { id: req.params.id, active: true }
        });

        if (!category) {
            return res.status(404).json({ error: 'Category not found' });
        }

        const { name, emoji, image } = req.body;
        await category.update({ name, emoji, image });

        res.json(category);
    } catch (error) {
        console.error('Error al actualizar categoría:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// DELETE /api/categories/:id - Soft delete (oculta la categoría, no la borra)
router.delete('/:id', authenticate, isOwner, async (req, res) => {
    try {
        const category = await Category.findOne({
            where: { id: req.params.id, active: true }
        });

        if (!category) {
            return res.status(404).json({ error: 'Category not found' });
        }

        await category.update({ active: false });
        res.json({ message: 'Category deleted successfully' });
    } catch (error) {
        console.error('Error al eliminar categoría:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

module.exports = router;
