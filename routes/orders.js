const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { Order, OrderItem, OrderPayment, Product, Customer, Table, ProductRecipe, Ingredient, Preparation, PreparationItem, PrivilegedActionLog, User, Discount, ModifierOptionRecipe, sequelize } = require('../models');
const { authenticate } = require('../middleware/auth');
const { autorizarAccionPrivilegiada } = require('../utils/verifyPin');
const { resolverBranchId, BranchError } = require('../utils/branch');
const {
    resolverFechaVenta, resolverPrecioUnitario, precioDifiere,
    MAXIMO_ATRASO_IMPORTACION_MS,
} = require('../utils/ventaOffline');
const { desglosar, baseParaRecalcular, resolverImpuestoVenta, configImpuestoNegocio } = require('../utils/impuestos');
const { resolverPropina, configPropinasNegocio } = require('../utils/propinas');
const { resolverPagos } = require('../utils/pagos');
const {
    resolverModificadores, catalogoModificadores, precioConModificadores, leerModificadores,
} = require('../utils/modificadores');
const { convertirParaInsumo } = require('../utils/unidades');
const { fraccionDeTanda } = require('../utils/preparaciones');
const { leerStockSucursal, escribirStockSucursal } = require('../utils/branchStock');
const { evaluarHorario, avisarFueraDeHorario } = require('../utils/horarios');
const { Op } = require('sequelize');
const { notificarAudit } = require('./audit');
const { enviarNotificacion, getPrefs } = require('../utils/push');
const { notificarInventario } = require('./inventory');
const { configurarSSE } = require('../utils/sse');
const rateLimit = require('express-rate-limit');

// Protección: máximo 60 pedidos por minuto por IP
const createOrderLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    message: { error: 'Demasiadas solicitudes de creación de pedidos. Intenta de nuevo en un minuto.' },
    standardHeaders: true,
    legacyHeaders: false
});

// ── SSE: notificaciones en tiempo real de cambios en pedidos/mesas ─────────────
const _ordersClients = new Map(); // businessId → Set<Response>

function notificarOrders(businessId) {
    const clients = _ordersClients.get(String(businessId));
    if (!clients || clients.size === 0) return;
    const msg = `data: {}\n\n`;
    for (const res of clients) {
        if (res.writableEnded) { clients.delete(res); continue; }
        try { res.write(msg); } catch { clients.delete(res); }
    }
}

router.get('/events', (req, res) => {
    configurarSSE(_ordersClients, req, res);
});

// Los factores de conversión viven en utils/unidades.js (BLOQUE 12): estaban
// duplicados aquí y en routes/inventory.js. Este envoltorio se queda porque
// todas las llamadas de este archivo pasan el INGREDIENTE, no su unidad.
//
// ⚠️ Y ese "no su unidad" era justo lo que faltaba (§45): el envoltorio TIRABA el
// ingrediente y solo pasaba `ingrediente.unit`, así que el contenido del paquete
// —lo único que sabe que una bolsa trae 50 g— nunca llegaba a la cuenta. Los diez
// sitios de este archivo ya pasaban el ingrediente entero; bastaba con no tirarlo.
function convertirUnidad(cantidad, unidadReceta, ingrediente) {
    return convertirParaInsumo(cantidad, unidadReceta, ingrediente);
}

// Stock por sucursal: UNA sola fuente, la tabla `branch_stocks` (deuda §12.1).
// La lógica vive en utils/branchStock.js; aquí solo quedan los nombres con los que
// la llama todo este archivo. El JSON legado ya no se lee ni se escribe.
const getBranchStock = leerStockSucursal;
const setBranchStock = escribirStockSucursal;

// Descuenta ingredientes según la receta del producto al registrar una venta
async function descontarIngredientesDeReceta(productId, qty, t, branchId = null) {
    const recetaItems = await ProductRecipe.findAll({ where: { product_id: productId }, transaction: t });
    if (!recetaItems.length) return;

    for (const item of recetaItems) {
        if (item.item_type === 'ingredient') {
            const ingrediente = await Ingredient.findByPk(item.item_id, { transaction: t, lock: t.LOCK.UPDATE });
            if (!ingrediente) continue;
            const cantDescontar = convertirUnidad(parseFloat(item.quantity), item.unit_recipe, ingrediente) * qty;
            const stockActual = await getBranchStock(ingrediente, branchId, t);
            await setBranchStock(ingrediente, branchId, Math.max(0, stockActual - cantDescontar), t);

        } else if (item.item_type === 'preparation') {
            const prepItems = await PreparationItem.findAll({
                where: { preparation_id: item.item_id },
                include: [{ model: Ingredient, as: 'ingredient' }],
                transaction: t,
                // Bloquear solo preparation_items: Postgres no permite FOR UPDATE
                // sobre el lado nullable (ingredients) de un LEFT OUTER JOIN.
                lock: { level: t.LOCK.UPDATE, of: PreparationItem }
            });
            const prep = await Preparation.findByPk(item.item_id, { transaction: t });
                // El rinde manda: "0.5 de una salsa que rinde 4" consume 1/8
                // de la tanda, no media tanda entera (ver utils/preparaciones.js).
            const cantPrep = fraccionDeTanda(item.quantity, prep) * qty;
            for (const pi of prepItems) {
                if (!pi.ingredient) continue;
                const cantDescontar = convertirUnidad(parseFloat(pi.quantity), pi.unit_recipe, pi.ingredient) * cantPrep;
                const stockActual = await getBranchStock(pi.ingredient, branchId, t);
                await setBranchStock(pi.ingredient, branchId, Math.max(0, stockActual - cantDescontar), t);
            }
        }
    }
}

// ── MODIFICADORES E INVENTARIO (BLOQUE 11) ───────────────────────────────────
// Un modificador puede AGREGAR insumos ("extra queso": +30 g) o QUITARLOS
// ("sin cebolla": −20 g, que devuelve lo que la receta base ya descontó).
//
// Por eso todo se expresa como un DELTA con signo y una sola fórmula sirve para
// los dos casos y para los dos sentidos:
//     vender    → stock − delta
//     cancelar  → stock + delta
// Con `quantity` negativa, "vender" suma y "cancelar" resta, que es exactamente
// lo que debe pasar. Sin la parte negativa, el inventario seguiría descontando
// la cebolla que nunca salió de la cocina.
//
// `signo`: -1 al vender, +1 al cancelar.
async function aplicarRecetaDeModificadores(modificadores, qty, t, branchId, signo) {
    if (!Array.isArray(modificadores) || modificadores.length === 0) return;

    const optionIds = modificadores
        .map(m => parseInt(m && m.option_id))
        .filter(id => Number.isInteger(id) && id > 0);
    if (optionIds.length === 0) return;

    const ajustes = await ModifierOptionRecipe.findAll({
        where: { option_id: optionIds },
        transaction: t,
    });
    if (!ajustes.length) return;

    for (const ajuste of ajustes) {
        // Una opción elegida DOS veces en el mismo renglón ajusta dos veces.
        const veces = optionIds.filter(id => id === ajuste.option_id).length;

        if (ajuste.item_type === 'ingredient') {
            const ingrediente = await Ingredient.findByPk(ajuste.item_id, { transaction: t, lock: t.LOCK.UPDATE });
            if (!ingrediente) continue;
            const delta = convertirUnidad(parseFloat(ajuste.quantity), ajuste.unit_recipe, ingrediente) * qty * veces;
            const stockActual = await getBranchStock(ingrediente, branchId, t);
            await setBranchStock(ingrediente, branchId, Math.max(0, stockActual + signo * delta), t);

        } else if (ajuste.item_type === 'preparation') {
            const prepItems = await PreparationItem.findAll({
                where: { preparation_id: ajuste.item_id },
                include: [{ model: Ingredient, as: 'ingredient' }],
                transaction: t,
                // Postgres no permite FOR UPDATE sobre el lado nullable de un
                // OUTER JOIN: se bloquea solo preparation_items (§19.25).
                lock: { level: t.LOCK.UPDATE, of: PreparationItem },
            });
            const prep = await Preparation.findByPk(ajuste.item_id, { transaction: t });
            const cantPrep = fraccionDeTanda(ajuste.quantity, prep) * qty * veces;
            for (const pi of prepItems) {
                if (!pi.ingredient) continue;
                const delta = convertirUnidad(parseFloat(pi.quantity), pi.unit_recipe, pi.ingredient) * cantPrep;
                const stockActual = await getBranchStock(pi.ingredient, branchId, t);
                await setBranchStock(pi.ingredient, branchId, Math.max(0, stockActual + signo * delta), t);
            }
        }
    }
}

// Suma al mapa de requerimientos lo que los modificadores agregan o quitan.
// Un delta NEGATIVO baja el requerimiento, así que "sin cebolla" no dispara una
// alerta de cebolla que el plato ya no lleva.
async function acumularRequerimientosDeModificadores(modificadores, qty, requerimientos, t) {
    if (!Array.isArray(modificadores) || modificadores.length === 0) return;

    const optionIds = modificadores
        .map(m => parseInt(m && m.option_id))
        .filter(id => Number.isInteger(id) && id > 0);
    if (optionIds.length === 0) return;

    const ajustes = await ModifierOptionRecipe.findAll({ where: { option_id: optionIds }, transaction: t });

    for (const ajuste of ajustes) {
        const veces = optionIds.filter(id => id === ajuste.option_id).length;

        if (ajuste.item_type === 'ingredient') {
            const ingrediente = await Ingredient.findByPk(ajuste.item_id, { transaction: t });
            if (!ingrediente) continue;
            const cantReq = convertirUnidad(parseFloat(ajuste.quantity), ajuste.unit_recipe, ingrediente) * qty * veces;
            const existente = requerimientos.get(ingrediente.id);
            if (existente) existente.required += cantReq;
            else requerimientos.set(ingrediente.id, { ingredient: ingrediente, required: cantReq });

        } else if (ajuste.item_type === 'preparation') {
            const prepItems = await PreparationItem.findAll({
                where: { preparation_id: ajuste.item_id },
                include: [{ model: Ingredient, as: 'ingredient' }],
                transaction: t,
            });
            const prep = await Preparation.findByPk(ajuste.item_id, { transaction: t });
            const cantPrep = fraccionDeTanda(ajuste.quantity, prep) * qty * veces;
            for (const pi of prepItems) {
                if (!pi.ingredient) continue;
                const cantReq = convertirUnidad(parseFloat(pi.quantity), pi.unit_recipe, pi.ingredient) * cantPrep;
                const existente = requerimientos.get(pi.ingredient.id);
                if (existente) existente.required += cantReq;
                else requerimientos.set(pi.ingredient.id, { ingredient: pi.ingredient, required: cantReq });
            }
        }
    }
}

// Agrega recursivamente los requerimientos de ingredientes de un producto al mapa acumulador
async function acumularRequerimientosDeProducto(productId, qty, requerimientos, t) {
    const recetaItems = await ProductRecipe.findAll({ where: { product_id: productId }, transaction: t });
    if (!recetaItems.length) return;

    for (const item of recetaItems) {
        if (item.item_type === 'ingredient') {
            const ingrediente = await Ingredient.findByPk(item.item_id, { transaction: t });
            if (!ingrediente) continue;
            const cantReq = convertirUnidad(parseFloat(item.quantity), item.unit_recipe, ingrediente) * qty;
            const existente = requerimientos.get(ingrediente.id);
            if (existente) {
                existente.required += cantReq;
            } else {
                requerimientos.set(ingrediente.id, { ingredient: ingrediente, required: cantReq });
            }
        } else if (item.item_type === 'preparation') {
            const prepItems = await PreparationItem.findAll({
                where: { preparation_id: item.item_id },
                include: [{ model: Ingredient, as: 'ingredient' }],
                transaction: t
            });
            const prep = await Preparation.findByPk(item.item_id, { transaction: t });
            const cantPrep = fraccionDeTanda(item.quantity, prep) * qty;
            for (const pi of prepItems) {
                if (!pi.ingredient) continue;
                const cantReq = convertirUnidad(parseFloat(pi.quantity), pi.unit_recipe, pi.ingredient) * cantPrep;
                const existente = requerimientos.get(pi.ingredient.id);
                if (existente) {
                    existente.required += cantReq;
                } else {
                    requerimientos.set(pi.ingredient.id, { ingredient: pi.ingredient, required: cantReq });
                }
            }
        }
    }
}

// Valida que haya stock suficiente para todos los items del pedido.
// Retorna un array de warnings con los ingredientes insuficientes. Vacío = stock OK.
async function validarStockIngredientes(resolvedItems, branchId, t) {
    const requerimientos = new Map();
    for (const { product, qty, modificadores } of resolvedItems) {
        await acumularRequerimientosDeProducto(product.id, qty, requerimientos, t);
        // Los extras cuentan para el aviso de stock: pedir 20 hamburguesas con
        // doble queso necesita el doble de queso que la receta base.
        await acumularRequerimientosDeModificadores(modificadores, qty, requerimientos, t);
    }

    const warnings = [];
    for (const { ingredient, required } of requerimientos.values()) {
        const available = await getBranchStock(ingredient, branchId, t);
        if (available < required) {
            warnings.push({
                ingredient_id: ingredient.id,
                ingredient: ingredient.name,
                unit: ingredient.unit,
                available: parseFloat(available.toFixed(4)),
                required: parseFloat(required.toFixed(4))
            });
        }
    }
    return warnings;
}

async function restaurarIngredientesDeReceta(productId, qty, t, branchId = null) {
    const recetaItems = await ProductRecipe.findAll({ where: { product_id: productId }, transaction: t });
    if (!recetaItems.length) return;

    for (const item of recetaItems) {
        if (item.item_type === 'ingredient') {
            const ingrediente = await Ingredient.findByPk(item.item_id, { transaction: t, lock: t.LOCK.UPDATE });
            if (!ingrediente) continue;
            const cantRestaurar = convertirUnidad(parseFloat(item.quantity), item.unit_recipe, ingrediente) * qty;
            const stockActual = await getBranchStock(ingrediente, branchId, t);
            await setBranchStock(ingrediente, branchId, stockActual + cantRestaurar, t);

        } else if (item.item_type === 'preparation') {
            const prepItems = await PreparationItem.findAll({
                where: { preparation_id: item.item_id },
                include: [{ model: Ingredient, as: 'ingredient' }],
                transaction: t,
                // Bloquear solo preparation_items: Postgres no permite FOR UPDATE
                // sobre el lado nullable (ingredients) de un LEFT OUTER JOIN.
                lock: { level: t.LOCK.UPDATE, of: PreparationItem }
            });
            const prep = await Preparation.findByPk(item.item_id, { transaction: t });
            // MISMO factor que al descontar, o restaurar devolvería otra cantidad.
            const cantPrep = fraccionDeTanda(item.quantity, prep) * qty;
            for (const pi of prepItems) {
                if (!pi.ingredient) continue;
                const cantRestaurar = convertirUnidad(parseFloat(pi.quantity), pi.unit_recipe, pi.ingredient) * cantPrep;
                const stockActual = await getBranchStock(pi.ingredient, branchId, t);
                await setBranchStock(pi.ingredient, branchId, stockActual + cantRestaurar, t);
            }
        }
    }
}

// Notificaciones push tras una venta (stock bajo / venta grande).
// Corre en segundo plano: no debe bloquear la respuesta del POS.
async function procesarNotificacionesVenta(biz, resolvedItems, branchId, finalTotal, paymentMethod) {
    const prefs = await getPrefs(biz);

    if (prefs.notif_stock_cero !== false) {
        const ingNotificados = new Set();
        for (const { product } of resolvedItems) {
            const recetaItems = await ProductRecipe.findAll({ where: { product_id: product.id } });
            for (const ri of recetaItems) {
                if (ri.item_type === 'ingredient' && !ingNotificados.has(ri.item_id)) {
                    const ing = await Ingredient.findByPk(ri.item_id, { attributes: ['id', 'name', 'stock', 'min_stock', 'business_id'] });
                    if (!ing) continue;
                    const stockActual = await getBranchStock(ing, branchId);
                    const minStock = parseFloat(ing.min_stock) || 0;
                    if (stockActual <= minStock && minStock > 0) {
                        ingNotificados.add(ri.item_id);
                        enviarNotificacion(
                            biz,
                            null,
                            '⚠️ Insumo con stock bajo',
                            `"${ing.name}" tiene ${stockActual.toFixed(1)} (mínimo: ${minStock})`
                        );
                    }
                }
            }
        }
    }

    const umbralVenta = parseFloat(prefs.notif_venta_grande_umbral ?? 500);
    if (prefs.notif_venta_grande !== false && finalTotal >= umbralVenta) {
        enviarNotificacion(
            biz,
            null,
            '💰 Venta grande registrada',
            `$${finalTotal.toFixed(2)} · ${resolvedItems.length} producto(s) · ${paymentMethod || 'efectivo'}`
        );
    }
}

// Carga un pedido con sus relaciones para la respuesta del POS (mismo shape
// para la creación normal y para las respuestas idempotentes).
// ⚠️ SIN `image`: las fotos son data-URIs base64 en columnas TEXT y engordan la
// respuesta de cada venta sin que ningún cliente las use aquí (ver §23 de CLAUDE.md).
function cargarPedidoCompleto(orderId) {
    return Order.findByPk(orderId, {
        include: [
            { model: Customer, as: 'customer', attributes: ['id', 'name', 'phone'] },
            {
                model: OrderItem,
                as: 'items',
                include: [{ model: Product, as: 'product', attributes: ['id', 'name', 'emoji'] }]
            },
            { model: User, as: 'creator', attributes: ['id', 'name'], required: false },
            // Desglose por método de pago (BLOQUE 10): el POS lo necesita en la
            // respuesta post-venta para imprimir el ticket con la división.
            { model: OrderPayment, as: 'payments', required: false }
        ]
    });
}

// Pedido + items, shape que esperan las pantallas de mesas al agregar/quitar
// productos (incluye `price` porque ahí sí se re-dibuja el precio del catálogo).
function cargarPedidoConItems(orderId) {
    return Order.findByPk(orderId, {
        include: [
            {
                model: OrderItem, as: 'items',
                include: [{ model: Product, as: 'product', attributes: ['id', 'name', 'emoji', 'price'] }],
            },
            // Desglose por método de pago (BLOQUE 10). Va en toda respuesta de
            // pedido para que el ticket y la reimpresión puedan mostrar cómo se
            // repartió la cuenta. Son pocas filas y sin imágenes: no pesa (§23).
            { model: OrderPayment, as: 'payments', required: false },
        ],
    });
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
        // Una pantalla de cocina ve SOLO la sucursal para la que fue aprobada
        // (BLOQUE 13). La sucursal la pone el DISPOSITIVO, nunca la URL: la URL
        // la controla quien tenga la tablet en la mano, y con ella podría
        // asomarse a la cocina de otra sucursal cambiando un número.
        if (req.user.esKds && req.user.branch_id) {
            where[Op.and] = [{ [Op.or]: [{ branch_id: req.user.branch_id }, { branch_id: null }] }];
        }
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
                    model: OrderPayment,
                    as: 'payments',
                    required: false
                },
                {
                    model: OrderItem,
                    as: 'items',
                    // Sin `image` (base64): el historial se lista de a 50 pedidos y las
                    // fotos multiplicaban el peso de la respuesta. El emoji basta.
                    include: [{
                        model: Product,
                        as: 'product',
                        attributes: ['id', 'name', 'emoji']
                    }]
                },
                {
                    model: User,
                    as: 'creator',
                    attributes: ['id', 'name'],
                    required: false
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
                        attributes: ['id', 'name', 'description', 'emoji']
                    }]
                },
                {
                    model: User,
                    as: 'creator',
                    attributes: ['id', 'name'],
                    required: false
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
router.post('/', createOrderLimiter, authenticate, async (req, res) => {
    const t = await sequelize.transaction();

    try {
        const biz = req.user.business_id;
        const {
            customer_id, customer_temp_info, items, total,
            payment_method, order_type, reference,
            delivery_address, maps_link, notes, branch_id,
            table_id, guests, discount_amount, discount_id,
            employee_id: disc_employee_id, pin: disc_pin, role: disc_role,
            loyalty_points_used, loyalty_points_earned, loyalty_discount_amount,
            skip_stock_check, client_uuid, sold_at, import_historico,
            tip_amount, tip_method,
            payments,
        } = req.body;

        // Venta DIFERIDA (BLOQUE 5): la hizo el POS sin internet y llega ahora.
        // Se reconoce por traer `sold_at` (hora real de la venta) junto al
        // client_uuid de la cola offline. En ese caso —y solo en ese caso— se
        // respetan la hora y los precios que declara el cliente: son los que el
        // negocio realmente cobró. Una venta online normal sigue igual que antes
        // (hora y precios del servidor). Ver utils/ventaOffline.js.
        // IMPORTACIÓN DE HISTORIAL (BLOQUE 18, Etapa 3): un negocio que venía
        // usando la app SIN CUENTA sube sus meses de ventas al crear su cuenta.
        // Solo el DUEÑO puede pedirlo, y se comprueba contra el dato que resuelve
        // `authenticate` desde la BD —para un dueño, `business_id` ES su propio id
        // (§14)—, no contra un `role` del token, que es lo que un cliente controla.
        //
        // Al resto del mundo no le cambia nada: sin la marca, la ventana sigue
        // siendo la de 30 días que protege al POS del §38.6.
        const esDuenoDelNegocio = Boolean(req.user && req.user.id && req.user.id === req.user.business_id);
        const importandoHistorial = Boolean(import_historico) && esDuenoDelNegocio;
        const { fecha: fechaVenta, motivo: motivoFecha } = resolverFechaVenta(
            sold_at,
            new Date(),
            importandoHistorial ? { atrasoMaximoMs: MAXIMO_ATRASO_IMPORTACION_MS } : {}
        );
        const esVentaDiferida = Boolean(client_uuid && fechaVenta);
        if (sold_at && !fechaVenta) {
            // Nunca se rechaza la venta por esto: se registra con la hora del
            // servidor y queda el aviso para diagnosticar el reloj del equipo.
            logger.warn(`sold_at descartado (${motivoFecha}) en venta de negocio ${biz}: ${sold_at}`);
        } else if (motivoFecha === 'futura_ajustada') {
            // La venta se registra igual y sigue siendo diferida; solo se le fijó
            // la hora del servidor porque venía del futuro. El aviso es lo único
            // que delata un equipo con el reloj mal configurado, que es un
            // problema real del local aunque ya no descuadre la caja.
            logger.warn(`sold_at por delante del reloj del servidor en negocio ${biz}: ${sold_at} (ajustado a ahora)`);
        }

        // Idempotencia: si ya existe un pedido con este client_uuid en el negocio,
        // devolverlo sin reprocesar. Protege contra reintentos (timeout de red tras
        // haber creado el pedido) que de otro modo duplicarían la venta y el descuento
        // de stock. La unicidad se refuerza además con el índice parcial en la BD.
        if (client_uuid) {
            const existente = await Order.findOne({
                where: { client_uuid, business_id: biz },
                transaction: t,
            });
            if (existente) {
                await t.rollback();
                return res.status(200).json(await cargarPedidoCompleto(existente.id));
            }
        }

        // Permitir pedido vacío cuando viene con table_id (mesa reservada, los items se agregan después)
        if ((!items || items.length === 0) && !table_id) {
            await t.rollback();
            return res.status(400).json({ error: 'El pedido debe tener al menos un producto' });
        }

        if (items && items.length > 500) {
            await t.rollback();
            return res.status(400).json({ error: 'Un pedido no puede tener más de 500 productos' });
        }

        // Validar longitud de notas
        if (notes && typeof notes === 'string' && notes.length > 1000) {
            await t.rollback();
            return res.status(400).json({ error: 'Las notas no pueden tener más de 1000 caracteres' });
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

        // Sucursal del registro (BLOQUE 4): ninguna venta puede quedar huérfana.
        // Con una sola sucursal se asigna sola; con varias, el equipo debe haber
        // elegido la suya. Ver utils/branch.js para las reglas completas.
        let branchIdFinal;
        try {
            branchIdFinal = await resolverBranchId({ user: req.user, branchId: branch_id, transaction: t });
        } catch (branchErr) {
            if (branchErr instanceof BranchError) {
                await t.rollback();
                return res.status(branchErr.status).json({ error: branchErr.message });
            }
            throw branchErr;
        }

        // Autorización de descuentos (seguridad de dinero):
        //  - descuentoAutorizadoPorId: el descuento corresponde a un Discount configurado
        //    del negocio (autorización implícita del dueño al crearlo).
        //  - descuentoEmpleado: empleado que autorizó vía PIN (si aplica), para auditoría.
        let descuentoAutorizadoPorId = false;
        let descuentoEmpleado = null;

        // Si viene discount_id, verificar que el descuento existe y si requiere PIN
        if (discount_id) {
            const discount = await Discount.findOne({
                where: { id: discount_id, business_id: biz },
                transaction: t
            });
            if (!discount) {
                await t.rollback();
                return res.status(404).json({ error: 'Descuento no encontrado' });
            }
            descuentoAutorizadoPorId = true;
            if (discount.requires_pin) {
                // Mismo criterio que cancelar (§19.19): vale el PIN de PUESTO o la
                // contraseña de CUENTA. Solo con la segunda, un descuento marcado
                // "requiere PIN" era inaplicable desde el POS.
                const authDesc = await autorizarAccionPrivilegiada({
                    businessId: biz,
                    actorId: req.user.id,
                    employee_id: disc_employee_id,
                    role: disc_role,
                    pin: disc_pin,
                    branchId: branchIdFinal,
                });
                if (!authDesc.ok) {
                    await t.rollback();
                    return res.status(403).json({ error: authDesc.error });
                }
                descuentoEmpleado = { id: authDesc.empleadoId, name: authDesc.nombre };
            }
        }

        // Calcular total en el servidor (no confiar en el cliente)
        // y validar que cada producto pertenezca al negocio
        let calculatedTotal = 0;
        const resolvedItems = [];
        // Items cuyo precio cobrado difiere del precio actual del catálogo (solo
        // puede pasar en ventas diferidas). Se auditan al final: es dinero que
        // salió a un precio que hoy no existe, y el dueño debe poder verlo.
        const preciosDistintos = [];

        // MODIFICADORES (BLOQUE 11). El catálogo se carga UNA vez por venta (va
        // cacheado 60s) y se resuelve cada renglón contra él: el cliente manda
        // qué opción eligió, nunca cuánto cuesta. Ver utils/modificadores.js.
        const catalogoMods = await catalogoModificadores(biz);

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
            // En una venta diferida vale el precio que se cobró, no el de hoy:
            // si el dueño subió los precios mientras el equipo estaba sin red,
            // cobrarle de más al ticket ya entregado descuadra la caja.
            const precioCatalogo = parseFloat(product.price);
            // ⚠️ `item.unit_price` es el precio BASE del producto, sin extras. La
            // comparación contra el catálogo tiene que hacerse aquí, antes de
            // sumar los modificadores: si no, cada "extra queso" quedaría
            // auditado como si el equipo hubiera cobrado un precio inventado.
            const { unitPrice: precioBase, origen } = resolverPrecioUnitario(
                precioCatalogo,
                item.base_unit_price !== undefined ? item.base_unit_price : item.unit_price,
                esVentaDiferida
            );
            if (!Number.isFinite(precioBase) || precioBase <= 0) {
                await t.rollback();
                return res.status(400).json({ error: `Precio inválido para el producto ${product.name || productId}` });
            }
            if (origen === 'cliente' && precioDifiere(precioBase, precioCatalogo)) {
                preciosDistintos.push({
                    producto: product.name,
                    cobrado: precioBase,
                    catalogo: Number.isFinite(precioCatalogo) ? precioCatalogo : null
                });
            }

            // MODIFICADORES: el delta sale de la base en una venta online y del
            // congelado del POS en una diferida (§26). Un error solo bloquea
            // online, donde el cajero puede volver a armar el producto.
            const mods = resolverModificadores({
                seleccion: item.modifiers,
                productId: product.id,
                catalogo: catalogoMods,
                esVentaDiferida,
            });
            if (!mods.ok) {
                await t.rollback();
                return res.status(400).json({ error: mods.error });
            }

            // `unit_price` es lo que el cliente paga por unidad (base + extras),
            // así que impuesto, descuentos, pagos y corte de caja siguen leyendo
            // ese campo sin enterarse de que existen modificadores.
            const unitPrice = precioConModificadores(precioBase, mods.modificadores);
            const subtotal = parseFloat((qty * unitPrice).toFixed(2));
            calculatedTotal += subtotal;

            resolvedItems.push({
                product, qty, unitPrice, subtotal,
                basePrice: precioBase,
                modificadores: mods.modificadores,
                notes: item.notes || item.nota || '',
            });
        }

        calculatedTotal = parseFloat(calculatedTotal.toFixed(2));

        // Validar stock de ingredientes antes de crear el pedido.
        // Si falta stock y el cliente no ha confirmado con skip_stock_check, devolver warnings
        // para que el frontend muestre el modal "¿continuar?" al usuario.
        if (!skip_stock_check) {
            const warnings = await validarStockIngredientes(resolvedItems, branchIdFinal, t);
            if (warnings.length > 0) {
                await t.rollback();
                return res.status(200).json({ stock_warning: true, warnings });
            }
        }

        const discountAmt = parseFloat(Math.min(Math.max(parseFloat(discount_amount) || 0, 0), calculatedTotal).toFixed(2));

        // Seguridad de dinero: un descuento manual (sin un Discount configurado del
        // negocio) debe autorizarse con PIN de empleado. Sin esto, cualquier cajero
        // podía mandar discount_amount arbitrario (hasta venta gratis) sin rastro.
        if (discountAmt > 0 && !descuentoAutorizadoPorId) {
            if (!disc_employee_id || !disc_pin) {
                await t.rollback();
                return res.status(403).json({ error: 'Aplicar un descuento requiere autorización con PIN' });
            }
            const authDesc = await autorizarAccionPrivilegiada({
                businessId: biz,
                actorId: req.user.id,
                employee_id: disc_employee_id,
                role: disc_role,
                pin: disc_pin,
                branchId: branchIdFinal,
            });
            if (!authDesc.ok) {
                await t.rollback();
                return res.status(403).json({ error: authDesc.error });
            }
            descuentoEmpleado = { id: authDesc.empleadoId, name: authDesc.nombre };
        }

        // Canje de puntos de fidelidad: NO es un descuento del empleado (el cliente
        // gasta puntos que ya ganó), así que no exige PIN. Pero tampoco se confía en
        // el monto que manda el cliente: se topa a `puntos canjeados × puntos_valor`
        // (valor configurado por el dueño), para que nadie pueda regalar dinero
        // declarando un canje inflado.
        let loyaltyAmt = 0;
        const puntosCanjeados = Math.max(parseInt(loyalty_points_used) || 0, 0);
        if (parseFloat(loyalty_discount_amount) > 0) {
            if (puntosCanjeados <= 0) {
                await t.rollback();
                return res.status(400).json({ error: 'El descuento por puntos requiere indicar los puntos canjeados' });
            }
            const prefsNegocio = await getPrefs(biz);
            const valorPunto = parseFloat(prefsNegocio.puntos_valor ?? 0.10) || 0;
            const topePorPuntos = parseFloat((puntosCanjeados * valorPunto).toFixed(2));
            loyaltyAmt = Math.min(
                parseFloat(loyalty_discount_amount) || 0,
                topePorPuntos,
                parseFloat((calculatedTotal - discountAmt).toFixed(2))
            );
            loyaltyAmt = parseFloat(Math.max(loyaltyAmt, 0).toFixed(2));
        }

        // IMPUESTO (BLOQUE 8). El descuento y el canje de puntos bajan la BASE
        // GRAVABLE: se descuentan primero y el impuesto se calcula sobre lo que
        // realmente se cobró. Con tasa 0 (el default) `desglosar` devuelve el
        // mismo total de siempre, así que un negocio sin impuesto no ve cambio.
        const baseGravable = parseFloat((calculatedTotal - discountAmt - loyaltyAmt).toFixed(2));
        const configImpuesto = resolverImpuestoVenta(
            await configImpuestoNegocio(biz),
            req.body,
            esVentaDiferida
        );
        const desglose = desglosar({
            base: baseGravable,
            tasa: configImpuesto.tasa,
            incluido: configImpuesto.incluido
        });
        const finalTotal = desglose.total;

        // PROPINA (BLOQUE 9). Se resuelve DESPUÉS del impuesto y por fuera de él a
        // propósito: la propina no es venta, así que no entra en la base gravable
        // ni en `total`. Lo que el cliente entrega es `total + tip_amount`; lo que
        // el negocio vendió sigue siendo `total`. Ver utils/propinas.js.
        const configPropinas = await configPropinasNegocio(biz);
        const propina = resolverPropina({
            config: configPropinas,
            tipAmount: tip_amount,
            tipMethod: tip_method,
            paymentMethod: payment_method,
        });

        // PAGOS DIVIDIDOS (BLOQUE 10). Los pagos REPARTEN `finalTotal`, no lo
        // aumentan: se resuelven después de conocerlo. Sin `payments` en el body
        // la venta es de un solo método y todo queda exactamente como antes.
        // Ver la regla completa en utils/pagos.js.
        const reparto = resolverPagos({
            payments,
            total: finalTotal,
            esVentaDiferida,
            propinasActivas: configPropinas.activo,
            metodoPorDefecto: payment_method,
        });
        if (reparto.error) {
            await t.rollback();
            return res.status(400).json({ error: reparto.error });
        }
        if (reparto.descartado) {
            // Venta offline con un desglose que no cuadra: se registra igual con su
            // método único (el total es correcto; solo se pierde el detalle). Queda
            // el rastro para poder investigarlo — §26: una venta atascada es peor.
            logger.warn(`Pagos descartados en venta diferida (negocio ${biz}): ${reparto.descartado}`);
        }

        // Con varios métodos, `payment_method` pasa a 'multiple' y el desglose real
        // vive en `order_payments`. Con uno solo, es ese método de siempre.
        const metodoFinal = reparto.aplicar
            ? reparto.metodoResumen
            : (payment_method || 'efectivo');

        // Con pagos, la propina de la venta es la SUMA de las de cada pago (cada
        // comensal deja la suya). Sin pagos, la del BLOQUE 9 tal cual.
        const propinaFinal = reparto.aplicar && reparto.propina.monto > 0
            ? reparto.propina
            : propina;

        const order = await Order.create({
            customer_id,
            customer_temp_info,
            total: finalTotal,
            subtotal: desglose.subtotal,
            tax_amount: desglose.impuesto,
            // Congelados: la tasa con la que se cobró ESTE ticket. Si el dueño la
            // cambia mañana, la mesa abierta y la reimpresión siguen cuadrando.
            tax_rate: configImpuesto.tasa,
            tax_included: configImpuesto.incluido,
            // Descuento total aplicado a la venta (empleado/promo + canje de puntos),
            // para que tickets y reportes muestren lo que realmente se descontó.
            discount_amount: parseFloat((discountAmt + loyaltyAmt).toFixed(2)),
            tip_amount: propinaFinal.monto,
            tip_method: propinaFinal.metodo,
            status: 'registrado',
            payment_method: metodoFinal,
            order_type: order_type || 'comer',
            reference,
            delivery_address,
            maps_link,
            notes,
            business_id: biz,
            branch_id: branchIdFinal,
            table_id: table_id || null,
            guests: guests ? parseInt(guests) : null,
            created_by: req.user.id,
            client_uuid: client_uuid || null,
            // Hora REAL de la venta. Sequelize solo pone `now` en createdAt si no
            // viene un valor; `updatedAt` sí queda con la hora del servidor, así
            // que el par (createdAt, updatedAt) deja ver cuándo se vendió y cuándo
            // llegó. Todo lo que reporta ventas (stats, turnos, filtros de fecha,
            // orden del historial) usa createdAt, así que con esto la venta cae
            // sola en el día y el turno correctos.
            ...(esVentaDiferida ? { createdAt: fechaVenta } : {}),
        }, { transaction: t });

        // Se guardan los items creados en orden para poder traducir los
        // `item_indexes` de una división POR ITEMS a ids reales (ver utils/pagos.js).
        const itemsCreados = [];
        for (const { product, qty, unitPrice, subtotal, basePrice, modificadores, notes: itemNotes } of resolvedItems) {
            const itemCreado = await OrderItem.create({
                order_id: order.id,
                product_id: product.id,
                quantity: qty,
                unit_price: unitPrice,
                subtotal,
                notes: itemNotes,
                // Congelado (BLOQUE 11): reimprimir este ticket dentro de un mes
                // debe mostrar lo que se cobró, aunque el extra haya cambiado de
                // precio o el dueño lo haya borrado de la biblioteca.
                base_unit_price: basePrice,
                modifiers: modificadores.length ? JSON.stringify(modificadores) : null,
            }, { transaction: t });
            itemsCreados.push(itemCreado);

            // Descontar insumos según la receta del producto (si tiene receta)
            await descontarIngredientesDeReceta(product.id, qty, t, branchIdFinal);
            // …y el ajuste de los modificadores: el queso extra sale del
            // inventario, y la cebolla que no se puso vuelve a él.
            await aplicarRecetaDeModificadores(modificadores, qty, t, branchIdFinal, -1);
        }

        // PAGOS DIVIDIDOS (BLOQUE 10). Van en la MISMA transacción que la venta:
        // un pedido cuyo desglose de pagos se perdiera a medias descuadraría el
        // corte de caja sin que nadie pudiera notarlo.
        if (reparto.aplicar) {
            for (const pago of reparto.pagos) {
                // `item_indexes` son posiciones del array `items` de esta misma
                // petición; se traducen ahora que los items ya tienen id.
                const idsPorIndice = pago.item_indexes
                    .map(i => itemsCreados[i])
                    .filter(Boolean)
                    .map(it => it.id);

                await OrderPayment.create({
                    order_id: order.id,
                    business_id: biz,
                    method: pago.method,
                    amount: pago.amount,
                    tip_amount: pago.tip_amount,
                    item_ids: idsPorIndice.length ? idsPorIndice : pago.item_ids,
                }, { transaction: t });
            }
        }

        // Actualizar puntos de fidelidad dentro de la misma transacción
        if (customer_id && (loyalty_points_used || loyalty_points_earned)) {
            const customer = await Customer.findOne({
                where: { id: customer_id, business_id: biz },
                transaction: t,
                lock: t.LOCK.UPDATE,
            });
            if (customer) {
                const puntosActuales = customer.loyalty_points || 0;
                let nuevoPuntaje = puntosActuales;
                if (loyalty_points_used && loyalty_points_used > 0) {
                    nuevoPuntaje = Math.max(0, nuevoPuntaje - loyalty_points_used);
                }
                if (loyalty_points_earned && loyalty_points_earned > 0) {
                    nuevoPuntaje += loyalty_points_earned;
                }
                await customer.update({ loyalty_points: nuevoPuntaje }, { transaction: t });
            }
        }

        // Auditar SIEMPRE que se aplique un descuento (quién, monto, pedido).
        let marcaDescuento = null;
        if (discountAmt > 0) {
            // Identidad de quien aplicó el descuento: el empleado del PIN si lo hubo;
            // si no (descuento configurado sin PIN), el usuario autenticado.
            let actorId = descuentoEmpleado?.id || req.user.id;
            let actorNombre = descuentoEmpleado?.name;
            if (!actorNombre) {
                const actor = await User.findByPk(req.user.id, { attributes: ['id', 'name'], transaction: t });
                actorNombre = actor?.name || 'Sin identificar';
            }
            // BLOQUE 14 — se evalúa contra la HORA REAL de la venta, no la de llegada
            // al servidor: un descuento aplicado a las 3 a.m. con la caja sin internet
            // y subido a las 9 a.m. es sospechoso a las 3 a.m., no a las 9 (§26).
            marcaDescuento = await evaluarHorario(biz, esVentaDiferida ? fechaVenta : new Date());
            await PrivilegedActionLog.create({
                business_id: biz,
                branch_id: branchIdFinal,
                employee_id: actorId,
                employee_name: actorNombre,
                action_type: 'apply_discount',
                target_description: `Pedido #${order.id}`,
                before_data: JSON.stringify({ subtotal: calculatedTotal }),
                after_data: JSON.stringify({ discount_amount: discountAmt, total: finalTotal, discount_id: discount_id || null }),
                fuera_horario: marcaDescuento.fuera
            }, { transaction: t });
        }

        // Rastro de los precios que llegaron distintos al catálogo. No bloquea nada
        // (la venta ya ocurrió y hay que registrarla), pero deja visible el caso en
        // que un equipo cobró un precio que hoy no existe: casi siempre es un cambio
        // de precio durante el corte de red, y si no lo es, aquí se ve.
        if (preciosDistintos.length > 0) {
            const actor = await User.findByPk(req.user.id, { attributes: ['id', 'name'], transaction: t });
            await PrivilegedActionLog.create({
                business_id: biz,
                branch_id: branchIdFinal,
                employee_id: req.user.id,
                employee_name: actor?.name || 'Sin identificar',
                action_type: 'offline_price',
                target_description: `Pedido #${order.id}`,
                before_data: JSON.stringify({ sold_at: fechaVenta }),
                after_data: JSON.stringify({ items: preciosDistintos, total: finalTotal })
            }, { transaction: t });
        }

        await t.commit();
        notificarOrders(biz);
        notificarInventario(biz);
        if (discountAmt > 0 || preciosDistintos.length > 0) notificarAudit(biz);
        // Después del commit y sin await: un aviso jamás puede afectar a la venta.
        avisarFueraDeHorario(biz, 'apply_discount', marcaDescuento);

        const fullOrder = await cargarPedidoCompleto(order.id);

        // Responder de inmediato: la venta ya está confirmada en la BD.
        // Las notificaciones push (stock bajo / venta grande) hacían varias
        // consultas secuenciales ANTES de responder, retrasando el cierre del
        // modal de venta en el POS. Ahora corren en segundo plano.
        res.status(201).json(fullOrder);

        procesarNotificacionesVenta(biz, resolvedItems, branchIdFinal, finalTotal, payment_method)
            .catch(err => logger.error('Notificaciones post-venta:', err));
    } catch (error) {
        await t.rollback();
        // Carrera: dos reintentos concurrentes con el mismo client_uuid. El índice
        // único hace fallar al segundo; en vez de 500, devolver el pedido ya creado.
        if (error.name === 'SequelizeUniqueConstraintError' && req.body.client_uuid) {
            try {
                const yaCreado = await Order.findOne({
                    where: { client_uuid: req.body.client_uuid, business_id: req.user.business_id },
                });
                if (yaCreado) return res.status(200).json(await cargarPedidoCompleto(yaCreado.id));
            } catch (e2) {
                logger.error('Error resolviendo carrera de client_uuid:', e2);
            }
        }
        logger.error('Create order error:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// POST /api/orders/:id/items  — agregar productos a un pedido abierto (para mesas)
router.post('/:id/items', authenticate, async (req, res) => {
    const t = await sequelize.transaction();
    try {
        const biz = req.user.business_id;
        const { items, client_uuid } = req.body;

        if (!items || items.length === 0) {
            await t.rollback();
            return res.status(400).json({ error: 'Se requiere al menos un producto' });
        }

        if (items.length > 500) {
            await t.rollback();
            return res.status(400).json({ error: 'No se pueden agregar más de 500 productos a la vez' });
        }

        const order = await Order.findOne({
            where: { id: req.params.id, business_id: biz, status: 'registrado' },
            transaction: t,
            lock: t.LOCK.UPDATE,
        });
        if (!order) {
            await t.rollback();
            return res.status(404).json({ error: 'Pedido no encontrado o ya cerrado' });
        }

        // Idempotencia del envío (BLOQUE 5): un doble tap con red débil duplicaba
        // los productos de la mesa y descontaba los insumos dos veces. Si este lote
        // ya se guardó, devolver el pedido tal como está. El SELECT es seguro
        // porque el pedido quedó bloqueado arriba: un reenvío simultáneo espera a
        // que el primero termine y entonces sí ve sus items.
        if (client_uuid) {
            const yaAgregado = await OrderItem.findOne({
                where: { order_id: order.id, client_uuid },
                transaction: t,
            });
            if (yaAgregado) {
                await t.rollback();
                return res.json(await cargarPedidoConItems(order.id));
            }
        }

        // Catálogo de modificadores (BLOQUE 11): una comanda que se agrega a una
        // mesa lleva extras igual que una venta de mostrador.
        const catalogoMods = await catalogoModificadores(biz);

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
            const precioBase = parseFloat(product.price);
            if (!Number.isFinite(precioBase) || precioBase <= 0) {
                await t.rollback();
                return res.status(400).json({ error: `Precio inválido para el producto ${product.name || productId}` });
            }

            // Aquí NO hay venta diferida: agregar a una mesa siempre ocurre en
            // línea (el pedido vive en el servidor), así que el delta sale
            // siempre de la base.
            const mods = resolverModificadores({
                seleccion: item.modifiers,
                productId: product.id,
                catalogo: catalogoMods,
                esVentaDiferida: false,
            });
            if (!mods.ok) {
                await t.rollback();
                return res.status(400).json({ error: mods.error });
            }

            const unitPrice = precioConModificadores(precioBase, mods.modificadores);
            const subtotal = parseFloat((qty * unitPrice).toFixed(2));
            additionalTotal += subtotal;

            await OrderItem.create({
                order_id: order.id,
                product_id: product.id,
                quantity: qty,
                unit_price: unitPrice,
                subtotal,
                notes: item.notes || '',
                client_uuid: client_uuid || null,
                base_unit_price: precioBase,
                modifiers: mods.modificadores.length ? JSON.stringify(mods.modificadores) : null,
            }, { transaction: t });

            await descontarIngredientesDeReceta(product.id, qty, t, order.branch_id || null);
            await aplicarRecetaDeModificadores(mods.modificadores, qty, t, order.branch_id || null, -1);
        }

        // El impuesto de la mesa se recalcula con la tasa CONGELADA del pedido,
        // no con la de hoy: si el dueño cambió el IVA a media comida, la cuenta
        // que el cliente ya vio no se mueve. `baseParaRecalcular` sabe qué
        // columna es el acumulador en cada modo (subtotal en AGREGADO, total en
        // INCLUIDO); sumarle el producto a la equivocada descuadra la mesa.
        const nuevaBase = parseFloat((baseParaRecalcular(order) + additionalTotal).toFixed(2));
        const desgloseMesa = desglosar({
            base: nuevaBase,
            tasa: order.tax_rate,
            incluido: order.tax_included
        });
        await order.update({
            total:      desgloseMesa.total,
            subtotal:   desgloseMesa.subtotal,
            tax_amount: desgloseMesa.impuesto
        }, { transaction: t });

        await t.commit();
        notificarOrders(biz);
        notificarInventario(biz);

        res.json(await cargarPedidoConItems(order.id));
    } catch (error) {
        await t.rollback();
        logger.error('Add items to order error:', error);
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

        // DEVOLVER LOS INSUMOS AL INVENTARIO.
        //
        // Agregar el producto a la mesa los descontó (POST /:id/items), así que
        // quitarlo tiene que devolverlos. Sin esto, un mesero que se equivoca de
        // plato y lo quita deja esos insumos descontados PARA SIEMPRE: el stock
        // se va desviando en silencio, un plato a la vez, y nadie puede
        // reconstruir por qué.
        //
        // Es exactamente lo que ya hace la cancelación del pedido completo
        // (PUT /:id/status): la misma pareja descontar/restaurar, aplicada a un
        // solo renglón. Solo se llega aquí con el pedido en 'registrado' —lo
        // filtra la consulta de arriba—, que es la misma condición bajo la que
        // se restaura al cancelar: el plato aún no se elaboró.
        const qtyItem = Math.max(1, parseInt(item.quantity) || 1);
        await restaurarIngredientesDeReceta(item.product_id, qtyItem, t, order.branch_id || null);
        // Y el ajuste de los modificadores (§32.6), con el signo invertido: el
        // queso extra vuelve al inventario y la cebolla que se había devuelto
        // vuelve a salir.
        await aplicarRecetaDeModificadores(
            leerModificadores(item.modifiers), qtyItem, t, order.branch_id || null, +1
        );

        await item.destroy({ transaction: t });

        const baseRestante = Math.max(0, parseFloat((baseParaRecalcular(order) - parseFloat(item.subtotal)).toFixed(2)));
        const desgloseMesa = desglosar({
            base: baseRestante,
            tasa: order.tax_rate,
            incluido: order.tax_included
        });
        await order.update({
            total:      desgloseMesa.total,
            subtotal:   desgloseMesa.subtotal,
            tax_amount: desgloseMesa.impuesto
        }, { transaction: t });

        await t.commit();
        notificarOrders(biz);
        // El stock cambió al devolver los insumos: sin este aviso, las pantallas
        // abiertas seguirían mostrando el stock de antes hasta el próximo refresco.
        notificarInventario(biz);

        res.json(await cargarPedidoConItems(order.id));
    } catch (error) {
        await t.rollback();
        logger.error('Delete order item error:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// PUT /api/orders/:id/status
// Ruta canónica de CANCELACIÓN. Si status='cancelado' exige { employee_id, pin },
// registra en auditoría y restaura los insumos (solo si el pedido estaba en
// 'registrado', aún sin elaborar). Un pedido ya elaborado (completado/entregado)
// no se cancela: se usa la devolución (POST /:id/devolucion).
router.put('/:id/status', authenticate, async (req, res) => {
    const t = await sequelize.transaction();
    try {
        const biz = req.user.business_id;
        const { status, employee_id, pin, employee_name, role, payment_method, tip_amount, tip_method, payments } = req.body;

        if (!['registrado', 'completado', 'entregado', 'cancelado'].includes(status)) {
            await t.rollback();
            return res.status(400).json({ error: 'Estado inválido. Use: registrado, completado, entregado o cancelado' });
        }

        // ⚠️ EL LOCK Y EL INCLUDE VAN POR SEPARADO, A PROPÓSITO.
        // Postgres rechaza `FOR UPDATE` sobre el lado nullable de un OUTER JOIN
        // ("FOR UPDATE cannot be applied to the nullable side of an outer join"),
        // y Sequelize genera exactamente eso al combinar `include` con `lock`.
        // Esta ruta las tenía juntas, así que respondía **500 siempre** en
        // producción: cobrar una mesa y cancelar un pedido estuvieron rotos desde
        // el 2026-07-27. No se detectó porque los tests corren sobre **SQLite**,
        // que ignora `FOR UPDATE` — la suite pasaba en verde con la ruta muerta.
        // Ver `tests/lock-sin-include.test.js`.
        const order = await Order.findOne({
            where: { id: req.params.id, business_id: biz },
            transaction: t,
            lock: t.LOCK.UPDATE
        });
        if (!order) {
            await t.rollback();
            return res.status(404).json({ error: 'Pedido no encontrado' });
        }

        // Los items se leen en una consulta aparte, ya con el pedido bloqueado.
        const itemsPedido = await OrderItem.findAll({
            where: { order_id: order.id },
            transaction: t
        });

        // Si se está cancelando: requiere PIN obligatorio y solo desde 'registrado'
        let authorizedEmployee = null;
        const beforeStatus = order.status;
        if (status === 'cancelado') {
            if (order.status !== 'registrado') {
                await t.rollback();
                return res.status(400).json({ error: 'Este pedido ya fue procesado. Usa "devolución" en lugar de cancelar.' });
            }
            // Acepta el PIN de PUESTO (`role`, lo que teclea el cajero) o la
            // contraseña de CUENTA (`employee_id`). Antes solo aceptaba la segunda,
            // que el POS no tiene, así que ningún cajero podía cancelar. Ver §19.19.
            const auth = await autorizarAccionPrivilegiada({
                businessId: biz,
                actorId: req.user.id,
                employee_id, employee_name, role, pin,
                branchId: order.branch_id || null,
            });
            if (!auth.ok) {
                await t.rollback();
                return res.status(auth.status).json({ error: auth.error });
            }
            authorizedEmployee = { id: auth.empleadoId, name: auth.nombre };

            // Restaurar insumos: el pedido estaba en 'registrado' (no elaborado).
            for (const item of itemsPedido) {
                const qty = Math.max(1, parseInt(item.quantity) || 1);
                await restaurarIngredientesDeReceta(item.product_id, qty, t, order.branch_id || null);
                // …y deshacer el ajuste de los modificadores (BLOQUE 11): el queso
                // extra vuelve al inventario, y la cebolla que se había devuelto
                // vuelve a salir. Es la misma fórmula con el signo al revés.
                await aplicarRecetaDeModificadores(
                    leerModificadores(item.modifiers), qty, t, order.branch_id || null, +1
                );
            }
        }

        // Esta es la ruta con la que los clientes COBRAN una mesa
        // (`closeTableOrder` → status 'completado' + método de pago), así que es
        // aquí donde se decide con qué se pagó y cuánta propina se dejó.
        const camposCobro = {};

        // ⚠️ BUG PREEXISTENTE (corregido en el BLOQUE 9): el desktop mandaba
        // `payment_method` en esta misma llamada desde siempre, pero la ruta lo
        // descartaba. Toda mesa cobrada con tarjeta o transferencia quedaba
        // guardada como 'efectivo', así que el cierre de turno le exigía al cajero
        // un efectivo que nunca entró al cajón. Solo se acepta al cobrar (no al
        // cancelar), y solo un método válido.
        if (status !== 'cancelado' && ['efectivo', 'tarjeta', 'transferencia'].includes(payment_method)) {
            camposCobro.payment_method = payment_method;
        }

        // PROPINA (BLOQUE 9). Se deja al cobrar, no al abrir la mesa, así que es
        // este el momento de registrarla. No toca `total`: es dinero del cliente
        // para el empleado. Una venta nunca falla por una propina inválida —
        // `resolverPropina` la deja en 0 (ver utils/propinas.js).
        const configPropinas = await configPropinasNegocio(biz);
        if (status !== 'cancelado' && tip_amount !== undefined) {
            const propina = resolverPropina({
                config: configPropinas,
                tipAmount: tip_amount,
                tipMethod: tip_method,
                paymentMethod: camposCobro.payment_method || order.payment_method,
            });
            camposCobro.tip_amount = propina.monto;
            camposCobro.tip_method = propina.metodo;
        }

        // PAGOS DIVIDIDOS (BLOQUE 10). Éste es el momento de "dividir la cuenta":
        // la mesa ya tiene todos sus items y el cliente dice cómo la paga. Los
        // `item_ids` de cada pago son ids REALES de `order_items` (a diferencia
        // de una venta de mostrador, donde los items nacen en la misma petición).
        //
        // Al cobrar se REEMPLAZA el desglose anterior: si el cajero se equivocó y
        // vuelve a cobrar, no deben quedar los pagos viejos sumando de más.
        if (status !== 'cancelado' && payments !== undefined) {
            const reparto = resolverPagos({
                payments,
                total: order.total,
                esVentaDiferida: false,
                propinasActivas: configPropinas.activo,
                metodoPorDefecto: camposCobro.payment_method || order.payment_method,
            });
            if (reparto.error) {
                await t.rollback();
                return res.status(400).json({ error: reparto.error });
            }
            if (reparto.aplicar) {
                await OrderPayment.destroy({ where: { order_id: order.id }, transaction: t });

                // Solo se aceptan ids de items que de verdad son de ESTA cuenta:
                // un id ajeno haría que el ticket dijera que alguien pagó algo que
                // no estaba en su mesa.
                const idsValidos = new Set(itemsPedido.map(i => i.id));

                for (const pago of reparto.pagos) {
                    await OrderPayment.create({
                        order_id: order.id,
                        business_id: biz,
                        method: pago.method,
                        amount: pago.amount,
                        tip_amount: pago.tip_amount,
                        item_ids: pago.item_ids.filter(id => idsValidos.has(id)),
                    }, { transaction: t });
                }

                camposCobro.payment_method = reparto.metodoResumen;
                if (reparto.propina.monto > 0) {
                    camposCobro.tip_amount = reparto.propina.monto;
                    camposCobro.tip_method = reparto.propina.metodo;
                }
            }
        }

        await order.update({ status, ...camposCobro }, { transaction: t });

        let marcaCancelacion = null;
        if (authorizedEmployee && status === 'cancelado') {
            marcaCancelacion = await evaluarHorario(biz);
            await PrivilegedActionLog.create({
                business_id: biz,
                branch_id: order.branch_id || null,
                employee_id: authorizedEmployee.id,
                employee_name: employee_name || authorizedEmployee.name,
                action_type: 'cancel_order',
                target_description: `Pedido #${order.id}`,
                before_data: JSON.stringify({ id: order.id, status: beforeStatus, total: order.total }),
                after_data: JSON.stringify({ id: order.id, status: 'cancelado', total: order.total }),
                fuera_horario: marcaCancelacion.fuera
            }, { transaction: t });
        }

        await t.commit();
        notificarOrders(biz);

        if (status === 'cancelado') {
            notificarInventario(biz);
            if (authorizedEmployee) notificarAudit(biz);
            avisarFueraDeHorario(biz, 'cancel_order', marcaCancelacion);
            // Push notification: pedido cancelado
            const empNombre = authorizedEmployee ? (employee_name || authorizedEmployee.name) : 'Sin identificar';
            enviarNotificacion(
                biz,
                'notif_pedido_cancelado',
                '❌ Pedido cancelado',
                `Pedido #${order.id} ($${parseFloat(order.total).toFixed(2)}) · cancelado por ${empNombre}`
            );
        }

        // Se recarga para devolver el desglose de pagos (BLOQUE 10): el cliente
        // imprime el ticket con esta respuesta y necesita saber cómo se repartió.
        res.json(await cargarPedidoConItems(order.id));
    } catch (error) {
        await t.rollback();
        logger.error('Update order status error:', error);
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

        // Cancelar y devolver son acciones sensibles: exigen PIN y auditoría, así que
        // NO se permiten desde este PUT genérico. Se enrutan a sus endpoints propios.
        if (status === 'cancelado' || status === 'devuelto') {
            return res.status(400).json({ error: 'Usa la ruta de cancelación/devolución (requiere PIN)' });
        }
        if (status !== undefined && !['registrado', 'completado', 'entregado'].includes(status)) {
            return res.status(400).json({ error: 'Estado inválido. Use: registrado, completado o entregado' });
        }

        // Validar transiciones de estado permitidas
        if (status !== undefined && status !== order.status) {
            const transicionesValidas = {
                registrado: ['completado'],
                completado: ['entregado'],
                entregado: [],
                cancelado: [],
                devuelto: []
            };
            const permitidas = transicionesValidas[order.status] || [];
            if (!permitidas.includes(status)) {
                return res.status(400).json({ error: `No se puede cambiar de "${order.status}" a "${status}"` });
            }
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
        const { employee_id, pin, employee_name, role } = req.body || {};

        // Misma regla que PUT /:id/status: PIN de puesto o contraseña de cuenta.
        const auth = await autorizarAccionPrivilegiada({
            businessId: biz,
            actorId: req.user.id,
            employee_id, employee_name, role, pin,
        });
        if (!auth.ok) {
            await t.rollback();
            return res.status(auth.status).json({ error: auth.error });
        }
        const authorizedEmployee = { id: auth.empleadoId, name: auth.nombre };

        const order = await Order.findOne({
            where: { id: req.params.id, business_id: biz },
            include: [{ model: OrderItem, as: 'items' }],
            transaction: t
        });

        if (!order) {
            await t.rollback();
            return res.status(404).json({ error: 'Pedido no encontrado' });
        }

        // Solo se cancela un pedido en 'registrado' (aún no elaborado). Un pedido ya
        // procesado se maneja con la devolución (POST /:id/devolucion). Misma regla que
        // PUT /:id/status para que la cancelación sea consistente por cualquier ruta.
        if (order.status !== 'registrado') {
            await t.rollback();
            const msg = order.status === 'cancelado'
                ? 'Este pedido ya está cancelado'
                : 'Este pedido ya fue procesado. Usa "devolución" en lugar de cancelar.';
            return res.status(400).json({ error: msg });
        }

        // Capturar estado antes de la cancelación (para auditoría)
        const beforeData = {
            id: order.id,
            status: order.status,
            total: order.total,
            payment_method: order.payment_method,
            order_type: order.order_type
        };

        // Restaurar ingredientes (el pedido estaba en 'registrado': insumos no consumidos)
        for (const item of order.items) {
            const qty = Math.max(1, parseInt(item.quantity) || 1);
            await restaurarIngredientesDeReceta(item.product_id, qty, t, order.branch_id || null);
            // Y el ajuste de los modificadores (BLOQUE 11). Este alias tiene que
            // hacer exactamente lo mismo que `PUT /:id/status`: si solo uno de
            // los dos deshiciera los extras, el inventario dependería de por cuál
            // de las dos rutas se canceló.
            await aplicarRecetaDeModificadores(
                leerModificadores(item.modifiers), qty, t, order.branch_id || null, +1
            );
        }

        await order.update({ status: 'cancelado' }, { transaction: t });

        // Registrar en auditoría si hubo autorización con PIN
        let marcaDelete = null;
        if (authorizedEmployee) {
            marcaDelete = await evaluarHorario(biz);
            await PrivilegedActionLog.create({
                business_id: biz,
                branch_id: order.branch_id || null,
                employee_id: authorizedEmployee.id,
                employee_name: authorizedEmployee.name,
                action_type: 'cancel_order',
                target_description: `Pedido #${order.id}`,
                before_data: JSON.stringify(beforeData),
                after_data: JSON.stringify({ ...beforeData, status: 'cancelado' }),
                fuera_horario: marcaDelete.fuera
            }, { transaction: t });
            notificarAudit(biz);
        }

        await t.commit();
        avisarFueraDeHorario(biz, 'cancel_order', marcaDelete);

        // Push notification: venta anulada
        const empNombreDelete = authorizedEmployee ? authorizedEmployee.name : 'Sin identificar';
        enviarNotificacion(
            biz,
            'notif_venta_anulada',
            '🗑️ Venta eliminada',
            `Pedido #${order.id} ($${parseFloat(order.total).toFixed(2)}) eliminado por ${empNombreDelete}`
        );

        res.json({ message: 'Pedido cancelado correctamente' });
    } catch (error) {
        await t.rollback();
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// POST /api/orders/:id/devolucion — devolver un pedido YA elaborado
// Para pedidos en 'completado' o 'entregado' no se puede cancelar (los insumos ya se
// consumieron). Exige PIN, NO restaura stock, marca 'devuelto' y audita (motivo opcional).
router.post('/:id/devolucion', authenticate, async (req, res) => {
    const t = await sequelize.transaction();
    try {
        const biz = req.user.business_id;
        const { employee_id, pin, employee_name, role, motivo } = req.body || {};

        // Misma regla que cancelar: PIN de puesto o contraseña de cuenta.
        const auth = await autorizarAccionPrivilegiada({
            businessId: biz,
            actorId: req.user.id,
            employee_id, employee_name, role, pin,
        });
        if (!auth.ok) {
            await t.rollback();
            return res.status(auth.status).json({ error: auth.error });
        }
        const authorizedEmployee = { id: auth.empleadoId, name: auth.nombre };

        const order = await Order.findOne({
            where: { id: req.params.id, business_id: biz },
            transaction: t,
            lock: t.LOCK.UPDATE
        });
        if (!order) {
            await t.rollback();
            return res.status(404).json({ error: 'Pedido no encontrado' });
        }

        // Solo pedidos ya elaborados: completado | entregado → devuelto
        if (!['completado', 'entregado'].includes(order.status)) {
            await t.rollback();
            return res.status(400).json({ error: 'Solo se puede devolver un pedido completado o entregado' });
        }

        const beforeStatus = order.status;
        await order.update({ status: 'devuelto' }, { transaction: t });

        const marcaDevolucion = await evaluarHorario(biz);
        await PrivilegedActionLog.create({
            business_id: biz,
            branch_id: order.branch_id || null,
            employee_id: authorizedEmployee.id,
            employee_name: employee_name || authorizedEmployee.name,
            action_type: 'return_order',
            target_description: `Pedido #${order.id}`,
            before_data: JSON.stringify({ id: order.id, status: beforeStatus, total: order.total }),
            after_data: JSON.stringify({ id: order.id, status: 'devuelto', total: order.total, motivo: motivo || null }),
            fuera_horario: marcaDevolucion.fuera
        }, { transaction: t });

        await t.commit();
        notificarOrders(biz);
        notificarAudit(biz);
        avisarFueraDeHorario(biz, 'return_order', marcaDevolucion);

        // Push notification: pedido devuelto
        const empNombre = employee_name || authorizedEmployee.name;
        enviarNotificacion(
            biz,
            'notif_pedido_devuelto',
            '↩️ Pedido devuelto',
            `Pedido #${order.id} ($${parseFloat(order.total).toFixed(2)}) · devuelto por ${empNombre}`
        );

        res.json(order);
    } catch (error) {
        await t.rollback();
        logger.error('Return order error:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

module.exports = router;
