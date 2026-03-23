/**
 * gIVEMEGAME.IO — Billing helpers (webhook-first, Stripe)
 * Source of truth: user_billing table, updated only from webhooks.
 */

const PAID_STATUSES = new Set(['active', 'trialing']);
const REVOKED_STATUSES = new Set(['canceled', 'unpaid', 'incomplete_expired', 'past_due']);
const PLAN_PRO = 'pro_teacher_monthly';

/**
 * @param {object} row - user_billing row
 * @returns {boolean}
 */
function hasPaidAccess(row) {
	if (!row || !row.subscription_status) return false;
	if (PAID_STATUSES.has(row.subscription_status)) return true;
	if (REVOKED_STATUSES.has(row.subscription_status)) return false;
	// past_due: keep access for grace period, but track in DB
	if (row.subscription_status === 'past_due') return row.current_period_end && new Date(row.current_period_end) > new Date();
	return false;
}

/**
 * @param {import('pg').Pool} pool
 * @param {string} userId
 * @returns {Promise<object|null>}
 */
async function getUserBillingState(pool, userId) {
	if (!pool || !userId) return null;
	try {
		const { rows } = await pool.query(
			`SELECT user_id, stripe_customer_id, stripe_subscription_id, stripe_price_id,
			        subscription_status, current_period_end, plan_code, billing_state_updated_at
			 FROM public.user_billing WHERE user_id = $1 LIMIT 1`,
			[userId]
		);
		return rows[0] || null;
	} catch (e) {
		console.error('[Billing] getUserBillingState error:', e.message);
		return null;
	}
}

/**
 * Map Stripe subscription status to app-friendly status
 */
function mapStripeStatus(stripeStatus) {
	if (!stripeStatus || typeof stripeStatus !== 'string') return 'none';
	const s = stripeStatus.toLowerCase();
	if (PAID_STATUSES.has(s) || REVOKED_STATUSES.has(s)) return s;
	return 'none';
}

/**
 * Upsert user billing from webhook data
 */
async function upsertBillingFromWebhook(pool, userId, data) {
	if (!pool || !userId) throw new Error('pool and userId required');
	const {
		stripeCustomerId,
		stripeSubscriptionId,
		stripePriceId,
		subscriptionStatus,
		currentPeriodEnd,
		planCode = PLAN_PRO
	} = data;
	const status = mapStripeStatus(subscriptionStatus);
	await pool.query(
		`INSERT INTO public.user_billing (user_id, stripe_customer_id, stripe_subscription_id, stripe_price_id,
		 subscription_status, current_period_end, plan_code, billing_state_updated_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now())
		 ON CONFLICT (user_id) DO UPDATE SET
		   stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, user_billing.stripe_customer_id),
		   stripe_subscription_id = COALESCE(EXCLUDED.stripe_subscription_id, user_billing.stripe_subscription_id),
		   stripe_price_id = COALESCE(EXCLUDED.stripe_price_id, user_billing.stripe_price_id),
		   subscription_status = EXCLUDED.subscription_status,
		   current_period_end = EXCLUDED.current_period_end,
		   plan_code = EXCLUDED.plan_code,
		   billing_state_updated_at = now(),
		   updated_at = now()`,
		[userId, stripeCustomerId || null, stripeSubscriptionId || null, stripePriceId || null, status, currentPeriodEnd || null, planCode]
	);
}

/**
 * Revoke billing (subscription deleted/canceled)
 */
async function revokeBilling(pool, userId) {
	if (!pool || !userId) return;
	await pool.query(
		`UPDATE public.user_billing SET
		   subscription_status = 'none',
		   plan_code = 'free',
		   stripe_subscription_id = NULL,
		   stripe_price_id = NULL,
		   current_period_end = NULL,
		   billing_state_updated_at = now(),
		   updated_at = now()
		 WHERE user_id = $1`,
		[userId]
	);
}

/**
 * Check if Stripe webhook event was already processed (idempotency)
 */
async function wasEventProcessed(pool, stripeEventId) {
	if (!pool || !stripeEventId) return false;
	const { rows } = await pool.query(
		'SELECT 1 FROM public.billing_events WHERE stripe_event_id = $1 LIMIT 1',
		[stripeEventId]
	);
	return rows.length > 0;
}

/**
 * Record event as processed
 */
async function recordEventProcessed(pool, stripeEventId, eventType) {
	if (!pool || !stripeEventId) return;
	await pool.query(
		'INSERT INTO public.billing_events (stripe_event_id, event_type) VALUES ($1, $2) ON CONFLICT (stripe_event_id) DO NOTHING',
		[stripeEventId, eventType || 'unknown']
	);
}

module.exports = {
	hasPaidAccess,
	getUserBillingState,
	mapStripeStatus,
	upsertBillingFromWebhook,
	revokeBilling,
	wasEventProcessed,
	recordEventProcessed,
	PLAN_PRO,
	PAID_STATUSES,
	REVOKED_STATUSES
};
