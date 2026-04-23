const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { Category } = require('../models');
const { authenticate, isOwner } = require('../middleware/auth');

// GET /api/categories
router.get('/', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const categories = await Category.findAll({
            where: { active: true, business_id: biz },
            order: [['name', 'ASC']]
        });
        res.json(categories);
    } catch (error) {
        logger.error('Error al obtener categorías:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// GET /api/categories/:id
router.get('/:id', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const category = await Category.findOne({
            where: { id: req.params.id, active: true, business_id: biz }
        });
        if (!category) {
            return res.status(404).json({ error: 'Categoría no encontrada' });
        }
        res.json(category);
    } catch (error) {
        logger.error('Error al obtener categoría:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// POST /api/categories
router.post('/', authenticate, isOwner, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const { name, emoji, image } = req.body;
        if (!name) {
            return res.status(400).json({ error: 'El nombre es requerido' });
        }
        const category = await Category.create({ name, emoji, image, business_id: biz });
        res.status(201).json(category);
    } catch (error) {
        if (error.name === 'SequelizeUniqueConstraintError' || (error.original && error.original.constraint === 'uq_categories_business_name')) {
            return res.status(409).json({ error: 'Ya existe una categoría con ese nombre' });
        }
        logger.error('Error al crear categoría:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// PUT /api/categories/:id
router.put('/:id', authenticate, isOwner, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const category = await Category.findOne({
            where: { id: req.params.id, active: true, business_id: biz }
        });
        if (!category) {
            return res.status(404).json({ error: 'Categoría no encontrada' });
        }
        const { name, emoji, image } = req.body;
        await category.update({ name, emoji, image });
        res.json(category);
    } catch (error) {
        if (error.name === 'SequelizeUniqueConstraintError' || (error.original && error.original.constraint === 'uq_categories_business_name')) {
            return res.status(409).json({ error: 'Ya existe una categoría con ese nombre' });
        }
        logger.error('Error al actualizar categoría:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// DELETE /api/categories/:id
router.delete('/:id', authenticate, isOwner, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const category = await Category.findOne({
            where: { id: req.params.id, active: true, business_id: biz }
        });
        if (!category) {
            return res.status(404).json({ error: 'Categoría no encontrada' });
        }
        await category.update({ active: false });
        res.json({ message: 'Categoría eliminada correctamente' });
    } catch (error) {
        logger.error('Error al eliminar categoría:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

module.exports = router;
