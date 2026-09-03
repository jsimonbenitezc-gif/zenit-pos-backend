// ============================================================================
// RECORRIDO 3 — El mismo día de caja, con el IVA AGREGADO al precio
//
// Modo AGREGADO (§29): el precio del catálogo es la BASE y el impuesto se SUMA al
// cobrar. Ese taco de $22 pasa a cobrarse en $25.52. Es lo típico de mayoreo y
// B2B, donde se cotiza "precio + IVA".
//
// ⚠️ ES EL MODO PELIGROSO, y por eso tiene recorrido propio. En INCLUIDO el total
// no se mueve, así que un error de desglose es feo pero no cambia lo que se cobra.
// En AGREGADO el total SÍ cambia: cada venta entra al cajón con un importe
// distinto al del catálogo. Si el backend y la caja no coinciden, el cajero pide
// una cantidad y el sistema registra otra — y el descuadre aparece multiplicado
// por todas las ventas del día.
//
// Lo que se comprueba:
//   1. Que el total es MAYOR que la suma de los precios de lista (si no, el modo
//      no se aplicó y el negocio está regalando el impuesto de cada venta).
//   2. El invariante `total = subtotal + tax_amount`, con el subtotal siendo
//      ahora la suma de los precios de lista.
//   3. Que el descuento baja la base ANTES de aplicar el impuesto.
//   4. Que el efectivo del cajón es el total CON impuesto — aquí sí sube, y el
//      corte tiene que contarlo.
// ============================================================================

const { LibroDeCaja, desglosar } = require('../lib/libro');

const FONDO_INICIAL = 1000.00;
const TASA = 16;

module.exports = {
    nombre: 'IVA agregado al precio: el cobro sube y la caja lo sabe',
    etiqueta: 'agregado',

    async ejecutar({ af, sembrar }) {
        const t = await sembrar('agregado', { productos: ['pastor', 'quesadilla', 'refresco'] });
        const api = t.api;
        const libro = new LibroDeCaja(FONDO_INICIAL);

        await api.exigir('PUT', '/api/settings', {
            tax_enabled: true,
            tax_rate: TASA,
            tax_included: false,
            tax_name: 'IVA',
        });

        const ajustes = await api.exigir('GET', '/api/settings', undefined, 200);
        af.igual('el impuesto quedó en modo AGREGADO', ajustes.tax_included, false);

        const turno = await api.exigir('POST', '/api/turnos', {
            cajero_nombre: 'Sandra',
            rol: 'cajero',
            fondo_inicial: FONDO_INICIAL,
            branch_id: t.sucursales.matriz,
        }, [200, 201]);

        const enMatriz = (cuerpo) => Object.assign({ branch_id: t.sucursales.matriz }, cuerpo);

        const comprobarVenta = (etiqueta, pedido, base) => {
            const esperado = desglosar({ base, tasa: TASA, incluido: false });
            af.dinero(etiqueta + ' · base (precios de lista)', pedido.subtotal, esperado.subtotal);
            af.dinero(etiqueta + ' · IVA agregado encima', pedido.tax_amount, esperado.impuesto);
            af.dinero(etiqueta + ' · total a cobrar', pedido.total, esperado.total);
            af.invarianteImpuesto(etiqueta, pedido);
            af.cierto(
                etiqueta + ' · el total SUPERA la suma de los precios de lista',
                parseFloat(pedido.total) > base,
                'el total (' + pedido.total + ') no subió sobre la base (' + base + '): ' +
                'el modo AGREGADO no se aplicó y el negocio regaló el impuesto'
            );
            return esperado;
        };

        // ── Venta 1 — 3 tacos al pastor ($66 + IVA), efectivo ───────────────
        const v1 = await api.exigir('POST', '/api/orders', enMatriz({
            items: [{ product_id: t.productos.pastor.id, quantity: 3, unit_price: t.productos.pastor.precio }],
            payment_method: 'efectivo',
        }), [200, 201]);

        const d1 = comprobarVenta('venta 1 (3 pastor)', v1, 66.00);
        af.dinero('el cliente paga $76.56 por $66 de tacos', v1.total, 76.56);
        libro.venta({ pagos: [{ metodo: 'efectivo', monto: d1.total }], impuesto: d1.impuesto, concepto: 'venta 1' });

        // ── Venta 2 — 2 quesadillas, con tarjeta ────────────────────────────
        const v2 = await api.exigir('POST', '/api/orders', enMatriz({
            items: [{ product_id: t.productos.quesadilla.id, quantity: 2, unit_price: t.productos.quesadilla.precio }],
            payment_method: 'tarjeta',
        }), [200, 201]);

        const d2 = comprobarVenta('venta 2 (2 quesadillas)', v2, 78.00);
        libro.venta({ pagos: [{ metodo: 'tarjeta', monto: d2.total }], impuesto: d2.impuesto, concepto: 'venta 2' });

        // ── Venta 3 — 3 refrescos a $27.50 menos $20 de cortesía ────────────
        const v3 = await api.exigir('POST', '/api/orders', enMatriz({
            items: [{ product_id: t.productos.refresco.id, quantity: 3, unit_price: t.productos.refresco.precio }],
            payment_method: 'efectivo',
            discount_id: t.descuento.id,
            discount_amount: t.descuento.valor,
            role: 'cajero',
            pin: t.pinCajero,
        }), [200, 201]);

        const d3 = comprobarVenta('venta 3 (3 refrescos − $20)', v3, 82.50 - 20.00);
        af.dinero('el IVA se calculó sobre $62.50, no sobre $82.50', v3.tax_amount, 10.00);
        libro.venta({ pagos: [{ metodo: 'efectivo', monto: d3.total }], impuesto: d3.impuesto, concepto: 'venta 3' });

        // ── Movimientos ─────────────────────────────────────────────────────
        await api.exigir('POST', '/api/turnos/' + turno.id + '/movimientos', {
            tipo: 'retiro', monto: 300.00, motivo: 'A la caja fuerte',
            role: 'cajero', pin: t.pinCajero,
        }, [200, 201]);
        libro.movimiento('retiro', 300.00);

        // ── Totales y cierre ────────────────────────────────────────────────
        const totales = await api.exigir('GET', '/api/turnos/' + turno.id + '/totales', undefined, 200);

        af.dinero('ventas del turno (con el IVA agregado dentro)', totales.total_ventas, libro.totalVentas);
        af.dinero('IVA recaudado', totales.total_impuesto, libro.totalImpuesto);
        af.dinero(
            'ventas netas',
            totales.total_ventas_netas,
            parseFloat((libro.totalVentas - libro.totalImpuesto).toFixed(2))
        );

        // Aquí el impuesto SÍ engorda el cajón: entró con cada venta en efectivo.
        af.dinero('efectivo esperado (incluye el IVA que sí entró al cajón)', totales.efectivo_esperado, libro.efectivoEnCajon);

        const cerrado = await api.exigir('PUT', '/api/turnos/' + turno.id + '/cerrar', {
            efectivo_contado: libro.efectivoEnCajon,
            notas: 'Cierre con IVA agregado',
        }, 200);

        af.dinero('DIFERENCIA DEL CORTE', cerrado.diferencia, 0);
        af.dinero('IVA congelado en el turno cerrado', cerrado.total_impuesto, libro.totalImpuesto);
    },
};
