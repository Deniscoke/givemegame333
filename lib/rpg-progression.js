/**
 * lib/rpg-progression.js — RPG Progression Foundation
 *
 * Single source of truth for:
 *  - XP threshold table (level 1–10)
 *  - Base RPG stats per avatar class
 *  - Competency → stat mapping (RVP-aligned)
 *  - Effective stat computation (base + talent bonuses)
 *  - Safe transactional XP award helper
 *
 * Design notes:
 *  - Level is always COMPUTED from XP — never stored separately
 *  - Stat bonuses are DETERMINISTIC from unlocked talent competencies
 *  - awardXpInTransaction requires an in-progress pg client (caller owns BEGIN/COMMIT)
 *  - No public HTTP endpoint — award is internal only (anti-spam)
 */

'use strict';

// ─── XP Thresholds ───────────────────────────────────────────────────────────
// XP_THRESHOLDS[i] = total XP required to reach level (i + 1).
// Level 1 = 0 XP, Level 2 = 500 XP, ..., Level 10 = 55 000 XP.
const XP_THRESHOLDS = [0, 500, 1200, 2500, 5000, 9000, 15000, 24000, 37000, 55000];
const MAX_LEVEL = XP_THRESHOLDS.length; // 10

// ─── Base Stats per Avatar Class ─────────────────────────────────────────────
// Six RPG stats, each on a 1–20 scale, total = 40 per class.
// Tuned to reflect each archetype's RVP competency strengths.
//
//   insight       — analytical perception, pattern recognition (← digitalna, problemy)
//   focus         — sustained concentration, learning drive    (← ucenie)
//   creativity    — novel approaches, expression               (← kulturna)
//   resilience    — perseverance, civic backbone               (← obcianska)
//   communication — verbal and interpersonal skill             (← komunikacia, socialna)
//   strategy      — planning, mathematical reasoning           (← matematika, pracovna)
//
const BASE_STATS_BY_CLASS = {
  2: { insight: 8, focus: 10, creativity: 5, resilience: 4, communication: 4, strategy: 9 }, // Scholar
  3: { insight: 6, focus: 5,  creativity: 10, resilience: 8, communication: 4, strategy: 7 }, // Builder
  4: { insight: 5, focus: 5,  creativity: 7,  resilience: 8, communication: 10, strategy: 5 }, // Healer
  5: { insight: 10, focus: 7, creativity: 6,  resilience: 6, communication: 3,  strategy: 8 }, // Shadow
  6: { insight: 9,  focus: 6, creativity: 8,  resilience: 4, communication: 4,  strategy: 9 }, // Alchemist
  7: { insight: 7,  focus: 8, creativity: 8,  resilience: 5, communication: 9,  strategy: 3 }, // Sage
  8: { insight: 4,  focus: 6, creativity: 4,  resilience: 10, communication: 7, strategy: 9 }, // Knight
};

// Null-class fallback — all zeros
const NULL_STATS = { insight: 0, focus: 0, creativity: 0, resilience: 0, communication: 0, strategy: 0 };

// ─── Competency → Stat Mapping ───────────────────────────────────────────────
// Each RVP competency tag (from lib/rpg-talents.js) maps to one primary RPG stat.
const COMPETENCY_TO_STAT = {
  ucenie:      'focus',
  matematika:  'strategy',
  komunikacia: 'communication',
  socialna:    'communication',
  obcianska:   'resilience',
  pracovna:    'strategy',
  digitalna:   'insight',
  kulturna:    'creativity',
  problemy:    'insight',
};

// ─── Talent Tier → Stat Bonus ────────────────────────────────────────────────
// Bonus added to the mapped stat for each unlocked talent by tier.
const TIER_BONUS = { 1: 3, 2: 5, 3: 10 };

// ─── Exported stat key list (stable ordering) ────────────────────────────────
const STAT_KEYS = ['insight', 'focus', 'creativity', 'resilience', 'communication', 'strategy'];

// ─── Core Functions ──────────────────────────────────────────────────────────

/**
 * Compute RPG level and progress bar data from raw XP.
 * Pure function — no DB calls.
 *
 * @param {number} xp — total accumulated XP (int >= 0)
 * @returns {{
 *   level: number,        // 1–10
 *   xp: number,           // normalized total XP
 *   xpForLevel: number,   // XP at which current level was reached
 *   xpToNext: number|null,// XP threshold for next level (null at max)
 *   progressPct: number   // 0–100, progress within current level
 * }}
 */
function computeRpgLevel(xp) {
  const totalXp = Math.max(0, parseInt(xp, 10) || 0);
  let level = 1;
  for (let i = 1; i < XP_THRESHOLDS.length; i++) {
    if (totalXp >= XP_THRESHOLDS[i]) level = i + 1;
    else break;
  }
  level = Math.min(level, MAX_LEVEL);

  const xpForLevel = XP_THRESHOLDS[level - 1];
  const xpToNext   = level < MAX_LEVEL ? XP_THRESHOLDS[level] : null;
  const progressPct = xpToNext
    ? Math.min(100, Math.round((totalXp - xpForLevel) / (xpToNext - xpForLevel) * 100))
    : 100;

  return { level, xp: totalXp, xpForLevel, xpToNext, progressPct };
}

/**
 * Get base RPG stats for an avatar class.
 *
 * @param {number|null} classId — profiles.rpg_avatar_id (2–8) or null
 * @returns {{ insight, focus, creativity, resilience, communication, strategy }}
 */
function getBaseStats(classId) {
  return BASE_STATS_BY_CLASS[classId] || { ...NULL_STATS };
}

/**
 * Compute additive stat bonuses from a list of unlocked talent objects.
 * Each talent's competency maps to one stat; tier determines bonus magnitude.
 *
 * @param {Array<{ competency: string, tier: number }>} unlockedTalents
 * @returns {{ insight, focus, creativity, resilience, communication, strategy }}
 */
function getTalentBonuses(unlockedTalents) {
  const bonuses = { ...NULL_STATS };
  for (const t of unlockedTalents) {
    const stat = COMPETENCY_TO_STAT[t.competency];
    if (stat && TIER_BONUS[t.tier] !== undefined) {
      bonuses[stat] += TIER_BONUS[t.tier];
    }
  }
  return bonuses;
}

/**
 * Compute effective stats = base stats + talent bonuses.
 *
 * @param {number|null} classId
 * @param {Array<{ competency: string, tier: number }>} unlockedTalents
 * @returns {{ base: object, bonuses: object, effective: object }}
 */
function getEffectiveStats(classId, unlockedTalents) {
  const base    = getBaseStats(classId);
  const bonuses = getTalentBonuses(unlockedTalents);
  const effective = {};
  for (const key of STAT_KEYS) {
    effective[key] = (base[key] || 0) + (bonuses[key] || 0);
  }
  return { base, bonuses, effective };
}

/**
 * Award XP to a user inside an existing pg transaction.
 * Caller is responsible for BEGIN / COMMIT / ROLLBACK.
 *
 * Security: this is intentionally NOT exposed as an HTTP endpoint.
 * Future callers (session completion, game reward) must go through
 * server-side handlers that validate eligibility before calling this.
 *
 * @param {import('pg').PoolClient} client — active transaction client
 * @param {string} userId — UUID
 * @param {number} amount — positive integer XP to add
 * @param {string} reason — audit description (max 120 chars)
 * @returns {Promise<{ rpg_xp: number, level: number }>}
 */
async function awardXpInTransaction(client, userId, amount, reason) {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(`awardXpInTransaction: invalid amount "${amount}" — must be positive integer`);
  }

  const { rows } = await client.query(
    `UPDATE public.profiles
        SET rpg_xp = LEAST(COALESCE(rpg_xp, 0) + $1, 999999)
      WHERE id = $2
      RETURNING rpg_xp`,
    [amount, userId]
  );
  if (!rows[0]) throw new Error(`awardXpInTransaction: profile not found for user ${userId}`);

  const newXp  = rows[0].rpg_xp;
  const { level } = computeRpgLevel(newXp);

  // Best-effort audit trail in coin_transactions (non-fatal)
  try {
    await client.query(
      `INSERT INTO public.coin_transactions (user_id, amount, action, metadata)
       VALUES ($1, 0, 'rpg_xp_award', $2)`,
      [userId, JSON.stringify({
        xp_awarded: amount,
        reason: String(reason).slice(0, 120),
        new_xp:    newXp,
        new_level: level,
      })]
    );
  } catch (_) { /* audit is best-effort; never block the XP award */ }

  return { rpg_xp: newXp, level };
}

module.exports = {
  XP_THRESHOLDS,
  MAX_LEVEL,
  BASE_STATS_BY_CLASS,
  COMPETENCY_TO_STAT,
  TIER_BONUS,
  STAT_KEYS,
  computeRpgLevel,
  getBaseStats,
  getTalentBonuses,
  getEffectiveStats,
  awardXpInTransaction,
};
