// ============================================================================
// RECORRIDO 2 — El mismo día de caja, con el IVA INCLUIDO en el precio
//
// Modo INCLUIDO (§29): el precio del catálogo YA trae el impuesto y el ticket lo
// desglosa hacia atrás. Un taco de $22 se sigue cobrando en $22; lo que cambia es
// que $3.03 de esos son IVA. Es el modo POR DEFECTO y el estándar en México.
//
// Lo que se pone a prueba, y que ninguna prueba unitaria recorre entera:
//
//   1. El INVARIANTE `total = subtotal + tax_amount` en cada venta. Está escrito
//      así —y no como `cobrado/(1+t)`— para que cuadre al centavo exacto; con
//      precios de $24.50 y un 16 % es justo donde el redondeo puede irse.
//   2. Que el DESCUENTO baja la BASE GRAVABLE. Se comprueba comparando contra el
//      impuesto que habría salido sin descontar: si el impuesto no bajara, el
//      negocio estaría pagándole al fisco por dinero que nunca entró.
//   3. Que el efectivo esperado NO CAMBIA por encender el impuesto: en modo
//      incluido ya estaba dentro del total, o sea ya estaba en el cajón. Si
//      alguien lo sumara aparte, cada corte pediría de más.
//   4. Que `total_impuesto` y `total_ventas_netas` del turno cuadran con lo que
//      el banco calculó por su cuenta.
// ============================================================================

const { LibroDeCaja, desglosar } = require('../lib/libro');

const FONDO_INICIAL = 800.00;
const TASA = 16;

module.exports = {
    nombre: 'IVA incluido en el precio: la caja no se mueve',
    etiqueta: 'incluido',

    async ejecutar({ af, sembrar }) {
        const t = await sembrar('incluido', { productos: ['pastor', 'suadero', 'gringa'] });
        const api = t.api;
        const libro = new LibroDeCaja(FONDO_INICIAL);

        await api.exigir('PUT', '/api/settings', {
            tax_enabled: true,
            tax_rate: TASA,
            tax_included: true,
            tax_name: 'IVA',
        });

        const ajustes = await api.exigir('GET', '/api/settings', undefined, 200);
        af.igual('el impuesto quedó encendido', ajustes.tax_enabled, true);
        af.igual('en modo INCLUIDO', ajustes.tax_included, true);

        const turno = await api.exigir('POST', '/api/turnos', {
            cajero_nombre: 'Beto',
            rol: 'cajero',
            fondo_inicial: FONDO_INICIAL,
            branch_id: t.sucursales.matriz,
        }, [200, 201]);

        const enMatriz = (cuerpo) => Object.assign({ branch_id: t.sucursales.matriz }, cuerpo);

        // Comprueba una venta contra el desglose que calcula el banco por su
        // cuenta, y de paso el invariante.
        const comprobarVenta = (etiqueta, pedido, base) => {
            const esperado = desglosar({ base, tasa: TASA, incluido: true });
            af.dinero(etiqueta + ' · total cobrado', pedido.total, esperado.total);
            af.dinero(etiqueta + ' · IVA desglosado', pedido.tax_amount, esperado.impuesto);
            af.dinero(etiqueta + ' · base sin IVA', pedido.subtotal, esperado.subtotal);
            af.invarianteImpuesto(etiqueta, pedido);
            af.dinero(etiqueta + ' · la tasa quedó congelada en el pedido', pedido.tax_rate, TASA);
            return esperado;
        };

        // ── Venta 1 — 3 tacos al pastor, efectivo ───────────────────────────
        const v1 = await api.exigir('POST', '/api/orders', enMatriz({
            items: [{ product_id: t.productos.pastor.id, quantity: 3, unit_price: t.productos.pastor.precio }],
            payment_method: 'efectivo',
        }), [200, 201]);

        const d1 = comprobarVenta('venta 1 (3 pastor)', v1, 66.00);
        af.dinero('y el precio de venta NO subió por encender el IVA', v1.total, 66.00);
        libro.venta({ pagos: [{ metodo: 'efectivo', monto: d1.total }], impuesto: d1.impuesto, concepto: 'venta 1' });

        // ── Venta 2 — 3 suaderos a $24.50, con tarjeta ──────────────────────
        //    $73.50 al 16 % da 10.1379…: el redondeo tiene que caer del lado que
        //    mantenga el invariante.
        const v2 = await api.exigir('POST', '/api/orders', enMatriz({
            items: [{ product_id: t.productos.suadero.id, quantity: 3, unit_price: t.productos.suadero.precio }],
            payment_method: 'tarjeta',
        }), [200, 201]);

        const d2 = comprobarVenta('venta 2 (3 suaderos, con centavos)', v2, 73.50);
        libro.venta({ pagos: [{ metodo: 'tarjeta', monto: d2.total }], impuesto: d2.impuesto, concepto: 'venta 2' });

        // ── Venta 3 — con descuento: el IVA se calcula sobre lo COBRADO ─────
        const v3 = await api.exigir('POST', '/api/orders', enMatriz({
            items: [{ product_id: t.productos.gringa.id, quantity: 2, unit_price: t.productos.gringa.precio }],
            payment_method: 'efectivo',
            discount_id: t.descuento.id,
            discount_amount: t.descuento.valor,
            role: 'cajero',
            pin: t.pinCajero,
        }), [200, 201]);

        const d3 = comprobarVenta('venta 3 (2 gringas − $20)', v3, 137.00 - 20.00);

        const sinDescuento = desglosar({ base: 137.00, tasa: TASA, incluido: true });
        af.cierto(
            'el descuento BAJA la base gravable, no solo el total',
            parseFloat(v3.tax_amount) < sinDescuento.impuesto,
            'el IVA cobrado (' + v3.tax_amount + ') no bajó respecto a los $137 sin descontar (' +
            sinDescuento.impuesto + '): se estaría pagando impuesto por dinero que no entró'
        );
        libro.venta({ pagos: [{ metodo: 'efectivo', monto: d3.total }], impuesto: d3.impuesto, concepto: 'venta 3' });

        // ── Movimientos ─────────────────────────────────────────────────────
        await api.exigir('POST', '/api/turnos/' + turno.id + '/movimientos', {
            tipo: 'gasto', monto: 145.00, motivo: 'Gas de la plancha',
            role: 'cajero', pin: t.pinCajero,
        }, [200, 201]);
        libro.movimiento('gasto', 145.00);

        // ── Totales ─────────────────────────────────────────────────────────
        const totales = await api.exigir('GET', '/api/turnos/' + turno.id + '/totales', undefined, 200);

        af.dinero('ventas del turno (lo COBRADO, con IVA dentro)', totales.total_ventas, libro.totalVentas);
        af.dinero('IVA recaudado en el turno', totales.total_impuesto, libro.totalImpuesto);
        af.dinero(
            'ventas netas (lo que se queda el negocio)',
            totales.total_ventas_netas,
            parseFloat((libro.totalVentas - libro.totalImpuesto).toFixed(2))
        );

        // El punto 3: el impuesto YA está dentro del total, así que no toca el cajón.
        af.dinero('efectivo esperado (el IVA no lo mueve: ya estaba dentro)', totales.efectivo_esperado, libro.efectivoEnCajon);

        const cerrado = await api.exigir('PUT', '/api/turnos/' + turno.id + '/cerrar', {
            efectivo_contado: libro.efectivoEnCajon,
            notas: 'Cierre con IVA incluido',
        }, 200);

        af.dinero('DIFERENCIA DEL CORTE', cerrado.diferencia, 0);
        af.dinero('IVA congelado en el turno cerrado', cerrado.total_impuesto, libro.totalImpuesto);
    },
};
