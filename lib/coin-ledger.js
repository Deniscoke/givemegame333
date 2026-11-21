'use strict';

/**
 * gIVEMEGAME.IO — server-side coin ledger (C2).
 *
 * The browser no longer writes profiles.coins. Wallet events reported through
 * POST /api/coins/log are applied here: rewards are credited up to a per-day
 * cap, spends are debited only when affordable, and every change is written
 * to coin_transactions. Runs inside a transaction the caller owns.
 */

const { rewardCapKey, computeRewardCredit, DAILY_REWARD_CAP } = require('./coin-log-policy');

/**
 * @param {import('pg').PoolClient} client
 * @param {{ userId: string, action: string, amount: number, metadata?: object|null }} entry
 *   — already validated by validateCoinLog()
 * @returns {Promise<
 *   { status: 'ok', credited: number, balance: number } |
 *   { status: 'capped', balance: number, cap: number } |
 *   { status: 'insufficient', balance: number, required: number } |
 *   { status: 'no_profile' }>}
 */
async function applyCoinLogEntry(client, { userId, action, amount, metadata = null }) {
	const { rows: prof } = await client.query(
		'SELECT COALESCE(coins, 0)::int AS coins FROM public.profiles WHERE id = $1 FOR UPDATE',
		[userId]
	);
	if (!prof.length) return { status: 'no_profile' };
	let balance = prof[0].coins;
	let applied = amount;

	if (amount > 0) {
		const key = rewardCapKey(action);
		const cap = key ? DAILY_REWARD_CAP[key] : 0;
		const { rows: usedRows } = await client.query(
			key === 'giveme'
				? `SELECT COALESCE(SUM(amount), 0)::int AS used FROM public.coin_transactions
				   WHERE user_id = $1 AND action LIKE 'giveme\\_%' AND amount > 0 AND created_at >= CURRENT_DATE`
				: `SELECT COALESCE(SUM(amount), 0)::int AS used FROM public.coin_transactions
				   WHERE user_id = $1 AND action = $2 AND amount > 0 AND created_at >= CURRENT_DATE`,
			key === 'giveme' ? [userId] : [userId, action]
		);
		applied = computeRewardCredit(amount, usedRows[0]?.used || 0, cap);
		if (applied <= 0) return { status: 'capped', balance, cap };
		const { rows } = await client.query(
			'UPDATE public.profiles SET coins = COALESCE(coins, 0) + $1 WHERE id = $2 RETURNING coins',
			[applied, userId]
		);
		balance = rows[0].coins;
	} else if (amount < 0) {
		const cost = -amount;
		const { rows } = await client.query(
			`UPDATE public.profiles SET coins = COALESCE(coins, 0) - $1
			  WHERE id = $2 AND COALESCE(coins, 0) >= $1
			  RETURNING coins`,
			[cost, userId]
		);
		if (!rows.length) return { status: 'insufficient', balance, required: cost };
		balance = rows[0].coins;
	}

	const meta = applied !== amount ? { ...(metadata || {}), requested: amount } : metadata;
	await client.query(
		'INSERT INTO public.coin_transactions (user_id, amount, action, metadata) VALUES ($1, $2, $3, $4)',
		[userId, applied, action, meta ? JSON.stringify(meta) : null]
	);
	return { status: 'ok', credited: applied, balance };
}

/**
 * One-time starter grant for a brand-new signed-in account: no ledger rows
 * yet and a zero balance. The guest practice wallet is never merged.
 *
 * @param {import('pg').PoolClient} client
 * @param {string} userId
 * @param {number} amount
 * @returns {Promise<{ granted: boolean, balance: number }>}
 */
async function grantStarterCoins(client, userId, amount) {
	await client.query(
		'INSERT INTO public.profiles (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
		[userId]
	);
	const { rows: prof } = await client.query(
		'SELECT COALESCE(coins, 0)::int AS coins FROM public.profiles WHERE id = $1 FOR UPDATE',
		[userId]
	);
	const balance = prof[0]?.coins || 0;
	if (balance !== 0) return { granted: false, balance };
	const { rows: any } = await client.query(
		'SELECT 1 FROM public.coin_transactions WHERE user_id = $1 LIMIT 1',
		[userId]
	);
	if (any.length) return { granted: false, balance };
	const { rows } = await client.query(
		'UPDATE public.profiles SET coins = COALESCE(coins, 0) + $1 WHERE id = $2 RETURNING coins',
		[amount, userId]
	);
	await client.query(
		'INSERT INTO public.coin_transactions (user_id, amount, action, metadata) VALUES ($1, $2, $3, $4)',
		[userId, amount, 'starter_grant', null]
	);
	return { granted: true, balance: rows[0].coins };
}

module.exports = { applyCoinLogEntry, grantStarterCoins };
