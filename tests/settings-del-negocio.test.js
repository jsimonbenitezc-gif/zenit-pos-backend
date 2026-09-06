/**
 * GET /api/settings devuelve los ajustes DEL NEGOCIO, no los del usuario.
 *
 * ── EL DEFECTO QUE VIGILA ───────────────────────────────────────────────────
 *
 * La ruta leía `req.user.id`. Para el dueño eso da igual —su id ES su
 * business_id—, pero un EMPLEADO con cuenta propia (los que crea
 * `POST /api/staff` y entran por `/api/staff/login`) recibía **{}**: sus
 * propios settings, que están vacíos.
 *
 * Y de ahí colgaba todo lo demás. Lo más grave es el impuesto: sin
 * `tax_enabled` el POS de ese empleado arma el carrito SIN IVA mientras el
 * backend registra la venta CON IVA. El cajero le pide al cliente un monto y el
 * sistema guarda otro — el descuadre que el BLOQUE 8 declara inaceptable (§29).
 * Detrás venían las propinas, los `permisos_roles` (sin puestos no hay PIN que
 * validar), la moneda, el logo y el horario.
 *
 * Hoy es un defecto LATENTE: ningún cliente usa todavía `/api/staff/login`
 * —el equipo se firma con la cuenta del dueño y elige puesto—, así que nadie
 * puede llegar. Se arregla y se fija ahora porque el día que exista la pantalla
 * de "empleados con cuenta" el síntoma sería dinero mal cobrado, y nadie
 * buscaría la causa en esta línea.
 */
jest.mock('../utils/push', () => ({
    enviarNotificacion: jest.fn(),
    getPrefs: jest.fn().mockResolvedValue({}),
}));

const request = require('supertest');
const { app, sequelize, initTestDb, createTestOwner } = require('./setup');

const auth = (token) => ({ Authorization: `Bearer ${token}` });

describe('GET /api/settings — los ajustes son del NEGOCIO', () => {
    let owner, ownerToken, empleadoToken;

    beforeAll(async () => {
        await initTestDb();
        ({ user: owner, token: ownerToken } = await createTestOwner());

        // El dueño configura su negocio.
        await request(app).put('/api/settings').set(auth(ownerToken)).send({
            business_name: 'Taquería El Buen Pastor',
            currency_symbol: '$',
            tax_enabled: true, tax_rate: 16, tax_included: true, tax_name: 'IVA',
            propinas_activas: true,
            permisos_roles: { cajero: { nombre: 'Cajero', activo: true } },
        });

        // Y da de alta a una cajera CON CUENTA propia.
        const alta = await request(app).post('/api/staff').set(auth(ownerToken))
            .send({ name: 'Ana', username: 'ana', password: 'Pass12345', role: 'cashier' });
        expect(alta.status).toBe(201);

        const login = await request(app).post('/api/staff/login')
            .send({ username: 'ana', password: 'Pass12345', business_email: owner.username });
        expect(login.status).toBe(200);
        empleadoToken = login.body.token || login.body.accessToken;
        expect(empleadoToken).toBeTruthy();
    });

    afterAll(async () => { await sequelize.close(); });

    it('el dueño ve la configuración de su negocio', async () => {
        const r = await request(app).get('/api/settings').set(auth(ownerToken));
        expect(r.status).toBe(200);
        expect(r.body.tax_enabled).toBe(true);
        expect(r.body.tax_rate).toBe(16);
    });

    it('🔒 el empleado ve EXACTAMENTE la misma configuración de impuesto', async () => {
        const r = await request(app).get('/api/settings').set(auth(empleadoToken));
        expect(r.status).toBe(200);
        // Sin esto el POS del empleado cobra sin IVA y el backend registra con IVA.
        expect(r.body.tax_enabled).toBe(true);
        expect(r.body.tax_rate).toBe(16);
        expect(r.body.tax_included).toBe(true);
        expect(r.body.tax_name).toBe('IVA');
    });

    it('🔒 y también las propinas, los puestos y los datos del negocio', async () => {
        const r = await request(app).get('/api/settings').set(auth(empleadoToken));
        expect(r.body.propinas_activas).toBe(true);
        // Sin los puestos no hay PIN contra el que validar una cancelación (§19.19).
        expect(r.body.permisos_roles).toBeTruthy();
        expect(r.body.permisos_roles.cajero).toBeTruthy();
        expect(r.body.business_name).toBe('Taquería El Buen Pastor');
        expect(r.body.currency_symbol).toBe('$');
    });

    it('el empleado sigue SIN poder cambiar lo que es del dueño', async () => {
        // El arreglo es de LECTURA. Que ahora vea el impuesto no le da permiso
        // para tocarlo: eso sigue siendo 403 (§29.8).
        const r = await request(app).put('/api/settings').set(auth(empleadoToken))
            .send({ tax_rate: 0 });
        expect(r.status).toBe(403);

        // Y la tasa del negocio no se movió.
        const tras = await request(app).get('/api/settings').set(auth(ownerToken));
        expect(tras.body.tax_rate).toBe(16);
    });
});
