'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const AM = require('../lib/attribute-map');
const { STAT_KEYS } = require('../lib/rpg-progression');
const FilterPresets = require('../lib/filter-presets');

describe('attribute map (Phase 5)', () => {
	it('covers every generation mode, including online, with a rationale', () => {
		for (const mode of FilterPresets.MODES) {
			const a = AM.modeAttributes(mode);
			assert.ok(a, `mode ${mode} mapped`);
			assert.ok(a.stats.length >= 1);
			for (const s of a.stats) assert.ok(STAT_KEYS.includes(s), `${mode}: ${s} is a stat`);
			for (const t of a.subtags) assert.ok(a.stats.includes(AM.SUBTAG_PARENT[t]), `${mode}: ${t} parent listed`);
			assert.match(a.rationale_key, /^attr_why_[a-z]+$/);
			assert.ok(a.rationale.length > 20);
		}
	});

	it('cooking trains focus + strategy with motorika and vyziva sub-tags; online adds digital', () => {
		const a = AM.modeAttributes('cooking');
		assert.deepEqual(a.stats, ['focus', 'strategy']);
		assert.deepEqual(a.subtags, ['motorika', 'vyziva']);
		assert.deepEqual(AM.modeAttributes('online').stats, ['communication', 'insight']);
		assert.deepEqual(AM.modeAttributes('online').subtags, ['digitalna']);
	});

	it('unifies Czech game keys and Slovak talent keys; creativity is reachable', () => {
		assert.equal(AM.statForCompetency('komunikativni'), 'communication');
		assert.equal(AM.statForCompetency('komunikacia'), 'communication');
		assert.equal(AM.statForCompetency('k-uceni'), 'focus');
		assert.equal(AM.statForCompetency('ucenie'), 'focus');
		assert.equal(AM.statForCompetency('kulturna'), 'creativity');
		assert.equal(AM.statForCompetency('toString'), null, 'no prototype keys');
		assert.equal(AM.statForCompetency(42), null);
		const reachable = new Set([
			...Object.values(AM.UNIFIED_COMPETENCY_TO_STAT),
			...Object.values(AM.MODE_ATTRIBUTES).flatMap((m) => m.stats),
		]);
		for (const s of STAT_KEYS) assert.ok(reachable.has(s), `${s} reachable`);
	});

	it('splits XP deterministically and exactly across weighted stats', () => {
		const game = { mode: 'cooking', kompetence: ['k-uceni', 'pracovni'] };
		const a = AM.splitStatXp(100, game);
		assert.deepEqual(a, AM.splitStatXp(100, game));
		// weights: focus 2+1, strategy 2+1 → 50/50
		assert.equal(a.focus, 50);
		assert.equal(a.strategy, 50);
		assert.equal(a.motorika, 50, 'sub-tag mirrors its parent share');
		assert.equal(a.vyziva, 50);
		assert.equal(STAT_KEYS.reduce((s, k) => s + (a[k] || 0), 0), 100);
	});

	it('uses largest remainder with a stable tie-break and ignores extra / unknown keys', () => {
		const game = { mode: 'party', kompetence: ['k-uceni', 'bogus', 'k-uceni', 'obcanske', 'pracovni', 'digitalni'] };
		const out = AM.splitStatXp(10, game);
		// party: communication 2, creativity 2; then focus 1, resilience 1, strategy 1 (3 counted)
		assert.equal(out.insight, undefined, 'fourth competency not counted');
		assert.equal(STAT_KEYS.reduce((s, k) => s + (out[k] || 0), 0), 10);
		assert.deepEqual(out, { communication: 3, creativity: 3, focus: 2, resilience: 1, strategy: 1 });
	});

	it('returns nothing for a zero pool, or no known mode and competency', () => {
		assert.deepEqual(AM.splitStatXp(0, { mode: 'cooking' }), {});
		assert.deepEqual(AM.splitStatXp(50, { mode: 'nope', kompetence: ['x'] }), {});
	});

	it('manifest is a copy and the map is frozen', () => {
		const m = AM.getAttributeManifest();
		m.modes.cooking.stats.push('x');
		assert.deepEqual(AM.modeAttributes('cooking').stats, ['focus', 'strategy']);
		assert.throws(() => { AM.MODE_ATTRIBUTES.cooking.stats.push('x'); });
		assert.deepEqual(AM.STAT_XP_KEYS, [...STAT_KEYS, 'motorika', 'vyziva', 'digitalna']);
	});
});
