/**
 * gIVEMEGAME.IO — Billing helpers (Payment Link MVP, manual provisioning)
 * Source of truth: user_billing table. paid_access_enabled is set manually by admin.
 * Future: webhooks will update plan_code/subscription_status; paid_access_enabled can be driven by those.
 */

const PLAN_FREE = 'free';
const PLAN_PRO = 'pro_teacher_monthly';
const { isIP } = require('node:net');

/**
 * @param {object} row - user_billing row (or null)
 * @returns {boolean}
 */
function hasPaidAccess(row) {
	if (!row) return false;
	if (row.paid_access_enabled === true) return true;
	if (row.plan_code === PLAN_PRO) return true;
	// Nový tier systém: teacher/school/admin = paid access
	if (row.tier && ['teacher', 'school', 'admin'].includes(row.tier)) return true;
	return false;
}

/**
 * @param {object} row - user_billing row (or null)
 * @returns {string} 'free' | 'pro_teacher_monthly'
 */
function getUserPlan(row) {
	if (!row) return PLAN_FREE;
	return row.plan_code === PLAN_PRO ? PLAN_PRO : PLAN_FREE;
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
			`SELECT user_id, plan_code, paid_access_enabled, billing_note, billing_state_updated_at
			 FROM public.user_billing WHERE user_id = $1 LIMIT 1`,
			[userId]
		);
		const base = rows[0] || null;
		// Spojenie s novým tier systémom — ak migrácia 026 bežala.
		let tier = null;
		try {
			const { rows: tr } = await pool.query(`SELECT public.effective_tier($1) AS tier`, [userId]);
			tier = tr[0]?.tier || null;
		} catch (_) { /* migrácia 026 ešte nebežala */ }
		if (base) return { ...base, tier };
		if (tier && tier !== 'free') {
			return { user_id: userId, plan_code: PLAN_FREE, paid_access_enabled: false, tier };
		}
		return null;
	} catch (e) {
		// Fallback ak migrácia 017 ešte nebežala (chýbajú stĺpce)
		const missingCol = e.code === '42703' || /paid_access_enabled|billing_note/.test(String(e.message || ''));
		if (missingCol) {
			try {
				const { rows } = await pool.query(
					`SELECT user_id, plan_code, billing_state_updated_at
					 FROM public.user_billing WHERE user_id = $1 LIMIT 1`,
					[userId]
				);
				const r = rows[0];
				if (!r) return null;
				return { ...r, paid_access_enabled: false, billing_note: null };
			} catch (e2) {
				console.error('[Billing] getUserBillingState fallback error:', e2.message);
				return null;
			}
		}
		console.error('[Billing] getUserBillingState error:', e.message);
		return null;
	}
}

// ═══════════════════════════════════════════════════════════════════
// Tier-based subscription system (migrácia 026) — Stripe integration
// ═══════════════════════════════════════════════════════════════════

let _stripe = null;
let _stripeKey = null;

const FREE_LIMITS = Object.freeze({
	dailyGenerations:  3,
	maxLevel:          5,
	maxPerkLevel:      5,
	concurrentLobbies: 1,
});

const BILLING_ENV_REQUIREMENTS = Object.freeze([
	'BILLING_SUBSCRIPTIONS_ENABLED',
	'STRIPE_SECRET_KEY',
	'STRIPE_PRICE_TEACHER_MONTHLY',
	'STRIPE_PRICE_TEACHER_YEARLY',
	'STRIPE_WEBHOOK_SECRET',
	'APP_ORIGIN',
	'BILLING_TOS_VERSION',
	'BILLING_PRIVACY_VERSION',
	'BILLING_TERMS_URL',
	'BILLING_PRIVACY_URL',
	'BILLING_CONTACT_URL',
	'BILLING_WITHDRAWAL_CONSENT_TEXT',
]);

const BILLING_URL_REQUIREMENTS = new Set([
	'APP_ORIGIN',
	'BILLING_TERMS_URL',
	'BILLING_PRIVACY_URL',
	'BILLING_CONTACT_URL',
]);

const WEBHOOK_ENV_REQUIREMENTS = Object.freeze([
	'STRIPE_SECRET_KEY',
	'STRIPE_PRICE_TEACHER_MONTHLY',
	'STRIPE_PRICE_TEACHER_YEARLY',
	'STRIPE_WEBHOOK_SECRET',
]);

const BILLING_VALUE_NAMES = Object.freeze([
	...new Set([...BILLING_ENV_REQUIREMENTS, 'STRIPE_PRICE_SCHOOL_YEARLY']),
]);

const STRIPE_VALUE_PATTERNS = Object.freeze({
	STRIPE_SECRET_KEY: /^sk_(?:test|live)_[A-Za-z0-9_]+$/,
	STRIPE_WEBHOOK_SECRET: /^whsec_[A-Za-z0-9_]+$/,
	STRIPE_PRICE_TEACHER_MONTHLY: /^price_[A-Za-z0-9_]+$/,
	STRIPE_PRICE_TEACHER_YEARLY: /^price_[A-Za-z0-9_]+$/,
	STRIPE_PRICE_SCHOOL_YEARLY: /^price_[A-Za-z0-9_]+$/,
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function configuredValue(env, name) {
	return typeof env?.[name] === 'string' ? env[name].trim() : '';
}

function hasPlaceholderMarker(value) {
	return /REPLACE|YOUR|EXAMPLE|PLACEHOLDER|YYYY-MM-DD/i.test(value);
}

function isLocalHostname(hostname) {
	return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function isAllowedBillingUrl(value, env) {
	try {
		const parsed = new URL(value);
		if (!parsed.host || parsed.username || parsed.password || hasPlaceholderMarker(value)) return false;
		if (parsed.hostname === 'example' || parsed.hostname.endsWith('.example')) return false;
		if (parsed.protocol === 'https:') return true;
		const localRuntime = env?.NODE_ENV === 'development' || env?.NODE_ENV === 'test';
		return parsed.protocol === 'http:' && localRuntime && isLocalHostname(parsed.hostname);
	} catch (_) {
		return false;
	}
}

function isConfiguredBillingValueValid(env, name, value) {
	if (name === 'BILLING_SUBSCRIPTIONS_ENABLED') return value === 'true';
	if (!value || hasPlaceholderMarker(value)) return false;
	if (BILLING_URL_REQUIREMENTS.has(name)) return isAllowedBillingUrl(value, env);
	const stripePattern = STRIPE_VALUE_PATTERNS[name];
	return stripePattern ? stripePattern.test(value) : true;
}

function billingConfiguration(env = process.env) {
	const values = Object.fromEntries(
		BILLING_VALUE_NAMES.map((name) => [name, configuredValue(env, name)])
	);
	const missing = BILLING_ENV_REQUIREMENTS.filter(
		(name) => !isConfiguredBillingValueValid(env, name, values[name])
	);
	const webhookMissing = WEBHOOK_ENV_REQUIREMENTS.filter(
		(name) => !isConfiguredBillingValueValid(env, name, values[name])
	);
	if (values.STRIPE_PRICE_SCHOOL_YEARLY
		&& !isConfiguredBillingValueValid(env, 'STRIPE_PRICE_SCHOOL_YEARLY', values.STRIPE_PRICE_SCHOOL_YEARLY)) {
		missing.push('STRIPE_PRICE_SCHOOL_YEARLY');
		webhookMissing.push('STRIPE_PRICE_SCHOOL_YEARLY');
	}
	const priceNames = [
		'STRIPE_PRICE_TEACHER_MONTHLY',
		'STRIPE_PRICE_TEACHER_YEARLY',
		'STRIPE_PRICE_SCHOOL_YEARLY',
	];
	const seenPrices = new Set();
	for (const name of priceNames) {
		if (values[name] && seenPrices.has(values[name])) {
			if (!missing.includes(name)) missing.push(name);
			if (!webhookMissing.includes(name)) webhookMissing.push(name);
		}
		seenPrices.add(values[name]);
	}
	const safeValue = (name) => isConfiguredBillingValueValid(env, name, values[name]) ? values[name] : null;

	return {
		ready: missing.length === 0,
		missing,
		webhookReady: webhookMissing.length === 0,
		webhookMissing,
		prices: {
			teacher_monthly: values.STRIPE_PRICE_TEACHER_MONTHLY || null,
			teacher_yearly: values.STRIPE_PRICE_TEACHER_YEARLY || null,
			school_yearly: values.STRIPE_PRICE_SCHOOL_YEARLY || null,
		},
		origin: safeValue('APP_ORIGIN')?.replace(/\/$/, '') || null,
		webhookSecret: safeValue('STRIPE_WEBHOOK_SECRET'),
		legal: {
			tosVersion: safeValue('BILLING_TOS_VERSION'),
			privacyVersion: safeValue('BILLING_PRIVACY_VERSION'),
			termsUrl: safeValue('BILLING_TERMS_URL'),
			privacyUrl: safeValue('BILLING_PRIVACY_URL'),
			contactUrl: safeValue('BILLING_CONTACT_URL'),
			withdrawalText: safeValue('BILLING_WITHDRAWAL_CONSENT_TEXT'),
		},
	};
}

function getStripe(env = process.env) {
	const key = configuredValue(env, 'STRIPE_SECRET_KEY');
	if (!key) return null;
	if (_stripe && _stripeKey === key) return _stripe;
	try {
		// Let the installed SDK select its compatible default API version.
		_stripe = require('stripe')(key);
		_stripeKey = key;
		return _stripe;
	} catch (e) {
		console.error('[Billing] Stripe SDK initialization failed:', e.message);
		return null;
	}
}

function billingReady(env = process.env, stripeProvider = getStripe) {
	return billingConfiguration(env).ready && stripeProvider(env) !== null;
}

function billingWebhookReady(env = process.env, stripeProvider = getStripe) {
	return billingConfiguration(env).webhookReady && stripeProvider(env) !== null;
}

function billingWebhookAvailable(pool, env = process.env, stripeProvider = getStripe) {
	return Boolean(pool) && billingWebhookReady(env, stripeProvider);
}

function normalizeBillingUserId(value) {
	if (typeof value !== 'string') return null;
	const normalized = value.trim().toLowerCase();
	return UUID_PATTERN.test(normalized) ? normalized : null;
}

function hasIntegrationOwnershipEvidence(object, knownCustomer = false) {
	const hasUserMetadata = (metadata) => normalizeBillingUserId(metadata?.supabase_user_id) !== null;
	return Boolean(knownCustomer)
		|| hasUserMetadata(object?.metadata)
		|| hasUserMetadata(object?.subscription_details?.metadata);
}

function billingEventUserId(object, eventType, integrationOwned = false, knownCustomerUserId = null) {
	if (!integrationOwned) return null;
	const candidates = [
		object?.metadata?.supabase_user_id,
		object?.subscription_details?.metadata?.supabase_user_id,
		knownCustomerUserId,
	];
	if (eventType === 'checkout.session.completed') {
		candidates.push(object?.client_reference_id);
	}
	const validUserIds = new Set();
	for (const value of candidates) {
		const normalized = normalizeBillingUserId(value);
		if (normalized) validUserIds.add(normalized);
	}
	if (validUserIds.size > 1) {
		const error = new Error('Conflicting billing ownership signals');
		error.code = 'BILLING_OWNERSHIP_CONFLICT';
		throw error;
	}
	return validUserIds.values().next().value || null;
}

function normalizeConsentIp(value) {
	if (typeof value !== 'string') return null;
	const normalized = value.trim();
	return isIP(normalized) ? normalized : null;
}

async function persistBillingConsent(pool, userId, ip, env = process.env) {
	const config = billingConfiguration(env);
	const result = await pool.query(
		`UPDATE public.profiles SET
		   withdrawal_consent_at   = now(),
		   withdrawal_consent_ip   = $2,
		   withdrawal_consent_text = $3,
		   tos_version             = $4,
		   privacy_version         = $5,
		   updated_at              = now()
		 WHERE id = $1`,
		[userId, ip, config.legal.withdrawalText, config.legal.tosVersion, config.legal.privacyVersion]
	);
	if (result.rowCount !== 1) {
		const error = new Error('Billing consent profile update did not affect exactly one row');
		error.code = 'BILLING_PROFILE_NOT_FOUND';
		throw error;
	}
}

function priceToTier(priceId, prices = billingConfiguration().prices) {
	if (!priceId) return null;
	if (priceId === prices.teacher_monthly || priceId === prices.teacher_yearly) return 'teacher';
	if (priceId === prices.school_yearly) return 'school';
	return null;
}

function isActiveStatus(status) {
	return status === 'active' || status === 'trialing';
}

function tierRank(t) {
	return { free: 0, teacher: 1, school: 2, admin: 3 }[t] ?? 0;
}

async function ensureCustomer(pool, user) {
	const stripe = getStripe();
	if (!stripe) throw new Error('Stripe not configured');
	const { rows } = await pool.query(
		`SELECT stripe_customer_id FROM public.billing_subscriptions
		 WHERE user_id = $1 LIMIT 1`,
		[user.id]
	);
	if (rows[0]?.stripe_customer_id) return rows[0].stripe_customer_id;

	const customer = await stripe.customers.create({
		email: user.email || undefined,
		metadata: { supabase_user_id: user.id }
	}, { idempotencyKey: `billing_customer_${user.id}` });
	return customer.id;
}

async function upsertSubscription(pool, sub, userId, eventCreated, env = process.env, options = {}) {
	// Stripe API 2026-03-25 (SDK v22) exposes billing periods on each item.
	// Keep the top-level fallback for already-recorded legacy webhook fixtures.
	const item = sub.items?.data?.[0];
	const priceId = item?.price?.id || null;
	const trustedTier = options.trustedTier;
	if (trustedTier !== undefined && trustedTier !== 'teacher' && trustedTier !== 'school') {
		const error = new Error('Durable billing subscription has an invalid tier');
		error.code = 'INVALID_BILLING_TIER';
		throw error;
	}
	const tier = trustedTier || priceToTier(priceId, billingConfiguration(env).prices);
	if (!tier) {
		const error = new Error('Stripe subscription uses an unknown configured price');
		error.code = 'UNKNOWN_STRIPE_PRICE';
		throw error;
	}
	if (!Number.isFinite(eventCreated)) {
		const error = new Error('Stripe event creation time is missing or invalid');
		error.code = 'INVALID_STRIPE_EVENT_TIME';
		throw error;
	}
	const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;

	const { rows } = await pool.query(
		`INSERT INTO public.billing_subscriptions
		   (user_id, tier, stripe_customer_id, stripe_subscription_id, stripe_price_id,
		    status, current_period_start, current_period_end, cancel_at_period_end, trial_end,
		    stripe_event_created_at, updated_at)
		 VALUES ($1,$2,$3,$4,$5,$6,
		         to_timestamp($7), to_timestamp($8), $9, to_timestamp($10), to_timestamp($11), now())
		 ON CONFLICT (stripe_subscription_id) DO UPDATE SET
		   tier                 = EXCLUDED.tier,
		   stripe_customer_id   = EXCLUDED.stripe_customer_id,
		   stripe_price_id      = EXCLUDED.stripe_price_id,
		   status               = EXCLUDED.status,
		   current_period_start = EXCLUDED.current_period_start,
		   current_period_end   = EXCLUDED.current_period_end,
		   cancel_at_period_end = EXCLUDED.cancel_at_period_end,
		   trial_end            = EXCLUDED.trial_end,
		   stripe_event_created_at = EXCLUDED.stripe_event_created_at,
		   updated_at           = now()
		 RETURNING id, user_id, tier, status`,
		[
			userId, tier, customerId, sub.id, priceId, sub.status,
			item?.current_period_start ?? sub.current_period_start ?? null,
			item?.current_period_end   ?? sub.current_period_end   ?? null,
			!!sub.cancel_at_period_end,
			sub.trial_end || null,
			eventCreated,
		]
	);
	if (!rows.length) return { applied: false, subscriptionId: null };

	const { rows: activeSubscriptions } = await pool.query(
		`SELECT tier FROM public.billing_subscriptions
		 WHERE user_id = $1 AND status IN ('active', 'trialing')`,
		[userId]
	);
	const newTier = activeSubscriptions.some((row) => row.tier === 'school')
		? 'school'
		: activeSubscriptions.some((row) => row.tier === 'teacher') ? 'teacher' : 'free';
	await pool.query(
		`UPDATE public.profiles SET tier = $1, updated_at = now()
		 WHERE id = $2 AND tier <> 'admin'`,
		[newTier, userId]
	);
	return { applied: true, subscriptionId: rows[0].id };
}

async function withSubscriptionAdvisoryLock(pool, subscriptionId, operation) {
	if (typeof subscriptionId !== 'string' || !subscriptionId.trim()) {
		const error = new Error('A Stripe subscription ID is required for billing serialization');
		error.code = 'MISSING_STRIPE_SUBSCRIPTION';
		throw error;
	}
	if (typeof operation !== 'function') throw new TypeError('Billing lock operation must be a function');

	const client = await pool.connect();
	const lockKey = `billing-subscription:${subscriptionId}`;
	let acquired = false;
	let result;
	let operationError = null;
	let releaseError = null;
	try {
		const lockResult = await client.query(
			`SELECT pg_advisory_lock(hashtextextended($1, 0)) AS acquired`,
			[lockKey]
		);
		if (!lockResult?.rows?.length) {
			const error = new Error('PostgreSQL did not acquire the billing advisory lock');
			error.code = 'BILLING_LOCK_ACQUIRE_FAILED';
			throw error;
		}
		acquired = true;
		result = await operation(client);
	} catch (error) {
		operationError = error;
	} finally {
		if (acquired) {
			try {
				const unlockResult = await client.query(
					`SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked`,
					[lockKey]
				);
				if (unlockResult?.rows?.[0]?.unlocked !== true) {
					const error = new Error('PostgreSQL did not release the billing advisory lock');
					error.code = 'BILLING_LOCK_RELEASE_FAILED';
					throw error;
				}
			} catch (error) {
				releaseError = error;
			}
		}
		try {
			// Passing an error asks node-postgres to destroy a session whose lock
			// state is uncertain instead of returning it to the shared pool.
			client.release(releaseError || (!acquired && operationError) || undefined);
		} catch (error) {
			if (!releaseError) releaseError = error;
		}
	}
	if (operationError) {
		if (releaseError && releaseError !== operationError) operationError.lockReleaseError = releaseError;
		throw operationError;
	}
	if (releaseError) throw releaseError;
	return result;
}

async function processSubscriptionEvent(pool, event, subscription, userId, env = process.env, options = {}) {
	const ownsClient = !options.client;
	const client = options.client || await pool.connect();
	try {
		await client.query('BEGIN');
		const { rows: reservations } = await client.query(
			`INSERT INTO public.billing_events
			   (stripe_event_id, type, user_id, payload, stripe_event_created_at)
			 VALUES ($1, $2, $3, $4, to_timestamp($5))
			 ON CONFLICT (stripe_event_id) DO NOTHING
			 RETURNING id`,
			[event.id, event.type, userId || null, event.data, event.created]
		);
		if (!reservations.length) {
			await client.query('COMMIT');
			return { duplicate: true, applied: false };
		}
		if (subscription && options.integrationOwned === true && !userId) {
			const error = new Error(`Billing user could not be resolved for ${event.type}`);
			error.code = 'UNRESOLVED_BILLING_USER';
			throw error;
		}

		let applied = false;
		let subscriptionId = null;
		if (subscription && userId) {
			// Serialize all subscription events for one user before recomputing
			// their highest active tier across potentially multiple subscriptions.
			await client.query(`SELECT id FROM public.profiles WHERE id = $1 FOR UPDATE`, [userId]);
			const mutation = await upsertSubscription(
				client,
				subscription,
				userId,
				event.created,
				env,
				{ trustedTier: options.trustedTier }
			);
			applied = mutation.applied;
			subscriptionId = mutation.subscriptionId;
		}

		await client.query(
			`UPDATE public.billing_events
			 SET subscription_id = $2
			 WHERE id = $1`,
			[reservations[0].id, subscriptionId]
		);
		await client.query('COMMIT');
		return { duplicate: false, applied };
	} catch (error) {
		try { await client.query('ROLLBACK'); } catch (_) { /* preserve original error */ }
		throw error;
	} finally {
		if (ownsClient) client.release();
	}
}

async function getEffectiveTier(pool, userId) {
	try {
		const { rows } = await pool.query(`SELECT public.effective_tier($1) AS tier`, [userId]);
		return rows[0]?.tier || 'free';
	} catch (e) {
		// Ak migrácia 026 ešte nebežala, fallback na free
		if (e.code === '42883') return 'free';
		throw e;
	}
}

function requireTier(minTier, pool, supabaseUserExtractor) {
	return async function (req, res, next) {
		try {
			const user = await supabaseUserExtractor(req, res);
			if (!user) return; // extractor already responded with 401
			const tier = await getEffectiveTier(pool, user.id);
			if (tierRank(tier) < tierRank(minTier)) {
				return res.status(402).json({
					error: `Táto funkcia vyžaduje ${minTier} tier.`,
					code: 'TIER_REQUIRED',
					required: minTier,
					current: tier
				});
			}
			req.user = user;
			req.userTier = tier;
			next();
		} catch (e) {
			console.error('[Billing] requireTier failed:', e.message);
			res.status(500).json({ error: 'Tier check failed' });
		}
	};
}

module.exports = {
	// Legacy (manual provisioning)
	hasPaidAccess,
	getUserPlan,
	getUserBillingState,
	PLAN_FREE,
	PLAN_PRO,
	// Tier-based (Stripe)
	billingConfiguration,
	billingReady,
	billingWebhookAvailable,
	billingWebhookReady,
	billingEventUserId,
	hasIntegrationOwnershipEvidence,
	getStripe,
	normalizeConsentIp,
	persistBillingConsent,
	FREE_LIMITS,
	priceToTier,
	isActiveStatus,
	tierRank,
	ensureCustomer,
	upsertSubscription,
	withSubscriptionAdvisoryLock,
	processSubscriptionEvent,
	getEffectiveTier,
	requireTier,
};
