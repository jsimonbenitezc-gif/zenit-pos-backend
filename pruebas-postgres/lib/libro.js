// ============================================================================
// pruebas-postgres/lib/libro.js — LA CONTABILIDAD PARALELA DEL BANCO
//
// ⚠️ REGLA DE ESTE ARCHIVO: **no importa NADA de `utils/`**. Ni impuestos, ni
// cashMovements, ni pagos.
//
// El motivo es el que hace que el bloque valga algo. Si el banco preguntara al
// backend "¿cuánto efectivo esperas?" y luego cerrara el turno contando ese
// mismo número, la diferencia daría cero SIEMPRE — incluso con la fórmula
// completamente mal. La prueba pasaría con y sin el arreglo, que es la
// definición de una prueba inútil (CLAUDE.md §32, §36).
//
// Así que el banco lleva SU PROPIO libro: va anotando, peso a peso, lo que
// debería haber en el cajón según lo que él mismo hizo, y al final cierra el
// turno contando ESE número. Si el backend calcula distinto, `diferencia` sale
// distinta de cero y el recorrido falla señalando el descuadre exacto.
//
// Es una segunda implementación de las reglas, escrita desde el enunciado y no
// copiada del código:
//   • esperado = fondo + ventas_efectivo + propinas_efectivo + depósitos − retiros − gastos
//   • la propina NO es venta y NO paga impuesto (§30)
//   • la propina de TARJETA no está en el cajón (§30)
//   • los pagos REPARTEN el total, no lo aumentan (§31)
//   • el descuento baja la BASE GRAVABLE (§29)
// ============================================================================

const cent = (n) => Math.round((parseFloat(n) || 0) * 100);
const aPesos = (c) => parseFloat((c / 100).toFixed(2));

/**
 * Desglose de impuesto, reescrito desde la regla del §29 (no copiado de
 * utils/impuestos.js). Que sean dos implementaciones es el punto: si alguien
 * cambia una, el banco lo nota.
 *
 *   INCLUIDO — el precio ya trae el impuesto y se extrae hacia atrás.
 *              El subtotal se define como (cobrado − impuesto) para que
 *              total = subtotal + impuesto cuadre al centavo.
 *   AGREGADO — el precio es la base y el impuesto se suma encima.
 */
function desglosar({ base, tasa, incluido }) {
    const monto = aPesos(cent(base));
    const t = parseFloat(tasa) || 0;
    if (t <= 0 || monto <= 0) return { subtotal: monto, impuesto: 0, total: monto };

    const redondear = (n) => parseFloat((Math.round((n + Number.EPSILON) * 100) / 100).toFixed(2));

    if (incluido) {
        const impuesto = redondear(monto - monto / (1 + t / 100));
        return { subtotal: redondear(monto - impuesto), impuesto, total: monto };
    }
    const impuesto = redondear(monto * t / 100);
    return { subtotal: monto, impuesto, total: redondear(monto + impuesto) };
}

class LibroDeCaja {
    constructor(fondoInicial) {
        this.fondo = cent(fondoInicial);
        this.ventas = { efectivo: 0, tarjeta: 0, transferencia: 0 };
        this.propinas = { efectivo: 0, tarjeta: 0, transferencia: 0 };
        this.impuesto = 0;
        this.pedidosContables = 0;
        this.movimientos = { deposito: 0, retiro: 0, gasto: 0 };
        this.bitacora = [];
    }

    /**
     * Anota una venta que SÍ cuenta para el corte.
     *
     * @param {object} v
     * @param {Array<{metodo:string, monto:number}>} v.pagos  reparto del total
     * @param {Array<{metodo:string, monto:number}>=} v.propinas
     * @param {number=} v.impuesto  impuesto incluido en el total (informativo)
     * @param {string=} v.concepto
     */
    venta({ pagos, propinas = [], impuesto = 0, concepto = 'venta' }) {
        let totalVenta = 0;
        for (const p of pagos) {
            const m = cent(p.monto);
            if (!(p.metodo in this.ventas)) {
                throw new Error(`Método de pago desconocido en el libro: ${p.metodo}`);
            }
            this.ventas[p.metodo] += m;
            totalVenta += m;
        }
        for (const p of propinas) {
            if (!p || !p.monto) continue;
            if (!(p.metodo in this.propinas)) {
                throw new Error(`Método de propina desconocido en el libro: ${p.metodo}`);
            }
            this.propinas[p.metodo] += cent(p.monto);
        }
        this.impuesto += cent(impuesto);
        this.pedidosContables++;
        this.bitacora.push(`${concepto}: ${aPesos(totalVenta)}`);
        return aPesos(totalVenta);
    }

    /** Una venta cancelada o devuelta NO se anota: el corte no debe verla. */
    ventaQueNoCuenta(concepto) {
        this.bitacora.push(`${concepto}: no cuenta para el corte`);
    }

    movimiento(tipo, monto) {
        if (!(tipo in this.movimientos)) throw new Error(`Tipo de movimiento desconocido: ${tipo}`);
        this.movimientos[tipo] += cent(monto);
        this.bitacora.push(`${tipo}: ${parseFloat(monto).toFixed(2)}`);
    }

    /** Un movimiento anulado deja de contar, pero sigue existiendo (§28.5). */
    anular(tipo, monto) {
        if (!(tipo in this.movimientos)) throw new Error(`Tipo de movimiento desconocido: ${tipo}`);
        this.movimientos[tipo] -= cent(monto);
        this.bitacora.push(`${tipo} ANULADO: ${parseFloat(monto).toFixed(2)}`);
    }

    get totalVentas()   { return aPesos(this.ventas.efectivo + this.ventas.tarjeta + this.ventas.transferencia); }
    get totalEfectivo() { return aPesos(this.ventas.efectivo); }
    get totalTarjeta()  { return aPesos(this.ventas.tarjeta); }
    get totalTransferencia() { return aPesos(this.ventas.transferencia); }
    get totalImpuesto() { return aPesos(this.impuesto); }

    get totalPropinas() {
        return aPesos(this.propinas.efectivo + this.propinas.tarjeta + this.propinas.transferencia);
    }
    get propinasEfectivo() { return aPesos(this.propinas.efectivo); }
    get propinasTarjeta()  { return aPesos(this.propinas.tarjeta); }

    get depositos() { return aPesos(this.movimientos.deposito); }
    get retiros()   { return aPesos(this.movimientos.retiro); }
    get gastos()    { return aPesos(this.movimientos.gasto); }

    /**
     * EL NÚMERO QUE EL CAJERO DEBE ENCONTRAR EN EL CAJÓN.
     *
     * Es lo que el banco cuenta al cerrar. Si el backend no llega al mismo
     * número, la diferencia del corte no da cero y el recorrido falla.
     */
    get efectivoEnCajon() {
        return aPesos(
            this.fondo
            + this.ventas.efectivo
            + this.propinas.efectivo      // está físicamente en el cajón (§30)
            + this.movimientos.deposito
            - this.movimientos.retiro
            - this.movimientos.gasto
        );
    }

    resumen() {
        return [
            `fondo inicial      ${this.fondo / 100}`,
            `ventas efectivo    ${this.totalEfectivo}`,
            `propinas efectivo  ${this.propinasEfectivo}`,
            `depósitos          ${this.depositos}`,
            `retiros           -${this.retiros}`,
            `gastos            -${this.gastos}`,
            `= en el cajón      ${this.efectivoEnCajon}`,
        ].join('\n        ');
    }
}

module.exports = { LibroDeCaja, desglosar, cent, aPesos };
