/**
 * gIVEMEGAME.IO — Plan entitlements (Free vs Pro Teacher Monthly)
 *
 * Single source of numbers for server + JSON exposed to the client.
 * Extend `entitlementsForPlan()` when adding new premium perks.
 */

'use strict';

const PLAN_FREE = 'free';
const PLAN_PRO = 'pro_teacher_monthly';

/** @param {boolean} hasPaidAccess */
function entitlementsForPlan(hasPaidAccess) {
	if (hasPaidAccess) {
		return {
			planKey: 'pro',
			givemeSocial: true,
			smartaOpenAiAndTts: true,
			/** null = no daily cap (only per-minute rate limit) */
			aiGamesPerUtcDay: null,
			/** null = no weekly cap on session generations */
			sessionsPerWeek: null,
			/** null = unlimited robot completions */
			robotCompletionsPer24h: null,
			soloCompletionsPer24h: 25,
			generatePerMinute: 30,
		};
	}
	return {
		planKey: 'free',
		givemeSocial: false,
		smartaOpenAiAndTts: false,
		aiGamesPerUtcDay: null,
		sessionsPerWeek: 3,
		robotCompletionsPer24h: 1,
		soloCompletionsPer24h: 5,
		generatePerMinute: 8,
	};
}

/** ISO timestamp of next UTC midnight (for UI “resets at …”). */
function nextUtcMidnightIso() {
	const now = new Date();
	const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));
	return next.toISOString();
}

module.exports = {
	entitlementsForPlan,
	nextUtcMidnightIso,
	PLAN_FREE,
	PLAN_PRO,
};
