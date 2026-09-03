// ============================================================================
// RECORRIDO 1 — Un día completo de caja, y la diferencia tiene que ser CERO
//
// Este es el recorrido que justifica el bloque entero. El BLOQUE 15 lo describe
// así: "abrir turno → vender en mostrador → cobrar una mesa dividida por items →
// aplicar un descuento con PIN → registrar un gasto y un retiro → dejar propinas
// en efectivo y tarjeta → cerrar turno y exigir que la diferencia sea
// exactamente cero".
//
// ⚠️ POR QUÉ ESTO NO ES CIRCULAR. El banco NO le pregunta al backend cuánto
// efectivo espera para después contar ese mismo número: lleva su propio libro
// (lib/libro.js) sumando peso a peso lo que él mismo hizo, y cierra el turno
// contando ESE número. Si la fórmula del backend se desvía aunque sea un centavo,
// `diferencia` deja de ser cero y el recorrido falla diciendo cuánto sobra o
// falta. Una prueba que pasa con y sin el arreglo no prueba nada (§32, §36).
//
// De paso se cubren tres cosas que ninguna prueba unitaria recorre entera:
//   • una venta de OTRA SUCURSAL que no debe contaminar este corte (§24),
//   • un pedido CANCELADO que no debe contar y sí debe devolver los insumos (§1),
//   • un movimiento ANULADO que sigue existiendo pero deja de sumar (§28.5).
// ============================================================================

const { LibroDeCaja } = require('../lib/libro');

const FONDO_INICIAL = 1500.00;

module.exports = {
    nombre: 'La caja cuadra al centavo',
    etiqueta: 'caja',

    async ejecutar({ af, sembrar }) {
        const t = await sembrar('caja');
        const api = t.api;
        const libro = new LibroDeCaja(FONDO_INICIAL);

        // Las propinas nacen apagadas (§30): sin encenderlas, el backend descarta
        // toda propina que llegue y este recorrido probaría lo contrario de lo
        // que dice probar.
        await api.exigir('PUT', '/api/settings', {
            propinas_activas: true,
            propina_sugerencias: [10, 15, 20],
        });

        // ── Abrir turno en la MATRIZ ────────────────────────────────────────
        const turno = await api.exigir('POST', '/api/turnos', {
            cajero_nombre: 'Lupita',
            rol: 'cajero',
            fondo_inicial: FONDO_INICIAL,
            branch_id: t.sucursales.matriz,
        }, [200, 201]);

        af.igual('el turno abre en la matriz', turno.branch_id, t.sucursales.matriz);

        const enMatriz = (cuerpo) => Object.assign({ branch_id: t.sucursales.matriz }, cuerpo);

        // ── Venta 1 — mostrador en efectivo ─────────────────────────────────
        //    5 tacos al pastor + 2 refrescos
        const venta1 = await api.exigir('POST', '/api/orders', enMatriz({
            items: [
                { product_id: t.productos.pastor.id, quantity: 5, unit_price: t.productos.pastor.precio },
                { product_id: t.productos.refresco.id, quantity: 2, unit_price: t.productos.refresco.precio },
            ],
            payment_method: 'efectivo',
            order_type: 'llevar',
        }), [200, 201]);

        af.dinero('venta 1 (5 pastor + 2 refrescos)', venta1.total, 165.00);
        af.invarianteImpuesto('venta 1', venta1);
        libro.venta({ pagos: [{ metodo: 'efectivo', monto: 165.00 }], concepto: 'venta 1' });

        // ── Venta 2 — se paga con TARJETA y la propina se deja en EFECTIVO ───
        //    Es el caso del §30 que descuadraba las cajas: el dinero de la
        //    propina SÍ está en el cajón aunque la venta no haya entrado por ahí.
        const venta2 = await api.exigir('POST', '/api/orders', enMatriz({
            items: [
                { product_id: t.productos.gringa.id, quantity: 1, unit_price: t.productos.gringa.precio },
                { product_id: t.productos.horchata.id, quantity: 1, unit_price: t.productos.horchata.precio },
            ],
            payment_method: 'tarjeta',
            tip_amount: 15.00,
            tip_method: 'efectivo',
        }), [200, 201]);

        af.dinero('venta 2 (gringa + horchata)', venta2.total, 113.50);
        af.dinero('la propina de la venta 2 queda FUERA del total', venta2.tip_amount, 15.00);
        af.cierto(
            'la propina no infla la venta',
            Math.round(parseFloat(venta2.total) * 100) === 11350,
            'el total incluyó la propina, que no es venta (§30)'
        );
        libro.venta({
            pagos: [{ metodo: 'tarjeta', monto: 113.50 }],
            propinas: [{ metodo: 'efectivo', monto: 15.00 }],
            concepto: 'venta 2',
        });

        // ── Mesa 1 — se abre, se le agregan platos y se cobra DIVIDIDA ───────
        const mesa = await api.exigir('POST', '/api/orders', enMatriz({
            table_id: t.mesas[0].id,
            guests: 4,
            items: [
                { product_id: t.productos.suadero.id, quantity: 4, unit_price: t.productos.suadero.precio },
                { product_id: t.productos.refresco.id, quantity: 2, unit_price: t.productos.refresco.precio },
            ],
            order_type: 'comer',
            client_uuid: 'mesa-1-' + Date.now(),
        }), [200, 201]);

        af.dinero('la mesa abre con 4 suaderos + 2 refrescos', mesa.total, 153.00);

        await api.exigir('POST', '/api/orders/' + mesa.id + '/items', {
            items: [{ product_id: t.productos.campechano.id, quantity: 2, unit_price: t.productos.campechano.precio }],
            client_uuid: 'lote-campechano-' + Date.now(),
        }, [200, 201]);

        const mesaConTodo = await api.exigir('GET', '/api/orders/' + mesa.id, undefined, 200);
        af.dinero('la cuenta de la mesa tras agregar 2 campechanos', mesaConTodo.total, 205.00);

        // Una mesa ABIERTA no es una venta todavía: no debe contar en el corte
        // mientras siga en `registrado` con mesa (§19.14). Se comprueba en vivo.
        const totalesConMesaAbierta = await api.exigir('GET', '/api/turnos/' + turno.id + '/totales', undefined, 200);
        af.dinero(
            'la mesa abierta NO cuenta como venta todavía',
            totalesConMesaAbierta.total_ventas,
            libro.totalVentas
        );

        // Se cobra dividida POR ITEMS: uno paga en efectivo y otro con tarjeta,
        // y cada quien deja su propina por su lado.
        await api.exigir('PUT', '/api/orders/' + mesa.id + '/status', {
            status: 'completado',
            payment_method: 'multiple',
            payments: [
                { method: 'efectivo', amount: 100.00, tip_amount: 10.00 },
                { method: 'tarjeta', amount: 105.00, tip_amount: 20.00 },
            ],
        }, 200);

        const mesaCobrada = await api.exigir('GET', '/api/orders/' + mesa.id, undefined, 200);
        af.igual('la mesa cobrada con dos métodos queda como "multiple"', mesaCobrada.payment_method, 'multiple');
        af.dinero('el total de la mesa no cambió al dividirla', mesaCobrada.total, 205.00);
        af.dinero('la propina total de la mesa es la suma de las dos', mesaCobrada.tip_amount, 30.00);

        libro.venta({
            pagos: [
                { metodo: 'efectivo', monto: 100.00 },
                { metodo: 'tarjeta', monto: 105.00 },
            ],
            propinas: [
                { metodo: 'efectivo', monto: 10.00 },
                { metodo: 'tarjeta', monto: 20.00 },
            ],
            concepto: 'mesa 1 dividida',
        });

        // ── Venta 4 — con DESCUENTO que exige PIN de puesto ──────────────────
        //    3 quesadillas menos la cortesía de $20. El PIN es el del PUESTO de
        //    cajero, que es lo único que se teclea en el POS (§19.19).
        const venta4 = await api.exigir('POST', '/api/orders', enMatriz({
            items: [{ product_id: t.productos.quesadilla.id, quantity: 3, unit_price: t.productos.quesadilla.precio }],
            payment_method: 'efectivo',
            discount_id: t.descuento.id,
            discount_amount: t.descuento.valor,
            role: 'cajero',
            pin: t.pinCajero,
            employee_name: 'Lupita',
        }), [200, 201]);

        af.dinero('venta 4 (3 quesadillas − $20 de cortesía)', venta4.total, 97.00);
        libro.venta({ pagos: [{ metodo: 'efectivo', monto: 97.00 }], concepto: 'venta 4 con descuento' });

        // El descuento con PIN tiene que dejar rastro: es dinero que salió.
        const auditoria = await api.exigir('GET', '/api/audit', undefined, 200);
        const filas = Array.isArray(auditoria) ? auditoria : (auditoria.data || []);
        af.cierto(
            'el descuento con PIN quedó auditado',
            filas.some((f) => f.action_type === 'apply_discount'),
            'no apareció ninguna fila apply_discount en /api/audit'
        );

        // ── Venta 5 — se CANCELA con PIN: no cuenta y devuelve los insumos ───
        const venta5 = await api.exigir('POST', '/api/orders', enMatriz({
            items: [{ product_id: t.productos.gringa.id, quantity: 2, unit_price: t.productos.gringa.precio }],
            payment_method: 'efectivo',
        }), [200, 201]);

        await api.exigir('PUT', '/api/orders/' + venta5.id + '/status', {
            status: 'cancelado',
            role: 'cajero',
            pin: t.pinCajero,
            employee_name: 'Lupita',
        }, 200);
        libro.ventaQueNoCuenta('venta 5 cancelada');

        // ── Venta 6 — en la OTRA sucursal: no puede tocar este corte ─────────
        await api.exigir('POST', '/api/orders', {
            branch_id: t.sucursales.narvarte,
            items: [{ product_id: t.productos.consome.id, quantity: 3, unit_price: t.productos.consome.precio }],
            payment_method: 'efectivo',
        }, [200, 201]);
        libro.ventaQueNoCuenta('venta en Narvarte');

        // ── Movimientos de caja ─────────────────────────────────────────────
        const movimiento = (cuerpo) => api.exigir(
            'POST', '/api/turnos/' + turno.id + '/movimientos',
            Object.assign({ role: 'cajero', pin: t.pinCajero, employee_name: 'Lupita' }, cuerpo),
            [200, 201]
        );

        await movimiento({ tipo: 'gasto', monto: 180.50, motivo: 'Cilantro y limones del mercado' });
        libro.movimiento('gasto', 180.50);

        await movimiento({ tipo: 'retiro', monto: 500.00, motivo: 'A la caja fuerte' });
        libro.movimiento('retiro', 500.00);

        // El depósito NO pide PIN a propósito: nadie se roba la caja metiéndole
        // billetes (§28.2).
        await api.exigir('POST', '/api/turnos/' + turno.id + '/movimientos', {
            tipo: 'deposito', monto: 200.00, motivo: 'Cambio para el turno de la noche',
        }, [200, 201]);
        libro.movimiento('deposito', 200.00);

        // Un movimiento equivocado se ANULA, nunca se borra: sigue visible y deja
        // de contar (§28.5).
        const equivocado = await movimiento({ tipo: 'gasto', monto: 90.00, motivo: 'Cargado por error' });
        await api.exigir(
            'POST', '/api/turnos/' + turno.id + '/movimientos/' + equivocado.id + '/anular',
            { role: 'cajero', pin: t.pinCajero, motivo_anulacion: 'Se cargó dos veces' },
            [200, 201]
        );
        libro.movimiento('gasto', 90.00);
        libro.anular('gasto', 90.00);

        const movimientos = await api.exigir('GET', '/api/turnos/' + turno.id + '/movimientos', undefined, 200);
        const listaMovs = movimientos.movimientos || [];
        af.igual('los 4 movimientos siguen en la lista (el anulado incluido)', listaMovs.length, 4);
        af.cierto(
            'el equivocado aparece marcado como anulado, no borrado',
            listaMovs.some((m) => m.anulado === true),
            'ningún movimiento quedó marcado como anulado'
        );
        af.dinero('y ya no suma en los totales de la caja', movimientos.totales.total_gastos, libro.gastos);

        // ── Totales en vivo, antes de cerrar ────────────────────────────────
        const totales = await api.exigir('GET', '/api/turnos/' + turno.id + '/totales', undefined, 200);

        af.igual('pedidos contables del turno', totales.total_pedidos, libro.pedidosContables);
        af.dinero('ventas del turno', totales.total_ventas, libro.totalVentas);
        af.dinero('ventas en efectivo', totales.total_efectivo, libro.totalEfectivo);
        af.dinero('ventas con tarjeta', totales.total_tarjeta, libro.totalTarjeta);
        af.dinero('ventas por transferencia', totales.total_transferencia, libro.totalTransferencia);
        af.dinero('propinas totales', totales.total_propinas, libro.totalPropinas);
        af.dinero('propinas en efectivo (las que SÍ están en el cajón)', totales.total_propinas_efectivo, libro.propinasEfectivo);
        af.dinero('propinas con tarjeta (las que NO están en el cajón)', totales.total_propinas_tarjeta, libro.propinasTarjeta);
        af.dinero('gastos vigentes', totales.total_gastos, libro.gastos);
        af.dinero('retiros', totales.total_retiros, libro.retiros);
        af.dinero('depósitos', totales.total_depositos, libro.depositos);

        // ── El número que importa ───────────────────────────────────────────
        console.log('\n      Libro del banco (contabilidad paralela):');
        console.log('        ' + libro.resumen() + '\n');

        af.dinero('efectivo esperado por el backend', totales.efectivo_esperado, libro.efectivoEnCajon);

        // Se cierra contando EXACTAMENTE lo que dice nuestro libro. Si el backend
        // calculara distinto, la diferencia no daría cero.
        const cerrado = await api.exigir('PUT', '/api/turnos/' + turno.id + '/cerrar', {
            efectivo_contado: libro.efectivoEnCajon,
            notas: 'Cierre del recorrido automático',
        }, 200);

        af.dinero('DIFERENCIA DEL CORTE', cerrado.diferencia, 0);
        af.dinero('ventas congeladas en el turno cerrado', cerrado.total_ventas, libro.totalVentas);
        af.dinero('gastos congelados en el turno cerrado', cerrado.total_gastos, libro.gastos);
        af.dinero('propinas congeladas en el turno cerrado', cerrado.total_propinas, libro.totalPropinas);

        // ── El inventario también tiene que cuadrar ──────────────────────────
        // Recetas en GRAMOS sobre un insumo en KILOS: pasa por convertirCantidad.
        //   venta 1 → 5 pastor × 80 g            = 0.400 kg
        //   venta 2 → 1 gringa × 120 g           = 0.120 kg
        //   mesa    → 2 campechanos × 45 g       = 0.090 kg
        //   venta 5 → cancelada: descuenta 0.240 y lo DEVUELVE  = 0
        //   Narvarte va a otra sucursal y no toca este stock.
        const insumos = await api.exigir(
            'GET', '/api/inventory/ingredients?branch_id=' + t.sucursales.matriz + '&limit=100', undefined, 200
        );
        const carne = (insumos.data || []).find((i) => i.id === t.insumos.pastor.id);
        af.cierto('se pudo leer el stock de la matriz', Boolean(carne), 'no llegó el insumo "Carne al pastor"');
        if (carne) {
            af.dinero('carne al pastor tras la jornada (cancelación devuelta)', carne.stock, 45 - 0.61);
        }
    },
};
