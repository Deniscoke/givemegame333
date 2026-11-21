'use strict';

/**
 * Allowlist for POST /api/coins/log.
 *
 * The client-side coin wallet (public/js/coins.js + public/gIVEME/script.js)
 * mirrors its local balance changes to the server via this endpoint. Only the
 * actions those files actually send are accepted, each with a bounded amount.
 * test/coin-log-policy.test.js re-reads coins.js so this list fails loudly
 * when the frontend catalog changes.
 */

/** Positive awards: coins.js `rewards` (base amount). */
const REWARD_BASE = Object.freeze({
	timer: 500,
	robot_challenge: 250,
	mode_click: 1,
	tamagochi_coin: 1,
	phone_buzz: 5,
	narrator_fact: 50
});

/** Max multiplier applied client-side (shop item "double_coins", value 2). */
const MAX_REWARD_MULTIPLIER = 2;

/** gIVEME social iframe: earnCoin(action) → Coins.award('giveme_' + action), base 1. */
const GIVEME_ACTIONS = Object.freeze([
	'like', 'double-tap-like', 'send-coin', 'bookmark', 'view-comments',
	'comment', 'like-comment', 'share-open', 'share', 'copy-link',
	'view-story', 'story-reply', 'story-like', 'story-coin', 'story-share',
	'publish'
]);

/** Generation costs: coins.js `costs`. */
const SPEND_COST = Object.freeze({ generate: 50, surprise: 25, remix: 25 });

/** Shop catalog: coins.js SHOP_ITEMS id → cost. */
const SHOP_COST = Object.freeze({
	xp_boost_2x: 1500,
	free_gen_3: 500,
	timer_extend: 300,
	double_coins: 2000,
	reroll_free: 200,
	xp_potion_500: 5000
});

const MAX_METADATA_BYTES = 1024;

/** action → [minAmount, maxAmount] (inclusive). */
function buildAllowlist() {
	const rules = new Map();
	for (const [action, base] of Object.entries(REWARD_BASE)) {
		rules.set(action, [1, base * MAX_REWARD_MULTIPLIER]);
	}
	for (const a of GIVEME_ACTIONS) {
		rules.set(`giveme_${a}`, [1, MAX_REWARD_MULTIPLIER]);
	}
	for (const [action, cost] of Object.entries(SPEND_COST)) {
		rules.set(`spend_${action}`, [-cost, -cost]);
		rules.set(`spend_${action}_free`, [0, 0]);
	}
	for (const [id, cost] of Object.entries(SHOP_COST)) {
		rules.set(`shop_${id}`, [-cost, -cost]);
	}
	return rules;
}

const COIN_LOG_RULES = buildAllowlist();

/**
 * @param {{ amount: unknown, action: unknown, metadata?: unknown }} body
 * @returns {{ ok: true, action: string, amount: number, metadata: object|null } |
 *           { ok: false, error: string, code: string }}
 */
function validateCoinLog(body) {
	const { amount, action, metadata } = body || {};
	if (!Number.isInteger(amount) || typeof action !== 'string' || !action.trim()) {
		return { ok: false, code: 'INVALID_INPUT', error: 'amount (integer) a action (string) sú povinné' };
	}
	const actionTrim = action.trim();
	const rule = COIN_LOG_RULES.get(actionTrim);
	if (!rule) {
		return { ok: false, code: 'UNKNOWN_ACTION', error: 'Nepovolená akcia' };
	}
	const [min, max] = rule;
	if (amount < min || amount > max) {
		return { ok: false, code: 'AMOUNT_OUT_OF_RANGE', error: `amount mimo povoleného rozsahu (${min}..${max})` };
	}
	let meta = null;
	if (metadata !== undefined && metadata !== null) {
		if (typeof metadata !== 'object' || Array.isArray(metadata)) {
			return { ok: false, code: 'INVALID_METADATA', error: 'metadata musí byť objekt' };
		}
		if (Buffer.byteLength(JSON.stringify(metadata), 'utf8') > MAX_METADATA_BYTES) {
			return { ok: false, code: 'INVALID_METADATA', error: 'metadata je príliš veľké' };
		}
		meta = metadata;
	}
	return { ok: true, action: actionTrim, amount, metadata: meta };
}

module.exports = {
	REWARD_BASE,
	MAX_REWARD_MULTIPLIER,
	GIVEME_ACTIONS,
	SPEND_COST,
	SHOP_COST,
	COIN_LOG_RULES,
	validateCoinLog
};
