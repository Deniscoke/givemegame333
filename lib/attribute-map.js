'use strict';

/**
 * lib/attribute-map.js — which RPG attributes a played game trains (Phase 5).
 *
 * One map for both competency vocabularies:
 *   - the Czech RVP keys games carry in rvp.kompetence (k-uceni, komunikativni …)
 *   - the Slovak talent keys from lib/rpg-talents.js (ucenie, komunikacia …)
 *
 * Plus a "mode prior": what the kind of activity (cooking, circus …) trains
 * no matter which competencies the AI listed. Each mode carries a short
 * pedagogical rationale (i18n key + Slovak fallback) shown in a tooltip, so
 * teachers can see why cooking grows Focus and Strategy.
 *
 * Sub-tags (motorika, vyziva, digitalna) are not new top-level stats. They are
 * visible tags under an existing stat: their XP is the part of the parent
 * stat's XP that came from that kind of practice.
 *
 * Pure module, no DB.
 */

const { STAT_KEYS, COMPETENCY_TO_STAT } = require('./rpg-progression');

/** Czech RVP game keys (server.js VALID_COMPETENCY_KEYS) → stat. */
const GAME_COMPETENCY_TO_STAT = Object.freeze({
	'k-uceni':             'focus',
	'k-reseni-problemu':   'insight',
	'komunikativni':       'communication',
	'socialni-personalni': 'communication',
	'obcanske':            'resilience',
	'pracovni':            'strategy',
	'digitalni':           'insight',
	// Not in the generation whitelist today; mapped so creativity stays reachable
	// if the key list grows (and for library games that already carry it).
	'kulturni':            'creativity',
});

/** Unified map: Czech game keys + Slovak talent keys → stat. */
const UNIFIED_COMPETENCY_TO_STAT = Object.freeze({
	...GAME_COMPETENCY_TO_STAT,
	...COMPETENCY_TO_STAT,
});

function deepFreeze(obj) {
	for (const v of Object.values(obj)) if (v && typeof v === 'object') deepFreeze(v);
	return Object.freeze(obj);
}

/** Sub-tag → the stat it lives under. */
const SUBTAG_PARENT = Object.freeze({
	motorika:  'focus',     // fine and gross motor control needs focused attention
	vyziva:    'strategy',  // nutrition knowledge: planning a balanced meal
	digitalna: 'insight',   // digital literacy (existing digitalni → insight mapping)
});
const SUBTAG_KEYS = Object.freeze(Object.keys(SUBTAG_PARENT));

/** Every key a user_stat_xp row may hold. */
const STAT_XP_KEYS = Object.freeze([...STAT_KEYS, ...SUBTAG_KEYS]);

/**
 * Mode priors. `stats` are the primary stats the activity type trains;
 * `subtags` must have their parent among `stats`.
 */
const MODE_ATTRIBUTES = deepFreeze({
	cooking: {
		stats: ['focus', 'strategy'],
		subtags: ['motorika', 'vyziva'],
		rationale_key: 'attr_why_cooking',
		rationale: 'Varenie trénuje jemnú motoriku (krájanie, miešanie), sústredenie na postup a plánovanie zdravého jedla.',
	},
	circus: {
		stats: ['resilience', 'focus'],
		subtags: ['motorika'],
		rationale_key: 'attr_why_circus',
		rationale: 'Cirkus trénuje pohyb a rovnováhu (motoriku) a vytrvalosť skúšať to znova po chybe.',
	},
	meditation: {
		stats: ['focus', 'resilience'],
		subtags: [],
		rationale_key: 'attr_why_meditation',
		rationale: 'Meditácia trénuje pozornosť a pokojné zvládanie emócií a stresu.',
	},
	party: {
		stats: ['communication', 'creativity'],
		subtags: [],
		rationale_key: 'attr_why_party',
		rationale: 'Párty hry trénujú rozprávanie s ostatnými, spoluprácu a nápady na mieste.',
	},
	classroom: {
		stats: ['insight', 'strategy'],
		subtags: [],
		rationale_key: 'attr_why_classroom',
		rationale: 'Hry v triede trénujú porozumenie učivu a plánovanie, ako úlohu vyriešiť.',
	},
	reflection: {
		stats: ['communication', 'focus'],
		subtags: [],
		rationale_key: 'attr_why_reflection',
		rationale: 'Reflexia trénuje pomenovať svoje pocity a myšlienky a sústrediť sa na to, čo sa stalo.',
	},
	online: {
		stats: ['communication', 'insight'],
		subtags: ['digitalna'],
		rationale_key: 'attr_why_online',
		rationale: 'Online hry trénujú jasnú komunikáciu cez obrazovku a bezpečné používanie digitálnych nástrojov.',
	},
});

/** Weight of each mode-prior stat vs. each listed competency (1). */
const MODE_STAT_WEIGHT = 2;
/** At most this many competencies count (generation asks for 1–3). */
const MAX_COUNTED_COMPETENCIES = 3;

/**
 * @param {unknown} key
 * @returns {string|null} stat for a competency key (Czech or Slovak)
 */
function statForCompetency(key) {
	if (typeof key !== 'string') return null;
	return Object.hasOwn(UNIFIED_COMPETENCY_TO_STAT, key) ? UNIFIED_COMPETENCY_TO_STAT[key] : null;
}

/**
 * @param {unknown} mode
 * @returns {{ stats: string[], subtags: string[], rationale_key: string, rationale: string }|null}
 */
function modeAttributes(mode) {
	if (typeof mode !== 'string' || !Object.hasOwn(MODE_ATTRIBUTES, mode)) return null;
	return MODE_ATTRIBUTES[mode];
}

/**
 * Stat weights for one game: mode prior stats weigh MODE_STAT_WEIGHT each,
 * each distinct counted competency adds 1 to its stat.
 *
 * @param {{ mode?: unknown, kompetence?: unknown }} input
 * @returns {Record<string, number>} only stats with weight > 0
 */
function statWeights({ mode, kompetence }) {
	const weights = {};
	const prior = modeAttributes(mode);
	if (prior) for (const s of prior.stats) weights[s] = (weights[s] || 0) + MODE_STAT_WEIGHT;
	const seen = new Set();
	const list = Array.isArray(kompetence) ? kompetence : [];
	for (const k of list) {
		if (seen.size >= MAX_COUNTED_COMPETENCIES) break;
		const stat = statForCompetency(k);
		if (!stat || seen.has(k)) continue;
		seen.add(k);
		weights[stat] = (weights[stat] || 0) + 1;
	}
	return weights;
}

/**
 * Deterministic split of `pool` XP across stats by weight (largest remainder,
 * ties broken by STAT_KEYS order), plus sub-tag XP equal to the parent's share.
 *
 * @param {number} pool — integer XP to distribute (>= 0)
 * @param {{ mode?: unknown, kompetence?: unknown }} game
 * @returns {Record<string, number>} stat/sub-tag → XP (> 0 only)
 */
function splitStatXp(pool, game) {
	const total = Math.max(0, Math.floor(Number(pool) || 0));
	const weights = statWeights(game || {});
	const keys = STAT_KEYS.filter((k) => weights[k] > 0);
	const out = {};
	if (!total || !keys.length) return out;

	const sumW = keys.reduce((a, k) => a + weights[k], 0);
	const parts = keys.map((k, i) => {
		const exact = (total * weights[k]) / sumW;
		return { k, i, floor: Math.floor(exact), rem: exact - Math.floor(exact) };
	});
	let left = total - parts.reduce((a, p) => a + p.floor, 0);
	[...parts]
		.sort((a, b) => (b.rem - a.rem) || (a.i - b.i))
		.forEach((p) => { if (left > 0) { p.floor += 1; left -= 1; } });
	for (const p of parts) if (p.floor > 0) out[p.k] = p.floor;

	const prior = modeAttributes(game?.mode);
	if (prior) {
		for (const tag of prior.subtags) {
			const parentXp = out[SUBTAG_PARENT[tag]] || 0;
			if (parentXp > 0) out[tag] = parentXp;
		}
	}
	return out;
}

/**
 * Public manifest for the client (tooltips, panel labels). Safe to send.
 * @returns {{ modes: object, subtags: object, competencies: object }}
 */
function getAttributeManifest() {
	const modes = {};
	for (const [mode, a] of Object.entries(MODE_ATTRIBUTES)) {
		modes[mode] = { stats: [...a.stats], subtags: [...a.subtags], rationale_key: a.rationale_key, rationale: a.rationale };
	}
	return {
		modes,
		subtags: { ...SUBTAG_PARENT },
		competencies: { ...UNIFIED_COMPETENCY_TO_STAT },
	};
}

module.exports = {
	GAME_COMPETENCY_TO_STAT,
	UNIFIED_COMPETENCY_TO_STAT,
	SUBTAG_PARENT,
	SUBTAG_KEYS,
	STAT_XP_KEYS,
	MODE_ATTRIBUTES,
	MODE_STAT_WEIGHT,
	MAX_COUNTED_COMPETENCIES,
	statForCompetency,
	modeAttributes,
	statWeights,
	splitStatXp,
	getAttributeManifest,
};
