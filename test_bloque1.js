/**
 * Tests rápidos — Bloque 1 (sin BD, sin servidor)
 * Verifica la lógica de los 4 cambios de seguridad.
 * Ejecutar con: node test_bloque1.js
 */

let passed = 0;
let failed = 0;

function ok(nombre, condicion) {
    if (condicion) {
        console.log(`  ✓  ${nombre}`);
        passed++;
    } else {
        console.error(`  ✗  ${nombre}`);
        failed++;
    }
}

// ─────────────────────────────────────────────────────────────
// 1.1 — loginLimiter aplicado a POST /login en staff.js
// ─────────────────────────────────────────────────────────────
console.log('\n1.1 — Rate limiting en staff login');
{
    const fs = require('fs');
    const src = fs.readFileSync('./routes/staff.js', 'utf8');

    ok('importa express-rate-limit', src.includes("require('express-rate-limit')"));
    ok('define loginLimiter',        src.includes('const loginLimiter = rateLimit('));
    ok('aplica loginLimiter en POST /login',
        /router\.post\(['"]\/login['"],\s*loginLimiter/.test(src));
}

// ─────────────────────────────────────────────────────────────
// 1.2 — Validación de status en PUT /api/orders/:id
// ─────────────────────────────────────────────────────────────
console.log('\n1.2 — Validación de status en orders');
{
    // Simulamos la lógica de validación extraída del archivo
    const ESTADOS_VALIDOS = ['registrado', 'completado', 'entregado', 'cancelado'];

    function validarStatus(status) {
        if (status !== undefined && !ESTADOS_VALIDOS.includes(status)) {
            return { ok: false, code: 400 };
        }
        return { ok: true };
    }

    ok('status válido "registrado" pasa',   validarStatus('registrado').ok === true);
    ok('status válido "completado" pasa',   validarStatus('completado').ok === true);
    ok('status válido "entregado" pasa',    validarStatus('entregado').ok === true);
    ok('status válido "cancelado" pasa',    validarStatus('cancelado').ok === true);
    ok('status inválido "cualquiera" → 400', validarStatus('cualquiera').code === 400);
    ok('status inválido "pending" → 400',   validarStatus('pending').code === 400);
    ok('status undefined (no enviado) pasa', validarStatus(undefined).ok === true);

    // Verificar que el código está efectivamente en el archivo
    const fs = require('fs');
    const src = fs.readFileSync('./routes/orders.js', 'utf8');
    ok('lógica de validación presente en orders.js',
        src.includes("['registrado', 'completado', 'entregado', 'cancelado'].includes(status)"));
}

// ─────────────────────────────────────────────────────────────
// 1.3 — Campos correctos al clonar ingredientes en branches.js
// ─────────────────────────────────────────────────────────────
console.log('\n1.3 — Campos de ingrediente clonado en branches');
{
    const fs = require('fs');
    const src = fs.readFileSync('./routes/branches.js', 'utf8');

    ok('usa campo "stock" (correcto)',         src.includes('stock: 0'));
    ok('usa campo "min_stock" (correcto)',     src.includes('min_stock: ing.min_stock'));
    ok('usa campo "cost_per_unit" (correcto)', src.includes('cost_per_unit: ing.cost_per_unit'));
    ok('NO usa "stock_actual" (campo viejo)',  !src.includes('stock_actual'));
    ok('NO usa "stock_minimo" (campo viejo)',  !src.includes('stock_minimo'));
}

// ─────────────────────────────────────────────────────────────
// 1.4 — Whitelist de claves en settings.js
// ─────────────────────────────────────────────────────────────
console.log('\n1.4 — Whitelist de claves en settings');
{
    // Simulamos la lógica de filtrado extraída del archivo
    const ALLOWED_KEYS = [
        'business_name', 'business_phone', 'business_email', 'business_website',
        'business_rfc', 'business_instagram', 'business_city', 'business_state',
        'business_address', 'business_tipo',
        'currency_symbol', 'ticket_footer',
        'show_logo', 'show_phone', 'show_direccion', 'show_email',
        'show_website', 'show_instagram', 'show_rfc',
        'logo_base64',
        'venta_sin_turno',
        'puntos_activos', 'puntos_por_peso', 'puntos_bono_pedido', 'puntos_valor',
        'permisos_roles',
        'sucursal_id',
    ];

    function filtrarSettings(body) {
        const incoming = {};
        for (const key of ALLOWED_KEYS) {
            if (key in body) incoming[key] = body[key];
        }
        return incoming;
    }

    const result1 = filtrarSettings({ business_name: 'Mi Tienda', campo_raro: 'hack', otro: 123 });
    ok('clave válida "business_name" pasa',        result1.business_name === 'Mi Tienda');
    ok('clave desconocida "campo_raro" se filtra', !('campo_raro' in result1));
    ok('clave desconocida "otro" se filtra',       !('otro' in result1));

    const result2 = filtrarSettings({ permisos_roles: { cajero: true }, puntos_activos: true });
    ok('"permisos_roles" pasa',    'permisos_roles' in result2);
    ok('"puntos_activos" pasa',    'puntos_activos' in result2);

    const result3 = filtrarSettings({ show_logo: true, logo_base64: 'abc', sucursal_id: 1 });
    ok('"show_logo" pasa',     result3.show_logo === true);
    ok('"logo_base64" pasa',   result3.logo_base64 === 'abc');
    ok('"sucursal_id" pasa',   result3.sucursal_id === 1);

    const resultVacio = filtrarSettings({ admin: true, __proto__: 'x', constructor: 'x' });
    ok('body con solo claves peligrosas → objeto vacío', Object.keys(resultVacio).length === 0);

    // Verificar que NO usa ...req.body sin filtrar
    const fs = require('fs');
    const src = fs.readFileSync('./routes/settings.js', 'utf8');
    ok('ya no usa ...req.body directamente',  !src.includes('...req.body'));
    ok('define ALLOWED_KEYS en el archivo',    src.includes('const ALLOWED_KEYS'));
}

// ─────────────────────────────────────────────────────────────
// Resultado final
// ─────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(45)}`);
console.log(`  Resultado: ${passed} pasaron, ${failed} fallaron`);
console.log('─'.repeat(45));
if (failed > 0) process.exit(1);
