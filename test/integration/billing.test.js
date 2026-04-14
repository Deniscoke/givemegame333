/**
 * gIVEMEGAME.IO — Integration tests: Payment Link billing MVP
 * Run: node --test test/integration/billing.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

let server = null;
let baseUrl = '';

describe('Billing API (Payment Link MVP)', () => {
	before(() => {
		process.env.VERCEL = '1';
		delete process.env.STRIPE_PAYMENT_LINK_PRO_MONTHLY;
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

	it('GET /api/billing/state without auth returns 401', async () => {
		const res = await fetch(`${baseUrl}/api/billing/state`);
		assert.strictEqual(res.status, 401);
	});

	it('GET /api/billing/upgrade-url without auth returns 401', async () => {
		const res = await fetch(`${baseUrl}/api/billing/upgrade-url`);
		assert.strictEqual(res.status, 401);
	});

	it('GET /api/billing/upgrade-url with invalid token returns 401/403', async () => {
		const res = await fetch(`${baseUrl}/api/billing/upgrade-url`, {
			headers: { 'Authorization': 'Bearer invalid_token_12345' }
		});
		assert.ok(res.status === 401 || res.status === 403);
	});

	it('GET /billing/success returns 200', async () => {
		const res = await fetch(`${baseUrl}/billing/success`);
		assert.strictEqual(res.status, 200);
		const html = await res.text();
		assert.ok(html.includes('Ďakujeme') || html.includes('success'));
	});

	it('GET /billing/cancel returns 200', async () => {
		const res = await fetch(`${baseUrl}/billing/cancel`);
		assert.strictEqual(res.status, 200);
		const html = await res.text();
		assert.ok(html.includes('zrušen') || html.includes('cancel'));
	});

	it('GET /api/billing/public-config returns JSON without auth', async () => {
		const res = await fetch(`${baseUrl}/api/billing/public-config`);
		assert.strictEqual(res.status, 200);
		const data = await res.json();
		assert.ok(typeof data.upgradeAvailable === 'boolean');
		assert.ok('proPlanLabel' in data || 'supportEmail' in data);
	});
});
