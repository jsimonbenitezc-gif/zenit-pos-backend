const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { User } = require('../models');
const { authenticate, isOwner, invalidarUsuario } = require('../middleware/auth');
const { Op } = require('sequelize');
const { paginate, paginatedResponse } = require('../utils/pagination');

// Genera un refresh token opaco y lo guarda hasheado en DB
async function generateAndSaveRefreshToken(user) {
    const refreshToken = crypto.randomBytes(64).toString('hex');
    const refreshTokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const refreshTokenExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await user.update({ refresh_token_hash: refreshTokenHash, refresh_token_expires: refreshTokenExpires });
    return refreshToken;
}

// Protección: máximo 10 intentos de login cada 15 minutos por IP
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: 'Demasiados intentos de inicio de sesión. Intenta de nuevo en 15 minutos.' },
    standardHeaders: true,
    legacyHeaders: false
});

// Protección: máximo 10 intentos de verificación de PIN por minuto por IP
const pinLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    message: { error: 'Demasiados intentos de verificación de PIN. Intenta de nuevo en un minuto.' },
    standardHeaders: true,
    legacyHeaders: false
});

// GET /api/staff — Listar todos los empleados del negocio
router.get('/', authenticate, isOwner, async (req, res) => {
    try {
        const { page, limit, offset } = paginate(req.query);
        const { count, rows } = await User.findAndCountAll({
            where: { business_id: req.user.id },
            attributes: ['id', 'name', 'username', 'role', 'active', 'createdAt'],
            limit,
            offset
        });
        res.json(paginatedResponse(rows, count, page, limit));
    } catch (error) {
        logger.error('Error al obtener empleados:', error);
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
        if (password.length < 8) {
            return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
        }

        const rolesValidos = ['cashier', 'waiter', 'delivery'];
        if (role && !rolesValidos.includes(role)) {
            return res.status(400).json({ error: 'El rol debe ser cashier, waiter o delivery' });
        }

        // Verificar que el username no esté en uso dentro del mismo negocio
        const existe = await User.findOne({ where: { username, business_id: req.user.id } });
        if (existe) {
            return res.status(409).json({ error: 'Ya existe un empleado con ese nombre de usuario en tu negocio' });
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
            { expiresIn: '15m' }
        );

        const refreshToken = await generateAndSaveRefreshToken(empleado);

        res.status(201).json({
            token,
            refreshToken,
            user: {
                id: empleado.id,
                name: empleado.name,
                username: empleado.username,
                role: empleado.role,
                business_id: req.user.id
            }
        });
    } catch (error) {
        logger.error('Error al crear empleado:', error);
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

        // El rol y el estado viven en el caché de `middleware/auth.js`: sin esto,
        // desactivar a un empleado tardaría hasta 30s en cortarle el acceso.
        invalidarUsuario(empleado.id);

        res.json({
            id: empleado.id,
            name: empleado.name,
            username: empleado.username,
            role: empleado.role,
            active: empleado.active
        });
    } catch (error) {
        logger.error('Error al actualizar empleado:', error);
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
        invalidarUsuario(empleado.id);   // corta el acceso al instante (ver caché en middleware/auth.js)
        res.json({ message: 'Empleado desactivado correctamente' });
    } catch (error) {
        logger.error('Error al eliminar empleado:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// POST /api/staff/verify-pin — Verificar PIN de un empleado sin crear token nuevo
// Recibe { employee_id, pin }. Requiere sesión activa. Útil para autorizar acciones sensibles.
router.post('/verify-pin', pinLimiter, authenticate, async (req, res) => {
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
        logger.error('Error en verify-pin:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// POST /api/staff/login — Login de empleado (genera token con business_id del dueño)
// Acepta { username, password, business_email? }
// business_email es el email del dueño — requerido si hay varios empleados con el mismo username
router.post('/login', loginLimiter, async (req, res) => {
    try {
        const { username, password, business_email } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: 'Usuario y contraseña son requeridos' });
        }

        let empleado;

        if (business_email) {
            // Buscar al dueño por su email (guardado como username del owner)
            const owner = await User.findOne({ where: { username: business_email, role: 'owner' } });
            if (!owner) {
                return res.status(401).json({ error: 'Credenciales incorrectas' });
            }
            empleado = await User.findOne({
                where: { username, business_id: owner.id, active: true }
            });
        } else {
            // Sin business_email: funciona si el username es único
            const matches = await User.findAll({
                where: { username, active: true, business_id: { [Op.ne]: null } }
            });
            if (matches.length === 1) {
                empleado = matches[0];
            } else if (matches.length > 1) {
                return res.status(400).json({
                    error: 'Hay varios empleados con ese usuario. Incluye el email del dueño (business_email) para identificar el negocio.',
                    require_business_email: true
                });
            }
        }

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
                business_id: empleado.business_id
            },
            process.env.JWT_SECRET,
            { expiresIn: '15m' }
        );

        const refreshToken = await generateAndSaveRefreshToken(empleado);

        res.json({
            token,
            refreshToken,
            user: {
                id: empleado.id,
                name: empleado.name,
                username: empleado.username,
                role: empleado.role,
                business_id: empleado.business_id
            }
        });
    } catch (error) {
        logger.error('Error en login de empleado:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

module.exports = router;
