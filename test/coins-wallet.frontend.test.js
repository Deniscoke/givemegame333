'use strict';

/**
 * Behavioural tests for public/js/coins.js after C2 / H9:
 *   - signed-in: the balance comes from the server, the browser never writes
 *     profiles, rewards / spends are reported and the server balance is adopted,
 *     mode clicks go to the capped route
 *   - guest: local practice wallet only, no network
 * Plus i18n coverage for the strings added in Phase 0.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const coinsSrc = read('public/js/coins.js');

function makeStorage() {
	const m = new Map();
	return {
		getItem: (k) => (m.has(k) ? m.get(k) : null),
		setItem: (k, v) => m.set(k, String(v)),
		removeItem: (k) => m.delete(k),
		_map: m,
	};
}

function loadCoins({ signedIn, serverBalance = 0, responses = {} }) {
	const calls = [];
	const profileWrites = [];
	const toasts = [];
	const el = { textContent: '', classList: { add() {}, remove() {} }, offsetWidth: 0 };
	const supabaseClient = {
		auth: { getSession: async () => ({ data: { session: signedIn ? { access_token: 'tok' } : null } }) },
		from: () => ({
			select: () => ({ eq: () => ({ single: async () => ({ data: { coins: serverBalance }, error: null }) }) }),
			upsert: (row) => { profileWrites.push(row); return Promise.resolve({ error: null }); },
			update: (row) => { profileWrites.push(row); return { eq: () => Promise.resolve({ error: null }) }; },
		}),
	};
	const fetch = async (url, init = {}) => {
		const body = init.body ? JSON.parse(init.body) : undefined;
		calls.push({ url, method: init.method || 'GET', body });
		const handler = responses[url];
		const r = typeof handler === 'function' ? handler(body) : handler;
		const { status = 200, json = {} } = r || {};
		return { ok: status < 400, status, json: async () => json };
	};
	const sandbox = {
		console: { log() {}, warn() {}, error() {} },
		setTimeout, clearTimeout, AbortController, Promise, JSON, Math, Number, parseInt, Object, Array, String, Date,
		localStorage: makeStorage(),
		document: { getElementById: () => el, addEventListener() {}, querySelectorAll: () => [] },
		window: { AudioContext: undefined },
		fetch,
		supabaseClient,
		supabaseProfilesOk: true,
		getCurrentUser: () => (signedIn ? { uid: 'user-1', name: 'U' } : { uid: 'guest' }),
		GameUI: { toast: (m) => toasts.push(m) },
	};
	sandbox.window.givemegame_t = (k, f) => f || k;
	vm.createContext(sandbox);
	vm.runInContext(coinsSrc, sandbox);
	return { Coins: sandbox.window.Coins, calls, profileWrites, toasts, el, storage: sandbox.localStorage };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('coins.js signed-in wallet (server-authoritative)', () => {
	it('loads the server balance and ignores a higher localStorage value', async () => {
		const t = loadCoins({ signedIn: true, responses: { '/api/coins/balance': { json: { balance: 120 } } } });
		t.storage.setItem('givemegame_coins', '999999');
		await t.Coins.load();
		assert.equal(t.Coins.getBalance(), 120);
		assert.equal(t.profileWrites.length, 0);
	});

	it('asks for the starter grant only when the server balance is 0', async () => {
		const t = loadCoins({
			signedIn: true,
			responses: {
				'/api/coins/balance': { json: { balance: 0 } },
				'/api/coins/starter-grant': { json: { granted: true, balance: 500 } },
			},
		});
		await t.Coins.load();
		assert.equal(t.Coins.getBalance(), 500);
		assert.ok(t.calls.some((c) => c.url === '/api/coins/starter-grant' && c.method === 'POST'));
	});

	it('reports rewards to /api/coins/log and adopts the server balance (cap revert)', async () => {
		const t = loadCoins({
			signedIn: true,
			responses: {
				'/api/coins/balance': { json: { balance: 100 } },
				'/api/coins/log': { status: 429, json: { code: 'COIN_DAILY_CAP', balance: 100 } },
			},
		});
		await t.Coins.load();
		t.Coins.award('timer');
		assert.equal(t.Coins.getBalance(), 600, 'optimistic');
		await flush(); await flush();
		assert.equal(t.Coins.getBalance(), 100, 'server balance wins');
		const log = t.calls.find((c) => c.url === '/api/coins/log');
		assert.deepEqual(log.body, { amount: 500, action: 'timer' });
		assert.equal(t.toasts.length, 1);
		assert.equal(t.profileWrites.length, 0);
	});

	it('sends mode clicks to the capped route, never to /api/coins/log (H9)', async () => {
		const t = loadCoins({
			signedIn: true,
			responses: {
				'/api/coins/balance': { json: { balance: 10 } },
				'/api/coins/award-mode-click': { json: { awarded: true, balance: 11 } },
			},
		});
		await t.Coins.load();
		t.Coins.award('mode_click');
		await flush(); await flush();
		assert.ok(t.calls.some((c) => c.url === '/api/coins/award-mode-click' && c.method === 'POST'));
		assert.ok(!t.calls.some((c) => c.url === '/api/coins/log'));
		assert.equal(t.Coins.getBalance(), 11);
	});

	it('does not grant a shop powerup when the server refuses the debit', async () => {
		const t = loadCoins({
			signedIn: true,
			responses: {
				'/api/coins/balance': { json: { balance: 1000 } },
				'/api/coins/log': { status: 402, json: { code: 'INSUFFICIENT_COINS', balance: 100, error: 'Nedostatok coinov' } },
			},
		});
		await t.Coins.load();
		await t.Coins.purchaseItem('free_gen_3');
		assert.equal(t.Coins.getActivePowerup('free_gen'), null);
		assert.equal(t.Coins.getBalance(), 100);
	});

	it('buys the XP boost through /api/shop/purchase', async () => {
		const t = loadCoins({
			signedIn: true,
			responses: {
				'/api/coins/balance': { json: { balance: 2000 } },
				'/api/shop/purchase': { json: { ok: true, new_balance: 500 } },
			},
		});
		await t.Coins.load();
		await t.Coins.purchaseItem('xp_boost_2x');
		const buy = t.calls.find((c) => c.url === '/api/shop/purchase');
		assert.deepEqual(buy.body, { item_id: 'xp_boost_2x' });
		assert.ok(!t.calls.some((c) => c.url === '/api/coins/log'));
		assert.equal(t.Coins.getBalance(), 500);
		assert.equal(t.Coins.getActivePowerup('xp_boost').uses, 3);
	});
});

describe('coins.js after the P0 review', () => {
	it('signed-in: spendAmount no longer lowers only the local number (gIVEME donations go to the server)', async () => {
		const t = loadCoins({ signedIn: true, responses: { '/api/coins/balance': { json: { balance: 100 } } } });
		await t.Coins.load();
		assert.equal(t.Coins.spendAmount(50), false);
		assert.equal(t.Coins.getBalance(), 100);
		assert.equal(t.Coins.isServerWallet(), true);
		t.Coins.syncServerBalance(50);
		assert.equal(t.Coins.getBalance(), 50);
		assert.equal(t.profileWrites.length, 0);
	});

	it('guest: spendAmount still debits the practice wallet; syncServerBalance is ignored', async () => {
		const t = loadCoins({ signedIn: false });
		await t.Coins.load();
		assert.equal(t.Coins.spendAmount(50), true);
		assert.equal(t.Coins.getBalance(), 450);
		t.Coins.syncServerBalance(99999);
		assert.equal(t.Coins.getBalance(), 450);
	});

	it('shows the daily-cap toast when a counted completion earned no coins (capped)', async () => {
		const t = loadCoins({
			signedIn: true,
			responses: {
				'/api/coins/balance': { json: { balance: 500 } },
				'/api/coins/log': { json: { ok: true, credited: 0, capped: true, balance: 500 } },
			},
		});
		await t.Coins.load();
		t.Coins.award('robot_challenge');
		await flush(); await flush();
		assert.equal(t.Coins.getBalance(), 500);
		assert.equal(t.toasts.length, 1);
	});
});

describe('coins.js guest practice wallet', () => {
	it('starts with the starter coins, stays local and never calls the server', async () => {
		const t = loadCoins({ signedIn: false });
		await t.Coins.load();
		assert.equal(t.Coins.getBalance(), 500);
		t.Coins.award('timer');
		assert.equal(t.Coins.spend('generate'), true);
		await flush();
		assert.equal(t.Coins.getBalance(), 950);
		assert.equal(t.storage.getItem('givemegame_coins'), '950');
		assert.equal(t.calls.length, 0);
		assert.equal(t.profileWrites.length, 0);
	});
});

describe('Phase 0 i18n keys', () => {
	const LANGS = ['sk', 'cs', 'en', 'de', 'es', 'tr'];
	const dicts = Object.fromEntries(LANGS.map((l) => [l, JSON.parse(read(`public/data/i18n/${l}.json`))]));
	const KEYS = ['coins_daily_cap', 'coins_tx_starter_grant', 'refl_verify_daily_cap', 'refl_verify_reward_capped'];

	it('exist and are translated in all six languages', () => {
		for (const k of KEYS) {
			for (const l of LANGS) assert.equal(typeof dicts[l][k], 'string', `${l}:${k}`);
			for (const l of ['en', 'de', 'es', 'tr']) assert.notEqual(dicts[l][k], dicts.sk[k], `${l}:${k}`);
		}
	});

	it('are the keys the code uses', () => {
		const src = coinsSrc + read('public/script.js');
		// coins.js keeps ledger labels as [key, fallback] pairs passed to _t().
		for (const k of KEYS) assert.match(src, new RegExp(`\\b_?t\\('${k}'|\\['${k}',`), k);
	});
});

describe('P0 review i18n keys', () => {
	const LANGS = ['sk', 'cs', 'en', 'de', 'es', 'tr'];
	const dicts = Object.fromEntries(LANGS.map((l) => [l, JSON.parse(read(`public/data/i18n/${l}.json`))]));
	const KEYS = ['coins_tx_donation_sent', 'coins_tx_donation_received', 'coins_tx_balance_reconcile', 'giveme_donate_daily_cap'];

	it('exist and are translated in all six languages', () => {
		for (const k of KEYS) {
			for (const l of LANGS) assert.equal(typeof dicts[l][k], 'string', `${l}:${k}`);
			for (const l of ['en', 'de', 'es', 'tr']) assert.notEqual(dicts[l][k], dicts.sk[k], `${l}:${k}`);
		}
	});

	it('are the keys the code uses', () => {
		const src = coinsSrc + read('public/gIVEME/script.js');
		for (const k of KEYS) assert.match(src, new RegExp(`'${k}'`), k);
	});
});
