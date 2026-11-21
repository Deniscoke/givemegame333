'use strict';

/**
 * gIVEMEGAME.IO — server-side economy helpers for sessions, solo completion
 * and photo verification (Phase 0 hotfixes C1, H1, H3, H4, M1).
 *
 * The DB helpers take an open pg client inside a transaction the caller owns
 * (BEGIN / COMMIT / ROLLBACK stay in server.js); the rest are pure functions.
 */

/** XP boost sold in the shop: 2x XP for the next 3 solo completions. */
const XP_BOOST_ITEM_ID = 'xp_boost_2x';
const XP_BOOST_MULTIPLIER = 2;
const XP_BOOST_USES = 3;

/** Photo verification (gpt-4o vision): attempts and paid rewards per UTC day. */
const PHOTO_VERIFY_DAILY_ATTEMPTS = 10;
const PHOTO_VERIFY_DAILY_REWARDS = 3;

function round1(n) {
	return Math.round((Number(n) || 0) * 10) / 10;
}

/**
 * Audit object stored in sessions.reward_validation when /complete passes.
 * C1: the route used undeclared `requiredMin` / `requiredPlayers`; the
 * required values come from the gate results.
 *
 * @param {{ durationValidation: { duration_actual_min: number, duration_required_min: number },
 *           participantValidation: { participants_actual: number, participants_required: number },
 *           hostSessionsLastHour: number, competencies: string[], participantsRewarded: number,
 *           now?: Date }} input
 * @returns {object}
 */
function buildCompletionValidation({
	durationValidation,
	participantValidation,
	hostSessionsLastHour,
	competencies,
	participantsRewarded,
	now = new Date(),
}) {
	return {
		duration_actual_min: round1(durationValidation.duration_actual_min),
		duration_required_min: durationValidation.duration_required_min,
		participants_actual: participantValidation.participants_actual,
		participants_required: participantValidation.participants_required,
		host_sessions_last_hour: hostSessionsLastHour,
		competencies_awarded: competencies,
		participants_rewarded: participantsRewarded,
		passed: true,
		validated_at: now.toISOString(),
	};
}

/**
 * Atomically start a waiting session and charge every unpaid participant.
 * Runs inside the caller's transaction.
 *
 * M1: the status flip is a compare-and-swap (`WHERE status = 'waiting'`), so a
 * second /start finds no row and charges nobody.
 * H1: each charge is conditional (`coins >= cost`); a participant who cannot
 * pay is skipped and stays unpaid (coins_paid = 0), so the reward loop and the
 * participant gate ignore them.
 *
 * H6 (Phase 6): players who left before start (left_at) and players unseen
 * for `presenceStaleSec` are marked absent and not charged; guests never pay.
 *
 * @param {import('pg').PoolClient} client
 * @param {{ sessionId: string, hostId: string, code: string, cost: number, timerEndsAt: string,
 *           expiresAt?: string|null, presenceStaleSec?: number }} opts
 * @returns {Promise<{ started: boolean, charged: string[], unpaid: string[], absent: number }>}
 */
async function startSessionAndCharge(client, { sessionId, hostId, code, cost, timerEndsAt, expiresAt = null, presenceStaleSec = 300 }) {
	const { rows: locked } = await client.query(
		`UPDATE public.sessions
		    SET status = 'active', timer_ends_at = $1, started_at = NOW(), expires_at = $4
		  WHERE id = $2 AND host_id = $3 AND status = 'waiting'
		  RETURNING id`,
		[timerEndsAt, sessionId, hostId, expiresAt]
	);
	if (!locked.length) return { started: false, charged: [], unpaid: [], absent: 0 };

	const { rows: absentRows } = await client.query(
		`UPDATE public.session_participants
		    SET left_at = NOW()
		  WHERE session_id = $1 AND left_at IS NULL AND coins_paid = 0
		    AND last_seen_at < NOW() - make_interval(secs => $2)
		  RETURNING id`,
		[sessionId, presenceStaleSec]
	);

	const { rows: parts } = await client.query(
		`SELECT user_id FROM public.session_participants
		  WHERE session_id = $1 AND coins_paid = 0 AND left_at IS NULL AND is_guest = false
		  ORDER BY joined_at ASC
		  FOR UPDATE`,
		[sessionId]
	);

	const charged = [];
	const unpaid = [];
	for (const p of parts) {
		const { rows: debited } = await client.query(
			`UPDATE public.profiles
			    SET coins = COALESCE(coins, 0) - $1
			  WHERE id = $2 AND COALESCE(coins, 0) >= $1
			  RETURNING coins`,
			[cost, p.user_id]
		);
		if (!debited.length) {
			unpaid.push(p.user_id);
			continue;
		}
		await client.query(
			'UPDATE public.session_participants SET coins_paid = $1 WHERE session_id = $2 AND user_id = $3',
			[cost, sessionId, p.user_id]
		);
		await client.query(
			'INSERT INTO public.coin_transactions (user_id, amount, action, metadata) VALUES ($1, $2, $3, $4)',
			[p.user_id, -cost, 'session_join', JSON.stringify({ session_code: code })]
		);
		charged.push(p.user_id);
	}
	return { started: true, charged, unpaid, absent: absentRows.length };
}

/**
 * H3 (short term): the client asks for an XP multiplier, but it only applies
 * while the ledger shows unused, server-sold boost uses.
 *
 * @param {unknown} requested — client xp_multiplier
 * @param {number} remainingBoostUses — from countRemainingBoostUses()
 * @returns {number} 1 or XP_BOOST_MULTIPLIER
 */
function resolveSoloXpMultiplier(requested, remainingBoostUses) {
	const req = parseInt(requested, 10);
	if (!Number.isFinite(req) || req <= 1) return 1;
	if (!(Number(remainingBoostUses) > 0)) return 1;
	return Math.min(req, XP_BOOST_MULTIPLIER);
}

/**
 * Unused boost uses = uses granted by server-side xp_boost_2x purchases
 * (metadata.boost_uses, written only by /api/shop/purchase) minus solo
 * completions that applied a multiplier > 1.
 *
 * @param {import('pg').PoolClient} client
 * @param {string} userId
 * @returns {Promise<number>}
 */
async function countRemainingBoostUses(client, userId) {
	const { rows } = await client.query(
		`SELECT
		   COALESCE((SELECT SUM((metadata->>'boost_uses')::int)
		               FROM public.coin_transactions
		              WHERE user_id = $1 AND action = $2 AND metadata ? 'boost_uses'), 0)
		 - (SELECT COUNT(*)
		      FROM public.coin_transactions
		     WHERE user_id = $1 AND action = 'solo_complete'
		       AND COALESCE((metadata->>'xp_multiplier')::int, 1) > 1) AS remaining`,
		[userId, `shop_${XP_BOOST_ITEM_ID}`]
	);
	return Math.max(0, parseInt(rows[0]?.remaining, 10) || 0);
}

/**
 * H4: photo verification is allowed while today's attempts (including the one
 * being made) stay within the cap.
 * @param {number} attemptsTodayIncludingThis
 */
function photoVerifyAttemptAllowed(attemptsTodayIncludingThis) {
	return attemptsTodayIncludingThis <= PHOTO_VERIFY_DAILY_ATTEMPTS;
}

/**
 * H4: a verified photo earns XP and coins only for the first N rewards a day.
 * @param {number} rewardsToday — photo_verify_bonus rows today
 */
function photoVerifyRewardAllowed(rewardsToday) {
	return rewardsToday < PHOTO_VERIFY_DAILY_REWARDS;
}

module.exports = {
	XP_BOOST_ITEM_ID,
	XP_BOOST_MULTIPLIER,
	XP_BOOST_USES,
	PHOTO_VERIFY_DAILY_ATTEMPTS,
	PHOTO_VERIFY_DAILY_REWARDS,
	buildCompletionValidation,
	startSessionAndCharge,
	resolveSoloXpMultiplier,
	countRemainingBoostUses,
	photoVerifyAttemptAllowed,
	photoVerifyRewardAllowed,
};
