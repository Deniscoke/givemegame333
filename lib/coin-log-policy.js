'use strict';

/**
 * Allowlist for POST /api/coins/log.
 *
 * The client-side coin wallet (public/js/coins.js + public/gIVEME/script.js)
 * reports rewards and spends to this endpoint; the server applies them to
 * profiles.coins (rewards capped per day, spends only when affordable). Only
 * the actions those files actually send are accepted, each with a bounded amount.
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

/**
 * Actions with their own server-authoritative route; /api/coins/log refuses
 * them so the cap / ledger proof on that route cannot be bypassed:
 *   mode_click        → POST /api/coins/award-mode-click (daily cap, H9)
 *   shop_xp_boost_2x  → POST /api/shop/purchase (ledger proof for the XP boost, H3)
 *   shop_xp_potion_500 → POST /api/shop/purchase
 */
const SERVER_ROUTED_ACTIONS = Object.freeze(['mode_click', 'shop_xp_boost_2x', 'shop_xp_potion_500']);

/**
 * /api/coins/log credits rewards on the server (C2: the browser no longer
 * writes profiles.coins). Each reward source is capped per UTC day; all
 * gIVEME social actions share one cap.
 */
const DAILY_REWARD_CAP = Object.freeze({
	timer: 1000,
	robot_challenge: 500,
	narrator_fact: 250,
	tamagochi_coin: 50,
	phone_buzz: 25,
	giveme: 50
});

/** One-time server grant for a brand-new signed-in account (replaces the guest wallet, no merge). */
const STARTER_GRANT_COINS = 500;

/**
 * Rewards that carry more than coins (robot_challenge also awards XP per
 * completion) only accept the exact amounts coins.js sends: the base reward,
 * or base × the double_coins multiplier. A range would let a script post
 * amount=1 hundreds of times and collect the XP each time (M5).
 */
const EXACT_REWARD_AMOUNTS = Object.freeze({
	robot_challenge: Object.freeze([REWARD_BASE.robot_challenge, REWARD_BASE.robot_challenge * MAX_REWARD_MULTIPLIER])
});

/**
 * gIVEME coin donations (POST /api/giveme/donate). The donor is debited on
 * the server in the same transaction as the donation row. The per-donation
 * bound matches the giveme_coin_donations_sane constraint (033); the daily
 * cap limits funnelling coins from farm accounts into one account.
 */
const DONATION_MIN = 1;
const DONATION_MAX = 100;
const DONATION_DAILY_CAP = 200;

/**
 * @param {{ post_id: unknown, amount: unknown }} body
 * @returns {{ ok: true, postId: string, amount: number } | { ok: false, error: string, code: string }}
 */
function validateDonation(body) {
	const { post_id: postId, amount } = body || {};
	if (typeof postId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(postId)) {
		return { ok: false, code: 'INVALID_INPUT', error: 'post_id (uuid) je povinné' };
	}
	if (!Number.isInteger(amount) || amount < DONATION_MIN || amount > DONATION_MAX) {
		return { ok: false, code: 'AMOUNT_OUT_OF_RANGE', error: `amount musí byť celé číslo ${DONATION_MIN}..${DONATION_MAX}` };
	}
	return { ok: true, postId: postId.toLowerCase(), amount };
}

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
	for (const action of SERVER_ROUTED_ACTIONS) rules.delete(action);
	return rules;
}

/**
 * Daily cap bucket for a positive reward action.
 * @param {string} action
 * @returns {string|null} key into DAILY_REWARD_CAP, or null when uncapped (not a reward)
 */
function rewardCapKey(action) {
	if (typeof action !== 'string') return null;
	if (action.startsWith('giveme_')) return 'giveme';
	return Object.prototype.hasOwnProperty.call(DAILY_REWARD_CAP, action) ? action : null;
}

/**
 * How much of a requested reward may still be credited today.
 * @param {number} amount — requested (validated, positive)
 * @param {number} usedToday — already credited today in the same bucket
 * @param {number} cap — bucket cap
 * @returns {number} 0..amount
 */
function computeRewardCredit(amount, usedToday, cap) {
	const left = Math.max(0, (Number(cap) || 0) - Math.max(0, Number(usedToday) || 0));
	return Math.max(0, Math.min(amount, left));
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
	const exact = EXACT_REWARD_AMOUNTS[actionTrim];
	if (exact && !exact.includes(amount)) {
		return { ok: false, code: 'AMOUNT_OUT_OF_RANGE', error: `amount musí byť jedna z hodnôt ${exact.join(', ')}` };
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
	SERVER_ROUTED_ACTIONS,
	DAILY_REWARD_CAP,
	STARTER_GRANT_COINS,
	EXACT_REWARD_AMOUNTS,
	DONATION_MIN,
	DONATION_MAX,
	DONATION_DAILY_CAP,
	COIN_LOG_RULES,
	rewardCapKey,
	computeRewardCredit,
	validateCoinLog,
	validateDonation
};
