/**
 * gIVEMEGAME.IO — Integration test: rate limit on /api/generate-game
 * Run: node --test test/integration/rate-limit.test.js
 * Requires: server starts without DB (generate-game returns 400 NO_API_KEY before hitting OpenAI)
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

let server = null;
let baseUrl = '';

describe('Rate limit on /api/generate-game', () => {
	before(() => {
		// Prevent server from auto-starting on port 3000 when required
		process.env.VERCEL = '1';
		return new Promise((resolve) => {
			const app = require('../../server');
			server = app.listen(0, () => {
				const port = server.address().port;
				baseUrl = `http://127.0.0.1:${port}`;
				resolve();
			});
		});
	});

	after(() => {
		if (server) server.close();
	});

	async function postGenerateGame() {
		const res = await fetch(`${baseUrl}/api/generate-game`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ filters: {} })
		});
		const body = await res.json().catch(() => null);
		return { status: res.status, body };
	}

	it('returns 429 RATE_LIMIT_EXCEEDED when exceeding anonymous per-minute cap', async () => {
		// Fire 11 requests in parallel — free anonymous cap is 8/min; at least one 429
		const promises = Array.from({ length: 11 }, () => postGenerateGame());
		const results = await Promise.all(promises);
		const rateLimited = results.filter(r => r.status === 429 && r.body?.code === 'RATE_LIMIT_EXCEEDED');
		assert.ok(rateLimited.length >= 1, `Expected at least one 429 RATE_LIMIT_EXCEEDED, got statuses: ${results.map(r => r.status).join(', ')}`);
	});
});
