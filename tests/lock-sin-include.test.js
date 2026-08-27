/**
 * GUARD: nunca combinar `lock` con `include` en la misma consulta.
 *
 * ─── POR QUÉ EXISTE ESTE TEST ────────────────────────────────────────────────
 * Postgres rechaza `FOR UPDATE` sobre el lado nullable de un OUTER JOIN:
 *
 *     ERROR: FOR UPDATE cannot be applied to the nullable side of an outer join
 *
 * Sequelize genera exactamente eso cuando una consulta lleva `include` **y**
 * `lock` a la vez. `PUT /api/orders/:id/status` las tenía juntas, así que la ruta
 * respondía **500 siempre** en producción: cobrar una mesa y cancelar un pedido
 * estuvieron rotos desde el 2026-07-27 hasta el 2026-08-26.
 *
 * ⚠️ LO PELIGROSO: la suite entera pasaba en verde con la ruta muerta, porque
 * **los tests corren sobre SQLite** (ver tests/setup.js) y SQLite ignora
 * `FOR UPDATE`. Un test de integración normal NO puede atrapar esto. Por eso este
 * guard revisa el CÓDIGO FUENTE en vez del comportamiento: es la única forma de
 * detectarlo sin levantar un Postgres real en CI.
 *
 * ─── QUÉ HACER SI ESTE TEST FALLA ────────────────────────────────────────────
 * Hay dos salidas, y las dos son válidas:
 *
 * 1. Separar las consultas — bloquea la fila principal sola y carga lo asociado
 *    después, dentro de la misma transacción (el lock ya está tomado):
 *
 *        const order = await Order.findOne({ where, transaction: t, lock: t.LOCK.UPDATE });
 *        const items = await OrderItem.findAll({ where: { order_id: order.id }, transaction: t });
 *
 * 2. Acotar el lock a la tabla no-nullable con `of`, que genera
 *    `FOR UPDATE OF <tabla>` y deja el JOIN fuera del bloqueo:
 *
 *        lock: { level: t.LOCK.UPDATE, of: PreparationItem }
 *
 *    `descontarIngredientesDeReceta` (routes/orders.js) ya lo hace así desde
 *    siempre — la trampa era conocida y aun así se coló en `/:id/status`.
 *    Este guard existe para que no vuelva a colarse.
 */
const fs = require('fs');
const path = require('path');

const DIRS = ['routes', 'utils', 'models'];
const RAIZ = path.join(__dirname, '..');

/** Archivos .js de las carpetas que ejecuta el servidor. */
function archivosDelServidor() {
    const encontrados = [];
    for (const dir of DIRS) {
        const ruta = path.join(RAIZ, dir);
        if (!fs.existsSync(ruta)) continue;
        for (const f of fs.readdirSync(ruta)) {
            if (f.endsWith('.js')) encontrados.push(path.join(dir, f));
        }
    }
    return encontrados;
}

/**
 * Encuentra las llamadas a findOne/findAll/findByPk y devuelve las que tienen
 * `lock` e `include` dentro del MISMO objeto de opciones.
 *
 * Se recorre contando llaves en vez de usar una expresión regular: las opciones
 * anidan objetos (`where: { ... }`) y una regex se pasaría de largo.
 */
function consultasConLockEIncludes(fuente) {
    const hallazgos = [];
    const re = /\.(findOne|findAll|findByPk)\s*\(/g;
    let m;

    while ((m = re.exec(fuente)) !== null) {
        let i = m.index + m[0].length;
        let prof = 1;
        const inicio = i;
        while (i < fuente.length && prof > 0) {
            const c = fuente[i];
            if (c === '(') prof++;
            else if (c === ')') prof--;
            i++;
        }
        const args = fuente.slice(inicio, i - 1);

        const tieneInclude = /\binclude\s*:/.test(args);
        const tieneLock = /\block\s*:/.test(args);

        // `lock: { level: ..., of: Modelo }` es la forma SEGURA: genera
        // `FOR UPDATE OF <tabla>` y deja el lado nullable del JOIN fuera del
        // bloqueo. Solo se marca el lock "pelado", que bloquea todo lo unido.
        const lockAcotado = /\block\s*:\s*\{[^}]*\bof\s*:/.test(args);

        if (tieneLock && tieneInclude && !lockAcotado) {
            const linea = fuente.slice(0, m.index).split('\n').length;
            hallazgos.push({ linea, metodo: m[1] });
        }
    }
    return hallazgos;
}

describe('Guard — `lock` e `include` nunca en la misma consulta', () => {

    test('ningún archivo del servidor combina lock con include', () => {
        const problemas = [];

        for (const relativo of archivosDelServidor()) {
            const fuente = fs.readFileSync(path.join(RAIZ, relativo), 'utf8');
            for (const h of consultasConLockEIncludes(fuente)) {
                problemas.push(`${relativo}:${h.linea} (${h.metodo})`);
            }
        }

        if (problemas.length > 0) {
            throw new Error(
                'Estas consultas combinan `lock` con `include`, lo que en Postgres da\n' +
                '"FOR UPDATE cannot be applied to the nullable side of an outer join"\n' +
                'y hace que la ruta responda 500 SIEMPRE (los tests en SQLite no lo ven):\n\n' +
                problemas.map(p => '  · ' + p).join('\n') +
                '\n\nSepáralas: bloquea la fila principal y carga lo asociado aparte.'
            );
        }

        expect(problemas).toEqual([]);
    });

    test('el detector reconoce el patrón roto (prueba del propio guard)', () => {
        const roto = `
            const order = await Order.findOne({
                where: { id: 1, business_id: biz },
                include: [{ model: OrderItem, as: 'items' }],
                transaction: t,
                lock: t.LOCK.UPDATE
            });
        `;
        expect(consultasConLockEIncludes(roto)).toHaveLength(1);
    });

    test('el detector NO marca la forma segura `lock: { level, of }`', () => {
        const seguro = `
            const prepItems = await PreparationItem.findAll({
                where: { preparation_id: 1 },
                include: [{ model: Ingredient, as: 'ingredient' }],
                transaction: t,
                lock: { level: t.LOCK.UPDATE, of: PreparationItem }
            });
        `;
        expect(consultasConLockEIncludes(seguro)).toHaveLength(0);
    });

    test('el detector NO marca un lock sin include ni un include sin lock', () => {
        const soloLock = `
            const order = await Order.findOne({
                where: { id: 1 }, transaction: t, lock: t.LOCK.UPDATE
            });
        `;
        const soloInclude = `
            const order = await Order.findOne({
                where: { id: 1 }, include: [{ model: OrderItem, as: 'items' }], transaction: t
            });
        `;
        expect(consultasConLockEIncludes(soloLock)).toHaveLength(0);
        expect(consultasConLockEIncludes(soloInclude)).toHaveLength(0);
    });
});
