/**
 * gIVEMEGAME.IO — Integration tests: Stripe billing MVP
 * Run: node --test test/integration/billing.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

let server = null;
let baseUrl = '';

describe('Billing API', () => {
	before(() => {
		process.env.VERCEL = '1';
		// Enable billingReady() so we hit auth checks (Stripe client won't init with placeholder)
		process.env.STRIPE_SECRET_KEY = 'sk_test_1234567890abcdef';
		process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_123';
		delete process.env.STRIPE_WEBHOOK_SECRET;
		return new Promise((resolve) => {
			const app = require('../../server');
			server = app.listen(0, () => {
				baseUrl = `http://127.0.0.1:${server.address().port}`;
				resolve();
			});
		});
	});

	after(() => {
		if (server) server.close();
	});

	it('POST /api/billing/create-checkout-session without auth returns 401', async () => {
		const res = await fetch(`${baseUrl}/api/billing/create-checkout-session`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: '{}'
		});
		const body = await res.json().catch(() => ({}));
		assert.strictEqual(res.status, 401);
		assert.ok(body.code === 'NO_TOKEN' || body.code === 'EMPTY_TOKEN' || body.code === 'INVALID_TOKEN');
	});

	it('POST /api/billing/create-checkout-session with invalid token returns 401/403', async () => {
		const res = await fetch(`${baseUrl}/api/billing/create-checkout-session`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer invalid_token_12345' },
			body: '{}'
		});
		assert.ok(res.status === 401 || res.status === 403);
	});

	it('POST /api/stripe/webhook with invalid signature returns 400', async () => {
		process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
		const res = await fetch(`${baseUrl}/api/stripe/webhook`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Stripe-Signature': 'invalid' },
			body: JSON.stringify({ id: 'evt_test', type: 'checkout.session.completed' })
		});
		// Raw body route: fetch sends JSON, server expects raw - signature will fail
		const body = await res.json().catch(() => ({}));
		assert.strictEqual(res.status, 400);
	});

	it('GET /api/billing/state without auth returns 401', async () => {
		const res = await fetch(`${baseUrl}/api/billing/state`);
		assert.strictEqual(res.status, 401);
	});

	it('POST /api/billing/create-portal-session without auth returns 401', async () => {
		const res = await fetch(`${baseUrl}/api/billing/create-portal-session`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: '{}'
		});
		assert.strictEqual(res.status, 401);
	});
});
