/**
 * gIVEMEGAME.IO — hermetic integration tests for secure subscription billing.
 * All database, Stripe mutation, Supabase Auth, and OpenAI boundaries are local doubles.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const USER_A = '11111111-2222-4333-8444-555555555555';
const USER_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const WEBHOOK_SECRET = 'whsec_BillingIntegrationFixture000000';
const TEACHER_PRICE = 'price_1TeacherMonthlyIntegration';
const SCHOOL_PRICE = 'price_1SchoolYearlyIntegration';

const ENV_KEYS = [
	'VERCEL', 'NODE_ENV', 'PORT', 'ALLOWED_ORIGINS', 'OPENAI_API_KEY',
	'SUPABASE_DB_URL', 'SUPABASE_URL', 'SUPABASE_ANON_KEY',
	'BILLING_SUBSCRIPTIONS_ENABLED', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET',
	'STRIPE_PRICE_TEACHER_MONTHLY', 'STRIPE_PRICE_TEACHER_YEARLY',
	'STRIPE_PRICE_SCHOOL_YEARLY', 'APP_ORIGIN', 'BILLING_TOS_VERSION',
	'BILLING_PRIVACY_VERSION', 'BILLING_TERMS_URL', 'BILLING_PRIVACY_URL',
	'BILLING_CONTACT_URL', 'BILLING_WITHDRAWAL_CONSENT_TEXT',
	'STRIPE_PAYMENT_LINK_PRO_MONTHLY',
];

const envSnapshot = new Map(ENV_KEYS.map((name) => [
	name,
	{ present: Object.prototype.hasOwnProperty.call(process.env, name), value: process.env[name] },
]));

function applyHermeticEnv(databaseUrl) {
	const values = {
		VERCEL: '1',
		NODE_ENV: 'test',
		PORT: '0',
		ALLOWED_ORIGINS: '',
		OPENAI_API_KEY: '',
		SUPABASE_DB_URL: databaseUrl,
		SUPABASE_URL: 'https://auth.givemegame.test',
		SUPABASE_ANON_KEY: 'anon_BillingIntegrationFixture',
		BILLING_SUBSCRIPTIONS_ENABLED: 'true',
		STRIPE_SECRET_KEY: 'sk_test_51BillingIntegrationFixture',
		STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
		STRIPE_PRICE_TEACHER_MONTHLY: TEACHER_PRICE,
		STRIPE_PRICE_TEACHER_YEARLY: 'price_1TeacherYearlyIntegration',
		STRIPE_PRICE_SCHOOL_YEARLY: SCHOOL_PRICE,
		APP_ORIGIN: 'https://billing.givemegame.test',
		BILLING_TOS_VERSION: '2026-08-21',
		BILLING_PRIVACY_VERSION: '2026-08-21',
		BILLING_TERMS_URL: 'https://billing.givemegame.test/terms',
		BILLING_PRIVACY_URL: 'https://billing.givemegame.test/privacy',
		BILLING_CONTACT_URL: 'https://billing.givemegame.test/contact',
		BILLING_WITHDRAWAL_CONSENT_TEXT: 'I agree to immediate performance.',
		STRIPE_PAYMENT_LINK_PRO_MONTHLY: '',
	};
	for (const name of ENV_KEYS) process.env[name] = values[name] ?? '';
}

function restoreEnv() {
	for (const [name, snapshot] of envSnapshot) {
		if (snapshot.present) process.env[name] = snapshot.value;
		else delete process.env[name];
	}
}

class FakeBillingDatabase {
	constructor() {
		this.reset();
		this.ownerByCustomer = new Map([
			['cus_owned', USER_A],
			['cus_conflict', USER_B],
		]);
	}

	reset() {
		this.events = new Set();
		this.subscriptions = new Map();
		this.profileTier = 'free';
		this.advisoryLocks = new Map();
		this.advisoryLockAcquisitions = 0;
		this.advisoryLockReleases = 0;
		this.lockWaitObserver = null;
	}

	async query(sql, params = [], sessionId = null) {
		const statement = String(sql).replace(/\s+/g, ' ').trim();
		if (statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK') return { rows: [] };
		if (/pg_advisory_unlock/i.test(statement)) {
			this.advisoryLockReleases += 1;
			const key = params[0];
			const lock = this.advisoryLocks.get(key);
			if (!lock || lock.owner !== sessionId) return { rows: [{ unlocked: false }] };
			const next = lock.waiters.shift();
			if (next) {
				lock.owner = next.sessionId;
				next.resolve();
			} else {
				this.advisoryLocks.delete(key);
			}
			return { rows: [{ unlocked: true }] };
		}
		if (/pg_advisory_lock/i.test(statement)) {
			this.advisoryLockAcquisitions += 1;
			const key = params[0];
			const lock = this.advisoryLocks.get(key);
			if (!lock) {
				this.advisoryLocks.set(key, { owner: sessionId, waiters: [] });
				return { rows: [{ acquired: true }] };
			}
			if (lock.owner !== sessionId) {
				this.lockWaitObserver?.();
				await new Promise((resolve) => lock.waiters.push({ sessionId, resolve }));
			}
			return { rows: [{ acquired: true }] };
		}

		if (/SELECT user_id FROM public\.billing_subscriptions WHERE stripe_customer_id/i.test(statement)) {
			const customerId = params[0];
			const owners = new Set();
			const configuredOwner = this.ownerByCustomer.get(customerId);
			if (configuredOwner) owners.add(configuredOwner);
			for (const sub of this.subscriptions.values()) {
				if (sub.customerId === customerId) owners.add(sub.userId);
			}
			return { rows: [...owners].map((user_id) => ({ user_id })) };
		}

		if (/SELECT stripe_customer_id FROM public\.billing_subscriptions WHERE user_id/i.test(statement)) {
			return { rows: [{ stripe_customer_id: 'cus_owned' }] };
		}

		if (/FROM public\.billing_subscriptions WHERE stripe_subscription_id = \$1/i.test(statement)) {
			const sub = this.subscriptions.get(params[0]);
			return { rows: sub ? [{
				user_id: sub.userId,
				tier: sub.tier,
				stripe_customer_id: sub.customerId,
				stripe_subscription_id: sub.id,
				stripe_price_id: sub.priceId,
				current_period_start: sub.currentPeriodStart,
				current_period_end: sub.currentPeriodEnd,
				cancel_at_period_end: sub.cancelAtPeriodEnd,
				trial_end: sub.trialEnd,
			}] : [] };
		}

		if (/SELECT public\.effective_tier/i.test(statement)) return { rows: [{ tier: this.profileTier }] };

		if (/SELECT tier AS sub_tier/i.test(statement)) {
			const prioritizesActiveTier = /status IN \('active', 'trialing'\)/i.test(statement)
				&& /school/i.test(statement) && /teacher/i.test(statement);
			return {
				rows: [prioritizesActiveTier
					? { sub_tier: 'school', status: 'active', current_period_end: '2027-08-21', cancel_at_period_end: false, trial_end: null }
					: { sub_tier: 'teacher', status: 'canceled', current_period_end: '2026-08-21', cancel_at_period_end: false, trial_end: null }],
			};
		}

		if (/UPDATE public\.profiles SET withdrawal_consent_at/i.test(statement)) return { rows: [], rowCount: 1 };
		if (/SELECT id FROM public\.profiles WHERE id/i.test(statement)) return { rows: [{ id: params[0] }] };

		if (/INSERT INTO public\.billing_events/i.test(statement)) {
			const eventId = params[0];
			if (this.events.has(eventId)) return { rows: [] };
			this.events.add(eventId);
			return { rows: [{ id: `audit-${this.events.size}` }] };
		}

		if (/INSERT INTO public\.billing_subscriptions/i.test(statement)) {
			const record = {
				userId: params[0], tier: params[1], customerId: params[2], id: params[3],
				priceId: params[4], status: params[5], currentPeriodStart: params[6],
				currentPeriodEnd: params[7], cancelAtPeriodEnd: params[8], trialEnd: params[9], eventCreated: params[10],
			};
			this.subscriptions.set(record.id, record);
			return { rows: [{ id: record.id, user_id: record.userId, tier: record.tier, status: record.status }] };
		}

		if (/SELECT tier FROM public\.billing_subscriptions WHERE user_id/i.test(statement)) {
			return {
				rows: [...this.subscriptions.values()]
					.filter((sub) => sub.userId === params[0] && ['active', 'trialing'].includes(sub.status))
					.map((sub) => ({ tier: sub.tier })),
			};
		}

		if (/UPDATE public\.profiles SET tier/i.test(statement)) {
			this.profileTier = params[0];
			return { rows: [], rowCount: 1 };
		}

		if (/UPDATE public\.billing_events/i.test(statement)) return { rows: [], rowCount: 1 };
		if (/FROM public\.user_billing/i.test(statement)) return { rows: [] };
		return { rows: [] };
	}

	async connect() {
		this.nextSessionId = (this.nextSessionId || 0) + 1;
		const sessionId = this.nextSessionId;
		return { query: (sql, params) => this.query(sql, params, sessionId), release() {} };
	}

	on() {}
}

const fakeDb = new FakeBillingDatabase();
let canonicalSubscription = null;
let retrieveFailure = null;
let retrieveHandler = null;
const retrievals = [];

function deferred() {
	let resolve;
	const promise = new Promise((done) => { resolve = done; });
	return { promise, resolve };
}

function subscription(status, metadataUserId = USER_A, id = 'sub_owned') {
	return {
		id,
		object: 'subscription',
		customer: 'cus_owned',
		status,
		metadata: metadataUserId ? { supabase_user_id: metadataUserId } : {},
		cancel_at_period_end: status === 'canceled',
		trial_end: null,
		items: {
			data: [{
				id: 'si_fixture', object: 'subscription_item', price: { id: TEACHER_PRICE },
				current_period_start: 1_777_000_000, current_period_end: 1_779_000_000,
			}],
		},
	};
}

let unconfiguredServer = null;
let configuredServer = null;
let unconfiguredBaseUrl = '';
let configuredBaseUrl = '';
let originalFetch = null;
const moduleRestorations = [];
let signingStripe = null;

function replaceModuleExport(moduleName, replacement) {
	const modulePath = require.resolve(moduleName);
	require(modulePath);
	const original = require.cache[modulePath].exports;
	require.cache[modulePath].exports = replacement;
	moduleRestorations.push(() => { require.cache[modulePath].exports = original; });
}

function loadFreshServer() {
	for (const modulePath of [require.resolve('../../server'), require.resolve('../../lib/billing')]) {
		delete require.cache[modulePath];
	}
	return require('../../server');
}

function listen(app) {
	return new Promise((resolve) => {
		const server = app.listen(0, '127.0.0.1', () => {
			resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
		});
	});
}

function close(server) {
	if (!server) return Promise.resolve();
	return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

before(async () => {
	const RealStripe = require('stripe');
	signingStripe = new RealStripe('sk_test_51OfflineSigningFixture');

	class OfflineOpenAI {
		constructor() {
			throw new Error('OpenAI must not be constructed in billing integration tests');
		}
	}
	class FakePool {
		query(...args) { return fakeDb.query(...args); }
		connect() { return fakeDb.connect(); }
		on() {}
	}

	const pg = require('pg');
	replaceModuleExport('pg', { ...pg, Pool: FakePool });
	replaceModuleExport('openai', OfflineOpenAI);
	replaceModuleExport('stripe', () => ({
		webhooks: signingStripe.webhooks,
		subscriptions: {
			async retrieve(id) {
				retrievals.push(id);
				if (retrieveFailure) throw retrieveFailure;
				if (retrieveHandler) return structuredClone(await retrieveHandler(id));
				return structuredClone(canonicalSubscription);
			},
		},
		customers: { async create() { return { id: 'cus_owned' }; } },
		checkout: { sessions: { async create() { return { url: 'https://checkout.givemegame.test/session' }; } } },
		billingPortal: { sessions: { async create() { return { url: 'https://portal.givemegame.test/session' }; } } },
	}));

	originalFetch = global.fetch;
	global.fetch = async (input, init) => {
		const url = String(input);
		if (url === 'https://auth.givemegame.test/auth/v1/user') {
			return new Response(JSON.stringify({ id: USER_A, email: 'teacher@givemegame.test' }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}
		if (url.startsWith('http://127.0.0.1:')) return originalFetch(input, init);
		throw new Error(`External network disabled in billing integration test: ${new URL(url).origin}`);
	};

	applyHermeticEnv('');
	const first = await listen(loadFreshServer());
	unconfiguredServer = first.server;
	unconfiguredBaseUrl = first.baseUrl;

	applyHermeticEnv('postgresql://billing-test.invalid/offline');
	const second = await listen(loadFreshServer());
	configuredServer = second.server;
	configuredBaseUrl = second.baseUrl;
});

after(async () => {
	await Promise.all([close(unconfiguredServer), close(configuredServer)]);
	global.fetch = originalFetch;
	for (const restore of moduleRestorations.reverse()) restore();
	delete require.cache[require.resolve('../../server')];
	delete require.cache[require.resolve('../../lib/billing')];
	restoreEnv();
});

async function authenticatedFetch(pathname, options = {}) {
	return fetch(`${configuredBaseUrl}${pathname}`, {
		...options,
		headers: { Authorization: 'Bearer offline-token', ...(options.headers || {}) },
	});
}

async function sendWebhook(event) {
	const payload = JSON.stringify(event);
	const signature = signingStripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
	return fetch(`${configuredBaseUrl}/api/billing/stripe-webhook`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature },
		body: payload,
	});
}

function seedLocalSubscription(id = 'sub_owned') {
	fakeDb.subscriptions.set(id, {
		userId: USER_A,
		tier: 'teacher',
		customerId: 'cus_owned',
		id,
		priceId: TEACHER_PRICE,
		status: 'active',
		currentPeriodStart: 1_777_000_000,
		currentPeriodEnd: 1_779_000_000,
		cancelAtPeriodEnd: false,
		trialEnd: null,
		eventCreated: 1_776_000_000,
	});
	fakeDb.profileTier = 'teacher';
}

describe('Billing API readiness and product surface', () => {
	it('returns 503 before auth when the database is unconfigured', async () => {
		for (const pathname of ['/api/billing/state', '/api/billing/tier', '/api/billing/portal']) {
			const method = pathname.endsWith('/portal') ? 'POST' : 'GET';
			const response = await fetch(`${unconfiguredBaseUrl}${pathname}`, { method });
			assert.equal(response.status, 503, `${pathname} must fail closed on database readiness`);
		}
	});

	it('requires authentication once the database and billing runtime are configured', async () => {
		assert.equal((await fetch(`${configuredBaseUrl}/api/billing/state`)).status, 401);
		assert.equal((await fetch(`${configuredBaseUrl}/api/billing/tier`)).status, 401);
	});

	it('opens the portal through offline authenticated/configured dependencies', async () => {
		const response = await authenticatedFetch('/api/billing/portal', { method: 'POST' });
		assert.equal(response.status, 200);
		assert.equal((await response.json()).url, 'https://portal.givemegame.test/session');
	});

	it('returns the highest active subscription instead of a newer canceled row', async () => {
		const response = await authenticatedFetch('/api/billing/tier');
		assert.equal(response.status, 200);
		const body = await response.json();
		assert.equal(body.subscription.status, 'active');
		assert.equal(body.subscription.sub_tier, 'school');
	});

	it('rejects school self-service Checkout while retaining the contact/pilot surface', async () => {
		const response = await authenticatedFetch('/api/billing/checkout', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'school-plan-request-1' },
			body: JSON.stringify({ plan: 'school_yearly', withdrawalConsent: true }),
		});
		assert.equal(response.status, 400);
		assert.equal((await response.json()).code, 'BAD_PLAN');

		const pricing = await (await fetch(`${configuredBaseUrl}/pricing.html`)).text();
		assert.deepEqual([...pricing.matchAll(/data-plan="([^"]+)"/g)].map((match) => match[1]), [
			'teacher_monthly', 'teacher_yearly',
		]);
		assert.doesNotMatch(pricing, /1 třída, až 30 žáků|Celá škola, neomezeně učitelů/i);
	});

	it('retires the legacy Payment Link and serves billing support pages', async () => {
		const legacy = await fetch(`${configuredBaseUrl}/api/billing/upgrade-url`);
		assert.equal(legacy.status, 410);
		assert.equal((await legacy.json()).code, 'LEGACY_PAYMENT_LINK_RETIRED');
		for (const pathname of ['/billing/success', '/billing/cancel']) {
			assert.equal((await fetch(`${configuredBaseUrl}${pathname}`)).status, 200);
		}
	});
});

describe('authoritative signed webhook reconciliation', () => {
	it('rejects a valid metadata/customer ownership conflict so Stripe can retry', async () => {
		fakeDb.reset();
		canonicalSubscription = { ...subscription('active'), customer: 'cus_conflict' };
		const object = { ...subscription('active'), customer: 'cus_conflict', metadata: { supabase_user_id: USER_A } };
		const response = await sendWebhook({
			id: 'evt_owner_conflict', type: 'customer.subscription.updated', created: 1_777_100_000,
			data: { object },
		});
		assert.equal(response.status, 500);
		assert.equal(fakeDb.subscriptions.size, 0);
	});

	it('does not persist or retrieve an unrelated object with invalid integration metadata', async () => {
		fakeDb.reset();
		retrievals.length = 0;
		const response = await sendWebhook({
			id: 'evt_unrelated_invalid', type: 'customer.subscription.updated', created: 1_777_100_001,
			data: { object: { ...subscription('active', null, 'sub_unrelated'), customer: 'cus_unknown', metadata: { supabase_user_id: 'not-a-uuid' } } },
		});
		assert.equal(response.status, 200);
		assert.equal(fakeDb.subscriptions.size, 0);
		assert.deepEqual(retrievals, []);
		assert.equal(fakeDb.advisoryLockAcquisitions, 0);
	});

	it('does not lock or retrieve for an audit-only payment failure', async () => {
		fakeDb.reset();
		retrievals.length = 0;
		const response = await sendWebhook({
			id: 'evt_payment_failed_audit', type: 'invoice.payment_failed', created: 1_777_100_002,
			data: { object: {
				id: 'in_failed', customer: 'cus_owned', subscription: 'sub_owned',
				metadata: { supabase_user_id: USER_A },
			} },
		});
		assert.equal(response.status, 200);
		assert.deepEqual(retrievals, []);
		assert.equal(fakeDb.advisoryLockAcquisitions, 0);
	});

	it('retrieves canonical snapshots for Checkout and subscription-created mutations', async () => {
		fakeDb.reset();
		retrievals.length = 0;
		retrieveFailure = null;
		canonicalSubscription = subscription('active');
		const checkoutResponse = await sendWebhook({
			id: 'evt_checkout_canonical', type: 'checkout.session.completed', created: 1_777_150_000,
			data: { object: {
				id: 'cs_owned', object: 'checkout.session', customer: 'cus_owned', subscription: 'sub_owned',
				metadata: { supabase_user_id: USER_A },
				subscription_details: { metadata: { supabase_user_id: USER_A } },
				client_reference_id: USER_A,
			} },
		});
		assert.equal(checkoutResponse.status, 200);

		const createdResponse = await sendWebhook({
			id: 'evt_created_canonical', type: 'customer.subscription.created', created: 1_777_150_000,
			data: { object: subscription('canceled') },
		});
		assert.equal(createdResponse.status, 200);
		assert.equal(fakeDb.subscriptions.get('sub_owned').status, 'active');
		assert.deepEqual(retrievals, ['sub_owned', 'sub_owned']);
	});

	it('keeps canonical canceled state when same-second active and canceled payloads arrive in reverse order', async () => {
		fakeDb.reset();
		retrievals.length = 0;
		retrieveFailure = null;
		canonicalSubscription = subscription('canceled');
		for (const [id, type, payloadStatus] of [
			['evt_cancel_first', 'customer.subscription.deleted', 'canceled'],
			['evt_stale_active_second', 'customer.subscription.updated', 'active'],
		]) {
			const response = await sendWebhook({ id, type, created: 1_777_200_000, data: { object: subscription(payloadStatus) } });
			assert.equal(response.status, 200);
		}
		assert.equal(fakeDb.subscriptions.get('sub_owned').status, 'canceled');
		assert.equal(fakeDb.profileTier, 'free');
		assert.deepEqual(retrievals, ['sub_owned', 'sub_owned']);
	});

	it('keeps canonical active state when a same-second deleted payload arrives last', async () => {
		fakeDb.reset();
		retrievals.length = 0;
		retrieveFailure = null;
		canonicalSubscription = subscription('active');
		for (const [id, type, payloadStatus] of [
			['evt_active_first', 'customer.subscription.updated', 'active'],
			['evt_stale_deleted_second', 'customer.subscription.deleted', 'canceled'],
		]) {
			const response = await sendWebhook({ id, type, created: 1_777_300_000, data: { object: subscription(payloadStatus) } });
			assert.equal(response.status, 200);
		}
		assert.equal(fakeDb.subscriptions.get('sub_owned').status, 'active');
		assert.equal(fakeDb.profileTier, 'teacher');
		assert.deepEqual(retrievals, ['sub_owned', 'sub_owned']);
	});

	it('serializes canonical retrieval so an older active snapshot cannot overwrite a newer cancellation', async () => {
		fakeDb.reset();
		retrievals.length = 0;
		retrieveFailure = null;
		const firstRetrieveStarted = deferred();
		const allowFirstRetrieve = deferred();
		const secondRetrieveStarted = deferred();
		const secondLockWaited = deferred();
		let retrieveCount = 0;
		retrieveHandler = async () => {
			retrieveCount += 1;
			if (retrieveCount === 1) {
				firstRetrieveStarted.resolve();
				await allowFirstRetrieve.promise;
				return subscription('active');
			}
			secondRetrieveStarted.resolve();
			return subscription('canceled');
		};
		fakeDb.lockWaitObserver = () => secondLockWaited.resolve();

		const olderActiveRequest = sendWebhook({
			id: 'evt_concurrent_active', type: 'customer.subscription.updated', created: 1_777_350_000,
			data: { object: subscription('active') },
		});
		await firstRetrieveStarted.promise;
		const newerCanceledRequest = sendWebhook({
			id: 'evt_concurrent_canceled', type: 'customer.subscription.updated', created: 1_777_350_000,
			data: { object: subscription('canceled') },
		});

		let boundaryObservation;
		try {
			boundaryObservation = await Promise.race([
				secondRetrieveStarted.promise.then(() => 'retrieved-before-release'),
				secondLockWaited.promise.then(() => 'waited-for-lock'),
			]);
		} finally {
			allowFirstRetrieve.resolve();
		}
		const [olderResponse, newerResponse] = await Promise.all([olderActiveRequest, newerCanceledRequest]);
		retrieveHandler = null;
		fakeDb.lockWaitObserver = null;

		assert.equal(boundaryObservation, 'waited-for-lock');
		assert.equal(olderResponse.status, 200);
		assert.equal(newerResponse.status, 200);
		assert.equal(fakeDb.subscriptions.get('sub_owned').status, 'canceled');
		assert.equal(fakeDb.profileTier, 'free');
		assert.equal(fakeDb.advisoryLockAcquisitions, 2);
		assert.equal(fakeDb.advisoryLockReleases, 2);
	});

	it('releases the subscription lock when canonical retrieval fails', async () => {
		fakeDb.reset();
		retrievals.length = 0;
		retrieveFailure = new Error('Stripe temporarily unavailable');
		const failedResponse = await sendWebhook({
			id: 'evt_lock_error', type: 'customer.subscription.updated', created: 1_777_360_000,
			data: { object: subscription('active') },
		});
		assert.equal(failedResponse.status, 500);
		assert.equal(fakeDb.advisoryLockAcquisitions, 1);
		assert.equal(fakeDb.advisoryLockReleases, 1);

		retrieveFailure = null;
		canonicalSubscription = subscription('canceled');
		const recoveredResponse = await sendWebhook({
			id: 'evt_after_lock_error', type: 'customer.subscription.updated', created: 1_777_360_001,
			data: { object: subscription('canceled') },
		});
		assert.equal(recoveredResponse.status, 200);
		assert.equal(fakeDb.subscriptions.get('sub_owned').status, 'canceled');
		assert.equal(fakeDb.advisoryLockAcquisitions, 2);
		assert.equal(fakeDb.advisoryLockReleases, 2);
	});

	it('uses the deleted webhook snapshot only when Stripe reports the subscription missing', async () => {
		fakeDb.reset();
		retrievals.length = 0;
		retrieveFailure = Object.assign(new Error('No such subscription'), { code: 'resource_missing', statusCode: 404 });
		const response = await sendWebhook({
			id: 'evt_deleted_missing', type: 'customer.subscription.deleted', created: 1_777_400_000,
			data: { object: subscription('canceled') },
		});
		retrieveFailure = null;
		assert.equal(response.status, 200);
		assert.equal(fakeDb.subscriptions.get('sub_owned').status, 'canceled');
		assert.deepEqual(retrievals, ['sub_owned']);
	});

	for (const [label, type] of [
		['subscription update', 'customer.subscription.updated'],
		['Checkout completion', 'checkout.session.completed'],
	]) {
		it(`cancels a durable local subscription when a delayed ${label} is missing from Stripe`, async () => {
			fakeDb.reset();
			seedLocalSubscription();
			retrievals.length = 0;
			retrieveFailure = Object.assign(new Error('No such subscription'), { code: 'resource_missing', statusCode: 404 });
			const object = type === 'checkout.session.completed'
				? {
					id: 'cs_delayed_missing', object: 'checkout.session', customer: 'cus_owned', subscription: 'sub_owned',
					metadata: { supabase_user_id: USER_A },
					subscription_details: { metadata: { supabase_user_id: USER_A } },
					client_reference_id: USER_A,
				}
				: subscription('active');
			let response;
			try {
				response = await sendWebhook({
					id: `evt_missing_local_${type}`, type, created: 1_777_450_000,
					data: { object },
				});
			} finally {
				retrieveFailure = null;
			}
			assert.equal(response.status, 200);
			const stored = fakeDb.subscriptions.get('sub_owned');
			assert.equal(stored.status, 'canceled');
			assert.equal(stored.userId, USER_A);
			assert.equal(stored.customerId, 'cus_owned');
			assert.equal(stored.priceId, TEACHER_PRICE);
			assert.equal(stored.currentPeriodStart, 1_777_000_000);
			assert.equal(stored.currentPeriodEnd, 1_779_000_000);
			assert.equal(fakeDb.profileTier, 'free');
			assert.equal(fakeDb.events.has(`evt_missing_local_${type}`), true);
		});

		it(`audits a delayed ${label} missing from Stripe when no durable local row exists`, async () => {
			fakeDb.reset();
			retrievals.length = 0;
			retrieveFailure = Object.assign(new Error('No such subscription'), { code: 'resource_missing', statusCode: 404 });
			const object = type === 'checkout.session.completed'
				? {
					id: 'cs_delayed_no_local', object: 'checkout.session', customer: 'cus_new', subscription: 'sub_not_local',
					metadata: { supabase_user_id: USER_A },
					subscription_details: { metadata: { supabase_user_id: USER_A } },
					client_reference_id: USER_A,
				}
				: { ...subscription('active', USER_A, 'sub_not_local'), customer: 'cus_new' };
			let response;
			try {
				response = await sendWebhook({
					id: `evt_missing_no_local_${type}`, type, created: 1_777_460_000,
					data: { object },
				});
			} finally {
				retrieveFailure = null;
			}
			assert.equal(response.status, 200);
			assert.equal(fakeDb.subscriptions.size, 0);
			assert.equal(fakeDb.profileTier, 'free');
			assert.equal(fakeDb.events.has(`evt_missing_no_local_${type}`), true);
		});
	}
});

describe('billing page safety', () => {
	it('renders account load errors as text rather than HTML', async () => {
		const html = await (await fetch(`${configuredBaseUrl}/account.html`)).text();
		const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
			.map((match) => match[1]).filter((script) => script.trim());
		const elements = new Map();
		function element(id = '') {
			if (elements.has(id)) return elements.get(id);
			const value = {
				id, style: {}, children: [], textContent: '', className: '', title: '',
				classList: { add() {}, remove() {} },
				addEventListener() {}, removeAttribute() {}, setAttribute() {},
				appendChild(child) { this.children.push(child); return child; },
				replaceChildren(...children) { this.children = children; },
				set innerHTML(htmlValue) { this.unsafeHtml = htmlValue; this.children = []; },
			};
			elements.set(id, value);
			return value;
		}
		const hostileMessage = '<img src=x onerror=alert(1)>';
		const context = {
			window: { supabase: { createClient: () => ({ auth: { getSession: async () => ({ data: { session: {
				access_token: 'offline-token', user: { email: 'teacher@givemegame.test', user_metadata: {} },
			} } }) } }) } },
			document: { getElementById: element, querySelectorAll: () => [], createElement: () => element(`created-${elements.size}`) },
			fetch: async () => { throw new Error(hostileMessage); },
			location: { href: '' }, alert() {}, console, setTimeout, clearTimeout,
		};
		vm.runInNewContext(scripts.at(-1), context);
		await new Promise((resolve) => setImmediate(resolve));
		await new Promise((resolve) => setImmediate(resolve));

		const actions = element('plan-actions');
		assert.equal(actions.children.length, 1);
		assert.equal(actions.children[0].textContent, `Nepodarilo sa načítať stav predplatného: ${hostileMessage}`);
		assert.equal(actions.unsafeHtml, undefined);
	});
});
