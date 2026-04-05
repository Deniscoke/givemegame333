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

const RPG_TALENTS = [
  // ═══════════════════════════════════════════
  // SCHOLAR (class 2) — Učenie + Matematika
  // ═══════════════════════════════════════════
  // Branch A: Štúdium
  { id: 201, class_id: 2, branch: 0, tier: 1, icon: '🎓', name: 'Sústredenie',
    description: '+5 % XP zo všetkých hier', competency: 'ucenie', coin_cost: 300 },
  { id: 202, class_id: 2, branch: 0, tier: 2, icon: '📖', name: 'Hlboké učenie',
    description: '+10 bodov K učeniu za každú hru', competency: 'ucenie', coin_cost: 600 },
  { id: 203, class_id: 2, branch: 0, tier: 3, icon: '🏆', name: 'Majster vedy',
    description: 'Dvojnásobné coiny každý piatok', competency: 'ucenie', coin_cost: 1000 },
  // Branch B: Analýza
  { id: 211, class_id: 2, branch: 1, tier: 1, icon: '🧮', name: 'Logická myseľ',
    description: '+5 % coinov z každej hry', competency: 'matematika', coin_cost: 300 },
  { id: 212, class_id: 2, branch: 1, tier: 2, icon: '📊', name: 'Štatistik',
    description: '+10 bodov K riešeniu problémov za hru', competency: 'matematika', coin_cost: 600 },
  { id: 213, class_id: 2, branch: 1, tier: 3, icon: '⚡', name: 'Kvantový génius',
    description: 'Extra pokus v každej hre raz za deň', competency: 'matematika', coin_cost: 1000 },

  // ═══════════════════════════════════════════
  // BUILDER (class 3) — Pracovná + Riešenie problémov
  // ═══════════════════════════════════════════
  // Branch A: Tvorba
  { id: 301, class_id: 3, branch: 0, tier: 1, icon: '🔨', name: 'Zručné ruky',
    description: '+5 % coinov z tímových výziev', competency: 'pracovna', coin_cost: 300 },
  { id: 302, class_id: 3, branch: 0, tier: 2, icon: '⚙️', name: 'Inovátor',
    description: '+10 bodov Pracovná kompetencia za hru', competency: 'pracovna', coin_cost: 600 },
  { id: 303, class_id: 3, branch: 0, tier: 3, icon: '🏗️', name: 'Majster tvorca',
    description: '2× coiny pri tímových hrách', competency: 'pracovna', coin_cost: 1000 },
  // Branch B: Konštrukcia
  { id: 311, class_id: 3, branch: 1, tier: 1, icon: '🔍', name: 'Diagnóza',
    description: '+5 % XP z logických hier', competency: 'problemy', coin_cost: 300 },
  { id: 312, class_id: 3, branch: 1, tier: 2, icon: '🗺️', name: 'Systémový pohľad',
    description: '+15 bodov K riešeniu problémov za hru', competency: 'problemy', coin_cost: 600 },
  { id: 313, class_id: 3, branch: 1, tier: 3, icon: '🏛️', name: 'Architekt',
    description: 'Odomkne denný Builder challenge', competency: 'problemy', coin_cost: 1000 },

  // ═══════════════════════════════════════════
  // HEALER (class 4) — Komunikatívna + Sociálna + Občianska
  // ═══════════════════════════════════════════
  // Branch A: Empatia
  { id: 401, class_id: 4, branch: 0, tier: 1, icon: '👂', name: 'Aktívny poslucháč',
    description: '+10 bodov Komunikatívna kompetencia', competency: 'komunikacia', coin_cost: 300 },
  { id: 402, class_id: 4, branch: 0, tier: 2, icon: '🤝', name: 'Mediátor',
    description: '+5 % coinov z kooperatívnych hier', competency: 'komunikacia', coin_cost: 600 },
  { id: 403, class_id: 4, branch: 0, tier: 3, icon: '💚', name: 'Healer skupiny',
    description: '+50 coinov za každé denné prihlásenie', competency: 'komunikacia', coin_cost: 1000 },
  // Branch B: Komunita
  { id: 411, class_id: 4, branch: 1, tier: 1, icon: '🏛️', name: 'Občiansky duch',
    description: '+5 bodov Občianska kompetencia', competency: 'obcianska', coin_cost: 300 },
  { id: 412, class_id: 4, branch: 1, tier: 2, icon: '👑', name: 'Komunitný líder',
    description: '+5 % coinov z každej hry', competency: 'obcianska', coin_cost: 600 },
  { id: 413, class_id: 4, branch: 1, tier: 3, icon: '🛡️', name: 'Ochranca',
    description: 'Bonus XP pre celú skupinu +5 %', competency: 'obcianska', coin_cost: 1000 },

  // ═══════════════════════════════════════════
  // SHADOW (class 5) — Digitálna + Riešenie problémov
  // ═══════════════════════════════════════════
  // Branch A: Infiltrácia
  { id: 501, class_id: 5, branch: 0, tier: 1, icon: '🌑', name: 'Stealthový pohyb',
    description: '+5 % XP z rýchlych hier', competency: 'digitalna', coin_cost: 300 },
  { id: 502, class_id: 5, branch: 0, tier: 2, icon: '💻', name: 'Sieťová analýza',
    description: '+10 bodov Digitálna kompetencia', competency: 'digitalna', coin_cost: 600 },
  { id: 503, class_id: 5, branch: 0, tier: 3, icon: '🔓', name: 'Tieňový hacker',
    description: 'Odomkne tajný denný challenge', competency: 'digitalna', coin_cost: 1000 },
  // Branch B: Stratégia
  { id: 511, class_id: 5, branch: 1, tier: 1, icon: '♟️', name: 'Taktické myslenie',
    description: '+5 % coinov zo solo hier', competency: 'problemy', coin_cost: 300 },
  { id: 512, class_id: 5, branch: 1, tier: 2, icon: '🎯', name: 'Predvídanie',
    description: '+15 bodov K riešeniu problémov', competency: 'problemy', coin_cost: 600 },
  { id: 513, class_id: 5, branch: 1, tier: 3, icon: '👤', name: 'Majster tieňov',
    description: '2× coiny každú 5. hru', competency: 'problemy', coin_cost: 1000 },

  // ═══════════════════════════════════════════
  // ALCHEMIST (class 6) — Matematická + Digitálna
  // ═══════════════════════════════════════════
  // Branch A: Experimenty
  { id: 601, class_id: 6, branch: 0, tier: 1, icon: '⚗️', name: 'Základná syntéza',
    description: '+5 % XP z vedeckých hier', competency: 'matematika', coin_cost: 300 },
  { id: 602, class_id: 6, branch: 0, tier: 2, icon: '🧪', name: 'Pokročilá chémia',
    description: '+10 bodov Matematická kompetencia', competency: 'matematika', coin_cost: 600 },
  { id: 603, class_id: 6, branch: 0, tier: 3, icon: '💎', name: 'Filozofický kameň',
    description: 'Premeni 500 XP → 250 coinov raz za týždeň', competency: 'matematika', coin_cost: 1000 },
  // Branch B: Transmutácia
  { id: 611, class_id: 6, branch: 1, tier: 1, icon: '🔢', name: 'Digitálna formula',
    description: '+5 % coinov z matematických hier', competency: 'digitalna', coin_cost: 300 },
  { id: 612, class_id: 6, branch: 1, tier: 2, icon: '🖥️', name: 'Výpočtová mágia',
    description: '+10 bodov Digitálna kompetencia', competency: 'digitalna', coin_cost: 600 },
  { id: 613, class_id: 6, branch: 1, tier: 3, icon: '✨', name: 'Veľká transmutácia',
    description: 'Coin multiplikátor ×1.5 každý deň', competency: 'digitalna', coin_cost: 1000 },

  // ═══════════════════════════════════════════
  // SAGE (class 7) — Kultúrna + Komunikatívna
  // ═══════════════════════════════════════════
  // Branch A: Múdrosť
  { id: 701, class_id: 7, branch: 0, tier: 1, icon: '📜', name: 'Staroveké texty',
    description: '+10 bodov Komunikatívna kompetencia', competency: 'komunikacia', coin_cost: 300 },
  { id: 702, class_id: 7, branch: 0, tier: 2, icon: '🌐', name: 'Jazyková sila',
    description: '+5 % coinov z jazykových hier', competency: 'komunikacia', coin_cost: 600 },
  { id: 703, class_id: 7, branch: 0, tier: 3, icon: '🔮', name: 'Orákulum',
    description: 'Dvojnásobné body kompetencií každú stredu', competency: 'komunikacia', coin_cost: 1000 },
  // Branch B: Kultúra
  { id: 711, class_id: 7, branch: 1, tier: 1, icon: '🎭', name: 'Kultúrne povedomie',
    description: '+5 bodov Kultúrna kompetencia', competency: 'kulturna', coin_cost: 300 },
  { id: 712, class_id: 7, branch: 1, tier: 2, icon: '🌍', name: 'Medzikultúrna empatia',
    description: '+5 % XP zo vzdelávacích hier', competency: 'kulturna', coin_cost: 600 },
  { id: 713, class_id: 7, branch: 1, tier: 3, icon: '👁️', name: 'Najvyššia múdrosť',
    description: 'Odomkne titul Sage v profile', competency: 'kulturna', coin_cost: 1000 },

  // ═══════════════════════════════════════════
  // KNIGHT (class 8) — Občianska + Sociálna
  // ═══════════════════════════════════════════
  // Branch A: Ochrana
  { id: 801, class_id: 8, branch: 0, tier: 1, icon: '🛡️', name: 'Štít spravodlivosti',
    description: '+5 bodov Občianska kompetencia', competency: 'obcianska', coin_cost: 300 },
  { id: 802, class_id: 8, branch: 0, tier: 2, icon: '⚔️', name: 'Rytiersky kódex',
    description: '+5 % coinov z každej výzvy', competency: 'obcianska', coin_cost: 600 },
  { id: 803, class_id: 8, branch: 0, tier: 3, icon: '✨', name: 'Paladin',
    description: 'Bonus XP pre celú triedu +5 %', competency: 'obcianska', coin_cost: 1000 },
  // Branch B: Vodcovstvo
  { id: 811, class_id: 8, branch: 1, tier: 1, icon: '🚩', name: 'Inšpiratívne vedenie',
    description: '+5 % XP z tímových hier', competency: 'socialna', coin_cost: 300 },
  { id: 812, class_id: 8, branch: 1, tier: 2, icon: '🗡️', name: 'Taktický veliteľ',
    description: '+10 bodov Sociálna kompetencia', competency: 'socialna', coin_cost: 600 },
  { id: 813, class_id: 8, branch: 1, tier: 3, icon: '👑', name: 'Kráľ rytierov',
    description: 'Odomkne Knight titul a exkluzívny badge', competency: 'socialna', coin_cost: 1000 },
];

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
  validatePrerequisite,
};
