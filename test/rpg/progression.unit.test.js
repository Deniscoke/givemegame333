/**
 * test/rpg/progression.unit.test.js
 * Unit tests for lib/rpg-progression.js
 *
 * Covers:
 *  - XP_THRESHOLDS shape
 *  - computeRpgLevel: default, boundaries, transitions, max level
 *  - getBaseStats: valid class, no class, invalid class
 *  - getTalentBonuses: empty, single, multi-competency
 *  - getEffectiveStats: additive composition, zero base + bonuses
 *  - Role gating contract (via RPG_ELIGIBLE_ROLES)
 *  - awardXpInTransaction input validation (no DB required)
 *
 * Run: node --test test/rpg/progression.unit.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  XP_THRESHOLDS,
  MAX_LEVEL,
  BASE_STATS_BY_CLASS,
  COMPETENCY_TO_STAT,
  TIER_BONUS,
  STAT_KEYS,
  computeRpgLevel,
  computeSoloXpFromDurationMax,
  getBaseStats,
  getTalentBonuses,
  getEffectiveStats,
  awardXpInTransaction,
} = require('../../lib/rpg-progression');

const { RPG_ELIGIBLE_ROLES } = require('../../lib/rpg-avatars');

// ─────────────────────────────────────────────────────────────
describe('XP_THRESHOLDS', () => {
  it('has exactly 10 thresholds (levels 1–10)', () => {
    assert.strictEqual(XP_THRESHOLDS.length, 10);
    assert.strictEqual(MAX_LEVEL, 10);
  });

  it('starts at 0 XP for level 1', () => {
    assert.strictEqual(XP_THRESHOLDS[0], 0);
  });

  it('is strictly increasing', () => {
    for (let i = 1; i < XP_THRESHOLDS.length; i++) {
      assert.ok(
        XP_THRESHOLDS[i] > XP_THRESHOLDS[i - 1],
        `threshold[${i}]=${XP_THRESHOLDS[i]} should be > threshold[${i-1}]=${XP_THRESHOLDS[i-1]}`
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────
describe('computeRpgLevel', () => {
  it('returns level 1 for 0 XP (default state)', () => {
    const r = computeRpgLevel(0);
    assert.strictEqual(r.level, 1);
    assert.strictEqual(r.xp, 0);
    assert.strictEqual(r.xpForLevel, 0);
    assert.strictEqual(r.progressPct, 0);
    assert.ok(r.xpToNext !== null);
  });

  it('returns level 1 for negative XP (clamped to 0)', () => {
    const r = computeRpgLevel(-100);
    assert.strictEqual(r.level, 1);
    assert.strictEqual(r.xp, 0);
  });

  it('returns level 1 for null/undefined XP', () => {
    assert.strictEqual(computeRpgLevel(null).level, 1);
    assert.strictEqual(computeRpgLevel(undefined).level, 1);
    assert.strictEqual(computeRpgLevel('').level, 1);
  });

  it('stays at level 1 for XP just below threshold for level 2', () => {
    const r = computeRpgLevel(XP_THRESHOLDS[1] - 1);
    assert.strictEqual(r.level, 1);
  });

  it('transitions to level 2 at exact XP_THRESHOLDS[1]', () => {
    const r = computeRpgLevel(XP_THRESHOLDS[1]);
    assert.strictEqual(r.level, 2);
    assert.strictEqual(r.xpForLevel, XP_THRESHOLDS[1]);
  });

  it('transitions to level 3 at exact XP_THRESHOLDS[2]', () => {
    const r = computeRpgLevel(XP_THRESHOLDS[2]);
    assert.strictEqual(r.level, 3);
  });

  it('transitions to level 5 at exact XP_THRESHOLDS[4]', () => {
    const r = computeRpgLevel(XP_THRESHOLDS[4]);
    assert.strictEqual(r.level, 5);
  });

  it('returns MAX_LEVEL at the final threshold', () => {
    const r = computeRpgLevel(XP_THRESHOLDS[MAX_LEVEL - 1]);
    assert.strictEqual(r.level, MAX_LEVEL);
    assert.strictEqual(r.xpToNext, null);
    assert.strictEqual(r.progressPct, 100);
  });

  it('does not exceed MAX_LEVEL for very large XP', () => {
    const r = computeRpgLevel(9_999_999);
    assert.strictEqual(r.level, MAX_LEVEL);
  });

  it('progressPct is 0 at exact level boundary', () => {
    const r = computeRpgLevel(XP_THRESHOLDS[1]); // start of level 2
    assert.strictEqual(r.progressPct, 0);
  });

  it('progressPct is 100 at max level', () => {
    const r = computeRpgLevel(XP_THRESHOLDS[MAX_LEVEL - 1]);
    assert.strictEqual(r.progressPct, 100);
  });

  it('progressPct is between 0 and 100 for mid-level XP', () => {
    // Halfway between level 1 and level 2
    const half = Math.floor((XP_THRESHOLDS[0] + XP_THRESHOLDS[1]) / 2);
    const r = computeRpgLevel(half);
    assert.strictEqual(r.level, 1);
    assert.ok(r.progressPct > 0 && r.progressPct < 100, `Expected 0 < progressPct=${r.progressPct} < 100`);
  });

  it('xpToNext is the threshold for the next level', () => {
    const r = computeRpgLevel(XP_THRESHOLDS[2]); // level 3
    assert.strictEqual(r.xpToNext, XP_THRESHOLDS[3]);
  });
});

// ─────────────────────────────────────────────────────────────
describe('getBaseStats', () => {
  it('returns correct stats for Scholar (class 2)', () => {
    const s = getBaseStats(2);
    assert.strictEqual(s.focus, BASE_STATS_BY_CLASS[2].focus);
    assert.strictEqual(s.strategy, BASE_STATS_BY_CLASS[2].strategy);
  });

  it('covers all 7 avatar classes', () => {
    for (const classId of [2, 3, 4, 5, 6, 7, 8]) {
      const s = getBaseStats(classId);
      assert.ok(typeof s.insight === 'number', `class ${classId} missing insight`);
      assert.ok(typeof s.focus === 'number');
      assert.ok(typeof s.creativity === 'number');
      assert.ok(typeof s.resilience === 'number');
      assert.ok(typeof s.communication === 'number');
      assert.ok(typeof s.strategy === 'number');
    }
  });

  it('each class base stats sum to 40', () => {
    for (const classId of [2, 3, 4, 5, 6, 7, 8]) {
      const s = getBaseStats(classId);
      const total = STAT_KEYS.reduce((acc, k) => acc + s[k], 0);
      assert.strictEqual(total, 40, `class ${classId} total=${total}, expected 40`);
    }
  });

  it('returns all-zero stats for null class (no avatar)', () => {
    const s = getBaseStats(null);
    for (const k of STAT_KEYS) {
      assert.strictEqual(s[k], 0, `${k} should be 0 for null class`);
    }
  });

  it('returns all-zero stats for unknown class id', () => {
    const s = getBaseStats(99);
    for (const k of STAT_KEYS) {
      assert.strictEqual(s[k], 0);
    }
  });
});

// ─────────────────────────────────────────────────────────────
describe('getTalentBonuses', () => {
  it('returns all zeros for empty unlocked list', () => {
    const b = getTalentBonuses([]);
    for (const k of STAT_KEYS) assert.strictEqual(b[k], 0);
  });

  it('applies correct bonus for ucenie tier 1 → focus +3', () => {
    const b = getTalentBonuses([{ competency: 'ucenie', tier: 1 }]);
    assert.strictEqual(b.focus, TIER_BONUS[1]);
    assert.strictEqual(b.insight, 0);
  });

  it('applies correct bonus for digitalna tier 2 → insight +5', () => {
    const b = getTalentBonuses([{ competency: 'digitalna', tier: 2 }]);
    assert.strictEqual(b.insight, TIER_BONUS[2]);
  });

  it('applies correct bonus for komunikacia tier 3 → communication +10', () => {
    const b = getTalentBonuses([{ competency: 'komunikacia', tier: 3 }]);
    assert.strictEqual(b.communication, TIER_BONUS[3]);
  });

  it('stacks multiple competencies of different stats', () => {
    const talents = [
      { competency: 'ucenie', tier: 1 },    // focus +3
      { competency: 'digitalna', tier: 2 }, // insight +5
      { competency: 'kulturna', tier: 1 },  // creativity +3
    ];
    const b = getTalentBonuses(talents);
    assert.strictEqual(b.focus, 3);
    assert.strictEqual(b.insight, 5);
    assert.strictEqual(b.creativity, 3);
    assert.strictEqual(b.resilience, 0);
  });

  it('stacks two talents on the same stat', () => {
    const talents = [
      { competency: 'ucenie',  tier: 1 }, // focus +3
      { competency: 'ucenie',  tier: 2 }, // focus +5
    ];
    const b = getTalentBonuses(talents);
    assert.strictEqual(b.focus, TIER_BONUS[1] + TIER_BONUS[2]);
  });

  it('skips unknown competency gracefully', () => {
    const b = getTalentBonuses([{ competency: 'neznamy', tier: 1 }]);
    for (const k of STAT_KEYS) assert.strictEqual(b[k], 0);
  });

  it('skips invalid tier gracefully', () => {
    const b = getTalentBonuses([{ competency: 'ucenie', tier: 99 }]);
    assert.strictEqual(b.focus, 0);
  });

  it('problemy → insight mapping', () => {
    const b = getTalentBonuses([{ competency: 'problemy', tier: 1 }]);
    assert.strictEqual(b.insight, TIER_BONUS[1]);
  });

  it('socialna → communication mapping', () => {
    const b = getTalentBonuses([{ competency: 'socialna', tier: 2 }]);
    assert.strictEqual(b.communication, TIER_BONUS[2]);
  });

  it('matematika → strategy mapping', () => {
    const b = getTalentBonuses([{ competency: 'matematika', tier: 3 }]);
    assert.strictEqual(b.strategy, TIER_BONUS[3]);
  });

  it('obcianska → resilience mapping', () => {
    const b = getTalentBonuses([{ competency: 'obcianska', tier: 1 }]);
    assert.strictEqual(b.resilience, TIER_BONUS[1]);
  });

  it('pracovna → strategy mapping', () => {
    const b = getTalentBonuses([{ competency: 'pracovna', tier: 2 }]);
    assert.strictEqual(b.strategy, TIER_BONUS[2]);
  });
});

// ─────────────────────────────────────────────────────────────
describe('getEffectiveStats', () => {
  it('equals base stats when no talents unlocked', () => {
    const { base, bonuses, effective } = getEffectiveStats(2, []);
    for (const k of STAT_KEYS) {
      assert.strictEqual(bonuses[k], 0);
      assert.strictEqual(effective[k], base[k]);
    }
  });

  it('adds talent bonus correctly to base', () => {
    const talents = [{ competency: 'ucenie', tier: 1 }]; // focus +3
    const { base, bonuses, effective } = getEffectiveStats(2, talents);
    assert.strictEqual(bonuses.focus, 3);
    assert.strictEqual(effective.focus, base.focus + 3);
    // Other stats unchanged
    assert.strictEqual(effective.insight, base.insight);
    assert.strictEqual(effective.strategy, base.strategy);
  });

  it('works with null class (no avatar) — zero base + bonuses', () => {
    const talents = [{ competency: 'digitalna', tier: 2 }]; // insight +5
    const { base, bonuses, effective } = getEffectiveStats(null, talents);
    assert.strictEqual(base.insight, 0);
    assert.strictEqual(bonuses.insight, 5);
    assert.strictEqual(effective.insight, 5);
  });

  it('handles multiple talents across different stats', () => {
    const talents = [
      { competency: 'matematika', tier: 1 }, // strategy +3
      { competency: 'kulturna',   tier: 3 }, // creativity +10
    ];
    const { effective } = getEffectiveStats(7, talents); // Sage
    const base = getBaseStats(7);
    assert.strictEqual(effective.strategy,  base.strategy + 3);
    assert.strictEqual(effective.creativity, base.creativity + 10);
    assert.strictEqual(effective.insight,   base.insight);
  });

  it('returns plain objects with all 6 STAT_KEYS', () => {
    const { base, bonuses, effective } = getEffectiveStats(5, []);
    for (const k of STAT_KEYS) {
      assert.ok(k in base,      `base missing ${k}`);
      assert.ok(k in bonuses,   `bonuses missing ${k}`);
      assert.ok(k in effective, `effective missing ${k}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────
describe('RPG role gating (contract via RPG_ELIGIBLE_ROLES)', () => {
  it('eligible roles: admin, teacher, student', () => {
    assert.deepStrictEqual(RPG_ELIGIBLE_ROLES, ['admin', 'teacher', 'student']);
  });

  it('parent role is NOT eligible', () => {
    assert.ok(!RPG_ELIGIBLE_ROLES.includes('parent'));
  });

  it('no empty string role', () => {
    assert.ok(!RPG_ELIGIBLE_ROLES.includes(''));
  });

  it('has exactly 3 eligible roles', () => {
    assert.strictEqual(RPG_ELIGIBLE_ROLES.length, 3);
  });
});

// ─────────────────────────────────────────────────────────────
describe('awardXpInTransaction input validation', () => {
  // We test only the validation logic — no DB connection needed.
  // We pass a mock client that always throws to verify the
  // validation fires before any DB call.

  async function award(amount) {
    const mockClient = { query: async () => { throw new Error('should not reach DB'); } };
    return awardXpInTransaction(mockClient, 'user-id', amount, 'test');
  }

  it('rejects amount=0', async () => {
    await assert.rejects(() => award(0), /invalid amount/);
  });

  it('rejects negative amount', async () => {
    await assert.rejects(() => award(-1), /invalid amount/);
  });

  it('rejects float amount', async () => {
    await assert.rejects(() => award(1.5), /invalid amount/);
  });

  it('rejects string amount', async () => {
    await assert.rejects(() => award('100'), /invalid amount/);
  });

  it('rejects null amount', async () => {
    await assert.rejects(() => award(null), /invalid amount/);
  });
});

// ─────────────────────────────────────────────────────────────
describe('computeSoloXpFromDurationMax', () => {
  it('returns 30 XP for short sessions (5 min)', () => {
    assert.strictEqual(computeSoloXpFromDurationMax(5), 30);
  });

  it('scales up for longer durations', () => {
    const xp15 = computeSoloXpFromDurationMax(15);
    const xp30 = computeSoloXpFromDurationMax(30);
    assert.ok(xp30 > xp15, '30m should beat 15m');
    assert.ok(xp15 >= 30 && xp15 <= 120);
    assert.ok(xp30 >= 30 && xp30 <= 120);
  });

  it('caps at 120 XP', () => {
    assert.strictEqual(computeSoloXpFromDurationMax(180), 120);
    assert.strictEqual(computeSoloXpFromDurationMax(999), 120);
  });

  it('defaults to 15 min when duration missing or invalid', () => {
    const expected = computeSoloXpFromDurationMax(15);
    assert.strictEqual(computeSoloXpFromDurationMax(undefined), expected);
    assert.strictEqual(computeSoloXpFromDurationMax(NaN), expected);
    assert.strictEqual(computeSoloXpFromDurationMax(''), expected);
  });
});

// ─────────────────────────────────────────────────────────────
describe('COMPETENCY_TO_STAT coverage', () => {
  const ALL_RVP = ['ucenie', 'matematika', 'komunikacia', 'socialna', 'obcianska', 'pracovna', 'digitalna', 'kulturna', 'problemy'];

  it('covers all 9 RVP competency tags used in talent tree', () => {
    for (const comp of ALL_RVP) {
      assert.ok(comp in COMPETENCY_TO_STAT, `Missing mapping for competency: ${comp}`);
    }
  });

  it('all mapped stats are valid STAT_KEYS', () => {
    for (const [comp, stat] of Object.entries(COMPETENCY_TO_STAT)) {
      assert.ok(STAT_KEYS.includes(stat), `${comp} maps to unknown stat: ${stat}`);
    }
  });
});
