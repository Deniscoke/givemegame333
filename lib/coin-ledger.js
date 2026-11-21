'use strict';

/**
 * gIVEMEGAME.IO — server-side coin ledger (C2).
 *
 * The browser no longer writes profiles.coins. Wallet events reported through
 * POST /api/coins/log are applied here: rewards are credited up to a per-day
 * cap, spends are debited only when affordable, and every change is written
 * to coin_transactions. Runs inside a transaction the caller owns.
 */

const { rewardCapKey, computeRewardCredit, DAILY_REWARD_CAP, DONATION_DAILY_CAP } = require('./coin-log-policy');

/**
 * Coins of `action` already credited today (UTC day of the DB clock).
 * @param {import('pg').PoolClient} client
 * @param {string} userId
 * @param {string} action
 * @returns {Promise<number>}
 */
async function creditedToday(client, userId, action) {
	const { rows } = await client.query(
		`SELECT COALESCE(SUM(amount), 0)::int AS used FROM public.coin_transactions
		   WHERE user_id = $1 AND action = $2 AND amount > 0 AND created_at >= CURRENT_DATE`,
		[userId, action]
	);
	return rows[0]?.used || 0;
}

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

/**
 * Robot challenge completion (M5). Counts completions (rows), not coins: the
 * completion limit applies to every plan and is checked under the profile
 * row lock, so parallel requests cannot both pass it. Coins are still capped
 * per day; a completion past the coin cap is recorded with amount 0, so it
 * counts toward the limit and the caller can award the completion XP.
 *
 * @param {import('pg').PoolClient} client
 * @param {{ userId: string, amount: number, metadata?: object|null, completionLimit: number }} entry
 *   — amount already validated (exact robot_challenge amount)
 * @returns {Promise<
 *   { status: 'ok', credited: number, balance: number, capped: boolean, completions: number } |
 *   { status: 'limit', balance: number, used: number, limit: number } |
 *   { status: 'no_profile' }>}
 */
async function applyRobotChallenge(client, { userId, amount, metadata = null, completionLimit }) {
	const { rows: prof } = await client.query(
		'SELECT COALESCE(coins, 0)::int AS coins FROM public.profiles WHERE id = $1 FOR UPDATE',
		[userId]
	);
	if (!prof.length) return { status: 'no_profile' };
	let balance = prof[0].coins;

	const { rows: cnt } = await client.query(
		`SELECT COUNT(*)::int AS c FROM public.coin_transactions
		 WHERE user_id = $1::uuid AND action = 'robot_challenge'
		   AND created_at > NOW() - INTERVAL '24 hours'`,
		[userId]
	);
	const used = cnt[0]?.c || 0;
	if (used >= completionLimit) return { status: 'limit', balance, used, limit: completionLimit };

	const applied = computeRewardCredit(amount, await creditedToday(client, userId, 'robot_challenge'),
		DAILY_REWARD_CAP.robot_challenge);
	if (applied > 0) {
		const { rows } = await client.query(
			'UPDATE public.profiles SET coins = COALESCE(coins, 0) + $1 WHERE id = $2 RETURNING coins',
			[applied, userId]
		);
		balance = rows[0].coins;
	}
	const meta = applied !== amount ? { ...(metadata || {}), requested: amount } : metadata;
	await client.query(
		'INSERT INTO public.coin_transactions (user_id, amount, action, metadata) VALUES ($1, $2, $3, $4)',
		[userId, applied, 'robot_challenge', meta ? JSON.stringify(meta) : null]
	);
	return { status: 'ok', credited: applied, balance, capped: applied < amount, completions: used + 1 };
}

/**
 * gIVEME coin donation: debit the donor, insert the donation row (its 003
 * trigger credits the recipient's profiles.coins) and record both sides in
 * coin_transactions, all in the caller's transaction. Before this, the
 * browser inserted the donation and only lowered its own displayed balance.
 *
 * @param {import('pg').PoolClient} client
 * @param {{ donorId: string, postId: string, amount: number }} entry — validated by validateDonation()
 * @returns {Promise<
 *   { status: 'ok', balance: number, recipientId: string } |
 *   { status: 'no_profile' } | { status: 'no_post' } | { status: 'self' } |
 *   { status: 'capped', balance: number, cap: number, sentToday: number } |
 *   { status: 'insufficient', balance: number, required: number }>}
 */
async function applyDonation(client, { donorId, postId, amount }) {
	const { rows: post } = await client.query(
		'SELECT author_id FROM public.giveme_posts WHERE id = $1',
		[postId]
	);
	if (!post.length) return { status: 'no_post' };
	const recipientId = post[0].author_id;
	if (recipientId === donorId) return { status: 'self' };

	// Lock both profiles in id order: the trigger updates the recipient, so
	// two users donating to each other at once would otherwise deadlock.
	let balance = null;
	for (const id of [donorId, recipientId].sort()) {
		const { rows } = await client.query(
			'SELECT COALESCE(coins, 0)::int AS coins FROM public.profiles WHERE id = $1 FOR UPDATE',
			[id]
		);
		if (id === donorId) balance = rows.length ? rows[0].coins : null;
	}
	if (balance === null) return { status: 'no_profile' };

	const { rows: sent } = await client.query(
		`SELECT COALESCE(SUM(-amount), 0)::int AS sent FROM public.coin_transactions
		   WHERE user_id = $1 AND action = 'giveme_donation_sent' AND created_at >= CURRENT_DATE`,
		[donorId]
	);
	const sentToday = sent[0]?.sent || 0;
	if (sentToday + amount > DONATION_DAILY_CAP) {
		return { status: 'capped', balance, cap: DONATION_DAILY_CAP, sentToday };
	}

	const { rows: debit } = await client.query(
		`UPDATE public.profiles SET coins = COALESCE(coins, 0) - $1
		  WHERE id = $2 AND COALESCE(coins, 0) >= $1
		  RETURNING coins`,
		[amount, donorId]
	);
	if (!debit.length) return { status: 'insufficient', balance, required: amount };

	await client.query(
		'INSERT INTO public.giveme_coin_donations (post_id, donor_id, recipient_id, amount) VALUES ($1, $2, $3, $4)',
		[postId, donorId, recipientId, amount]
	);
	// The on_giveme_donation trigger (003) credits the recipient; both ledger
	// rows keep the transfer auditable. The recipient row must not start with
	// 'giveme_': the gIVEME reward cap sums positive 'giveme\_%' rows.
	await client.query(
		'INSERT INTO public.coin_transactions (user_id, amount, action, metadata) VALUES ($1, $2, $3, $4)',
		[donorId, -amount, 'giveme_donation_sent', JSON.stringify({ post_id: postId, recipient_id: recipientId })]
	);
	await client.query(
		'INSERT INTO public.coin_transactions (user_id, amount, action, metadata) VALUES ($1, $2, $3, $4)',
		[recipientId, amount, 'donation_received', JSON.stringify({ post_id: postId, donor_id: donorId })]
	);
	return { status: 'ok', balance: debit[0].coins, recipientId };
}

module.exports = { applyCoinLogEntry, grantStarterCoins, applyRobotChallenge, applyDonation };
