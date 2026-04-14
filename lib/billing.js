/**
 * gIVEMEGAME.IO — Billing helpers (Payment Link MVP, manual provisioning)
 * Source of truth: user_billing table. paid_access_enabled is set manually by admin.
 * Future: webhooks will update plan_code/subscription_status; paid_access_enabled can be driven by those.
 */

const PLAN_FREE = 'free';
const PLAN_PRO = 'pro_teacher_monthly';

/**
 * @param {object} row - user_billing row (or null)
 * @returns {boolean}
 */
function hasPaidAccess(row) {
	if (!row) return false;
	if (row.paid_access_enabled === true) return true;
	if (row.plan_code === PLAN_PRO) return true;
	return false;
}

/**
 * @param {object} row - user_billing row (or null)
 * @returns {string} 'free' | 'pro_teacher_monthly'
 */
function getUserPlan(row) {
	if (!row) return PLAN_FREE;
	return row.plan_code === PLAN_PRO ? PLAN_PRO : PLAN_FREE;
}

/**
 * @param {import('pg').Pool} pool
 * @param {string} userId
 * @returns {Promise<object|null>}
 */
async function getUserBillingState(pool, userId) {
	if (!pool || !userId) return null;
	try {
		const { rows } = await pool.query(
			`SELECT user_id, plan_code, paid_access_enabled, billing_note, billing_state_updated_at
			 FROM public.user_billing WHERE user_id = $1 LIMIT 1`,
			[userId]
		);
		return rows[0] || null;
	} catch (e) {
		// Fallback ak migrácia 017 ešte nebežala (chýbajú stĺpce)
		const missingCol = e.code === '42703' || /paid_access_enabled|billing_note/.test(String(e.message || ''));
		if (missingCol) {
			try {
				const { rows } = await pool.query(
					`SELECT user_id, plan_code, billing_state_updated_at
					 FROM public.user_billing WHERE user_id = $1 LIMIT 1`,
					[userId]
				);
				const r = rows[0];
				if (!r) return null;
				return { ...r, paid_access_enabled: false, billing_note: null };
			} catch (e2) {
				console.error('[Billing] getUserBillingState fallback error:', e2.message);
				return null;
			}
		}
		console.error('[Billing] getUserBillingState error:', e.message);
		return null;
	}
}

module.exports = {
	hasPaidAccess,
	getUserPlan,
	getUserBillingState,
	PLAN_FREE,
	PLAN_PRO,
};
