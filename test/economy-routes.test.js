'use strict';

/**
 * Route-level tests for the Phase 0 coin / XP fixes:
 *   C2  /api/coins/log credits and debits on the server (daily caps, no overdraft),
 *       starter grant for brand-new accounts, mode_click / shop boost refused there
 *   H3  solo xp_multiplier clamped to 1 unless a server-sold boost is in the ledger
 *   H4  photo verification: daily attempt cap (no OpenAI call) and daily reward cap
 *   H9  mode-click coins only through the capped route
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startEconomyServer } = require('./helpers/economy-harness');
const { PHOTO_VERIFY_DAILY_ATTEMPTS, PHOTO_VERIFY_DAILY_REWARDS } = require('../lib/session-economy');
const { DAILY_REWARD_CAP, STARTER_GRANT_COINS } = require('../lib/coin-log-policy');

const U = 'user-solo';
let h;

function profile(coins, extra = {}) {
	h.db.state.profiles[U] = { coins, rpg_xp: 0, rpg_avatar_id: null, ...extra };
}

const GAME = { title: 'Solo', duration: { min: 5, max: 15 }, rvp: { kompetence: ['komunikativni'] } };

before(async () => { h = await startEconomyServer(); });
after(async () => { await h.stop(); });
beforeEach(() => {
	h.db.state = { profiles: {}, sessions: {}, participants: [], tx: [], talents: [] };
	h.db.openAiCalls = 0;
});

describe('solo completion xp_multiplier (H3)', () => {
	it('ignores a client multiplier when no boost was bought', async () => {
		profile(0);
		const res = await h.call('POST', '/api/profile/complete-solo', {
			user: U, body: { game_json: GAME, xp_multiplier: 5 },
		});
		assert.equal(res.status, 200, JSON.stringify(res.body));
		assert.equal(res.body.xp_multiplier_applied, 1);
		assert.equal(res.body.rpg_xp_gained, 53);
	});

	it('applies 2x for exactly the 3 uses of a server-sold boost, and never more than 2x', async () => {
		profile(2000);
		const buy = await h.call('POST', '/api/shop/purchase', { user: U, body: { item_id: 'xp_boost_2x' } });
		assert.equal(buy.status, 200, JSON.stringify(buy.body));
		assert.equal(buy.body.new_balance, 500);

		const gained = [];
		for (let i = 0; i < 4; i++) {
			const r = await h.call('POST', '/api/profile/complete-solo', {
				user: U, body: { game_json: GAME, xp_multiplier: 5 },
			});
			assert.equal(r.status, 200, JSON.stringify(r.body));
			gained.push(r.body.xp_multiplier_applied);
		}
		assert.deepEqual(gained, [2, 2, 2, 1]);
	});

	it('a boost row forged through /api/coins/log is refused and grants nothing', async () => {
		profile(5000);
		const forged = await h.call('POST', '/api/coins/log', {
			user: U, body: { action: 'shop_xp_boost_2x', amount: -1500, metadata: { boost_uses: 99 } },
		});
		assert.equal(forged.status, 400);
		assert.equal(forged.body.code, 'UNKNOWN_ACTION');
		const r = await h.call('POST', '/api/profile/complete-solo', {
			user: U, body: { game_json: GAME, xp_multiplier: 2 },
		});
		assert.equal(r.body.xp_multiplier_applied, 1);
	});
});

describe('POST /api/coins/log is server-authoritative (C2)', () => {
	it('credits rewards up to the daily cap and reports the balance', async () => {
		profile(0);
		const cap = DAILY_REWARD_CAP.timer;
		const a = await h.call('POST', '/api/coins/log', { user: U, body: { action: 'timer', amount: 500 } });
		assert.equal(a.status, 200, JSON.stringify(a.body));
		assert.equal(a.body.balance, 500);
		const b = await h.call('POST', '/api/coins/log', { user: U, body: { action: 'timer', amount: 1000 } });
		assert.equal(b.body.credited, cap - 500, 'clamped to what is left of the cap');
		const c = await h.call('POST', '/api/coins/log', { user: U, body: { action: 'timer', amount: 500 } });
		assert.equal(c.status, 429);
		assert.equal(c.body.code, 'COIN_DAILY_CAP');
		assert.equal(h.db.state.profiles[U].coins, cap);
	});

	it('gIVEME actions share one cap', async () => {
		profile(0);
		for (let i = 0; i < DAILY_REWARD_CAP.giveme / 2; i++) {
			await h.call('POST', '/api/coins/log', { user: U, body: { action: i % 2 ? 'giveme_like' : 'giveme_share', amount: 2 } });
		}
		const over = await h.call('POST', '/api/coins/log', { user: U, body: { action: 'giveme_comment', amount: 1 } });
		assert.equal(over.status, 429);
		assert.equal(h.db.state.profiles[U].coins, DAILY_REWARD_CAP.giveme);
	});

	it('debits spends only when affordable', async () => {
		profile(60);
		const ok = await h.call('POST', '/api/coins/log', { user: U, body: { action: 'spend_generate', amount: -50 } });
		assert.equal(ok.status, 200);
		assert.equal(ok.body.balance, 10);
		const no = await h.call('POST', '/api/coins/log', { user: U, body: { action: 'spend_generate', amount: -50 } });
		assert.equal(no.status, 402);
		assert.equal(no.body.code, 'INSUFFICIENT_COINS');
		assert.equal(no.body.balance, 10);
		assert.equal(h.db.state.profiles[U].coins, 10);
	});

	it('refuses mode_click (it has its own capped route, H9)', async () => {
		profile(0);
		const res = await h.call('POST', '/api/coins/log', { user: U, body: { action: 'mode_click', amount: 1 } });
		assert.equal(res.status, 400);
		assert.equal(h.db.state.profiles[U].coins, 0);
	});
});

describe('POST /api/coins/award-mode-click (H9)', () => {
	it('credits one coin and returns the server balance', async () => {
		profile(7);
		const res = await h.call('POST', '/api/coins/award-mode-click', { user: U });
		assert.equal(res.status, 200);
		assert.equal(res.body.awarded, true);
		assert.equal(res.body.balance, 8);
	});
});

describe('POST /api/coins/starter-grant', () => {
	it('grants the starter coins once to a brand-new account', async () => {
		const first = await h.call('POST', '/api/coins/starter-grant', { user: U });
		assert.equal(first.status, 200);
		assert.deepEqual(first.body, { granted: true, balance: STARTER_GRANT_COINS });
		const again = await h.call('POST', '/api/coins/starter-grant', { user: U });
		assert.equal(again.body.granted, false);
		assert.equal(h.db.state.profiles[U].coins, STARTER_GRANT_COINS);
	});

	it('does not grant to an account that already has ledger history', async () => {
		profile(0);
		h.db.insertTx(U, -50, 'spend_generate', null);
		const res = await h.call('POST', '/api/coins/starter-grant', { user: U });
		assert.equal(res.body.granted, false);
		assert.equal(h.db.state.profiles[U].coins, 0);
	});
});

describe('POST /api/verify-completion caps (H4)', () => {
	const body = { photo_base64: 'data:image/png;base64,AAAA', challenge_description: 'Ukáž výrobok', game_title: 'X' };

	it('stops calling the vision model after the daily attempt cap', async () => {
		profile(0);
		for (let i = 0; i < PHOTO_VERIFY_DAILY_ATTEMPTS; i++) {
			const r = await h.call('POST', '/api/verify-completion', { user: U, body });
			assert.equal(r.status, 200, JSON.stringify(r.body));
		}
		const capped = await h.call('POST', '/api/verify-completion', { user: U, body });
		assert.equal(capped.status, 429);
		assert.equal(capped.body.code, 'PHOTO_VERIFY_DAILY_CAP');
		assert.equal(h.db.openAiCalls, PHOTO_VERIFY_DAILY_ATTEMPTS);
	});

	it('pays the XP/coin bonus only for the first rewards of the day', async () => {
		profile(0);
		const results = [];
		for (let i = 0; i < PHOTO_VERIFY_DAILY_REWARDS + 1; i++) {
			results.push((await h.call('POST', '/api/verify-completion', { user: U, body })).body);
		}
		assert.deepEqual(results.map((r) => r.bonus_coins > 0), [true, true, true, false]);
		assert.equal(results.at(-1).reward_capped, true);
		assert.equal(results.at(-1).bonus_xp, 0);
		assert.equal(h.db.state.profiles[U].coins, 75 * PHOTO_VERIFY_DAILY_REWARDS);
	});
});
