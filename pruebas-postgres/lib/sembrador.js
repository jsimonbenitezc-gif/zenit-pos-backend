// ============================================================================
// pruebas-postgres/lib/sembrador.js — una taquería de verdad
//
// El BLOQUE 15 lo pide con todas sus letras: datos realistas, no `test1`/`test2`,
// "que es donde salen los casos raros". Y es verdad — casi todo lo que se tuerce
// en Zenit vive en los bordes de los datos reales:
//
//   • Precios con centavos ($24.50, $27.50) que al desglosar un IVA del 16 %
//     obligan a redondear. Con precios redondos el impuesto cuadra por suerte.
//   • Recetas escritas en GRAMOS sobre insumos comprados en KILOS, que es como
//     las escribe una cocina y como se ejercita `utils/unidades.js`.
//   • DOS sucursales, porque una sola esconde el bug que el §24 vino a arreglar:
//     un turno que no filtra por sucursal suma las ventas del negocio entero.
//   • Un descuento con `requires_pin`, para pasar por la autorización del §19.19.
//
// Todo se crea POR HTTP, con el mismo token y las mismas rutas que usaría el
// desktop. No se escribe ni una fila a mano: si un endpoint de alta se rompe, el
// banco se entera al sembrar.
// ============================================================================

const crypto = require('crypto');

const PIN_CAJERO = '2468';
const PIN_ENCARGADO = '1357';

// El desktop guarda el PIN del puesto como SHA256 (utils/verifyPin.js acepta ese
// formato legacy y lo migra a bcrypt al primer uso). Se siembra así a propósito:
// es lo que hay hoy en las cuentas reales, y de paso el banco recorre esa
// migración automática en vez del camino feliz.
const sha256 = (t) => crypto.createHash('sha256').update(t).digest('hex');

const CATEGORIAS = [
    { name: 'Tacos', emoji: '🌮' },
    { name: 'Quesadillas y gringas', emoji: '🧀' },
    { name: 'Bebidas', emoji: '🥤' },
    { name: 'Para acompañar', emoji: '🍲' },
];

// Precios de una taquería de barrio. Los centavos NO son decorativos: son los
// que hacen que el desglose del impuesto tenga que redondear de verdad.
const PRODUCTOS = [
    { clave: 'pastor',     name: 'Taco al pastor',       price: 22.00, categoria: 'Tacos', emoji: '🌮' },
    { clave: 'suadero',    name: 'Taco de suadero',      price: 24.50, categoria: 'Tacos', emoji: '🌮' },
    { clave: 'campechano', name: 'Taco campechano',      price: 26.00, categoria: 'Tacos', emoji: '🌮' },
    { clave: 'gringa',     name: 'Gringa de pastor',     price: 68.50, categoria: 'Quesadillas y gringas', emoji: '🧀' },
    { clave: 'quesadilla', name: 'Quesadilla de queso',  price: 39.00, categoria: 'Quesadillas y gringas', emoji: '🧀' },
    { clave: 'consome',    name: 'Consomé de res',       price: 35.00, categoria: 'Para acompañar', emoji: '🍲' },
    { clave: 'horchata',   name: 'Agua de horchata 1 L', price: 45.00, categoria: 'Bebidas', emoji: '🥤' },
    { clave: 'refresco',   name: 'Refresco 600 ml',      price: 27.50, categoria: 'Bebidas', emoji: '🥤' },
];

// El insumo se compra en kilos; la receta se escribe en gramos (abajo).
const INSUMOS = [
    { clave: 'tortilla', name: 'Tortilla de maíz', unit: 'pcs', stock: 6000, min_stock: 1000, cost_per_unit: 0.85 },
    { clave: 'pastor',   name: 'Carne al pastor',  unit: 'kg',  stock: 45,   min_stock: 8,    cost_per_unit: 212.00 },
    { clave: 'suadero',  name: 'Suadero',          unit: 'kg',  stock: 28,   min_stock: 5,    cost_per_unit: 248.00 },
    { clave: 'queso',    name: 'Queso Oaxaca',     unit: 'kg',  stock: 14,   min_stock: 3,    cost_per_unit: 186.00 },
    { clave: 'cebolla',  name: 'Cebolla blanca',   unit: 'kg',  stock: 22,   min_stock: 4,    cost_per_unit: 28.50 },
    { clave: 'cilantro', name: 'Cilantro',         unit: 'kg',  stock: 6,    min_stock: 1,    cost_per_unit: 46.00 },
    { clave: 'pina',     name: 'Piña',             unit: 'kg',  stock: 11,   min_stock: 2,    cost_per_unit: 24.00 },
];

// `unit_recipe` en 'g' contra insumos en 'kg': el descuento tiene que pasar por
// `convertirCantidad`. Si alguien rompe esa conversión, el banco lo ve como un
// stock que no bajó lo que debía.
const RECETAS = {
    pastor:     [['tortilla', 2, 'pcs'], ['pastor', 80, 'g'], ['cebolla', 10, 'g'], ['cilantro', 5, 'g'], ['pina', 12, 'g']],
    suadero:    [['tortilla', 2, 'pcs'], ['suadero', 90, 'g'], ['cebolla', 10, 'g'], ['cilantro', 5, 'g']],
    campechano: [['tortilla', 2, 'pcs'], ['pastor', 45, 'g'], ['suadero', 45, 'g'], ['cebolla', 10, 'g']],
    gringa:     [['tortilla', 2, 'pcs'], ['pastor', 120, 'g'], ['queso', 60, 'g'], ['pina', 15, 'g']],
    quesadilla: [['tortilla', 1, 'pcs'], ['queso', 80, 'g']],
};

const MESAS = [
    { name: 'Mesa 1', zone: 'Comedor', capacity: 4 },
    { name: 'Mesa 2', zone: 'Comedor', capacity: 4 },
    { name: 'Mesa 3', zone: 'Comedor', capacity: 6 },
    { name: 'Banca 1', zone: 'Barra', capacity: 2 },
    { name: 'Terraza 1', zone: 'Terraza', capacity: 6 },
];

const CLIENTES = [
    { name: 'Doña Carmen Espinoza', phone: '5551234567' },
    { name: 'Ing. Ramírez (oficina)', phone: '5559876543' },
    { name: 'Familia Beltrán', phone: '5544332211' },
];

/**
 * Registra un negocio y lo llena. Todo por HTTP.
 *
 * @param {import('./http').ClienteApi} api
 * @param {object} opts
 * @param {string} opts.etiqueta  distingue el negocio de cada recorrido
 * @returns {Promise<object>} handles del negocio sembrado
 */
async function sembrarTaqueria(api, { etiqueta, productos: soloEstos = null }) {
    const sufijo = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const correo = 'taqueria_' + etiqueta + '_' + sufijo + '@pruebas.local';
    const clave = 'TaqueriaPruebas123';

    // ── 1. La cuenta ────────────────────────────────────────────────────────
    const registro = await api.exigir('POST', '/api/auth/register', {
        name: 'Taquería El Buen Pastor',
        email: correo,
        password: clave,
        tz: 'America/Mexico_City',
    }, 201);

    const negocio = api.como(registro.token);
    const negocioId = registro.user.id;

    // ── 2. Premium ──────────────────────────────────────────────────────────
    // Inventario, recetas y descuentos son premium. Se activa por la ruta real
    // (`start-trial`), no tocando la columna: si ese endpoint se rompe, el banco
    // se entera aquí y no en mitad de un recorrido.
    await negocio.exigir('POST', '/api/billing/start-trial', {}, [200]);

    // ── 3. Ajustes del negocio ──────────────────────────────────────────────
    // El PIN del PUESTO de cajero es lo único que se teclea en el POS (§19.19).
    await negocio.exigir('PUT', '/api/settings', {
        business_name: 'Taquería El Buen Pastor',
        currency_symbol: '$',
        tz: 'America/Mexico_City',
        ticket_footer: 'Gracias por su visita',
        movimientos_caja_pin: true,
        permisos_roles: {
            cajero: {
                pin_set: true,
                pin: sha256(PIN_CAJERO),
                ver_dashboard: true,
                ver_inventario: false,
            },
            encargado: {
                pin_set: true,
                pin: sha256(PIN_ENCARGADO),
                ver_dashboard: true,
                ver_inventario: true,
            },
        },
    });

    // ── 4. Sucursales ───────────────────────────────────────────────────────
    // DOS a propósito. Con una sola, `resolverBranchId` la asigna sola y el
    // filtro de sucursal del cierre de turno nunca se pone a prueba — que es
    // justo donde vivía el doble conteo que arregló el §24.
    const matriz = await negocio.exigir('POST', '/api/branches', {
        name: 'Matriz Portales', address: 'Av. Universidad 1200', phone: '5555550101',
    }, [200, 201]);
    const narvarte = await negocio.exigir('POST', '/api/branches', {
        name: 'Sucursal Narvarte', address: 'Eje 5 Sur 210', phone: '5555550202',
    }, [200, 201]);

    // ── 5. Categorías y productos ───────────────────────────────────────────
    const categorias = {};
    for (const c of CATEGORIAS) {
        const creada = await negocio.exigir('POST', '/api/categories', c, [200, 201]);
        categorias[c.name] = creada.id;
    }

    // Un recorrido puede pedir solo los productos que usa. No es por ahorrar
    // tiempo: `POST /api/products` admite 30 altas por minuto y por IP, y el
    // banco da de alta varios negocios enteros en tres segundos desde la misma
    // IP. Los productos son los MISMOS de la carta real —mismos nombres, mismos
    // precios con centavos—, solo que menos. El cliente HTTP además reintenta
    // ante un 429, así que esto es la primera defensa y no la única.
    const carta = soloEstos ? PRODUCTOS.filter((p) => soloEstos.includes(p.clave)) : PRODUCTOS;

    const productos = {};
    for (const p of carta) {
        const creado = await negocio.exigir('POST', '/api/products', {
            name: p.name,
            price: p.price,
            emoji: p.emoji,
            category_id: categorias[p.categoria],
        }, [200, 201]);
        productos[p.clave] = { id: creado.id, precio: p.price, nombre: p.name };
    }

    // ── 6. Insumos y recetas ────────────────────────────────────────────────
    const insumos = {};
    for (const i of INSUMOS) {
        const creado = await negocio.exigir('POST', '/api/inventory/ingredients', {
            name: i.name, unit: i.unit, stock: i.stock,
            min_stock: i.min_stock, cost_per_unit: i.cost_per_unit,
        }, [200, 201]);
        insumos[i.clave] = { id: creado.id, unidad: i.unit, stock: i.stock, nombre: i.name };
    }

    for (const [claveProducto, lineas] of Object.entries(RECETAS)) {
        if (!productos[claveProducto]) continue; // no está en la carta de este recorrido
        await negocio.exigir('POST', '/api/inventory/products/' + productos[claveProducto].id + '/recipe', {
            items: lineas.map(([claveInsumo, cantidad, unidad]) => ({
                item_type: 'ingredient',
                item_id: insumos[claveInsumo].id,
                quantity: cantidad,
                unit_recipe: unidad,
            })),
        }, [200, 201]);
    }

    // ── 7. Mesas (en la matriz) ─────────────────────────────────────────────
    const mesas = [];
    for (const m of MESAS) {
        const creada = await negocio.exigir('POST', '/api/tables',
            Object.assign({}, m, { branch_id: matriz.id }), [200, 201]);
        mesas.push({ id: creada.id, nombre: creada.name });
    }

    // ── 8. Clientes ─────────────────────────────────────────────────────────
    const clientes = [];
    for (const c of CLIENTES) {
        const creado = await negocio.exigir('POST', '/api/customers', c, [200, 201]);
        clientes.push({ id: creado.id, nombre: c.name });
    }

    // ── 9. Un descuento que EXIGE PIN ───────────────────────────────────────
    const descuento = await negocio.exigir('POST', '/api/offers/discounts', {
        name: 'Cortesía de la casa',
        type: 'fixed',
        value: 20,
        // `applies_to` es OBLIGATORIO aunque el default de la columna sea 'all':
        // la ruta lo valida antes de aplicar ese default, así que omitirlo da 400.
        applies_to: 'all',
        requires_pin: true,
    }, [200, 201]);

    return {
        correo,
        clave,
        negocioId,
        api: negocio,
        token: registro.token,
        sucursales: { matriz: matriz.id, narvarte: narvarte.id },
        categorias,
        productos,
        insumos,
        mesas,
        clientes,
        descuento: { id: descuento.id, valor: 20 },
        pinCajero: PIN_CAJERO,
        pinEncargado: PIN_ENCARGADO,
    };
}

module.exports = { sembrarTaqueria, PRODUCTOS, INSUMOS, RECETAS, PIN_CAJERO, PIN_ENCARGADO };
