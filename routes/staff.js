const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { User } = require('../models');
const { authenticate, isOwner } = require('../middleware/auth');

// Protección: máximo 10 intentos de login cada 15 minutos por IP
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: 'Demasiados intentos de inicio de sesión. Intenta de nuevo en 15 minutos.' },
    standardHeaders: true,
    legacyHeaders: false
});

// GET /api/staff — Listar todos los empleados del negocio
router.get('/', authenticate, isOwner, async (req, res) => {
    try {
        const staff = await User.findAll({
            where: { business_id: req.user.id },
            attributes: ['id', 'name', 'username', 'role', 'active', 'createdAt']
        });
        res.json(staff);
    } catch (error) {
        console.error('Error al obtener empleados:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// POST /api/staff — Crear un nuevo empleado
router.post('/', authenticate, isOwner, async (req, res) => {
    try {
        const { name, username, password, role } = req.body;

        if (!name || !username || !password) {
            return res.status(400).json({ error: 'Nombre, usuario y contraseña son requeridos' });
        }
        if (password.length < 6) {
            return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
        }

        const rolesValidos = ['cashier', 'waiter', 'delivery'];
        if (role && !rolesValidos.includes(role)) {
            return res.status(400).json({ error: 'El rol debe ser cashier, waiter o delivery' });
        }

        // Verificar que el username no esté en uso
        const existe = await User.findOne({ where: { username } });
        if (existe) {
            return res.status(409).json({ error: 'Ya existe un usuario con ese nombre de usuario' });
        }

        const empleado = await User.create({
            name,
            username,
            password,
            role: role || 'cashier',
            business_id: req.user.id  // Vinculado al dueño que lo crea
        });

        // Token para que el empleado pueda usar la app conectada
        const token = jwt.sign(
            {
                id: empleado.id,
                username: empleado.username,
                role: empleado.role,
                business_id: req.user.id  // business_id = el dueño, no el empleado
            },
            process.env.JWT_SECRET,
            { expiresIn: '30d' }
        );

        res.status(201).json({
            token,
            user: {
                id: empleado.id,
                name: empleado.name,
                username: empleado.username,
                role: empleado.role,
                business_id: req.user.id
            }
        });
    } catch (error) {
        console.error('Error al crear empleado:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// PUT /api/staff/:id — Actualizar datos de un empleado
router.put('/:id', authenticate, isOwner, async (req, res) => {
    try {
        const empleado = await User.findOne({
            where: { id: req.params.id, business_id: req.user.id }
        });
        if (!empleado) {
            return res.status(404).json({ error: 'Empleado no encontrado' });
        }

        const { name, password, role, active } = req.body;

        if (role) {
            const rolesValidos = ['cashier', 'waiter', 'delivery'];
            if (!rolesValidos.includes(role)) {
                return res.status(400).json({ error: 'El rol debe ser cashier, waiter o delivery' });
            }
        }

        await empleado.update({
            name: name !== undefined ? name : empleado.name,
            password: password || undefined, // Solo actualizar si se envía
            role: role !== undefined ? role : empleado.role,
            active: active !== undefined ? active : empleado.active
        });

        res.json({
            id: empleado.id,
            name: empleado.name,
            username: empleado.username,
            role: empleado.role,
            active: empleado.active
        });
    } catch (error) {
        console.error('Error al actualizar empleado:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// DELETE /api/staff/:id — Desactivar un empleado (soft delete)
router.delete('/:id', authenticate, isOwner, async (req, res) => {
    try {
        const empleado = await User.findOne({
            where: { id: req.params.id, business_id: req.user.id, active: true }
        });
        if (!empleado) {
            return res.status(404).json({ error: 'Empleado no encontrado' });
        }
        await empleado.update({ active: false });
        res.json({ message: 'Empleado desactivado correctamente' });
    } catch (error) {
        console.error('Error al eliminar empleado:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// POST /api/staff/verify-pin — Verificar PIN de un empleado sin crear token nuevo
// Recibe { employee_id, pin }. Requiere sesión activa. Útil para autorizar acciones sensibles.
router.post('/verify-pin', authenticate, async (req, res) => {
    try {
        const { employee_id, pin } = req.body;
        const biz = req.user.business_id;

        if (!employee_id || !pin) {
            return res.status(400).json({ error: 'employee_id y pin son requeridos' });
        }

        const employee = await User.findByPk(employee_id);

        // Verificar que el empleado pertenece al negocio (puede ser el dueño o un empleado)
        const perteneceAlNegocio =
            employee &&
            employee.active &&
            (employee.id === biz || employee.business_id === biz);

        if (!perteneceAlNegocio) {
            return res.json({ valid: false });
        }

        const valid = await employee.comparePassword(pin);
        res.json({
            valid,
            employee_name: valid ? employee.name : undefined
        });
    } catch (error) {
        console.error('Error en verify-pin:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// POST /api/staff/login — Login de empleado (genera token con business_id del dueño)
router.post('/login', loginLimiter, async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: 'Usuario y contraseña son requeridos' });
        }

        const empleado = await User.findOne({
            where: { username, active: true }
        });

        if (!empleado || !empleado.business_id) {
            return res.status(401).json({ error: 'Credenciales incorrectas' });
        }

        const valido = await empleado.comparePassword(password);
        if (!valido) {
            return res.status(401).json({ error: 'Credenciales incorrectas' });
        }

        const token = jwt.sign(
            {
                id: empleado.id,
                username: empleado.username,
                role: empleado.role,
                business_id: empleado.business_id  // Ver datos del negocio del dueño
            },
            process.env.JWT_SECRET,
            { expiresIn: '30d' }
        );

        res.json({
            token,
            user: {
                id: empleado.id,
                name: empleado.name,
                username: empleado.username,
                role: empleado.role,
                business_id: empleado.business_id
            }
        });
    } catch (error) {
        console.error('Error en login de empleado:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

module.exports = router;
