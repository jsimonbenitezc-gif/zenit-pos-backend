const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { authenticate } = require('../middleware/auth');
const { User } = require('../models');

// ─── Helpers ────────────────────────────────────────────────────────────────

function planInfo(user) {
    const now = new Date();
    const expiresAt = user.plan_expires_at ? new Date(user.plan_expires_at) : null;
    const isPremium  = (user.plan === 'premium' || user.plan === 'trial') && expiresAt && expiresAt > now;
    const daysLeft   = expiresAt ? Math.max(0, Math.ceil((expiresAt - now) / 86400000)) : 0;
    return { plan: user.plan, plan_expires_at: expiresAt, is_premium: isPremium, days_left: daysLeft };
}

// ─── GET /api/billing/status ─────────────────────────────────────────────────
// Devuelve el estado del plan del usuario autenticado
router.get('/status', authenticate, async (req, res) => {
    try {
        const user = await User.findByPk(req.user.id);
        if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
        res.json(planInfo(user));
    } catch (err) {
        res.status(500).json({ error: 'Error interno' });
    }
});

// ─── POST /api/billing/start-trial ──────────────────────────────────────────
// Activa 30 días de prueba (solo si nunca ha tenido plan premium ni trial)
router.post('/start-trial', authenticate, async (req, res) => {
    try {
        const user = await User.findByPk(req.user.id);
        if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

        // Solo si nunca ha activado prueba antes
        if (user.plan !== 'free' || user.plan_expires_at) {
            return res.status(400).json({ error: 'La prueba gratuita ya fue utilizada' });
        }

        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 30);
        await user.update({ plan: 'trial', plan_expires_at: expiresAt });

        res.json({ message: 'Prueba de 30 días activada', ...planInfo(user) });
    } catch (err) {
        res.status(500).json({ error: 'Error interno' });
    }
});

// ─── POST /api/billing/create-checkout ──────────────────────────────────────
// Crea una sesión de Stripe Checkout y devuelve la URL
router.post('/create-checkout', authenticate, async (req, res) => {
    try {
        const user = await User.findByPk(req.user.id);
        if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

        // Crear o recuperar customer de Stripe
        let customerId = user.stripe_customer_id;
        if (!customerId) {
            const customer = await stripe.customers.create({
                email: user.username, // username es el email en Zenit
                name: user.name,
                metadata: { user_id: String(user.id) }
            });
            customerId = customer.id;
            await user.update({ stripe_customer_id: customerId });
        }

        const session = await stripe.checkout.sessions.create({
            customer: customerId,
            payment_method_types: ['card'],
            line_items: [{
                price: process.env.STRIPE_PRICE_ID,
                quantity: 1
            }],
            mode: 'subscription',
            success_url: `${process.env.APP_URL}/billing-success`,
            cancel_url:  `${process.env.APP_URL}/billing-cancel`,
            locale: 'es',
            allow_promotion_codes: true,
            payment_method_options: {
                card: { request_three_d_secure: 'automatic' }
            }
        });

        res.json({ url: session.url });
    } catch (err) {
        console.error('Stripe checkout error:', err.message);
        res.status(500).json({ error: 'No se pudo iniciar el proceso de pago' });
    }
});

// ─── POST /api/billing/portal ────────────────────────────────────────────────
// Crea sesión del portal de Stripe (gestionar/cancelar suscripción, ver facturas)
router.post('/portal', authenticate, async (req, res) => {
    try {
        const user = await User.findByPk(req.user.id);
        if (!user || !user.stripe_customer_id) {
            return res.status(400).json({ error: 'No hay suscripción activa' });
        }

        const session = await stripe.billingPortal.sessions.create({
            customer: user.stripe_customer_id,
            return_url: `${process.env.APP_URL}/billing-return`
        });

        res.json({ url: session.url });
    } catch (err) {
        console.error('Stripe portal error:', err.message);
        res.status(500).json({ error: 'No se pudo abrir el portal de facturación' });
    }
});

// ─── POST /api/billing/webhook ───────────────────────────────────────────────
// Recibe eventos de Stripe (DEBE ir ANTES del express.json() global — usa raw body)
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error('Webhook signature error:', err.message);
        return res.status(400).json({ error: `Webhook error: ${err.message}` });
    }

    try {
        switch (event.type) {
            // Suscripción creada o renovada exitosamente
            case 'invoice.payment_succeeded': {
                const invoice = event.data.object;
                if (invoice.subscription) {
                    const sub = await stripe.subscriptions.retrieve(invoice.subscription);
                    const user = await User.findOne({ where: { stripe_customer_id: sub.customer } });
                    if (user) {
                        const expiresAt = new Date(sub.current_period_end * 1000);
                        await user.update({
                            plan: 'premium',
                            plan_expires_at: expiresAt,
                            stripe_subscription_id: sub.id
                        });
                        console.log(`✅ Plan premium activado: user ${user.id} hasta ${expiresAt.toISOString()}`);
                    }
                }
                break;
            }

            // Pago fallido
            case 'invoice.payment_failed': {
                const invoice = event.data.object;
                const user = await User.findOne({ where: { stripe_customer_id: invoice.customer } });
                if (user) {
                    console.warn(`⚠️ Pago fallido para user ${user.id}`);
                    // No degradamos inmediatamente — Stripe reintenta automáticamente
                    // La degradación ocurre en customer.subscription.deleted
                }
                break;
            }

            // Suscripción cancelada / no renovada
            case 'customer.subscription.deleted': {
                const sub = event.data.object;
                const user = await User.findOne({ where: { stripe_customer_id: sub.customer } });
                if (user) {
                    await user.update({
                        plan: 'free',
                        plan_expires_at: null,
                        stripe_subscription_id: null
                    });
                    console.log(`ℹ️ Plan degradado a free: user ${user.id}`);
                }
                break;
            }

            // Suscripción actualizada (ej. cambio de plan)
            case 'customer.subscription.updated': {
                const sub = event.data.object;
                const user = await User.findOne({ where: { stripe_customer_id: sub.customer } });
                if (user && sub.status === 'active') {
                    const expiresAt = new Date(sub.current_period_end * 1000);
                    await user.update({ plan: 'premium', plan_expires_at: expiresAt });
                }
                break;
            }

            default:
                // Ignorar eventos no manejados
                break;
        }

        res.json({ received: true });
    } catch (err) {
        console.error('Webhook handler error:', err);
        res.status(500).json({ error: 'Error procesando webhook' });
    }
});

module.exports = router;
