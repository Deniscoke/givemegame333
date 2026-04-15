/**
 * gIVEMEGAME.IO — UTC daily AI generation counter (plan_usage_daily)
 * Robot completions use coin_transactions (24h rolling window).
 */

'use strict';

const UTC_DATE_SQL = `(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date`;

/**
 * @param {import('pg').Pool} pool
 * @param {string} userId
 * @returns {Promise<number>}
 */
async function getAiGenerationsTodayUtc(pool, userId) {
	if (!pool || !userId) return 0;
	const { rows } = await pool.query(
		`SELECT COALESCE(ai_generations, 0)::int AS n
		 FROM public.plan_usage_daily
		 WHERE user_id = $1::uuid AND usage_date = ${UTC_DATE_SQL}
		 LIMIT 1`,
		[userId]
	);
	return rows[0]?.n ?? 0;
}

/**
 * Increment after a successful /api/generate-game response (logged-in users only).
 * @param {import('pg').Pool} pool
 * @param {string} userId
 */
async function incrementAiGenerationsSuccess(pool, userId) {
	if (!pool || !userId) return;
	await pool.query(
		`INSERT INTO public.plan_usage_daily (user_id, usage_date, ai_generations)
		 VALUES ($1::uuid, ${UTC_DATE_SQL}, 1)
		 ON CONFLICT (user_id, usage_date)
		 DO UPDATE SET ai_generations = public.plan_usage_daily.ai_generations + 1`,
		[userId]
	);
}

/**
 * @param {import('pg').Pool} pool
 * @param {string} userId
 * @returns {Promise<number>}
 */
async function countRobotChallengesLast24h(pool, userId) {
	if (!pool || !userId) return 0;
	const { rows } = await pool.query(
		`SELECT COUNT(*)::int AS c FROM public.coin_transactions
		 WHERE user_id = $1::uuid AND action = 'robot_challenge'
		   AND created_at > NOW() - INTERVAL '24 hours'`,
		[userId]
	);
	return rows[0]?.c ?? 0;
}

/**
 * @param {import('pg').Pool} pool
 * @param {string} userId
 * @returns {Promise<number>}
 */
async function countSoloCompletionsLast24h(pool, userId) {
	if (!pool || !userId) return 0;
	const { rows } = await pool.query(
		`SELECT COUNT(*)::int AS c FROM public.coin_transactions
		 WHERE user_id = $1::uuid AND action = 'solo_complete'
		   AND created_at > NOW() - INTERVAL '24 hours'`,
		[userId]
	);
	return rows[0]?.c ?? 0;
}

module.exports = {
	getAiGenerationsTodayUtc,
	incrementAiGenerationsSuccess,
	countRobotChallengesLast24h,
	countSoloCompletionsLast24h,
};
