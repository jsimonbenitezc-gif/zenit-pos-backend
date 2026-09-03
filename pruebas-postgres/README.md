# Banco de pruebas contra PostgreSQL real

```bash
npm run probar:postgres
```

Un guion **determinista** —sin LLM, sin tokens, apto para CI— que levanta un
PostgreSQL desechable, arranca el backend de verdad contra él, siembra una
taquería completa y recorre un día entero de caja terminando en una **afirmación
sobre el dinero**, no en un 200.

Tarda unos 20 segundos. No necesita configuración: si no hay Docker, usa un
binario embebido de PostgreSQL.

---

## Por qué existe

Las pruebas de `npm test` corren sobre **SQLite**. Producción es **PostgreSQL**.
Ese hueco no es teórico: costó **un mes** con el cobro de mesas devolviendo 500
en producción mientras las 395 pruebas pasaban en verde. SQLite ignora
`FOR UPDATE`; Postgres lo rechaza sobre el lado nullable de un `OUTER JOIN`
(CLAUDE.md §19.25, §30). Ninguna prueba de comportamiento podía verlo.

El segundo agujero es de dinero: un descuadre de caja solo se nota **al final**
de un recorrido largo —abrir turno → vender → dividir cuentas → gastos →
propinas → cerrar y contar—. Ninguna prueba unitaria recorre eso entero.

**Está comprobado que atrapa las dos cosas.** Ver *Cómo se verificó* abajo.

---

## ⚠️ Nunca contra producción

`zenit-pos-backend/.env` tiene las credenciales de la Supabase **real**, y la
primera línea de `server.js` carga dotenv. Hay **tres defensas independientes**,
descritas al detalle en [`lib/guardas.js`](lib/guardas.js):

1. **Estructural** — el backend se lanza con el `cwd` en una carpeta temporal
   vacía, así que dotenv no encuentra ningún `.env` y esas credenciales no
   llegan a existir en el proceso. Además recibe un entorno mínimo, no una copia
   del actual.
2. **Declarativa** — se exige que el host sea local y que el nombre de la base
   contenga `prueba`. Cualquier cosa que huela a Supabase, Render o AWS aborta.
3. **Empírica** — tras arrancar, se busca con nuestra propia conexión la primera
   cuenta registrada por HTTP. Si no está en la base desechable, todo se detiene.

Y no hace falta un endpoint que borre negocios: al terminar **se tira la base
entera**. Construir ese endpoint sería de lo más peligroso que se le puede
agregar a Zenit.

---

## Qué recorre

| Etiqueta | Recorrido | Termina afirmando |
|---|---|---|
| `caja` | Un día completo: turno, mostrador, mesa dividida por items, descuento con PIN, cancelación, gasto, retiro, depósito, movimiento anulado, venta en otra sucursal | **la diferencia del corte es exactamente $0** |
| `incluido` | Lo mismo con el IVA **incluido** en el precio | el invariante `total = subtotal + impuesto`, y que el cajón **no se mueve** |
| `agregado` | Lo mismo con el IVA **agregado** al precio | que el cobro **sube** y el corte lo cuenta |
| `diferida` | Ventas offline que suben tarde (§26) | que caen en el **día y el turno** correctos, con su precio y sin duplicarse |
| `reloj` | 🔎 **hallazgo abierto** (ver abajo) | — |

Uno solo:

```bash
npm run probar:postgres -- --recorrido=caja
```

Otras banderas: `--verboso` (vuelca la salida del backend y del Postgres),
`--puerto-api=3099`, `--puerto-db=55432`.

---

## La contabilidad paralela

La pieza que hace que esto valga algo es [`lib/libro.js`](lib/libro.js), y su
regla es **no importar nada de `utils/`**.

Si el banco le preguntara al backend cuánto efectivo espera y luego cerrara el
turno contando ese mismo número, la diferencia daría cero **siempre**, incluso
con la fórmula completamente mal. Sería una prueba que pasa con y sin el
arreglo, que es la definición de una prueba inútil.

Así que el banco lleva su propio libro: va anotando peso a peso lo que él mismo
hizo y cierra el turno contando **ese** número. Si el backend calcula distinto,
la diferencia sale distinta de cero y el fallo dice el descuadre exacto.

---

## 🔎 Hallazgo abierto

El recorrido `reloj` **falla hoy a propósito**: reproduce un defecto real que
este banco encontró el 2026-09-02, todavía sin arreglar. Se ejecuta y se reporta
en cada corrida, pero **no tumba el código de salida** — un banco que siempre
está en rojo deja de mirarse a la semana.

> El cierre de turno acota las ventas con `BETWEEN apertura AND ahora`, mientras
> los totales en vivo usan `>= apertura`. Y `resolverFechaVenta` acepta a
> propósito una venta fechada hasta **5 minutos en el futuro** ("tolerancia por
> relojes adelantados", §26). Una venta subida desde un equipo con el reloj un
> par de minutos adelantado **aparece en los totales y desaparece del cierre**,
> dejando un sobrante fantasma de su mismo importe.

El razonamiento completo y la corrección propuesta están en
[`recorridos/05-reloj-adelantado.js`](recorridos/05-reloj-adelantado.js). Cuando
se arregle, el recorrido pasa a verde y hay que quitarle la marca
`hallazgoAbierto`.

---

## Cómo se verificó que tiene dientes

Una red de seguridad que no se ha probado no es una red de seguridad. Se
comprobó reintroduciendo defectos reales:

| Defecto reintroducido | `npm test` (SQLite) | `npm run probar:postgres` |
|---|---|---|
| `lock` + `include` en `PUT /orders/:id/status` (el bug de un mes) | **75 pruebas en VERDE** | ❌ 500 al cobrar la mesa, salida 1 |
| La propina en efectivo deja de contar en el efectivo esperado | — | ❌ diferencia del corte ≠ 0, salida 1 |

La primera fila es el bloque entero en una línea: las pruebas de comportamiento
sobre SQLite no pueden ver ese fallo, y este banco lo señala en el sitio exacto.

*(El guard `tests/lock-sin-include.test.js` sí atrapa ese caso concreto, pero lo
hace leyendo el código fuente en busca de ese patrón. Este banco lo atrapa por
comportamiento, así que también cubre las variantes que ese guard no conoce.)*

---

## Añadir un recorrido

Un archivo en `recorridos/`, ordenado por nombre:

```js
module.exports = {
    nombre: 'Lo que prueba, en una frase',
    etiqueta: 'corta',            // para --recorrido=
    async ejecutar({ api, af, sembrar, db }) {
        const t = await sembrar('corta', { productos: ['pastor'] });
        // ...
        af.dinero('DIFERENCIA DEL CORTE', cerrado.diferencia, 0);
    },
};
```

- `sembrar(etiqueta, { productos })` registra y llena un negocio nuevo. Pide solo
  los productos que uses: `POST /api/products` admite **30 altas por minuto y por
  IP** y el banco siembra varios negocios en segundos. (El cliente HTTP reintenta
  ante un 429, así que esto es la primera defensa y no la única.)
- **Tope de 5 negocios por corrida**: `POST /api/auth/register` está limitado a 5
  por hora y por IP. Ese contador vive en la memoria del proceso del backend, que
  el banco arranca y mata en cada corrida, así que se reinicia solo entre
  corridas — pero dentro de una, cinco es el techo.
- Termina siempre en una afirmación sobre **dinero**, no en un 200.
