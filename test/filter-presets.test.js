'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const P = require('../lib/filter-presets');
const { enforceConstraints } = require('../lib/game-prompt');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

describe('filter-presets: ranges (product decisions)', () => {
	it('duration presets: speedrun 5-10, classic 15-25, marathon 30-60', () => {
		assert.deepEqual(
			Object.fromEntries(Object.entries(P.DURATION_PRESETS).map(([k, v]) => [k, [v.min, v.max]])),
			{ speedrun: [5, 10], classic: [15, 25], marathon: [30, 60] }
		);
	});

	it('squad presets: solo 1, pair 2, group 3-6, class 15-30', () => {
		assert.deepEqual(
			Object.fromEntries(Object.entries(P.SQUAD_PRESETS).map(([k, v]) => [k, [v.min, v.max]])),
			{ solo: [1, 1], pair: [2, 2], group: [3, 6], class: [15, 30] }
		);
	});

	it('age bands 6-8, 8-11, 11-15, 15-19 inside the 6-19 limits', () => {
		assert.deepEqual(Object.keys(P.AGE_BANDS), ['6-8', '8-11', '11-15', '15-19']);
		for (const [key, b] of Object.entries(P.AGE_BANDS)) {
			assert.equal(key, `${b.min}-${b.max}`);
			assert.ok(b.min >= P.AGE_LIMITS.min && b.max <= P.AGE_LIMITS.max);
			assert.ok(P.STUPNE.includes(b.stupen));
		}
		assert.deepEqual(P.AGE_LIMITS, { min: 6, max: 19 });
	});

	it('every preset has min <= max and a label carrying its numbers', () => {
		for (const table of [P.DURATION_PRESETS, P.SQUAD_PRESETS]) {
			for (const v of Object.values(table)) {
				assert.ok(v.min <= v.max);
				assert.ok(v.label.includes(String(v.max)), v.label);
			}
		}
	});

	it('online is a mode (data only)', () => {
		assert.ok(P.MODES.includes('online'));
		assert.equal(P.isMode('online'), true);
		assert.equal(P.isMode('robot'), false);
	});
});

describe('filter-presets: helpers', () => {
	it('resolves legacy keys and rejects unknown ones', () => {
		assert.equal(P.resolveDurationKey('quick'), 'speedrun');
		assert.equal(P.resolveDurationKey('marathon'), 'marathon');
		assert.equal(P.resolveDurationKey('toString'), null);
		assert.equal(P.resolveSquadKey('large'), 'class');
		assert.equal(P.resolveSquadKey('pair'), 'pair');
		assert.equal(P.resolveSquadKey('__proto__'), null);
		assert.equal(P.getSquad('nope'), null);
	});

	it('normalizeAgeRange clamps, fills and swaps', () => {
		assert.equal(P.normalizeAgeRange('', undefined), null);
		assert.deepEqual(P.normalizeAgeRange('12', '9'), { min: 9, max: 12 });
		assert.deepEqual(P.normalizeAgeRange(2, 40), { min: 6, max: 19 });
		assert.deepEqual(P.normalizeAgeRange('16', ''), { min: 16, max: 19 });
		assert.deepEqual(P.normalizeAgeRange(null, '7'), { min: 6, max: 7 });
		assert.equal(P.clampAge('abc'), null);
	});

	it('stupenForAge maps bands to prvni / druhy / stredni', () => {
		for (const b of Object.values(P.AGE_BANDS)) {
			assert.equal(P.stupenForAge(b.min, b.max), b.stupen);
		}
		assert.equal(P.matchAgeBand(15, 19), '15-19');
		assert.equal(P.matchAgeBand(7, 9), null);
	});
});

describe('filter-presets: enforceConstraints with every preset', () => {
	const baseGame = () => ({
		playerCount: { min: 1, max: 99 }, duration: { min: 1, max: 120 }, ageRange: { min: 3, max: 99 },
		setting: 'any', energyLevel: 'medium', mode: 'party', rvp: { stupen: 'druhy' }
	});

	for (const [key, d] of Object.entries(P.DURATION_PRESETS)) {
		it(`duration ${key} → ${d.min}-${d.max}`, () => {
			const g = enforceConstraints(baseGame(), { duration: key });
			assert.deepEqual(g.duration, { min: d.min, max: d.max });
		});
	}
	for (const [key, s] of Object.entries(P.SQUAD_PRESETS)) {
		it(`squad ${key} → ${s.min}-${s.max}`, () => {
			const g = enforceConstraints(baseGame(), { players: key });
			assert.deepEqual(g.playerCount, { min: s.min, max: s.max });
		});
	}
	for (const [key, b] of Object.entries(P.AGE_BANDS)) {
		it(`age band ${key} → ageRange ${b.min}-${b.max}, stupen ${b.stupen}`, () => {
			const g = enforceConstraints(baseGame(), { ageMin: String(b.min), ageMax: String(b.max) });
			assert.deepEqual(g.ageRange, { min: b.min, max: b.max });
			assert.equal(g.rvp.stupen, b.stupen);
		});
	}

	it('acceptance: speedrun + 15-19 + pair', () => {
		const g = enforceConstraints(baseGame(), { duration: 'speedrun', ageMin: '15', ageMax: '19', players: 'pair', mode: 'classroom' });
		assert.ok(g.duration.max <= 10);
		assert.deepEqual(g.ageRange, { min: 15, max: 19 });
		assert.deepEqual(g.playerCount, { min: 2, max: 2 });
		assert.equal(g.rvp.stupen, 'stredni');
		assert.equal(g.mode, 'classroom');
	});

	it('explicit stupen filter wins over the age-derived one', () => {
		const g = enforceConstraints(baseGame(), { stupen: 'prvni', ageMin: '15', ageMax: '19' });
		assert.equal(g.rvp.stupen, 'prvni');
	});

	it('drops invented stupen values and creates rvp when missing', () => {
		const g1 = enforceConstraints({ rvp: { stupen: 'treti' } }, {});
		assert.equal(g1.rvp.stupen, undefined);
		const g2 = enforceConstraints({ rvp: { stupen: ['prvni', 'x'] } }, {});
		assert.deepEqual(g2.rvp.stupen, ['prvni']);
		const g3 = enforceConstraints({}, { ageMin: '6', ageMax: '8' });
		assert.equal(g3.rvp.stupen, 'prvni');
	});

	it('circus activity solo/pair applies only without a squad preset', () => {
		assert.deepEqual(enforceConstraints(baseGame(), { activity: 'pair' }).playerCount, { min: 2, max: 2 });
		assert.deepEqual(enforceConstraints(baseGame(), { activity: 'solo', players: 'group' }).playerCount, { min: 3, max: 6 });
	});

	it('ignores non-object games', () => {
		assert.equal(enforceConstraints(null, { players: 'pair' }), null);
		assert.deepEqual(enforceConstraints([], { players: 'pair' }), []);
	});
});

describe('filter-presets: browser copy stays in sync', () => {
	it('public/js/filter-presets.js equals lib/filter-presets.js', () => {
		assert.equal(read('public/js/filter-presets.js'), read('lib/filter-presets.js'));
	});

	it('the browser copy registers window.FilterPresets', () => {
		const vm = require('vm');
		const sandbox = { self: {} };
		vm.runInNewContext(read('public/js/filter-presets.js'), sandbox);
		assert.deepEqual(Object.keys(sandbox.self.FilterPresets.SQUAD_PRESETS), ['solo', 'pair', 'group', 'class']);
	});
});
