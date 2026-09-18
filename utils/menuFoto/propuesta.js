// ============================================================================
// utils/menuFoto/propuesta.js — LO QUE LEYÓ EL MODELO, CONVERTIDO EN PROPUESTA
//
// IDEA 1 (IDEAS.md): el negocio le saca una foto a su menú y Zenit da de alta sus
// productos solo. Aquí vive la regla que hace eso seguro, y es la misma que
// sostiene al bot (§52.1):
//
//     🔴 EL MODELO PROPONE; EL CÓDIGO Y EL USUARIO DECIDEN.
//
// Nada de lo que sale de este archivo se escribe en el catálogo. Es una
// PROPUESTA que la pantalla de revisión enseña con todo editable, y que solo se
// guarda cuando el dueño la confirma (`confirmar` en routes/importarMenu.js, que
// además la vuelve a validar entera: el cliente la pudo haber tocado).
//
// Aquí pesa más que en el bot: un `$24.50` leído como `$2450` no es un error de
// IA, son CIEN VENTAS COBRADAS MAL antes de que alguien lo note.
//
// 🔴 LO DUDOSO SE MARCA, NO SE ADIVINA. Cada renglón lleva la lista de motivos
// por los que hay que mirarlo, y los dudosos salen PRIMERO. Un precio que no se
// leyó se reporta como desconocido —null— y NUNCA se rellena con 0 ni con el de
// al lado: es la regla del costo desconocido del §33, aplicada al precio.
//
// Este archivo no habla con ninguna IA ni con la base: recibe lo que el lector
// devolvió y lo que el negocio ya tiene, y decide. Por eso se puede probar
// entero sin red.
// ============================================================================

const PRECIO_MAXIMO = 100000;          // más que esto no es un precio de menú: es un OCR roto
const FACTOR_RARO = 10;                // 10× la mediana o 1/10 de ella = "míralo"
const MINIMO_PARA_MEDIANA = 5;         // con menos precios, la mediana no dice nada
const LARGO_NOMBRE = 200;              // el mismo tope que POST /api/products

/**
 * La forma "comparable" de un nombre: sin acentos, sin mayúsculas y sin
 * espacios de más. "Bebidas", "bebidas" y "BEBÍDAS " son la misma categoría,
 * y la foto no puede crear tres (trampa 4 de la idea).
 */
function normalizarNombre(texto) {
    return String(texto || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

/** Un nombre presentable: sin espacios de más y con tope de largo. */
function limpiarNombre(texto) {
    return String(texto || '').replace(/\s+/g, ' ').trim().slice(0, LARGO_NOMBRE);
}

/**
 * Los títulos de sección de un menú suelen ir en MAYÚSCULAS ("TACOS", "BEBIDAS
 * FRÍAS"), y copiados tal cual la pantalla de venta del POS se vería a gritos.
 * Solo se tocan los que vienen ENTEROS en mayúsculas, y a "tipo oración"
 * ("Bebidas frías"), no "Tipo Título": en español poner mayúscula a cada palabra
 * se ve raro ("Tacos De Pastor"). Encontrado en la primera lectura real.
 */
function nombreDeCategoria(texto) {
    const limpio = limpiarNombre(texto);
    const letras = limpio.replace(/[^a-záéíóúüñ]/gi, '');
    // Más de 3 letras: una sigla corta ("BBQ", "DF") se queda como está.
    if (letras.length > 3 && limpio === limpio.toUpperCase()) {
        const bajo = limpio.toLowerCase();
        return bajo.charAt(0).toUpperCase() + bajo.slice(1);
    }
    return limpio;
}

/**
 * Un precio, o null si no hay uno creíble. Acepta número o texto ("$24.50",
 * "24,50"), porque el modelo a veces devuelve lo que ve. Cero, negativo, basura
 * o absurdo → null: se reporta como desconocido, no se inventa.
 */
function normalizarPrecio(valor) {
    if (valor === null || valor === undefined || valor === '') return null;
    let n;
    if (typeof valor === 'number') {
        n = valor;
    } else {
        const texto = String(valor).replace(/[^\d.,-]/g, '');
        // "24,50" es coma decimal; "1,250.00" es separador de miles. Si hay
        // punto, la coma es de miles; si no lo hay, la coma es el decimal.
        n = Number(texto.includes('.') ? texto.replace(/,/g, '') : texto.replace(',', '.'));
    }
    if (!Number.isFinite(n) || n <= 0 || n > PRECIO_MAXIMO) return null;
    return Math.round(n * 100) / 100;
}

function mediana(numeros) {
    const orden = [...numeros].sort((a, b) => a - b);
    const m = Math.floor(orden.length / 2);
    return orden.length % 2 ? orden[m] : (orden[m - 1] + orden[m]) / 2;
}

/**
 * Convierte lo que devolvió el lector (una lectura por archivo, cada una con sus
 * productos) en la propuesta que ve la pantalla de revisión.
 *
 * @param {Array<{productos?: Array, negocio?: Object}>} lecturas
 * @param {{categoriasExistentes?: Array<{id,name}>, productosExistentes?: Array<{name}>}} negocio
 */
function armarPropuesta(lecturas, { categoriasExistentes = [], productosExistentes = [] } = {}) {
    const categoriasPorNombre = new Map(
        categoriasExistentes.map((c) => [normalizarNombre(c.name), c])
    );
    const productosQueYaHay = new Set(productosExistentes.map((p) => normalizarNombre(p.name)));

    // ── 1. Juntar todas las páginas, sin repetir ────────────────────────────
    // Un menú son 2 a 6 fotos, y la segunda página vuelve a traer los refrescos
    // de la primera (trampa 5). Se queda el PRIMERO; si el repetido trae otro
    // precio, se marca: una de las dos lecturas está mal y hay que decir cuál.
    const porNombre = new Map();
    const orden = [];
    let datosNegocio = null;

    for (const lectura of lecturas || []) {
        if (!datosNegocio && lectura && lectura.negocio) datosNegocio = lectura.negocio;
        for (const crudo of (lectura && lectura.productos) || []) {
            const nombre = limpiarNombre(crudo && crudo.nombre);
            if (!nombre) continue;
            const clave = normalizarNombre(nombre);
            const precio = normalizarPrecio(crudo.precio);

            if (porNombre.has(clave)) {
                const previo = porNombre.get(clave);
                if (precio !== null && previo.precio !== null && precio !== previo.precio) {
                    previo.motivos.add('duplicado_con_otro_precio');
                    previo.otro_precio_leido = precio;
                } else if (previo.precio === null && precio !== null) {
                    previo.precio = precio;   // la otra página sí lo tenía legible
                }
                continue;
            }

            const alternos = (Array.isArray(crudo.precios_alternos) ? crudo.precios_alternos : [])
                .map(normalizarPrecio)
                .filter((p) => p !== null && p !== precio);

            const item = {
                nombre,
                precio,
                descripcion: crudo.descripcion ? String(crudo.descripcion).trim().slice(0, 2000) : null,
                categoria_leida: crudo.categoria ? nombreDeCategoria(crudo.categoria) : null,
                precios_alternos: alternos,
                nota: crudo.nota ? String(crudo.nota).trim().slice(0, 200) : null,
                motivos: new Set(),
            };
            if (precio === null) item.motivos.add('sin_precio');
            if (alternos.length) item.motivos.add('varios_precios');
            if (crudo.confianza !== 'alta') item.motivos.add('lectura_dudosa');
            if (item.nota) item.motivos.add('nota');
            if (productosQueYaHay.has(clave)) item.motivos.add('ya_existe');

            porNombre.set(clave, item);
            orden.push(item);
        }
    }

    // ── 2. El precio que no cuadra con el resto ─────────────────────────────
    // El caso que más dinero cuesta: el punto decimal que el OCR se come. En un
    // menú donde todo anda entre $20 y $90, un $2450 no es un platillo caro, es
    // un $24.50 mal leído. No se corrige solo —podría ser una charola para 40—:
    // se MARCA, y se dice con qué se comparó.
    const conPrecio = orden.map((i) => i.precio).filter((p) => p !== null);
    if (conPrecio.length >= MINIMO_PARA_MEDIANA) {
        const m = mediana(conPrecio);
        for (const item of orden) {
            if (item.precio === null) continue;
            if (item.precio > m * FACTOR_RARO || item.precio < m / FACTOR_RARO) {
                item.motivos.add('precio_raro');
                item.mediana_del_menu = Math.round(m * 100) / 100;
            }
        }
    }

    // ── 3. Categorías: se MAPEAN a las que ya hay, no se inventan ───────────
    const nuevas = new Map();   // clave normalizada → nombre a mostrar
    for (const item of orden) {
        if (!item.categoria_leida) { item.categoria_id = null; item.categoria_nueva = null; continue; }
        const clave = normalizarNombre(item.categoria_leida);
        const existente = categoriasPorNombre.get(clave);
        if (existente) {
            item.categoria_id = existente.id;
            item.categoria_nueva = null;
        } else {
            if (!nuevas.has(clave)) nuevas.set(clave, item.categoria_leida);
            item.categoria_id = null;
            item.categoria_nueva = nuevas.get(clave);   // el mismo texto para todas
        }
    }

    // ── 4. Qué va marcado de salida, y en qué orden ─────────────────────────
    // Sin precio no se puede crear (Product.price es obligatorio), y lo que ya
    // existe no se duplica: los dos nacen DESMARCADOS. El resto nace marcado,
    // también los dudosos: el dueño los tiene que ver, no que buscarlos.
    const productos = orden.map((item) => {
        const motivos = [...item.motivos];
        return {
            nombre: item.nombre,
            precio: item.precio,
            descripcion: item.descripcion,
            categoria_id: item.categoria_id,
            categoria_nueva: item.categoria_nueva,
            precios_alternos: item.precios_alternos,
            nota: item.nota,
            ...(item.otro_precio_leido !== undefined ? { otro_precio_leido: item.otro_precio_leido } : {}),
            ...(item.mediana_del_menu !== undefined ? { mediana_del_menu: item.mediana_del_menu } : {}),
            motivos,
            dudoso: motivos.some((m) => m !== 'ya_existe'),
            incluir: !motivos.includes('sin_precio') && !motivos.includes('ya_existe'),
        };
    });

    // Los dudosos PRIMERO (trampa 2): lo que hay que mirar no puede quedar
    // enterrado en el renglón 47. Dentro de cada grupo se respeta el orden del
    // menú, que es como el dueño lo recuerda.
    productos.sort((a, b) => Number(b.dudoso) - Number(a.dudoso));

    return {
        productos,
        categorias_nuevas: [...nuevas.values()],
        negocio: limpiarDatosNegocio(datosNegocio),
        resumen: {
            total: productos.length,
            dudosos: productos.filter((p) => p.dudoso).length,
            sin_precio: productos.filter((p) => p.motivos.includes('sin_precio')).length,
            ya_existen: productos.filter((p) => p.motivos.includes('ya_existe')).length,
            a_crear: productos.filter((p) => p.incluir).length,
        },
    };
}

/** El nombre, teléfono y dirección que a veces trae la foto. Solo se sugieren. */
function limpiarDatosNegocio(d) {
    if (!d || typeof d !== 'object') return null;
    const texto = (v, max) => (v ? String(v).trim().slice(0, max) : null);
    const r = {
        nombre: texto(d.nombre, 200),
        telefono: texto(d.telefono, 50),
        direccion: texto(d.direccion, 300),
    };
    return (r.nombre || r.telefono || r.direccion) ? r : null;
}

/**
 * Lo que el dueño CONFIRMÓ, validado otra vez desde cero. El cliente pudo haber
 * editado la propuesta —para eso está la pantalla— o mandar cualquier cosa, así
 * que aquí no se le cree nada: nombre, precio y categoría se revisan de nuevo.
 *
 * Devuelve { validos, rechazados } — un renglón malo NO tumba a los demás: el
 * dueño que revisó 60 productos no tiene que volver a empezar por uno.
 */
function validarConfirmacion(productos) {
    const validos = [];
    const rechazados = [];
    const vistos = new Set();

    for (const [i, p] of (Array.isArray(productos) ? productos : []).entries()) {
        const nombre = limpiarNombre(p && p.nombre);
        const precio = normalizarPrecio(p && p.precio);
        if (!nombre) { rechazados.push({ indice: i, nombre: '', motivo: 'sin_nombre' }); continue; }
        if (precio === null) { rechazados.push({ indice: i, nombre, motivo: 'precio_invalido' }); continue; }

        const clave = normalizarNombre(nombre);
        if (vistos.has(clave)) { rechazados.push({ indice: i, nombre, motivo: 'repetido' }); continue; }
        vistos.add(clave);

        const categoriaId = Number.isInteger(p.categoria_id) && p.categoria_id > 0 ? p.categoria_id : null;
        const categoriaNueva = !categoriaId && p.categoria_nueva ? limpiarNombre(p.categoria_nueva) : null;

        validos.push({
            nombre,
            precio,
            descripcion: p.descripcion ? String(p.descripcion).trim().slice(0, 2000) : null,
            categoria_id: categoriaId,
            categoria_nueva: categoriaNueva || null,
        });
    }
    return { validos, rechazados };
}

module.exports = {
    armarPropuesta,
    validarConfirmacion,
    normalizarNombre,
    normalizarPrecio,
    nombreDeCategoria,
    PRECIO_MAXIMO,
    FACTOR_RARO,
};
