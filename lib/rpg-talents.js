/**
 * lib/rpg-talents.js — RPG Talent Tree Manifest
 *
 * Single source of truth for all talent definitions.
 * ID encoding: class_id * 100 + branch * 10 + tier
 *   branch 0 = A (first branch), branch 1 = B (second branch)
 *   tier 1/2/3
 *
 * Prerequisite rule: tier > 1 requires talent_id - 1 to be unlocked first.
 *
 * Competency tags map to Slovak RVP (Rámcový vzdelávací program):
 *   ucenie       — Kompetencia k učeniu
 *   problemy     — Kompetencia k riešeniu problémov
 *   komunikacia  — Komunikatívna kompetencia
 *   socialna     — Sociálna a personálna kompetencia
 *   obcianska    — Občianska kompetencia
 *   pracovna     — Pracovná kompetencia
 *   digitalna    — Digitálna kompetencia
 *   kulturna     — Kultúrna kompetencia
 *   matematika   — Matematická kompetencia
 */

'use strict';

const { COMPETENCY_TO_STAT, TIER_BONUS } = require('./rpg-progression');

const TALENT_DEFS = [
  // ═══════════════════════════════════════════
  // SCHOLAR (class 2) — Učenie + Matematika
  // ═══════════════════════════════════════════
  // Branch A: Štúdium
  { id: 201, class_id: 2, branch: 0, tier: 1, icon: '🎓', name: 'Sústredenie', competency: 'ucenie', coin_cost: 300 },
  { id: 202, class_id: 2, branch: 0, tier: 2, icon: '📖', name: 'Hlboké učenie', competency: 'ucenie', coin_cost: 600 },
  { id: 203, class_id: 2, branch: 0, tier: 3, icon: '🏆', name: 'Majster vedy', competency: 'ucenie', coin_cost: 1000 },
  // Branch B: Analýza
  { id: 211, class_id: 2, branch: 1, tier: 1, icon: '🧮', name: 'Logická myseľ', competency: 'matematika', coin_cost: 300 },
  { id: 212, class_id: 2, branch: 1, tier: 2, icon: '📊', name: 'Štatistik', competency: 'matematika', coin_cost: 600 },
  { id: 213, class_id: 2, branch: 1, tier: 3, icon: '⚡', name: 'Kvantový génius', competency: 'matematika', coin_cost: 1000 },

  // ═══════════════════════════════════════════
  // BUILDER (class 3) — Pracovná + Riešenie problémov
  // ═══════════════════════════════════════════
  // Branch A: Tvorba
  { id: 301, class_id: 3, branch: 0, tier: 1, icon: '🔨', name: 'Zručné ruky', competency: 'pracovna', coin_cost: 300 },
  { id: 302, class_id: 3, branch: 0, tier: 2, icon: '⚙️', name: 'Inovátor', competency: 'pracovna', coin_cost: 600 },
  { id: 303, class_id: 3, branch: 0, tier: 3, icon: '🏗️', name: 'Majster tvorca', competency: 'pracovna', coin_cost: 1000 },
  // Branch B: Konštrukcia
  { id: 311, class_id: 3, branch: 1, tier: 1, icon: '🔍', name: 'Diagnóza', competency: 'problemy', coin_cost: 300 },
  { id: 312, class_id: 3, branch: 1, tier: 2, icon: '🗺️', name: 'Systémový pohľad', competency: 'problemy', coin_cost: 600 },
  { id: 313, class_id: 3, branch: 1, tier: 3, icon: '🏛️', name: 'Architekt', competency: 'problemy', coin_cost: 1000 },

  // ═══════════════════════════════════════════
  // HEALER (class 4) — Komunikatívna + Sociálna + Občianska
  // ═══════════════════════════════════════════
  // Branch A: Empatia
  { id: 401, class_id: 4, branch: 0, tier: 1, icon: '👂', name: 'Aktívny poslucháč', competency: 'komunikacia', coin_cost: 300 },
  { id: 402, class_id: 4, branch: 0, tier: 2, icon: '🤝', name: 'Mediátor', competency: 'komunikacia', coin_cost: 600 },
  { id: 403, class_id: 4, branch: 0, tier: 3, icon: '💚', name: 'Healer skupiny', competency: 'komunikacia', coin_cost: 1000 },
  // Branch B: Komunita
  { id: 411, class_id: 4, branch: 1, tier: 1, icon: '🏛️', name: 'Občiansky duch', competency: 'obcianska', coin_cost: 300 },
  { id: 412, class_id: 4, branch: 1, tier: 2, icon: '👑', name: 'Komunitný líder', competency: 'obcianska', coin_cost: 600 },
  { id: 413, class_id: 4, branch: 1, tier: 3, icon: '🛡️', name: 'Ochranca', competency: 'obcianska', coin_cost: 1000 },

  // ═══════════════════════════════════════════
  // SHADOW (class 5) — Digitálna + Riešenie problémov
  // ═══════════════════════════════════════════
  // Branch A: Infiltrácia
  { id: 501, class_id: 5, branch: 0, tier: 1, icon: '🌑', name: 'Stealthový pohyb', competency: 'digitalna', coin_cost: 300 },
  { id: 502, class_id: 5, branch: 0, tier: 2, icon: '💻', name: 'Sieťová analýza', competency: 'digitalna', coin_cost: 600 },
  { id: 503, class_id: 5, branch: 0, tier: 3, icon: '🔓', name: 'Tieňový hacker', competency: 'digitalna', coin_cost: 1000 },
  // Branch B: Stratégia
  { id: 511, class_id: 5, branch: 1, tier: 1, icon: '♟️', name: 'Taktické myslenie', competency: 'problemy', coin_cost: 300 },
  { id: 512, class_id: 5, branch: 1, tier: 2, icon: '🎯', name: 'Predvídanie', competency: 'problemy', coin_cost: 600 },
  { id: 513, class_id: 5, branch: 1, tier: 3, icon: '👤', name: 'Majster tieňov', competency: 'problemy', coin_cost: 1000 },

  // ═══════════════════════════════════════════
  // ALCHEMIST (class 6) — Matematická + Digitálna
  // ═══════════════════════════════════════════
  // Branch A: Experimenty
  { id: 601, class_id: 6, branch: 0, tier: 1, icon: '⚗️', name: 'Základná syntéza', competency: 'matematika', coin_cost: 300 },
  { id: 602, class_id: 6, branch: 0, tier: 2, icon: '🧪', name: 'Pokročilá chémia', competency: 'matematika', coin_cost: 600 },
  { id: 603, class_id: 6, branch: 0, tier: 3, icon: '💎', name: 'Filozofický kameň', competency: 'matematika', coin_cost: 1000 },
  // Branch B: Transmutácia
  { id: 611, class_id: 6, branch: 1, tier: 1, icon: '🔢', name: 'Digitálna formula', competency: 'digitalna', coin_cost: 300 },
  { id: 612, class_id: 6, branch: 1, tier: 2, icon: '🖥️', name: 'Výpočtová mágia', competency: 'digitalna', coin_cost: 600 },
  { id: 613, class_id: 6, branch: 1, tier: 3, icon: '✨', name: 'Veľká transmutácia', competency: 'digitalna', coin_cost: 1000 },

  // ═══════════════════════════════════════════
  // SAGE (class 7) — Kultúrna + Komunikatívna
  // ═══════════════════════════════════════════
  // Branch A: Múdrosť
  { id: 701, class_id: 7, branch: 0, tier: 1, icon: '📜', name: 'Staroveké texty', competency: 'komunikacia', coin_cost: 300 },
  { id: 702, class_id: 7, branch: 0, tier: 2, icon: '🌐', name: 'Jazyková sila', competency: 'komunikacia', coin_cost: 600 },
  { id: 703, class_id: 7, branch: 0, tier: 3, icon: '🔮', name: 'Orákulum', competency: 'komunikacia', coin_cost: 1000 },
  // Branch B: Kultúra
  { id: 711, class_id: 7, branch: 1, tier: 1, icon: '🎭', name: 'Kultúrne povedomie', competency: 'kulturna', coin_cost: 300 },
  { id: 712, class_id: 7, branch: 1, tier: 2, icon: '🌍', name: 'Medzikultúrna empatia', competency: 'kulturna', coin_cost: 600 },
  { id: 713, class_id: 7, branch: 1, tier: 3, icon: '👁️', name: 'Najvyššia múdrosť', competency: 'kulturna', coin_cost: 1000 },

  // ═══════════════════════════════════════════
  // KNIGHT (class 8) — Občianska + Sociálna
  // ═══════════════════════════════════════════
  // Branch A: Ochrana
  { id: 801, class_id: 8, branch: 0, tier: 1, icon: '🛡️', name: 'Štít spravodlivosti', competency: 'obcianska', coin_cost: 300 },
  { id: 802, class_id: 8, branch: 0, tier: 2, icon: '⚔️', name: 'Rytiersky kódex', competency: 'obcianska', coin_cost: 600 },
  { id: 803, class_id: 8, branch: 0, tier: 3, icon: '✨', name: 'Paladin', competency: 'obcianska', coin_cost: 1000 },
  // Branch B: Vodcovstvo
  { id: 811, class_id: 8, branch: 1, tier: 1, icon: '🚩', name: 'Inšpiratívne vedenie', competency: 'socialna', coin_cost: 300 },
  { id: 812, class_id: 8, branch: 1, tier: 2, icon: '🗡️', name: 'Taktický veliteľ', competency: 'socialna', coin_cost: 600 },
  { id: 813, class_id: 8, branch: 1, tier: 3, icon: '👑', name: 'Kráľ rytierov', competency: 'socialna', coin_cost: 1000 },
];

// Phase 5: a talent only adds stat points (lib/rpg-progression.js TIER_BONUS).
// The old descriptions promised XP / coin effects that were never built, so
// every description is now generated from what the talent really does.
const STAT_LABEL_SK = Object.freeze({
  insight: 'Insight', focus: 'Focus', creativity: 'Kreativita',
  resilience: 'Odolnosť', communication: 'Komunikácia', strategy: 'Stratégia',
});
const COMPETENCY_LABEL_SK = Object.freeze({
  ucenie: 'učenie', problemy: 'riešenie problémov', komunikacia: 'komunikácia',
  socialna: 'spolupráca', obcianska: 'občianska kompetencia', pracovna: 'pracovná kompetencia',
  digitalna: 'digitálna kompetencia', kulturna: 'kultúra', matematika: 'matematika',
});

/**
 * Stat-only description, e.g. "+3 k atribútu Focus (učenie)".
 * @param {{ competency: string, tier: number }} t
 * @returns {string}
 */
function statOnlyDescription(t) {
  const stat = COMPETENCY_TO_STAT[t.competency];
  return `+${TIER_BONUS[t.tier]} k atribútu ${STAT_LABEL_SK[stat]} (${COMPETENCY_LABEL_SK[t.competency]})`;
}

const RPG_TALENTS = Object.freeze(TALENT_DEFS.map(t => Object.freeze({ ...t, description: statOnlyDescription(t) })));

/** All valid talent IDs */
const VALID_TALENT_IDS = RPG_TALENTS.map(t => t.id);

/** Map for O(1) lookup */
const TALENT_BY_ID = Object.fromEntries(RPG_TALENTS.map(t => [t.id, t]));

/**
 * Get the talent manifest (safe to send to client).
 * @returns {Array}
 */
function getTalentManifest() {
  return RPG_TALENTS;
}

/**
 * Get talents for a specific avatar class.
 * @param {number} classId
 * @returns {Array}
 */
function getTalentsForClass(classId) {
  return RPG_TALENTS.filter(t => t.class_id === classId);
}

/**
 * Look up a talent by ID.
 * @param {number} id
 * @returns {object|null}
 */
function getTalentById(id) {
  return TALENT_BY_ID[id] || null;
}

/**
 * Map unlocked talent ids (rpg_user_talents.talent_id rows) to talent objects.
 * getEffectiveStats() reads `competency` and `tier`, so it needs the objects;
 * unknown ids are dropped.
 * @param {Array<number|string>} ids
 * @returns {Array<object>}
 */
function talentIdsToTalents(ids) {
  return (ids || [])
    .map(id => TALENT_BY_ID[Number(id)])
    .filter(Boolean);
}

/**
 * Validate that an unlock is allowed given a set of already-unlocked IDs.
 * Prerequisite: tier > 1 requires (id - 1) to be already unlocked.
 * @param {number} talentId
 * @param {number[]} unlockedIds
 * @returns {{ ok: boolean, reason?: string }}
 */
function validatePrerequisite(talentId, unlockedIds) {
  const talent = TALENT_BY_ID[talentId];
  if (!talent) return { ok: false, reason: 'Talent neexistuje' };
  if (talent.tier > 1) {
    const prereqId = talentId - 1;
    if (!unlockedIds.includes(prereqId)) {
      return { ok: false, reason: 'Najprv musíš odomknúť predchádzajúci stupeň' };
    }
  }
  return { ok: true };
}

module.exports = {
  RPG_TALENTS,
  VALID_TALENT_IDS,
  getTalentManifest,
  getTalentsForClass,
  getTalentById,
  talentIdsToTalents,
  validatePrerequisite,
  statOnlyDescription,
};
