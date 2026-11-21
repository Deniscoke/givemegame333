/**
 * gIVEMEGAME.IO — shared generation filter presets (single source of truth).
 *
 * Used by the server (prompt builder, sanitizer, enforcement) and by the
 * browser (fallback scorer, age-band picker). public/js/filter-presets.js is
 * a byte-identical copy (CRLF/LF aside); test/filter-presets.test.js keeps
 * them in sync. Edit this file, then copy it over.
 *
 * Product decisions (Phase 4):
 *   - content age focus 6-18: bands 6-8, 8-11, 11-15, 15-19, plus a free
 *     min/max range clamped to 6-19
 *   - duration: speedrun 5-10, classic 15-25, marathon 30-60 minutes
 *   - squad: solo 1, pair 2, group 3-6, class 15-30
 */
(function (root, factory) {
	if (typeof module === 'object' && module.exports) module.exports = factory();
	else root.FilterPresets = factory();
})(typeof self !== 'undefined' ? self : this, function () {
	'use strict';

	var AGE_LIMITS = Object.freeze({ min: 6, max: 19 });

	/** RVP stupeň keys. `stredni` covers secondary school (15-19). */
	var STUPNE = Object.freeze(['prvni', 'druhy', 'stredni']);

	var AGE_BANDS = Object.freeze({
		'6-8': Object.freeze({ min: 6, max: 8, stupen: 'prvni' }),
		'8-11': Object.freeze({ min: 8, max: 11, stupen: 'prvni' }),
		'11-15': Object.freeze({ min: 11, max: 15, stupen: 'druhy' }),
		'15-19': Object.freeze({ min: 15, max: 19, stupen: 'stredni' })
	});

	var DURATION_PRESETS = Object.freeze({
		speedrun: Object.freeze({ min: 5, max: 10, label: '5–10 min' }),
		classic: Object.freeze({ min: 15, max: 25, label: '15–25 min' }),
		marathon: Object.freeze({ min: 30, max: 60, label: '30–60 min' })
	});

	var SQUAD_PRESETS = Object.freeze({
		solo: Object.freeze({ min: 1, max: 1, label: '1 player (solo)' }),
		pair: Object.freeze({ min: 2, max: 2, label: '2 players (pair)' }),
		group: Object.freeze({ min: 3, max: 6, label: '3–6 players (small group)' }),
		class: Object.freeze({ min: 15, max: 30, label: '15–30 players (whole class)' })
	});

	/** Values the pre-Phase-4 UI sent; API clients may still send them. */
	var LEGACY_DURATION = Object.freeze({ quick: 'speedrun', medium: 'classic', long: 'marathon' });
	var LEGACY_SQUAD = Object.freeze({ small: 'group', medium: 'group', large: 'class' });

	/**
	 * Generation modes. `online` asks for remote-safe mechanics (Phase 6
	 * mode button; sessions default to the online play style).
	 */
	var MODES = Object.freeze(['party', 'classroom', 'reflection', 'circus', 'cooking', 'meditation', 'online']);

	var ENUMS = Object.freeze({
		setting: Object.freeze(['any', 'indoor', 'outdoor']),
		energy: Object.freeze(['any', 'low', 'medium', 'high']),
		activity: Object.freeze(['any', 'solo', 'pair', 'group', 'mass']),
		depth: Object.freeze(['any', 'light', 'medium', 'deep']),
		cuisine: Object.freeze(['any', 'sweet', 'savory', 'healthy', 'international']),
		focus: Object.freeze(['any', 'breath', 'body', 'visualization', 'movement']),
		stupen: Object.freeze(['any'].concat(STUPNE)),
		kompetence: Object.freeze(['any', 'k-uceni', 'k-reseni-problemu', 'komunikativni',
			'socialni-personalni', 'obcanske', 'pracovni', 'digitalni']),
		oblast: Object.freeze(['any', 'jazyk', 'matematika', 'ict', 'clovek-svet', 'clovek-spolecnost',
			'clovek-priroda', 'umeni-kultura', 'clovek-zdravi', 'clovek-prace'])
	});

	function has(obj, key) {
		return typeof key === 'string' && Object.prototype.hasOwnProperty.call(obj, key);
	}

	/** Canonical duration key ('quick' → 'speedrun'), or null. */
	function resolveDurationKey(value) {
		if (has(DURATION_PRESETS, value)) return value;
		if (has(LEGACY_DURATION, value)) return LEGACY_DURATION[value];
		return null;
	}

	/** Canonical squad key ('small' → 'group'), or null. */
	function resolveSquadKey(value) {
		if (has(SQUAD_PRESETS, value)) return value;
		if (has(LEGACY_SQUAD, value)) return LEGACY_SQUAD[value];
		return null;
	}

	/** @returns {{min:number,max:number,label:string}|null} */
	function getDuration(value) {
		var key = resolveDurationKey(value);
		return key ? DURATION_PRESETS[key] : null;
	}

	/** @returns {{min:number,max:number,label:string}|null} */
	function getSquad(value) {
		var key = resolveSquadKey(value);
		return key ? SQUAD_PRESETS[key] : null;
	}

	/** Integer age clamped to 6-19, or null when not a number. */
	function clampAge(value) {
		if (value === '' || value === null || value === undefined) return null;
		var n = typeof value === 'number' ? value : Number(String(value).trim());
		if (!isFinite(n)) return null;
		n = Math.round(n);
		return Math.min(AGE_LIMITS.max, Math.max(AGE_LIMITS.min, n));
	}

	/**
	 * Normalise an age range: clamp to 6-19, fill a missing side with the
	 * limit, swap when min > max. Returns null when neither side is set.
	 * @returns {{min:number,max:number}|null}
	 */
	function normalizeAgeRange(minValue, maxValue) {
		var min = clampAge(minValue);
		var max = clampAge(maxValue);
		if (min === null && max === null) return null;
		if (min === null) min = AGE_LIMITS.min;
		if (max === null) max = AGE_LIMITS.max;
		if (min > max) { var t = min; min = max; max = t; }
		return { min: min, max: max };
	}

	/** Band key whose range equals {min,max} exactly, or null. */
	function matchAgeBand(min, max) {
		for (var key in AGE_BANDS) {
			if (has(AGE_BANDS, key) && AGE_BANDS[key].min === min && AGE_BANDS[key].max === max) return key;
		}
		return null;
	}

	/** RVP stupeň for an age range, by its midpoint. */
	function stupenForAge(min, max) {
		var mid = (Number(min) + Number(max)) / 2;
		if (mid < 11) return 'prvni';
		if (mid < 15) return 'druhy';
		return 'stredni';
	}

	function isMode(value) {
		return MODES.indexOf(value) !== -1;
	}

	return Object.freeze({
		AGE_LIMITS: AGE_LIMITS,
		AGE_BANDS: AGE_BANDS,
		STUPNE: STUPNE,
		DURATION_PRESETS: DURATION_PRESETS,
		SQUAD_PRESETS: SQUAD_PRESETS,
		LEGACY_DURATION: LEGACY_DURATION,
		LEGACY_SQUAD: LEGACY_SQUAD,
		MODES: MODES,
		ENUMS: ENUMS,
		resolveDurationKey: resolveDurationKey,
		resolveSquadKey: resolveSquadKey,
		getDuration: getDuration,
		getSquad: getSquad,
		clampAge: clampAge,
		normalizeAgeRange: normalizeAgeRange,
		matchAgeBand: matchAgeBand,
		stupenForAge: stupenForAge,
		isMode: isMode
	});
});
