// ============================================================================
// pruebas-postgres/lib/afirmar.js — afirmaciones y reporte
//
// El BLOQUE 15 pide recorridos "que terminan en una afirmación sobre el DINERO,
// no en un 200". Estos helpers existen para que esa afirmación se escriba en una
// línea y, cuando falle, diga CUÁNTO falta y de dónde salía cada número — un
// "expected 431.2 to be 431.19" no le sirve a nadie para arreglar una caja.
// ============================================================================

class FalloDeAfirmacion extends Error {}

/** Centavos enteros: comparar dinero con floats produce fallos fantasma. */
function centavos(n) {
    return Math.round((parseFloat(n) || 0) * 100);
}

function pesos(n) {
    const v = (parseFloat(n) || 0);
    return `$${v.toFixed(2)}`;
}

class Afirmador {
    constructor(nombreRecorrido) {
        this.recorrido = nombreRecorrido;
        this.comprobaciones = 0;
        this.fallos = [];
    }

    _ok(descripcion) {
        this.comprobaciones++;
        console.log(`      ✓ ${descripcion}`);
    }

    _fallo(descripcion, detalle) {
        this.comprobaciones++;
        this.fallos.push({ descripcion, detalle });
        console.log(`      ✗ ${descripcion}`);
        console.log(`        ${detalle}`);
    }

    /** Igualdad de DINERO, al centavo exacto. */
    dinero(descripcion, obtenido, esperado) {
        if (centavos(obtenido) === centavos(esperado)) {
            this._ok(`${descripcion} = ${pesos(esperado)}`);
        } else {
            const dif = (centavos(obtenido) - centavos(esperado)) / 100;
            this._fallo(
                descripcion,
                `esperaba ${pesos(esperado)} y llegó ${pesos(obtenido)} ` +
                `(descuadre de ${dif > 0 ? '+' : ''}${dif.toFixed(2)})`
            );
        }
        return this;
    }

    igual(descripcion, obtenido, esperado) {
        if (obtenido === esperado) this._ok(`${descripcion} = ${JSON.stringify(esperado)}`);
        else this._fallo(descripcion, `esperaba ${JSON.stringify(esperado)} y llegó ${JSON.stringify(obtenido)}`);
        return this;
    }

    cierto(descripcion, condicion, detalle = 'la condición no se cumplió') {
        if (condicion) this._ok(descripcion);
        else this._fallo(descripcion, detalle);
        return this;
    }

    /**
     * El invariante del BLOQUE 8, que ninguna venta puede romper:
     *     total = subtotal + tax_amount
     * Se comprueba en TODA venta del banco: si un día alguien mete la propina o
     * un modificador dentro del total, revienta aquí y no en la caja de nadie.
     */
    invarianteImpuesto(descripcion, pedido) {
        const sub = pedido.subtotal;
        if (sub === null || sub === undefined) {
            // Pedido anterior al BLOQUE 8: su total ES lo cobrado, no hay desglose.
            this._ok(`${descripcion} — sin desglose (subtotal null), nada que cuadrar`);
            return this;
        }
        const suma = centavos(sub) + centavos(pedido.tax_amount);
        if (suma === centavos(pedido.total)) {
            this._ok(`${descripcion} — total = subtotal + impuesto (${pesos(pedido.total)})`);
        } else {
            this._fallo(
                descripcion,
                `total ${pesos(pedido.total)} ≠ subtotal ${pesos(sub)} + impuesto ${pesos(pedido.tax_amount)} ` +
                `(= ${pesos(suma / 100)})`
            );
        }
        return this;
    }

    get paso() { return this.fallos.length === 0; }
}

module.exports = { Afirmador, FalloDeAfirmacion, centavos, pesos };
