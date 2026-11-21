'use strict';

/**
 * Route-level tests for the P0 review fixes:
 *   - M5: robot_challenge counts completions (rows) for every plan, accepts
 *     only the exact reward amounts, and awards XP once per completion in the
 *     same transaction (also past the daily coin cap)
 *   - gIVEME donations: POST /api/giveme/donate debits the donor, credits the
 *     author and writes both ledger rows in one transaction
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startEconomyServer } = require('./helpers/economy-harness');
const { DAILY_REWARD_CAP, DONATION_DAILY_CAP } = require('../lib/coin-log-policy');
const { entitlementsForPlan } = require('../lib/plan-entitlements');

const U = 'user-robot';
const DONOR = 'user-donor';
const AUTHOR = 'user-author';
const POST = '11111111-2222-4333-8444-555555555555';
let h;

function profile(id, coins, extra = {}) {
	h.db.state.profiles[id] = { coins, rpg_xp: 0, rpg_avatar_id: null, ...extra };
}

before(async () => { h = await startEconomyServer(); });
after(async () => { await h.stop(); });
beforeEach(() => {
	h.db.state = { profiles: {}, sessions: {}, participants: [], tx: [], talents: [], posts: {}, donations: [], billing: {} };
});

const robot = (amount = 250, user = U) => h.call('POST', '/api/coins/log', { user, body: { action: 'robot_challenge', amount } });

describe('robot_challenge completions (M5)', () => {
	it('refuses amounts other than the base reward or its double', async () => {
		profile(U, 0);
		for (const amount of [1, 100, 251, 499]) {
			const r = await robot(amount);
			assert.equal(r.status, 400, `amount ${amount}`);
			assert.equal(r.body.code, 'AMOUNT_OUT_OF_RANGE');
		}
		assert.equal(h.db.state.profiles[U].rpg_xp, 0);
		assert.equal(h.db.state.tx.length, 0);
	});

	it('free plan: one completion per 24 h, 30 XP with it, nothing after', async () => {
		profile(U, 0);
		const ok = await robot(250);
		assert.equal(ok.status, 200, JSON.stringify(ok.body));
		assert.equal(ok.body.credited, 250);
		assert.equal(ok.body.xp_awarded, 30);
		const again = await robot(250);
		assert.equal(again.status, 429);
		assert.equal(again.body.code, 'ROBOT_DAILY_LIMIT');
		assert.equal(h.db.state.profiles[U].coins, 250);
		assert.equal(h.db.state.profiles[U].rpg_xp, 30);
	});

	it('Pro plan is capped by completions, and XP no longer scales with request count', async () => {
		profile(U, 0);
		h.db.state.billing[U] = { plan_code: 'pro_teacher_monthly', paid_access_enabled: true };
		const limit = entitlementsForPlan(true).robotCompletionsPer24h;
		assert.ok(Number.isInteger(limit) && limit > 0, 'Pro must have a robot completion cap');

		const results = [];
		for (let i = 0; i < limit + 3; i++) results.push(await robot(250));
		const accepted = results.filter((r) => r.status === 200);
		assert.equal(accepted.length, limit);
		assert.ok(results.slice(limit).every((r) => r.status === 429 && r.body.code === 'ROBOT_DAILY_LIMIT'));

		// Coins stop at the daily coin cap; later completions still count and still give XP.
		assert.equal(h.db.state.profiles[U].coins, DAILY_REWARD_CAP.robot_challenge);
		assert.equal(accepted.at(-1).body.credited, 0);
		assert.equal(accepted.at(-1).body.capped, true);
		assert.equal(h.db.state.profiles[U].rpg_xp, 30 * limit);
	});

	it('parallel requests cannot pass the completion limit together', async () => {
		profile(U, 0);
		const results = await Promise.all([robot(250), robot(250), robot(250), robot(500)]);
		assert.equal(results.filter((r) => r.status === 200).length, 1);
		assert.equal(h.db.state.profiles[U].rpg_xp, 30);
		assert.equal(h.db.state.tx.filter((t) => t.action === 'robot_challenge').length, 1);
	});
});

describe('POST /api/giveme/donate', () => {
	beforeEach(() => {
		profile(DONOR, 100);
		profile(AUTHOR, 7);
		h.db.state.posts[POST] = { author_id: AUTHOR };
	});

	const donate = (amount, user = DONOR, postId = POST) => h.call('POST', '/api/giveme/donate', { user, body: { post_id: postId, amount } });

	it('debits the donor, credits the author and records both sides', async () => {
		const r = await donate(50);
		assert.equal(r.status, 200, JSON.stringify(r.body));
		assert.equal(r.body.balance, 50);
		assert.equal(h.db.state.profiles[DONOR].coins, 50);
		assert.equal(h.db.state.profiles[AUTHOR].coins, 57);
		assert.equal(h.db.state.donations.length, 1);
		const sent = h.db.state.tx.find((t) => t.action === 'giveme_donation_sent');
		const got = h.db.state.tx.find((t) => t.action === 'donation_received');
		assert.deepEqual([sent.user_id, sent.amount], [DONOR, -50]);
		assert.deepEqual([got.user_id, got.amount], [AUTHOR, 50]);

		// A reload reads the debited balance from the server.
		const bal = await h.call('GET', '/api/coins/balance', { user: DONOR });
		assert.equal(bal.body.balance, 50);
	});

	it('refuses a donation the donor cannot afford and records nothing', async () => {
		const r = await donate(100);
		assert.equal(r.status, 200);
		const no = await donate(1);
		assert.equal(no.status, 402);
		assert.equal(no.body.code, 'INSUFFICIENT_COINS');
		assert.equal(h.db.state.donations.length, 1);
		assert.equal(h.db.state.profiles[AUTHOR].coins, 107);
	});

	it('refuses self-donations, unknown posts and out-of-range amounts', async () => {
		h.db.state.posts[POST] = { author_id: DONOR };
		assert.equal((await donate(5)).body.code, 'SELF_DONATION');
		assert.equal((await donate(5, DONOR, '99999999-2222-4333-8444-555555555555')).status, 404);
		assert.equal((await donate(0)).status, 400);
		assert.equal((await donate(101)).status, 400);
		assert.equal((await donate(5, DONOR, 'not-a-uuid')).status, 400);
		assert.equal(h.db.state.profiles[DONOR].coins, 100);
		assert.equal(h.db.state.donations.length, 0);
	});

	it('caps what one donor can send per day', async () => {
		profile(DONOR, 10000);
		let sent = 0;
		while (sent + 100 <= DONATION_DAILY_CAP) {
			assert.equal((await donate(100)).status, 200);
			sent += 100;
		}
		const over = await donate(1);
		assert.equal(over.status, 429);
		assert.equal(over.body.code, 'DONATION_DAILY_CAP');
		assert.equal(h.db.state.profiles[DONOR].coins, 10000 - DONATION_DAILY_CAP);
	});

	it('requires a signed-in user', async () => {
		const r = await h.call('POST', '/api/giveme/donate', { body: { post_id: POST, amount: 5 } });
		assert.equal(r.status, 401);
	});
});
