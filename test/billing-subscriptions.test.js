const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
	billingConfiguration,
	billingEventUserId,
	hasIntegrationOwnershipEvidence,
	billingReady,
	billingWebhookAvailable,
	billingWebhookReady,
	FREE_LIMITS,
	normalizeConsentIp,
	persistBillingConsent,
	priceToTier,
	processSubscriptionEvent,
	upsertSubscription,
	withSubscriptionAdvisoryLock,
} = require('../lib/billing');

const completeBillingEnv = Object.freeze({
	NODE_ENV: 'test',
	BILLING_SUBSCRIPTIONS_ENABLED: 'true',
	STRIPE_SECRET_KEY: 'sk_test_51BillingFixtureOnly000000',
	STRIPE_PRICE_TEACHER_MONTHLY: 'price_1TeacherMonthlyFixture',
	STRIPE_PRICE_TEACHER_YEARLY: 'price_1TeacherYearlyFixture',
	STRIPE_PRICE_SCHOOL_YEARLY: 'price_1SchoolYearlyFixture',
	STRIPE_WEBHOOK_SECRET: 'whsec_BillingFixtureOnly000000',
	APP_ORIGIN: 'https://billing.givemegame.test',
	BILLING_TOS_VERSION: '2026-08-21',
	BILLING_PRIVACY_VERSION: '2026-08-21',
	BILLING_TERMS_URL: 'https://billing.givemegame.test/terms',
	BILLING_PRIVACY_URL: 'https://billing.givemegame.test/privacy',
	BILLING_CONTACT_URL: 'https://billing.givemegame.test/contact',
	BILLING_WITHDRAWAL_CONSENT_TEXT: 'I agree to immediate performance.',
});

const webhookOnlyEnv = Object.freeze({
	NODE_ENV: 'test',
	STRIPE_SECRET_KEY: completeBillingEnv.STRIPE_SECRET_KEY,
	STRIPE_PRICE_TEACHER_MONTHLY: completeBillingEnv.STRIPE_PRICE_TEACHER_MONTHLY,
	STRIPE_PRICE_TEACHER_YEARLY: completeBillingEnv.STRIPE_PRICE_TEACHER_YEARLY,
	STRIPE_WEBHOOK_SECRET: completeBillingEnv.STRIPE_WEBHOOK_SECRET,
});

const USER_A = '11111111-2222-4333-8444-555555555555';
const USER_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const USER_V7 = '01890f47-e9b0-7cc3-98c0-4c6f52d8b123';

function resolveEventUserIdForRegression(object, eventType, integrationOwned) {
	if (typeof billingEventUserId === 'function') {
		return billingEventUserId(object, eventType, integrationOwned);
	}
	// Pre-fix behavior: Checkout copied an arbitrary client reference before
	// ownership or UUID validation. This keeps RED focused on the regression.
	return eventType === 'checkout.session.completed' ? object?.client_reference_id || null : null;
}

describe('subscription price recognition', () => {
	it('maps only the three configured Stripe prices to their intended tier', () => {
		const prices = billingConfiguration(completeBillingEnv).prices;

		assert.equal(priceToTier(completeBillingEnv.STRIPE_PRICE_TEACHER_MONTHLY, prices), 'teacher');
		assert.equal(priceToTier(completeBillingEnv.STRIPE_PRICE_TEACHER_YEARLY, prices), 'teacher');
		assert.equal(priceToTier(completeBillingEnv.STRIPE_PRICE_SCHOOL_YEARLY, prices), 'school');
		assert.equal(priceToTier('price_not_configured', prices), null);
	});

	it('keeps the optional school price available for webhook mapping without requiring it for Checkout', () => {
		const withoutSchoolPrice = { ...completeBillingEnv };
		delete withoutSchoolPrice.STRIPE_PRICE_SCHOOL_YEARLY;

		const config = billingConfiguration(withoutSchoolPrice);
		assert.equal(config.ready, true);
		assert.equal(config.webhookReady, true);
		assert.equal(config.prices.school_yearly, null);
	});

	it('rejects a subscription with an unknown price before writing billing state', async () => {
		const databaseThatMustNotBeCalled = {
			query() {
				throw new Error('database write must not be reached');
			},
		};
		const subscription = {
			id: 'sub_unknown',
			customer: 'cus_123',
			status: 'active',
			items: { data: [{ price: { id: 'price_not_configured' } }] },
		};

		await assert.rejects(
			upsertSubscription(databaseThatMustNotBeCalled, subscription, '00000000-0000-0000-0000-000000000001', 1_777_000_000, completeBillingEnv),
			(error) => error && error.code === 'UNKNOWN_STRIPE_PRICE'
		);
	});
});

describe('billing readiness', () => {
	it('is ready only with the explicit enable flag and every checkout prerequisite', () => {
		const ready = billingConfiguration(completeBillingEnv);
		assert.equal(ready.ready, true);
		assert.deepEqual(ready.missing, []);

		const checkoutRequirements = [
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
		];
		for (const name of checkoutRequirements) {
			const incomplete = { ...completeBillingEnv };
			delete incomplete[name];
			const result = billingConfiguration(incomplete);
			assert.equal(result.ready, false, `${name} must be required`);
			assert.ok(result.missing.includes(name), `${name} must be reported missing`);
		}
	});

	it('treats malformed origins and legal links as unavailable', () => {
		for (const name of ['APP_ORIGIN', 'BILLING_TERMS_URL', 'BILLING_PRIVACY_URL', 'BILLING_CONTACT_URL']) {
			const result = billingConfiguration({ ...completeBillingEnv, [name]: '/relative/path' });
			assert.equal(result.ready, false);
			assert.ok(result.missing.includes(name));
			if (name === 'BILLING_TERMS_URL') assert.equal(result.legal.termsUrl, null);
		}
	});

	it('rejects duplicate configured price IDs to keep tier mapping unambiguous', () => {
		const result = billingConfiguration({
			...completeBillingEnv,
			STRIPE_PRICE_SCHOOL_YEARLY: completeBillingEnv.STRIPE_PRICE_TEACHER_YEARLY,
		});
		assert.equal(result.ready, false);
		assert.ok(result.missing.includes('STRIPE_PRICE_SCHOOL_YEARLY'));
	});

	it('rejects copied template placeholders even when the feature flag is flipped', () => {
		const template = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
		const copiedEnv = { NODE_ENV: 'production', BILLING_SUBSCRIPTIONS_ENABLED: 'true' };
		for (const rawLine of template.split(/\r?\n/)) {
			const line = rawLine.trim();
			if (!line || line.startsWith('#') || !line.includes('=')) continue;
			const separator = line.indexOf('=');
			copiedEnv[line.slice(0, separator)] = line.slice(separator + 1);
		}
		copiedEnv.BILLING_SUBSCRIPTIONS_ENABLED = 'true';

		const result = billingConfiguration(copiedEnv);
		assert.equal(result.ready, false);
		assert.ok(result.missing.includes('STRIPE_SECRET_KEY'));
		assert.ok(result.missing.includes('STRIPE_WEBHOOK_SECRET'));
		assert.ok(result.missing.includes('STRIPE_PRICE_TEACHER_MONTHLY'));
		assert.ok(result.missing.includes('APP_ORIGIN'));
		assert.ok(result.missing.includes('BILLING_TOS_VERSION'));
	});

	it('validates Stripe identifier prefixes and production HTTPS URLs', () => {
		const invalidShapes = {
			STRIPE_SECRET_KEY: 'invalid_BillingFixtureOnly000000',
			STRIPE_WEBHOOK_SECRET: 'secret_BillingFixtureOnly000000',
			STRIPE_PRICE_TEACHER_MONTHLY: 'prod_1TeacherMonthlyFixture',
			APP_ORIGIN: 'http://billing.givemegame.test',
			BILLING_TERMS_URL: 'http://billing.givemegame.test/terms',
		};
		for (const [name, value] of Object.entries(invalidShapes)) {
			const result = billingConfiguration({ ...completeBillingEnv, NODE_ENV: 'production', [name]: value });
			assert.equal(result.ready, false, `${name} must reject an invalid production value`);
			assert.ok(result.missing.includes(name), `${name} must be reported by name only`);
		}
	});

	it('allows HTTP only for localhost in an explicit local or test environment', () => {
		const localEnv = {
			...completeBillingEnv,
			NODE_ENV: 'development',
			APP_ORIGIN: 'http://localhost:3000',
			BILLING_TERMS_URL: 'http://localhost:3000/terms',
			BILLING_PRIVACY_URL: 'http://localhost:3000/privacy',
			BILLING_CONTACT_URL: 'http://localhost:3000/contact',
		};
		assert.equal(billingConfiguration(localEnv).ready, true);
		assert.equal(billingConfiguration({ ...localEnv, APP_ORIGIN: 'http://192.0.2.1:3000' }).ready, false);
		assert.equal(billingConfiguration({ ...localEnv, NODE_ENV: 'production' }).ready, false);
	});

	it('keeps webhook processing ready when Checkout-only legal and sales settings are absent', () => {
		const result = billingConfiguration(webhookOnlyEnv);
		let runtimeChecks = 0;
		assert.equal(result.ready, false);
		assert.equal(result.webhookReady, true);
		assert.deepEqual(result.webhookMissing, []);
		assert.equal(billingWebhookReady(webhookOnlyEnv, () => { runtimeChecks += 1; return {}; }), true);
		assert.equal(runtimeChecks, 1);
	});

	it('requires a database pool but no Supabase auth-client settings for webhook availability', () => {
		const stripeProvider = () => ({});
		assert.equal(billingWebhookAvailable(null, webhookOnlyEnv, stripeProvider), false);
		assert.equal(billingWebhookAvailable({}, webhookOnlyEnv, stripeProvider), true);
	});

	it('fails Checkout readiness when the configured Stripe runtime cannot initialize', () => {
		let runtimeChecks = 0;
		assert.equal(billingReady(completeBillingEnv, () => { runtimeChecks += 1; return null; }), false);
		assert.equal(runtimeChecks, 1);
	});
});

describe('checkout consent evidence', () => {
	it('accepts only a validated Express-derived IP address', () => {
		assert.equal(normalizeConsentIp('203.0.113.8'), '203.0.113.8');
		assert.equal(normalizeConsentIp('2001:db8::8'), '2001:db8::8');
		assert.equal(normalizeConsentIp('203.0.113.8, 198.51.100.2'), null);
		assert.equal(normalizeConsentIp('not-an-ip'), null);
	});

	it('rejects checkout consent when no profile row was updated', async () => {
		const pool = { async query() { return { rowCount: 0, rows: [] }; } };
		await assert.rejects(
			persistBillingConsent(pool, 'user-1', '203.0.113.8', completeBillingEnv),
			(error) => error?.code === 'BILLING_PROFILE_NOT_FOUND'
		);
	});
});

describe('Stripe object ownership', () => {
	it('recognizes only a valid integration UUID or an existing billing customer', () => {
		assert.equal(typeof hasIntegrationOwnershipEvidence, 'function');
		assert.equal(hasIntegrationOwnershipEvidence({ metadata: { supabase_user_id: '' } }, false), false);
		assert.equal(hasIntegrationOwnershipEvidence({ metadata: { supabase_user_id: USER_A } }, false), true);
		assert.equal(hasIntegrationOwnershipEvidence({ subscription_details: { metadata: { supabase_user_id: USER_A } } }, false), true);
		assert.equal(hasIntegrationOwnershipEvidence({ metadata: { other_integration: 'user-1' } }, false), false);
		assert.equal(hasIntegrationOwnershipEvidence({ metadata: {} }, true), true);
	});

	it('ignores unrelated Checkout client references and accepts an owned UUID reference', () => {
		assert.equal(typeof billingEventUserId, 'function');
		assert.equal(
			billingEventUserId(
				{ metadata: {}, client_reference_id: 'shared-account-order-123' },
				'checkout.session.completed',
				false
			),
			null
		);
		assert.equal(
			billingEventUserId(
				{ metadata: {}, client_reference_id: USER_A },
				'checkout.session.completed',
				true
			),
			USER_A
		);
		assert.equal(
			billingEventUserId(
				{ metadata: { supabase_user_id: 'not-a-uuid' }, client_reference_id: 'also-not-a-uuid' },
				'checkout.session.completed',
				true
			),
			null
		);
	});

	it('accepts matching valid ownership signals and rejects every conflicting pair', () => {
		assert.equal(
			billingEventUserId({
				metadata: { supabase_user_id: USER_A },
				subscription_details: { metadata: { supabase_user_id: USER_A } },
				client_reference_id: USER_A,
			}, 'checkout.session.completed', true, USER_A),
			USER_A
		);

		const conflicts = [
			[{ metadata: { supabase_user_id: USER_A }, subscription_details: { metadata: { supabase_user_id: USER_B } } }, 'customer.subscription.updated', null],
			[{ metadata: { supabase_user_id: USER_A }, client_reference_id: USER_B }, 'checkout.session.completed', null],
			[{ subscription_details: { metadata: { supabase_user_id: USER_A } }, client_reference_id: USER_B }, 'checkout.session.completed', null],
			[{ metadata: { supabase_user_id: USER_A } }, 'customer.subscription.updated', USER_B],
		];
		for (const [object, eventType, knownCustomerUserId] of conflicts) {
			assert.throws(
				() => billingEventUserId(object, eventType, true, knownCustomerUserId),
				(error) => error?.code === 'BILLING_OWNERSHIP_CONFLICT'
			);
		}
	});

	it('normalizes UUID case and accepts modern UUID versions as the same owner', () => {
		assert.equal(hasIntegrationOwnershipEvidence({ metadata: { supabase_user_id: USER_V7 } }), true);
		assert.equal(
			billingEventUserId(
				{ metadata: { supabase_user_id: USER_B.toUpperCase() } },
				'customer.subscription.updated',
				true,
				USER_B
			),
			USER_B
		);
	});
});

describe('Stripe subscription period persistence', () => {
	async function persistedPeriod(subscription) {
		let upsertParams = null;
		const client = {
			async query(sql, params) {
				if (/INSERT INTO public\.billing_subscriptions/i.test(sql)) {
					upsertParams = params;
					return { rows: [{ id: 'subscription-row', user_id: USER_A, tier: 'teacher', status: subscription.status }] };
				}
				if (/SELECT tier FROM public\.billing_subscriptions/i.test(sql)) return { rows: [{ tier: 'teacher' }] };
				return { rows: [] };
			},
		};
		await upsertSubscription(client, subscription, USER_A, 1_777_000_000, completeBillingEnv);
		return { start: upsertParams[6], end: upsertParams[7] };
	}

	it('uses Stripe v22 subscription-item current period fields', async () => {
		const period = await persistedPeriod({
			id: 'sub_v22', customer: 'cus_1', status: 'active',
			items: { data: [{
				price: { id: completeBillingEnv.STRIPE_PRICE_TEACHER_MONTHLY },
				current_period_start: 1_777_000_100,
				current_period_end: 1_779_000_100,
			}] },
		});
		assert.deepEqual(period, { start: 1_777_000_100, end: 1_779_000_100 });
	});

	it('falls back to legacy top-level current period fields for older webhook shapes', async () => {
		const period = await persistedPeriod({
			id: 'sub_legacy', customer: 'cus_1', status: 'active',
			current_period_start: 1_776_000_100,
			current_period_end: 1_778_000_100,
			items: { data: [{ price: { id: completeBillingEnv.STRIPE_PRICE_TEACHER_MONTHLY } }] },
		});
		assert.deepEqual(period, { start: 1_776_000_100, end: 1_778_000_100 });
	});
});

describe('webhook persistence', () => {
	it('holds a dedicated subscription advisory lock for the whole callback', async () => {
		const statements = [];
		let released = false;
		const client = {
			async query(sql, params) {
				statements.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
				if (/pg_advisory_unlock/i.test(sql)) return { rows: [{ unlocked: true }] };
				if (/pg_advisory_lock/i.test(sql)) return { rows: [{ acquired: true }] };
				return { rows: [] };
			},
			release() { released = true; },
		};

		const value = await withSubscriptionAdvisoryLock(
			{ async connect() { return client; } },
			'sub_serialized',
			async (lockedClient) => {
				assert.equal(lockedClient, client);
				await lockedClient.query('SELECT canonical_retrieval_boundary');
				return 'processed';
			}
		);

		assert.equal(value, 'processed');
		assert.match(statements[0].sql, /pg_advisory_lock\(hashtextextended\(\$1, 0\)\)/i);
		assert.deepEqual(statements[0].params, ['billing-subscription:sub_serialized']);
		assert.equal(statements[1].sql, 'SELECT canonical_retrieval_boundary');
		assert.match(statements[2].sql, /pg_advisory_unlock\(hashtextextended\(\$1, 0\)\)/i);
		assert.equal(released, true);
	});

	it('unlocks and releases the dedicated advisory-lock client when processing fails', async () => {
		const failure = new Error('transaction failed');
		let unlocks = 0;
		let released = false;
		const client = {
			async query(sql) {
				if (/pg_advisory_unlock/i.test(sql)) {
					unlocks += 1;
					return { rows: [{ unlocked: true }] };
				}
				return { rows: [{ acquired: true }] };
			},
			release() { released = true; },
		};

		await assert.rejects(
			withSubscriptionAdvisoryLock(
				{ async connect() { return client; } },
				'sub_error',
				async () => { throw failure; }
			),
			(error) => error === failure
		);
		assert.equal(unlocks, 1);
		assert.equal(released, true);
	});

	it('fails closed and releases the client when the advisory lock cannot be acquired', async () => {
		const lockFailure = new Error('database lock unavailable');
		let callbackCalled = false;
		let released = false;
		const client = {
			async query() { throw lockFailure; },
			release() { released = true; },
		};

		await assert.rejects(
			withSubscriptionAdvisoryLock(
				{ async connect() { return client; } },
				'sub_lock_failure',
				async () => { callbackCalled = true; }
			),
			(error) => error === lockFailure
		);
		assert.equal(callbackCalled, false);
		assert.equal(released, true);
	});

	it('uses a caller-owned client for event persistence without releasing its session lock', async () => {
		let released = false;
		const client = {
			async query(sql) {
				if (/INSERT INTO public\.billing_events/i.test(sql)) return { rows: [{ id: 'audit-row' }] };
				return { rows: [] };
			},
			release() { released = true; },
		};
		const pool = { async connect() { throw new Error('must use the caller-owned client'); } };

		const result = await processSubscriptionEvent(
			pool,
			{ id: 'evt_locked', type: 'invoice.payment_failed', created: 1_777_000_000, data: { object: {} } },
			null,
			null,
			completeBillingEnv,
			{ integrationOwned: true, client }
		);

		assert.deepEqual(result, { duplicate: false, applied: false });
		assert.equal(released, false);
	});

	it('preserves a trusted durable tier when canceling a Stripe-missing legacy price', async () => {
		let persistedTier = null;
		let persistedPrice = null;
		const client = {
			async query(sql, params) {
				if (/INSERT INTO public\.billing_events/i.test(sql)) return { rows: [{ id: 'audit-row' }] };
				if (/INSERT INTO public\.billing_subscriptions/i.test(sql)) {
					persistedTier = params[1];
					persistedPrice = params[4];
					return { rows: [{ id: 'sub-legacy', user_id: USER_A, tier: params[1], status: params[5] }] };
				}
				return { rows: [] };
			},
			release() {},
		};

		const result = await processSubscriptionEvent(
			{ async connect() { return client; } },
			{ id: 'evt_missing_legacy', type: 'customer.subscription.updated', created: 1_777_000_000, data: { object: {} } },
			{
				id: 'sub_legacy', customer: 'cus_owned', status: 'canceled',
				items: { data: [{ price: { id: 'price_retired_legacy' } }] },
			},
			USER_A,
			completeBillingEnv,
			{ integrationOwned: true, trustedTier: 'teacher' }
		);

		assert.deepEqual(result, { duplicate: false, applied: true });
		assert.equal(persistedTier, 'teacher');
		assert.equal(persistedPrice, 'price_retired_legacy');
	});

	it('commits event reservation, subscription/profile changes, and audit linkage together', async () => {
		const statements = [];
		const client = {
			async query(sql) {
				statements.push(String(sql).replace(/\s+/g, ' ').trim());
				if (/INSERT INTO public\.billing_events/i.test(sql)) return { rows: [{ id: 'audit-row' }] };
				if (/INSERT INTO public\.billing_subscriptions/i.test(sql)) {
					return { rows: [{ id: 'subscription-row', tier: 'teacher', status: 'active', user_id: 'user-1' }] };
				}
				return { rows: [] };
			},
			release() {},
		};
		const pool = { async connect() { return client; } };
		const event = {
			id: 'evt_1',
			type: 'customer.subscription.updated',
			created: 1_777_000_000,
			data: { object: { id: 'sub_1' } },
		};
		const subscription = {
			id: 'sub_1', customer: 'cus_1', status: 'active',
			items: { data: [{ price: { id: completeBillingEnv.STRIPE_PRICE_TEACHER_MONTHLY } }] },
		};

		const result = await processSubscriptionEvent(pool, event, subscription, 'user-1', completeBillingEnv);

		assert.deepEqual(result, { duplicate: false, applied: true });
		assert.equal(statements[0], 'BEGIN');
		assert.match(statements[1], /INSERT INTO public\.billing_events/);
		assert.ok(statements.some((sql) => /INSERT INTO public\.billing_subscriptions/.test(sql)));
		assert.ok(statements.some((sql) => /UPDATE public\.profiles/.test(sql)));
		assert.ok(statements.some((sql) => /UPDATE public\.billing_events/.test(sql)));
		assert.equal(statements.at(-1), 'COMMIT');
	});

	it('commits a duplicate reservation without mutating subscription or profile state', async () => {
		const statements = [];
		const client = {
			async query(sql) {
				statements.push(String(sql).replace(/\s+/g, ' ').trim());
				if (/INSERT INTO public\.billing_events/i.test(sql)) return { rows: [] };
				return { rows: [] };
			},
			release() {},
		};
		const result = await processSubscriptionEvent(
			{ async connect() { return client; } },
			{ id: 'evt_duplicate', type: 'customer.subscription.updated', created: 1_777_000_000, data: { object: {} } },
			{ id: 'sub_1' },
			'user-1',
			completeBillingEnv
		);

		assert.deepEqual(result, { duplicate: true, applied: false });
		assert.ok(!statements.some((sql) => /INSERT INTO public\.billing_subscriptions/.test(sql)));
		assert.ok(!statements.some((sql) => /UPDATE public\.profiles/.test(sql)));
		assert.equal(statements.at(-1), 'COMMIT');
	});

	it('rolls back an integration-owned mutating event whose user cannot be resolved so Stripe can retry', async () => {
		const statements = [];
		const client = {
			async query(sql) {
				statements.push(String(sql).replace(/\s+/g, ' ').trim());
				if (/INSERT INTO public\.billing_events/i.test(sql)) return { rows: [{ id: 'audit-row' }] };
				return { rows: [] };
			},
			release() {},
		};

		await assert.rejects(
			processSubscriptionEvent(
				{ async connect() { return client; } },
				{ id: 'evt_unresolved', type: 'customer.subscription.deleted', created: 1_777_000_000, data: { object: {} } },
				{ id: 'sub_1' },
				null,
				completeBillingEnv,
				{ integrationOwned: true }
			),
			(error) => error?.code === 'UNRESOLVED_BILLING_USER'
		);
		assert.ok(statements.includes('ROLLBACK'));
		assert.ok(!statements.includes('COMMIT'));
	});

	it('audits and acknowledges an unresolved payment failure without retrying forever', async () => {
		const statements = [];
		const client = {
			async query(sql) {
				statements.push(String(sql).replace(/\s+/g, ' ').trim());
				if (/INSERT INTO public\.billing_events/i.test(sql)) return { rows: [{ id: 'audit-row' }] };
				return { rows: [] };
			},
			release() {},
		};

		const result = await processSubscriptionEvent(
			{ async connect() { return client; } },
			{ id: 'evt_payment_failed', type: 'invoice.payment_failed', created: 1_777_000_000, data: { object: {} } },
			null,
			null,
			completeBillingEnv,
			{ integrationOwned: true }
		);

		assert.deepEqual(result, { duplicate: false, applied: false });
		assert.ok(statements.some((sql) => /UPDATE public\.billing_events/.test(sql)));
		assert.equal(statements.at(-1), 'COMMIT');
		assert.ok(!statements.includes('ROLLBACK'));
	});

	it('audits and acknowledges an unrelated subscription event without entitlement mutation', async () => {
		const statements = [];
		const client = {
			async query(sql) {
				statements.push(String(sql).replace(/\s+/g, ' ').trim());
				if (/INSERT INTO public\.billing_events/i.test(sql)) return { rows: [{ id: 'audit-row' }] };
				return { rows: [] };
			},
			release() {},
		};

		const result = await processSubscriptionEvent(
			{ async connect() { return client; } },
			{ id: 'evt_unrelated', type: 'customer.subscription.updated', created: 1_777_000_000, data: { object: {} } },
			{ id: 'sub_unrelated' },
			null,
			completeBillingEnv,
			{ integrationOwned: false }
		);

		assert.deepEqual(result, { duplicate: false, applied: false });
		assert.ok(!statements.some((sql) => /INSERT INTO public\.billing_subscriptions/.test(sql)));
		assert.ok(!statements.some((sql) => /UPDATE public\.profiles/.test(sql)));
		assert.equal(statements.at(-1), 'COMMIT');
	});

	it('audits an unrelated Checkout session with an arbitrary client reference as user_id null', async () => {
		const statements = [];
		let reservedUserId = 'not-observed';
		const client = {
			async query(sql, params) {
				statements.push(String(sql).replace(/\s+/g, ' ').trim());
				if (/INSERT INTO public\.billing_events/i.test(sql)) {
					reservedUserId = params[2];
					return { rows: [{ id: 'audit-row' }] };
				}
				return { rows: [] };
			},
			release() {},
		};
		const object = {
			id: 'cs_shared',
			object: 'checkout.session',
			client_reference_id: 'shared-account-order-123',
			metadata: {},
		};
		const integrationOwned = hasIntegrationOwnershipEvidence(object);
		const userId = resolveEventUserIdForRegression(object, 'checkout.session.completed', integrationOwned);

		const result = await processSubscriptionEvent(
			{ async connect() { return client; } },
			{ id: 'evt_shared_checkout', type: 'checkout.session.completed', created: 1_777_000_000, data: { object } },
			null,
			userId,
			completeBillingEnv,
			{ integrationOwned }
		);

		assert.deepEqual(result, { duplicate: false, applied: false });
		assert.equal(reservedUserId, null);
		assert.equal(statements.at(-1), 'COMMIT');
	});

	it('acknowledges invalid unowned Checkout metadata without poisoning billing', async () => {
		const statements = [];
		const client = {
			async query(sql) {
				statements.push(String(sql).replace(/\s+/g, ' ').trim());
				if (/INSERT INTO public\.billing_events/i.test(sql)) return { rows: [{ id: 'audit-row' }] };
				return { rows: [] };
			},
			release() {},
		};
		const object = {
			id: 'cs_owned_invalid',
			object: 'checkout.session',
			client_reference_id: 'not-a-uuid',
			metadata: { supabase_user_id: '' },
		};
		const integrationOwned = hasIntegrationOwnershipEvidence(object);
		const userId = resolveEventUserIdForRegression(object, 'checkout.session.completed', integrationOwned);

		const result = await processSubscriptionEvent(
			{ async connect() { return client; } },
			{ id: 'evt_owned_checkout', type: 'checkout.session.completed', created: 1_777_000_000, data: { object } },
			null,
			userId,
			completeBillingEnv,
			{ integrationOwned }
		);
		assert.deepEqual(result, { duplicate: false, applied: false });
		assert.equal(integrationOwned, false);
		assert.equal(statements.at(-1), 'COMMIT');
		assert.ok(!statements.some((sql) => /INSERT INTO public\.billing_subscriptions/.test(sql)));
	});

	it('applies an authoritative correction even when its triggering event timestamp is older', async () => {
		let persistedStatus = null;
		let profileUpdates = 0;
		const client = {
			async query(sql, params) {
				if (/INSERT INTO public\.billing_events/i.test(sql)) return { rows: [{ id: 'audit-row' }] };
				if (/INSERT INTO public\.billing_subscriptions/i.test(sql)) {
					// Model a row whose last webhook timestamp is newer. A conditional
					// event-time WHERE clause would suppress this authoritative snapshot.
					if (/WHERE public\.billing_subscriptions\.stripe_event_created_at/i.test(sql)) return { rows: [] };
					persistedStatus = params[5];
					return { rows: [{ id: 'sub-row', user_id: USER_A, tier: 'teacher', status: params[5] }] };
				}
				if (/SELECT tier FROM public\.billing_subscriptions/i.test(sql)) return { rows: [] };
				if (/UPDATE public\.profiles/i.test(sql)) profileUpdates += 1;
				return { rows: [] };
			},
			release() {},
		};
		const result = await processSubscriptionEvent(
			{ async connect() { return client; } },
			{ id: 'evt_old', type: 'customer.subscription.updated', created: 1_776_000_000, data: { object: {} } },
			{
				id: 'sub_1', customer: 'cus_1', status: 'canceled',
				items: { data: [{ price: { id: completeBillingEnv.STRIPE_PRICE_TEACHER_MONTHLY } }] },
			},
			USER_A,
			completeBillingEnv
		);

		assert.deepEqual(result, { duplicate: false, applied: true });
		assert.equal(persistedStatus, 'canceled');
		assert.equal(profileUpdates, 1);
	});

	it('preserves the highest active tier when another subscription is canceled', async () => {
		let persistedTier = null;
		const client = {
			async query(sql, params) {
				if (/INSERT INTO public\.billing_subscriptions/i.test(sql)) {
					return { rows: [{ id: 'teacher-sub', tier: 'teacher', status: 'canceled', user_id: 'user-1' }] };
				}
				if (/SELECT tier FROM public\.billing_subscriptions/i.test(sql)) {
					return { rows: [{ tier: 'school' }] };
				}
				if (/UPDATE public\.profiles/i.test(sql)) persistedTier = params[0];
				return { rows: [] };
			},
		};
		await upsertSubscription(
			client,
			{
				id: 'sub_teacher', customer: 'cus_1', status: 'canceled',
				items: { data: [{ price: { id: completeBillingEnv.STRIPE_PRICE_TEACHER_MONTHLY } }] },
			},
			'user-1',
			1_777_000_000,
			completeBillingEnv
		);

		assert.equal(persistedTier, 'school');
	});
});

describe('free tier limits', () => {
	it('preserves the product limit of three generated games per day', () => {
		assert.equal(FREE_LIMITS.dailyGenerations, 3);
	});
});
