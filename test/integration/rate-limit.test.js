/**
 * gIVEMEGAME.IO — Integration test: rate limit on /api/generate-game
 * Run: node --test test/integration/rate-limit.test.js
 * The harness forces DB/API credentials off and rejects every non-local network call.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

let server = null;
let baseUrl = '';
let originalFetch = null;
let originalOpenAiExport = null;
const TEST_ENV_KEYS = [
	'VERCEL', 'NODE_ENV', 'OPENAI_API_KEY', 'SUPABASE_DB_URL', 'SUPABASE_URL',
	'SUPABASE_ANON_KEY', 'ALLOWED_ORIGINS',
];
const envSnapshot = new Map(TEST_ENV_KEYS.map((name) => [
	name,
	{ present: Object.prototype.hasOwnProperty.call(process.env, name), value: process.env[name] },
]));

function restoreEnvironment() {
	for (const [name, snapshot] of envSnapshot) {
		if (snapshot.present) process.env[name] = snapshot.value;
		else delete process.env[name];
	}
}

describe('Rate limit on /api/generate-game', () => {
	before(() => {
		Object.assign(process.env, {
			VERCEL: '1', NODE_ENV: 'test', OPENAI_API_KEY: '', SUPABASE_DB_URL: '',
			SUPABASE_URL: '', SUPABASE_ANON_KEY: '', ALLOWED_ORIGINS: '',
		});

		const openAiPath = require.resolve('openai');
		require(openAiPath);
		originalOpenAiExport = require.cache[openAiPath].exports;
		require.cache[openAiPath].exports = class OfflineOpenAI {
			constructor() {
				throw new Error('OpenAI must not be constructed in the rate-limit integration test');
			}
		};

		originalFetch = global.fetch;
		global.fetch = (input, init) => {
			const url = String(input);
			if (url.startsWith('http://127.0.0.1:')) return originalFetch(input, init);
			throw new Error(`External network disabled in rate-limit integration test: ${new URL(url).origin}`);
		};

		delete require.cache[require.resolve('../../server')];
		return new Promise((resolve) => {
			const app = require('../../server');
			server = app.listen(0, '127.0.0.1', () => {
				const port = server.address().port;
				baseUrl = `http://127.0.0.1:${port}`;
				resolve();
			});
		});
	});

	after(async () => {
		if (server) {
			await new Promise((resolve, reject) => {
				server.close((error) => error ? reject(error) : resolve());
			});
		}
		global.fetch = originalFetch;
		const openAiPath = require.resolve('openai');
		require.cache[openAiPath].exports = originalOpenAiExport;
		delete require.cache[require.resolve('../../server')];
		restoreEnvironment();
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
		const admitted = results.filter((result) => result.status !== 429);
		assert.ok(admitted.length >= 1);
		assert.ok(admitted.every((result) => result.status === 400 && result.body?.code === 'NO_API_KEY'));
	});
});
