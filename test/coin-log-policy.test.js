'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
	REWARD_BASE,
	GIVEME_ACTIONS,
	SPEND_COST,
	SHOP_COST,
	SERVER_ROUTED_ACTIONS,
	DAILY_REWARD_CAP,
	STARTER_GRANT_COINS,
	COIN_LOG_RULES,
	rewardCapKey,
	computeRewardCredit,
	validateCoinLog,
} = require('../lib/coin-log-policy');

const ROOT = path.join(__dirname, '..');
const coinsJs = fs.readFileSync(path.join(ROOT, 'public', 'js', 'coins.js'), 'utf8');
const givemeJs = fs.readFileSync(path.join(ROOT, 'public', 'gIVEME', 'script.js'), 'utf8');

function parseObjectLiteral(src, name) {
	const m = new RegExp(`const ${name} = \\{([\\s\\S]*?)\\};`).exec(src);
	assert.ok(m, `${name} not found in coins.js`);
	const out = {};
	for (const [, k, v] of m[1].matchAll(/(\w+)\s*:\s*(\d+)/g)) out[k] = Number(v);
	return out;
}

describe('coin-log policy stays in sync with the frontend', () => {
	it('rewards match coins.js', () => {
		assert.deepEqual({ ...REWARD_BASE }, parseObjectLiteral(coinsJs, 'rewards'));
	});

	it('costs match coins.js', () => {
		assert.deepEqual({ ...SPEND_COST }, parseObjectLiteral(coinsJs, 'costs'));
	});

	it('shop items match coins.js SHOP_ITEMS', () => {
		const shop = {};
		for (const [, id, cost] of coinsJs.matchAll(/\{\s*id:\s*'([\w-]+)'[^}]*?cost:\s*(\d+)/g)) shop[id] = Number(cost);
		assert.deepEqual({ ...SHOP_COST }, shop);
	});

	it('gIVEME earnCoin actions are all allowed', () => {
		const actions = new Set([...givemeJs.matchAll(/earnCoin\('([\w-]+)'\)/g)].map(m => m[1]));
		assert.ok(actions.size > 0);
		assert.deepEqual([...actions].sort(), [...GIVEME_ACTIONS].sort());
	});
});

describe('validateCoinLog', () => {
	it('accepts every frontend action at its nominal amount', () => {
		for (const [a, base] of Object.entries(REWARD_BASE)) {
			if (SERVER_ROUTED_ACTIONS.includes(a)) continue;
			assert.equal(validateCoinLog({ action: a, amount: base }).ok, true, a);
			assert.equal(validateCoinLog({ action: a, amount: base * 2 }).ok, true, `${a} x2`);
		}
		assert.equal(validateCoinLog({ action: 'giveme_like', amount: 1 }).ok, true);
		assert.equal(validateCoinLog({ action: 'spend_generate', amount: -50 }).ok, true);
		assert.equal(validateCoinLog({ action: 'spend_remix_free', amount: 0 }).ok, true);
		assert.equal(validateCoinLog({ action: 'shop_timer_extend', amount: -300 }).ok, true);
	});

	it('refuses actions that have their own server route (mode_click, server-sold shop items)', () => {
		for (const action of SERVER_ROUTED_ACTIONS) {
			assert.equal(COIN_LOG_RULES.has(action), false, action);
		}
		assert.equal(validateCoinLog({ action: 'mode_click', amount: 1 }).code, 'UNKNOWN_ACTION');
		assert.equal(validateCoinLog({ action: 'shop_xp_boost_2x', amount: -1500 }).code, 'UNKNOWN_ACTION');
		assert.equal(validateCoinLog({ action: 'shop_xp_potion_500', amount: -5000 }).code, 'UNKNOWN_ACTION');
	});

	it('rejects unknown actions', () => {
		const r = validateCoinLog({ action: 'admin_grant', amount: 1 });
		assert.equal(r.ok, false);
		assert.equal(r.code, 'UNKNOWN_ACTION');
		assert.equal(validateCoinLog({ action: 'solo_complete_boosted', amount: 1 }).ok, false);
	});

	it('rejects out-of-range amounts', () => {
		assert.equal(validateCoinLog({ action: 'timer', amount: 1001 }).code, 'AMOUNT_OUT_OF_RANGE');
		assert.equal(validateCoinLog({ action: 'timer', amount: -5 }).code, 'AMOUNT_OUT_OF_RANGE');
		assert.equal(validateCoinLog({ action: 'robot_challenge', amount: 0 }).code, 'AMOUNT_OUT_OF_RANGE');
		assert.equal(validateCoinLog({ action: 'spend_generate', amount: 50 }).code, 'AMOUNT_OUT_OF_RANGE');
		assert.equal(validateCoinLog({ action: 'giveme_like', amount: 1000000 }).code, 'AMOUNT_OUT_OF_RANGE');
	});

	it('rejects bad types', () => {
		assert.equal(validateCoinLog({ action: 'timer', amount: '500' }).code, 'INVALID_INPUT');
		assert.equal(validateCoinLog({ action: 'timer', amount: 1.5 }).code, 'INVALID_INPUT');
		assert.equal(validateCoinLog({ action: 5, amount: 1 }).code, 'INVALID_INPUT');
		assert.equal(validateCoinLog(null).code, 'INVALID_INPUT');
	});

	it('trims action and bounds metadata', () => {
		const r = validateCoinLog({ action: ' robot_challenge ', amount: 250 });
		assert.equal(r.ok, true);
		assert.equal(r.action, 'robot_challenge');
		assert.equal(r.metadata, null);
		assert.equal(validateCoinLog({ action: 'timer', amount: 1, metadata: { a: 'x'.repeat(2000) } }).code, 'INVALID_METADATA');
		assert.equal(validateCoinLog({ action: 'timer', amount: 1, metadata: 'str' }).code, 'INVALID_METADATA');
		assert.deepEqual(validateCoinLog({ action: 'timer', amount: 1, metadata: { k: 1 } }).metadata, { k: 1 });
	});

	it('allowlist is finite and explicit', () => {
		assert.ok(COIN_LOG_RULES.size < 100);
	});
});

describe('server-side reward caps (C2)', () => {
	it('every positive reward source has a daily cap bucket', () => {
		for (const action of Object.keys(REWARD_BASE)) {
			if (SERVER_ROUTED_ACTIONS.includes(action)) continue;
			const key = rewardCapKey(action);
			assert.ok(key && DAILY_REWARD_CAP[key] > 0, action);
		}
		for (const a of GIVEME_ACTIONS) assert.equal(rewardCapKey(`giveme_${a}`), 'giveme');
		assert.equal(rewardCapKey('spend_generate'), null);
		assert.equal(rewardCapKey('toString'), null);
	});

	it('computeRewardCredit clamps to what is left of the cap', () => {
		assert.equal(computeRewardCredit(500, 0, 1000), 500);
		assert.equal(computeRewardCredit(500, 800, 1000), 200);
		assert.equal(computeRewardCredit(500, 1000, 1000), 0);
		assert.equal(computeRewardCredit(500, 5000, 1000), 0);
		assert.equal(computeRewardCredit(5, -10, 3), 3);
	});

	it('the server starter grant matches the guest starter wallet in coins.js', () => {
		const m = /const STARTER_COINS = (\d+);/.exec(coinsJs);
		assert.ok(m, 'STARTER_COINS not found in coins.js');
		assert.equal(Number(m[1]), STARTER_GRANT_COINS);
	});
});
