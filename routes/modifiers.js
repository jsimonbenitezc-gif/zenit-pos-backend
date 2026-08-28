// ============================================================================
// routes/modifiers.js — Biblioteca de modificadores (BLOQUE 11 V5)
//
// Los grupos son del NEGOCIO, no del producto: se configuran una vez ("Extras",
// "Tamaño") y se enganchan a los productos que los usan. Ver models/ModifierGroup.
//
// Configurar la biblioteca es del DUEÑO (`isOwner`): cambia lo que se le COBRA
// al cliente, igual que el impuesto (§29) y las propinas (§30). LEERLA la puede
// hacer cualquier puesto — el cajero necesita el catálogo para armar el carrito,
// y el desktop lo baja entero para poder vender sin internet.
// ============================================================================

const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const {
    ModifierGroup, ModifierOption, ProductModifierGroup, ModifierOptionRecipe,
    Product, Ingredient, Preparation, sequelize,
} = require('../models');
const { authenticate, isOwner } = require('../middleware/auth');
const { invalidarCatalogoModificadores, MAX_DELTA } = require('../utils/modificadores');

const NOMBRE_MAX = 60;
// Topes defensivos: una biblioteca se configura a mano, no se genera.
const MAX_GRUPOS = 100;
const MAX_OPCIONES_POR_GRUPO = 50;
const MAX_GRUPOS_POR_PRODUCTO = 20;

function nombreValido(valor) {
    return typeof valor === 'string' && valor.trim().length > 0 && valor.trim().length <= NOMBRE_MAX;
}

function entero(valor, porDefecto = 0) {
    const n = parseInt(valor);
    return Number.isInteger(n) ? n : porDefecto;
}

/**
 * `max_select`: null = sin límite. Se distingue de "no vino en el body"
 * a propósito — un grupo "Extras" sin tope es un caso normal.
 */
function normalizarMaxSelect(valor) {
    if (valor === null || valor === '' || valor === 'null') return null;
    const n = parseInt(valor);
    if (!Number.isInteger(n) || n < 1) return null;
    return Math.min(n, MAX_OPCIONES_POR_GRUPO);
}

// ── GET /api/modifiers ──────────────────────────────────────────────────────
// El catálogo entero en UNA llamada: grupos con sus opciones + qué producto usa
// qué grupo. Es lo que bajan el desktop (a su SQLite) y el mobile (a su caché)
// para poder armar un carrito con extras SIN internet.
//
// No lleva imágenes ni nada pesado (§23): son unas decenas de filas de texto.
router.get('/', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;

        const [grupos, enlaces] = await Promise.all([
            ModifierGroup.findAll({
                where: { business_id: biz, active: true },
                include: [{
                    model: ModifierOption,
                    as: 'options',
                    where: { active: true },
                    required: false,
                }],
                order: [['sort_order', 'ASC'], ['id', 'ASC']],
            }),
            ProductModifierGroup.findAll({
                where: { business_id: biz },
                order: [['sort_order', 'ASC'], ['id', 'ASC']],
            }),
        ]);

        res.json({
            groups: grupos.map(g => ({
                id: g.id,
                name: g.name,
                min_select: g.min_select,
                max_select: g.max_select === null ? null : parseInt(g.max_select),
                sort_order: g.sort_order,
                options: (g.options || [])
                    .slice()
                    .sort((a, b) => (a.sort_order - b.sort_order) || (a.id - b.id))
                    .map(o => ({
                        id: o.id,
                        group_id: o.group_id,
                        name: o.name,
                        price_delta: parseFloat(o.price_delta) || 0,
                        sort_order: o.sort_order,
                    })),
            })),
            product_groups: enlaces.map(e => ({
                product_id: e.product_id,
                group_id: e.group_id,
                sort_order: e.sort_order,
            })),
        });
    } catch (error) {
        logger.error('Listar modificadores:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ── GRUPOS ──────────────────────────────────────────────────────────────────

// POST /api/modifiers/groups
router.post('/groups', authenticate, isOwner, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const { name, min_select, max_select, sort_order } = req.body;

        if (!nombreValido(name)) {
            return res.status(400).json({ error: `El nombre del grupo es obligatorio (máximo ${NOMBRE_MAX} caracteres).` });
        }

        const cuantos = await ModifierGroup.count({ where: { business_id: biz, active: true } });
        if (cuantos >= MAX_GRUPOS) {
            return res.status(400).json({ error: `No puedes tener más de ${MAX_GRUPOS} grupos de modificadores.` });
        }

        const grupo = await ModifierGroup.create({
            business_id: biz,
            name: name.trim(),
            min_select: Math.max(0, entero(min_select, 0)),
            max_select: normalizarMaxSelect(max_select === undefined ? 1 : max_select),
            sort_order: entero(sort_order, 0),
        });

        invalidarCatalogoModificadores(biz);
        res.status(201).json(grupo);
    } catch (error) {
        logger.error('Crear grupo de modificadores:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// PUT /api/modifiers/groups/:id
router.put('/groups/:id', authenticate, isOwner, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const grupo = await ModifierGroup.findOne({ where: { id: req.params.id, business_id: biz } });
        if (!grupo) return res.status(404).json({ error: 'Grupo no encontrado' });

        const { name, min_select, max_select, sort_order, active } = req.body;
        if (name !== undefined && !nombreValido(name)) {
            return res.status(400).json({ error: `El nombre del grupo es obligatorio (máximo ${NOMBRE_MAX} caracteres).` });
        }

        await grupo.update({
            name: name !== undefined ? name.trim() : grupo.name,
            min_select: min_select !== undefined ? Math.max(0, entero(min_select, 0)) : grupo.min_select,
            max_select: max_select !== undefined ? normalizarMaxSelect(max_select) : grupo.max_select,
            sort_order: sort_order !== undefined ? entero(sort_order, 0) : grupo.sort_order,
            active: active !== undefined ? Boolean(active) : grupo.active,
        });

        invalidarCatalogoModificadores(biz);
        res.json(grupo);
    } catch (error) {
        logger.error('Actualizar grupo de modificadores:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// DELETE /api/modifiers/groups/:id
// Borrado SUAVE, como los productos: los pedidos viejos guardan el nombre y el
// precio congelados (§ modificadores), así que borrarlo de verdad no rompería
// ningún ticket — pero desactivar permite recuperarlo y deja el historial de la
// biblioteca intacto.
router.delete('/groups/:id', authenticate, isOwner, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const grupo = await ModifierGroup.findOne({ where: { id: req.params.id, business_id: biz } });
        if (!grupo) return res.status(404).json({ error: 'Grupo no encontrado' });

        await grupo.update({ active: false });
        // Se sueltan los productos: si el grupo vuelve a activarse, el dueño
        // decide otra vez a qué se engancha. Dejar enlaces colgando de un grupo
        // inactivo produce menús que reaparecen solos.
        await ProductModifierGroup.destroy({ where: { group_id: grupo.id, business_id: biz } });

        invalidarCatalogoModificadores(biz);
        res.json({ message: 'Grupo eliminado correctamente' });
    } catch (error) {
        logger.error('Eliminar grupo de modificadores:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ── OPCIONES ────────────────────────────────────────────────────────────────

// POST /api/modifiers/groups/:id/options
router.post('/groups/:id/options', authenticate, isOwner, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const grupo = await ModifierGroup.findOne({ where: { id: req.params.id, business_id: biz } });
        if (!grupo) return res.status(404).json({ error: 'Grupo no encontrado' });

        const { name, price_delta, sort_order } = req.body;
        if (!nombreValido(name)) {
            return res.status(400).json({ error: `El nombre de la opción es obligatorio (máximo ${NOMBRE_MAX} caracteres).` });
        }

        // El delta SÍ se valida duro: es dinero que se le cobra al cliente, y un
        // valor basura cobraría de más en cada venta (mismo criterio que la tasa
        // del impuesto, §29, que responde 400 en vez de caer a un default).
        const delta = parseFloat(price_delta === undefined || price_delta === '' ? 0 : price_delta);
        if (!Number.isFinite(delta) || Math.abs(delta) > MAX_DELTA) {
            return res.status(400).json({ error: 'El precio del modificador no es válido.' });
        }

        const cuantas = await ModifierOption.count({ where: { group_id: grupo.id, active: true } });
        if (cuantas >= MAX_OPCIONES_POR_GRUPO) {
            return res.status(400).json({ error: `Un grupo no puede tener más de ${MAX_OPCIONES_POR_GRUPO} opciones.` });
        }

        const opcion = await ModifierOption.create({
            group_id: grupo.id,
            business_id: biz,
            name: name.trim(),
            price_delta: parseFloat(delta.toFixed(2)),
            sort_order: entero(sort_order, 0),
        });

        invalidarCatalogoModificadores(biz);
        res.status(201).json(opcion);
    } catch (error) {
        logger.error('Crear opción de modificador:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// PUT /api/modifiers/options/:id
router.put('/options/:id', authenticate, isOwner, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const opcion = await ModifierOption.findOne({ where: { id: req.params.id, business_id: biz } });
        if (!opcion) return res.status(404).json({ error: 'Opción no encontrada' });

        const { name, price_delta, sort_order, active } = req.body;
        if (name !== undefined && !nombreValido(name)) {
            return res.status(400).json({ error: `El nombre de la opción es obligatorio (máximo ${NOMBRE_MAX} caracteres).` });
        }

        let delta = opcion.price_delta;
        if (price_delta !== undefined) {
            const n = parseFloat(price_delta === '' ? 0 : price_delta);
            if (!Number.isFinite(n) || Math.abs(n) > MAX_DELTA) {
                return res.status(400).json({ error: 'El precio del modificador no es válido.' });
            }
            delta = parseFloat(n.toFixed(2));
        }

        await opcion.update({
            name: name !== undefined ? name.trim() : opcion.name,
            price_delta: delta,
            sort_order: sort_order !== undefined ? entero(sort_order, 0) : opcion.sort_order,
            active: active !== undefined ? Boolean(active) : opcion.active,
        });

        invalidarCatalogoModificadores(biz);
        res.json(opcion);
    } catch (error) {
        logger.error('Actualizar opción de modificador:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// DELETE /api/modifiers/options/:id
router.delete('/options/:id', authenticate, isOwner, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const opcion = await ModifierOption.findOne({ where: { id: req.params.id, business_id: biz } });
        if (!opcion) return res.status(404).json({ error: 'Opción no encontrada' });

        await opcion.update({ active: false });
        invalidarCatalogoModificadores(biz);
        res.json({ message: 'Opción eliminada correctamente' });
    } catch (error) {
        logger.error('Eliminar opción de modificador:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ── AJUSTE DE RECETA DE UNA OPCIÓN ──────────────────────────────────────────
// Qué insumos agrega o quita la opción. `quantity` NEGATIVA devuelve al
// inventario lo que la receta base ya descontó ("sin cebolla").
//
// No lleva `requirePremium`: quien no tiene inventario simplemente no tiene
// insumos que enganchar, y gatearlo dejaría al dueño premium que se pasa a free
// sin poder ver lo que ya configuró.

// GET /api/modifiers/options/:id/recipe
router.get('/options/:id/recipe', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const opcion = await ModifierOption.findOne({ where: { id: req.params.id, business_id: biz } });
        if (!opcion) return res.status(404).json({ error: 'Opción no encontrada' });

        const receta = await ModifierOptionRecipe.findAll({ where: { option_id: opcion.id } });
        const enriquecida = await Promise.all(receta.map(async (item) => {
            const modelo = item.item_type === 'ingredient' ? Ingredient : Preparation;
            const ref = await modelo.findByPk(item.item_id, { attributes: ['id', 'name'] });
            return {
                id: item.id,
                item_type: item.item_type,
                item_id: item.item_id,
                name: ref ? ref.name : null,
                quantity: parseFloat(item.quantity),
                unit_recipe: item.unit_recipe,
            };
        }));
        res.json(enriquecida);
    } catch (error) {
        logger.error('Leer receta de opción:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// POST /api/modifiers/options/:id/recipe — reemplaza la receta completa
router.post('/options/:id/recipe', authenticate, isOwner, async (req, res) => {
    const t = await sequelize.transaction();
    try {
        const biz = req.user.business_id;
        const opcion = await ModifierOption.findOne({
            where: { id: req.params.id, business_id: biz },
            transaction: t,
        });
        if (!opcion) {
            await t.rollback();
            return res.status(404).json({ error: 'Opción no encontrada' });
        }

        const items = Array.isArray(req.body.items) ? req.body.items : [];
        if (items.length > 50) {
            await t.rollback();
            return res.status(400).json({ error: 'Una opción no puede ajustar más de 50 insumos.' });
        }

        await ModifierOptionRecipe.destroy({ where: { option_id: opcion.id }, transaction: t });

        for (const item of items) {
            const tipo = item.item_type === 'preparation' ? 'preparation' : 'ingredient';
            const itemId = parseInt(item.item_id);
            const cantidad = parseFloat(item.quantity);
            // 0 no ajusta nada: se descarta en vez de guardar filas inertes.
            if (!Number.isInteger(itemId) || !Number.isFinite(cantidad) || cantidad === 0) continue;

            const modelo = tipo === 'ingredient' ? Ingredient : Preparation;
            const ref = await modelo.findOne({ where: { id: itemId, business_id: biz }, transaction: t });
            if (!ref) {
                await t.rollback();
                return res.status(404).json({ error: `El insumo ${itemId} no existe en este negocio.` });
            }

            await ModifierOptionRecipe.create({
                option_id: opcion.id,
                business_id: biz,
                item_type: tipo,
                item_id: itemId,
                quantity: cantidad,
                unit_recipe: item.unit_recipe || null,
            }, { transaction: t });
        }

        await t.commit();
        res.json({ message: 'Receta del modificador guardada' });
    } catch (error) {
        await t.rollback();
        logger.error('Guardar receta de opción:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ── ENGANCHAR GRUPOS A UN PRODUCTO ──────────────────────────────────────────

// GET /api/modifiers/products/:id — qué grupos usa este producto
router.get('/products/:id', authenticate, async (req, res) => {
    try {
        const biz = req.user.business_id;
        const enlaces = await ProductModifierGroup.findAll({
            where: { product_id: req.params.id, business_id: biz },
            order: [['sort_order', 'ASC'], ['id', 'ASC']],
        });
        res.json(enlaces.map(e => ({ group_id: e.group_id, sort_order: e.sort_order })));
    } catch (error) {
        logger.error('Leer modificadores de producto:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// PUT /api/modifiers/products/:id — reemplaza la lista completa
// Body: { group_ids: [3, 7] } en el orden en que se le muestran al cajero.
router.put('/products/:id', authenticate, isOwner, async (req, res) => {
    const t = await sequelize.transaction();
    try {
        const biz = req.user.business_id;
        const producto = await Product.findOne({
            where: { id: req.params.id, business_id: biz },
            transaction: t,
        });
        if (!producto) {
            await t.rollback();
            return res.status(404).json({ error: 'Producto no encontrado' });
        }

        const ids = Array.isArray(req.body.group_ids)
            ? [...new Set(req.body.group_ids.map(n => parseInt(n)).filter(Number.isInteger))]
            : [];
        if (ids.length > MAX_GRUPOS_POR_PRODUCTO) {
            await t.rollback();
            return res.status(400).json({ error: `Un producto no puede usar más de ${MAX_GRUPOS_POR_PRODUCTO} grupos.` });
        }

        // Todos los grupos deben ser del negocio: si no, un id ajeno metería en
        // el menú opciones de otro negocio.
        const grupos = await ModifierGroup.findAll({
            where: { id: ids, business_id: biz, active: true },
            transaction: t,
        });
        if (grupos.length !== ids.length) {
            await t.rollback();
            return res.status(404).json({ error: 'Alguno de los grupos no existe en este negocio.' });
        }

        await ProductModifierGroup.destroy({
            where: { product_id: producto.id, business_id: biz },
            transaction: t,
        });
        for (let i = 0; i < ids.length; i++) {
            await ProductModifierGroup.create({
                product_id: producto.id,
                group_id: ids[i],
                business_id: biz,
                sort_order: i,
            }, { transaction: t });
        }

        await t.commit();
        invalidarCatalogoModificadores(biz);
        res.json({ message: 'Modificadores del producto actualizados', group_ids: ids });
    } catch (error) {
        await t.rollback();
        logger.error('Guardar modificadores de producto:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

module.exports = router;
