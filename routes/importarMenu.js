// ============================================================================
// routes/importarMenu.js — EL MENÚ DESDE UNA FOTO (IDEA 1)
//
//     POST /api/importar-menu/leer        foto(s), PDF o texto  → PROPUESTA
//     POST /api/importar-menu/confirmar   lo que el dueño aprobó → catálogo
//
// Dos pasos A PROPÓSITO, y el primero no escribe nada. `leer` devuelve una
// propuesta con todo editable; solo `confirmar` toca el catálogo, y vuelve a
// validar cada renglón como si nunca lo hubiera visto: la pantalla de revisión
// existe justo para que el dueño lo cambie. Es la regla del bot (§52.1) —el
// modelo propone, el código y el usuario deciden— en el sitio donde un precio
// mal leído son cien ventas mal cobradas.
//
// Por qué `confirmar` es una ruta propia y no 60 llamadas a POST /api/products:
// ese endpoint topa a 30 altas por minuto, así que un menú normal se quedaría a
// la mitad; y lo que se confirma tiene que entrar ENTERO o no entrar — un
// catálogo a medias es peor que ninguno, porque parece terminado.
//
// Solo el DUEÑO, y solo con cuenta (decidido el 2026-09-18): cambia lo que se le
// cobra al cliente, y la clave de Gemini vive aquí, en el servidor.
//
// ⚠️ EL CUERPO GRANDE SE MONTA EN server.js, NO AQUÍ: el límite general es de
// 2 MB (§23) y una foto de celular pesa de 3 a 8, así que la primera foto del
// primer negocio habría dado un 413 (trampa 7 de la idea). Esta ruta lleva su
// propio parser —más grande— y va DESPUÉS de `authenticate`, para que nadie sin
// sesión pueda obligar al servidor a leer 50 MB.
// ============================================================================

const express = require('express');
const router = express.Router();

const { sequelize, Product, Category } = require('../models');
const { isOwner } = require('../middleware/auth');
const logger = require('../utils/logger');
const { obtenerLector } = require('../utils/menuFoto/lector');
const { armarPropuesta, validarConfirmacion, normalizarNombre } = require('../utils/menuFoto/propuesta');

const TIPOS_PERMITIDOS = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const MAX_ARCHIVOS = 6;                        // un menú son 2 a 6 fotos (trampa 5)
const MAX_BYTES_ARCHIVO = 6 * 1024 * 1024;     // ya reducida en el cliente, sobra
const MAX_TEXTO = 20000;
const MAX_PRODUCTOS_CONFIRMAR = 300;
const LECTURAS_POR_DIA = 40;                   // nadie importa 400 menús (trampa 3)

// ── Tope diario por negocio, en memoria ─────────────────────────────────────
// Cada lectura es una llamada pagada a Gemini. Vive en memoria como los códigos
// de emparejamiento del KDS (§35): perder el contador en un reinicio regala unas
// lecturas, que es un precio aceptable a cambio de no tener otra tabla.
const _lecturasHoy = new Map();   // `${biz}:${AAAA-MM-DD}` → n
function cupoDisponible(biz, cuantas) {
    const clave = `${biz}:${new Date().toISOString().slice(0, 10)}`;
    const usadas = _lecturasHoy.get(clave) || 0;
    if (usadas + cuantas > LECTURAS_POR_DIA) return false;
    _lecturasHoy.set(clave, usadas + cuantas);
    return true;
}
function _reiniciarCupos() { _lecturasHoy.clear(); }

/** Lo que llega del cliente, convertido en entradas para el lector. */
function prepararEntradas(body) {
    const entradas = [];
    const archivos = Array.isArray(body.archivos) ? body.archivos : [];
    if (archivos.length > MAX_ARCHIVOS) {
        return { error: `Máximo ${MAX_ARCHIVOS} fotos por vez. Si tu menú tiene más páginas, mándalas en dos tandas.` };
    }
    for (const [i, a] of archivos.entries()) {
        const mime = String((a && a.mime) || '').toLowerCase().split(';')[0].trim();
        if (mime === 'image/heic' || mime === 'image/heif') {
            // El formato de la cámara del iPhone. Casi nada lo acepta, y fallar
            // con un "formato no soportado" sin más dejaría tirado a cualquiera
            // con iPhone (IDEA 1). Se dice qué hacer.
            return { error: 'Las fotos de iPhone (HEIC) no se pueden leer todavía. Mándala como captura de pantalla, o cambia la cámara a "Más compatible" en Ajustes → Cámara → Formatos.', estado: 415 };
        }
        if (!TIPOS_PERMITIDOS.includes(mime)) {
            return { error: `El archivo ${i + 1} no es una foto ni un PDF (llegó "${mime || 'sin tipo'}").`, estado: 415 };
        }
        const datos = Buffer.from(String((a && a.datos) || ''), 'base64');
        if (!datos.length) return { error: `El archivo ${i + 1} llegó vacío.` };
        if (datos.length > MAX_BYTES_ARCHIVO) {
            return { error: `El archivo ${i + 1} pesa demasiado. Redúcelo antes de mandarlo: para leer precios no hace falta la foto en máxima calidad.`, estado: 413 };
        }
        entradas.push({ indice: i, mime, datos });
    }
    const texto = typeof body.texto === 'string' ? body.texto.trim() : '';
    if (texto) {
        if (texto.length > MAX_TEXTO) return { error: `El texto es demasiado largo (máximo ${MAX_TEXTO} caracteres).` };
        entradas.push({ indice: archivos.length, texto });
    }
    if (!entradas.length) return { error: 'Manda al menos una foto, un PDF o el texto del menú.' };
    return { entradas };
}

// POST /api/importar-menu/leer
router.post('/leer', isOwner, async (req, res) => {
    const biz = req.user.business_id;

    const lector = obtenerLector();
    if (!lector) {
        logger.warn('importar-menu: falta GEMINI_API_KEY; la lectura de menús está apagada');
        return res.status(503).json({ error: 'La lectura de menús desde foto no está disponible en este momento.' });
    }

    const { entradas, error, estado } = prepararEntradas(req.body || {});
    if (error) return res.status(estado || 400).json({ error });

    if (!cupoDisponible(biz, entradas.length)) {
        return res.status(429).json({ error: `Llegaste al máximo de ${LECTURAS_POR_DIA} lecturas de menú por día. Mañana puedes seguir, o captura el resto a mano.` });
    }

    // Una llamada por archivo, en fila: son pocas, y en paralelo solo
    // cambiaríamos unos segundos de espera por un pico de gasto si algo se repite.
    const lecturas = [];
    const archivos = [];
    for (const entrada of entradas) {
        const r = await lector.leer(entrada);
        if (r.ok) {
            lecturas.push(r.lectura);
            archivos.push({ indice: entrada.indice, ok: true, productos: r.lectura.productos.length });
            logger.info('importar-menu: lectura', { biz, ...r.uso, productos: r.lectura.productos.length });
        } else {
            // Un archivo que falla no tumba a los demás: se dice cuál fue y se sigue.
            archivos.push({ indice: entrada.indice, ok: false, motivo: r.motivo });
            logger.warn('importar-menu: una lectura falló', { biz, motivo: r.motivo, estado: r.estado, detalle: r.detalle });
        }
    }

    if (!lecturas.length) {
        return res.status(502).json({ error: 'No se pudo leer ninguno de los archivos. Prueba con una foto más nítida, o pega el texto del menú.', archivos });
    }

    try {
        const [categoriasExistentes, productosExistentes] = await Promise.all([
            Category.findAll({ where: { business_id: biz }, attributes: ['id', 'name'] }),
            Product.findAll({ where: { business_id: biz, active: true }, attributes: ['id', 'name'] }),
        ]);
        const propuesta = armarPropuesta(lecturas, { categoriasExistentes, productosExistentes });
        return res.json({ ...propuesta, archivos });
    } catch (e) {
        logger.error('importar-menu: error armando la propuesta', { message: e.message });
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// POST /api/importar-menu/confirmar
router.post('/confirmar', isOwner, async (req, res) => {
    const biz = req.user.business_id;
    const entrada = (req.body && req.body.productos) || [];
    if (!Array.isArray(entrada) || !entrada.length) {
        return res.status(400).json({ error: 'No hay productos que crear.' });
    }
    if (entrada.length > MAX_PRODUCTOS_CONFIRMAR) {
        return res.status(400).json({ error: `Máximo ${MAX_PRODUCTOS_CONFIRMAR} productos por vez.` });
    }

    // El cliente pudo tocar la propuesta: se vuelve a validar TODO.
    const { validos, rechazados } = validarConfirmacion(entrada);
    if (!validos.length) {
        return res.status(400).json({ error: 'Ninguno de los productos tiene nombre y precio válidos.', rechazados });
    }

    const t = await sequelize.transaction();
    try {
        const [categorias, productosQueHay] = await Promise.all([
            Category.findAll({ where: { business_id: biz }, attributes: ['id', 'name'], transaction: t }),
            Product.findAll({ where: { business_id: biz, active: true }, attributes: ['name'], transaction: t }),
        ]);
        const categoriaPorNombre = new Map(categorias.map((c) => [normalizarNombre(c.name), c.id]));
        const idsDelNegocio = new Set(categorias.map((c) => c.id));
        const yaHay = new Set(productosQueHay.map((p) => normalizarNombre(p.name)));

        const categoriasCreadas = [];
        const creados = [];
        const omitidos = [...rechazados];

        for (const p of validos) {
            // Un producto que ya existe no se duplica. Pudo haberse dado de alta
            // entre la lectura y la confirmación, así que se mira aquí otra vez.
            if (yaHay.has(normalizarNombre(p.nombre))) {
                omitidos.push({ nombre: p.nombre, motivo: 'ya_existe' });
                continue;
            }

            let categoriaId = null;
            if (p.categoria_id) {
                // Una categoría ajena NO se acepta: se ignora, no se cruza de negocio.
                categoriaId = idsDelNegocio.has(p.categoria_id) ? p.categoria_id : null;
            } else if (p.categoria_nueva) {
                // "Nueva" según la propuesta… pero la categoría pudo crearse después,
                // o venir escrita con otra mayúscula. Se busca antes de crear.
                const clave = normalizarNombre(p.categoria_nueva);
                categoriaId = categoriaPorNombre.get(clave) || null;
                if (!categoriaId) {
                    const nueva = await Category.create(
                        { name: p.categoria_nueva, business_id: biz },
                        { transaction: t }
                    );
                    categoriaId = nueva.id;
                    categoriaPorNombre.set(clave, nueva.id);
                    idsDelNegocio.add(nueva.id);
                    categoriasCreadas.push(nueva.name);
                }
            }

            const creado = await Product.create({
                name: p.nombre,
                description: p.descripcion,
                price: p.precio,
                category_id: categoriaId,
                // Sin control de existencias (§19.38): una foto no sabe cuántas
                // cocas hay en el refri, y un 0 inventado diría "se acabó".
                stock: null,
                business_id: biz,
            }, { transaction: t });
            yaHay.add(normalizarNombre(p.nombre));
            creados.push({ id: creado.id, nombre: creado.name, precio: Number(creado.price) });
        }

        await t.commit();
        logger.info('importar-menu: confirmado', { biz, creados: creados.length, omitidos: omitidos.length });
        return res.status(201).json({ creados, omitidos, categorias_creadas: categoriasCreadas });
    } catch (e) {
        await t.rollback();
        logger.error('importar-menu: error al confirmar', { message: e.message });
        return res.status(500).json({ error: 'No se guardó nada: hubo un error y se deshizo todo. Vuelve a intentarlo.' });
    }
});

module.exports = router;
module.exports._reiniciarCupos = _reiniciarCupos;
module.exports.LECTURAS_POR_DIA = LECTURAS_POR_DIA;
