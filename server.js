require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { syncDatabase } = require('./models');

const app = express();
const PORT = process.env.PORT || 3000;

// Confiar en el proxy de Render.com (necesario para que el rate limiter funcione correctamente)
app.set('trust proxy', 1);

// Orígenes permitidos para conectarse al API
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);

app.use(cors({
    origin: (origin, callback) => {
        // Permitir requests sin origen (apps de escritorio, mobile, Postman, etc.)
        if (!origin) return callback(null, true);
        // Permitir si el origen está en la lista
        if (allowedOrigins.includes(origin)) return callback(null, true);
        callback(new Error('Origen no permitido por CORS'));
    },
    credentials: true
}));
// Billing (Stripe webhook necesita body sin parsear — DEBE ir antes de express.json)
app.use('/api/billing', require('./routes/billing'));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Logging
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});

// Routes
app.get('/', (req, res) => {
    res.json({
        message: 'Zenit POS API',
        version: '1.0.0',
        status: 'running'
    });
});

// Páginas de retorno de Stripe Checkout (el navegador redirige aquí tras el pago)
app.get('/billing-success', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Pago exitoso</title>
    <style>body{font-family:sans-serif;text-align:center;padding:60px;background:#f0fdf4;}
    h1{color:#16a34a;}p{color:#374151;}</style></head>
    <body><h1>¡Pago completado!</h1>
    <p>Tu plan Premium ya está activo.<br>Puedes cerrar esta ventana y volver a Zenit POS.</p>
    </body></html>`);
});

app.get('/billing-cancel', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Pago cancelado</title>
    <style>body{font-family:sans-serif;text-align:center;padding:60px;background:#fafafa;}
    h1{color:#6b7280;}p{color:#374151;}</style></head>
    <body><h1>Pago cancelado</h1>
    <p>No se realizó ningún cargo.<br>Puedes cerrar esta ventana y volver a Zenit POS.</p>
    </body></html>`);
});

app.get('/billing-return', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Portal de facturación</title>
    <style>body{font-family:sans-serif;text-align:center;padding:60px;background:#fafafa;}
    h1{color:#374151;}</style></head>
    <body><h1>Listo</h1><p>Puedes cerrar esta ventana y volver a Zenit POS.</p>
    </body></html>`);
});

// ─── GET /kds?token=<jwt>  ────────────────────────────────────────────────────
// Página web del KDS para ver en el navegador de cualquier dispositivo.
// Polling cada 15 s al backend usando el token JWT en la query.
app.get('/kds', (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(401).send('<h1>Token requerido. Escanea el QR desde la app.</h1>');
    try {
        require('jsonwebtoken').verify(token, process.env.JWT_SECRET);
    } catch {
        return res.status(401).send('<h1>Token inválido o expirado. Genera un nuevo QR desde la app.</h1>');
    }

    const safeToken = token.replace(/['"<>&]/g, '');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cocina — Zenit KDS</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#111827;color:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh}
    header{background:#1f2937;padding:12px 20px;display:flex;align-items:center;justify-content:space-between;border-bottom:2px solid #374151;position:sticky;top:0;z-index:10}
    .logo{font-size:1.2em;font-weight:700}.logo span{color:#818cf8}
    .status{display:flex;align-items:center;gap:8px;font-size:0.85em;color:#d1d5db}
    .dot{width:10px;height:10px;border-radius:50%;background:#10b981;flex-shrink:0}
    .dot.error{background:#ef4444}
    .reloj{color:#9ca3af;font-size:0.9em;font-variant-numeric:tabular-nums}
    #grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:14px;padding:16px}
    .card{background:#1f2937;border-radius:12px;border:2px solid #374151;overflow:hidden;animation:entrar 0.25s ease}
    .card.nueva{border-color:#818cf8}.card.urgente{border-color:#ef4444}
    @keyframes entrar{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}
    .card-header{background:#374151;padding:10px 14px;display:flex;align-items:center;justify-content:space-between;gap:8px}
    .card-num{font-size:1.4em;font-weight:800}
    .badge{padding:3px 10px;border-radius:20px;font-size:0.78em;font-weight:700}
    .badge-mesa{background:#4f46e5;color:#fff}.badge-mostrador{background:#059669;color:#fff}.badge-delivery{background:#d97706;color:#fff}
    .card-tiempo{font-size:0.8em;color:#9ca3af;white-space:nowrap}
    .card-tiempo.tarde{color:#f59e0b;font-weight:600}.card-tiempo.urgente{color:#ef4444;font-weight:700}
    .card-items{padding:10px 14px}
    .item{display:flex;align-items:flex-start;gap:10px;padding:7px 0;border-bottom:1px solid #374151}
    .item:last-child{border-bottom:none}
    .item-qty{background:#4b5563;color:#f9fafb;font-weight:700;min-width:30px;height:30px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:0.95em;flex-shrink:0}
    .item-nombre{font-weight:600;font-size:1em;line-height:1.3}
    .card-nota{margin:0 14px 8px;padding:6px 10px;background:#2d2009;border-left:3px solid #f59e0b;border-radius:0 6px 6px 0;font-size:0.82em;color:#fcd34d}
    .card-footer{padding:10px 14px}
    .btn-listo{width:100%;padding:11px;border:none;border-radius:8px;font-size:0.95em;font-weight:700;cursor:pointer;color:#fff;background:#10b981;transition:background 0.15s}
    .btn-listo:hover{background:#059669}
    .empty{grid-column:1/-1;text-align:center;padding:80px 20px}
    .empty p{font-size:1.2em;color:#4b5563;margin-top:12px}
  </style>
</head>
<body>
<header>
  <div class="logo">Zenit <span>Cocina</span></div>
  <div class="status"><div class="dot" id="dot"></div><span id="status-text">Cargando...</span></div>
  <div class="reloj" id="reloj"></div>
</header>
<div id="grid"></div>
<script>
  const TOKEN = '${safeToken}';
  const API   = '/api';
  let orders  = [];

  // Comandas marcadas como listas en cocina (persisten mientras la página esté abierta)
  // No cambian el status del backend — la mesa sigue activa hasta que el cajero cobra.
  const dismissed = new Set(JSON.parse(sessionStorage.getItem('kds_ok') || '[]'));

  async function cargar() {
    try {
      const r = await fetch(API + '/orders?status=registrado&limit=100', {
        headers: { 'Authorization': 'Bearer ' + TOKEN }
      });
      if (!r.ok) throw new Error();
      const data = await r.json();
      const todas = Array.isArray(data) ? data : (data.data || data.orders || data.rows || []);
      orders = todas.filter(function(o){ return !dismissed.has(o.id); });
      document.getElementById('dot').className = 'dot';
      document.getElementById('status-text').textContent = 'Conectado · actualiza cada 15s';
      renderAll();
    } catch {
      document.getElementById('dot').className = 'dot error';
      document.getElementById('status-text').textContent = 'Sin conexión — reintentando...';
    }
  }

  function renderAll() {
    const grid = document.getElementById('grid');
    if (!orders.length) {
      grid.innerHTML = '<div class="empty"><div style="font-size:3em">✅</div><p>Todo al día — sin comandas pendientes</p></div>';
      return;
    }
    grid.innerHTML = orders.map(renderCard).join('');
  }

  function renderCard(o) {
    const mins = Math.floor((Date.now() - new Date(o.createdAt).getTime()) / 60000);
    const timeText  = mins < 1 ? 'Ahora mismo' : mins + ' min';
    const timeClass = mins >= 20 ? 'urgente' : mins >= 10 ? 'tarde' : '';
    const cardClass = mins >= 20 ? 'urgente' : 'nueva';
    const table = (o.table && o.table.name) || (o.Table && o.Table.name);
    const tipo  = o.order_type;
    const badgeText  = table ? ('\\u{1FA91} ' + esc(table)) : (tipo === 'domicilio' ? 'Domicilio' : (tipo === 'llevar' ? 'Para llevar' : 'Mostrador'));
    const badgeClass = table ? 'badge-mesa' : (tipo === 'domicilio' ? 'badge-delivery' : 'badge-mostrador');
    const items = (o.items || o.OrderItems || []).map(function(i) {
      return '<div class="item"><div class="item-qty">' + (i.quantity||1) + '</div><div class="item-nombre">' + esc((i.product && i.product.name) || (i.Product && i.Product.name) || 'Producto') + '</div></div>';
    }).join('');
    const nota = o.notes ? '<div class="card-nota">\\uD83D\\uDCDD ' + esc(o.notes) + '</div>' : '';
    return '<div class="card ' + cardClass + '" id="card-' + o.id + '">' +
      '<div class="card-header"><div class="card-num">#' + o.id + '</div><div class="badge ' + badgeClass + '">' + badgeText + '</div><div class="card-tiempo ' + timeClass + '">' + timeText + '</div></div>' +
      '<div class="card-items">' + items + '</div>' + nota +
      '<div class="card-footer"><button class="btn-listo" onclick="completar(' + o.id + ')">\\u2713 Completado</button></div>' +
      '</div>';
  }

  function completar(id) {
    // Marcar como lista en cocina — NO cambia el status en el backend.
    // La mesa permanece activa hasta que el cajero procese el cobro.
    dismissed.add(id);
    sessionStorage.setItem('kds_ok', JSON.stringify([...dismissed]));
    orders = orders.filter(function(o){ return o.id !== id; });
    var card = document.getElementById('card-' + id);
    if (card) { card.style.opacity='0'; card.style.transform='scale(0.9)'; card.style.transition='all 0.2s'; setTimeout(function(){ card.remove(); renderAll(); }, 200); }
  }

  function esc(s) {
    return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function actualizarReloj() {
    document.getElementById('reloj').textContent = new Date().toLocaleTimeString('es',{hour:'2-digit',minute:'2-digit'});
  }

  cargar();
  setInterval(cargar, 15000);
  actualizarReloj();
  setInterval(actualizarReloj, 10000);
  setInterval(function(){ if(orders.length) renderAll(); }, 60000);
</script>
</body>
</html>`);
});

// API Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/products', require('./routes/products'));
app.use('/api/categories', require('./routes/categories'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/customers', require('./routes/customers'));
app.use('/api/stats', require('./routes/stats'));
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/offers', require('./routes/offers'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/staff', require('./routes/staff'));
app.use('/api/alerts', require('./routes/alerts'));
app.use('/api/branches', require('./routes/branches'));
app.use('/api/tables',   require('./routes/tables'));
app.use('/api/turnos',   require('./routes/turnos'));

// Error handling
app.use((err, req, res, next) => {
    console.error('Error:', err);
    res.status(err.status || 500).json({ error: 'Error interno del servidor' });
});

// 404
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

// Sync database and start server
syncDatabase().then(() => {
    app.listen(PORT, () => {
        console.log(`🚀 Zenit POS API running on http://localhost:${PORT}`);
        console.log(`📝 Environment: ${process.env.NODE_ENV}`);
    });
});

module.exports = app;