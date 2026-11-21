'use strict';

// Phase 4 frontend: filter block options, i18n label parity with the shared
// presets, the age-band picker helpers, the fallback scorer and rvp.json.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const P = require('../lib/filter-presets');
const FilterBand = require('../public/js/filter-band.js');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const html = read('public/index.html');
const LANGS = ['sk', 'cs', 'en', 'de', 'es', 'tr'];
const i18n = Object.fromEntries(LANGS.map(l => [l, JSON.parse(read(`public/data/i18n/${l}.json`))]));

function selectBlock(id) {
	const m = html.match(new RegExp(`<select id="${id}"[\\s\\S]*?</select>`));
	assert.ok(m, `missing #${id}`);
	return m[0];
}
function optionValues(id) {
	return [...selectBlock(id).matchAll(/<option value="([^"]*)"/g)].map(m => m[1]);
}
const enDash = s => s.replace(/–/g, '-');

describe('filter block options match the shared presets', () => {
	it('squad select offers solo / pair / group / class', () => {
		assert.deepEqual(optionValues('filter-players'), ['', ...Object.keys(P.SQUAD_PRESETS)]);
	});

	it('duration select offers speedrun / classic / marathon', () => {
		assert.deepEqual(optionValues('filter-duration'), ['', ...Object.keys(P.DURATION_PRESETS)]);
	});

	it('age band select carries each band range in data attributes', () => {
		const block = selectBlock('filter-age-band');
		for (const [key, b] of Object.entries(P.AGE_BANDS)) {
			assert.ok(block.includes(`value="${key}" data-min="${b.min}" data-max="${b.max}"`), key);
		}
		assert.deepEqual(optionValues('filter-age-band'), ['', ...Object.keys(P.AGE_BANDS), 'custom']);
	});

	it('free age range is exactly 6-19 on both sides (no "16+" cap)', () => {
		const ages = Array.from({ length: 14 }, (_, i) => String(i + 6));
		assert.deepEqual(optionValues('filter-age-min'), ['', ...ages]);
		assert.deepEqual(optionValues('filter-age-max'), ['', ...ages]);
		assert.ok(!/16\+/.test(selectBlock('filter-age-max')));
	});

	it('loads filter-presets.js before game-data.js and wires the band picker', () => {
		const presets = html.indexOf('src="js/filter-presets.js');
		const band = html.indexOf('src="js/filter-band.js');
		assert.ok(presets > 0 && band > presets);
		assert.ok(presets < html.indexOf('src="js/game-data.js'));
	});

	it('every data-i18n key in the filter block exists in all six languages', () => {
		const block = html.slice(html.indexOf('id="filter-age-label"'), html.indexOf('src="js/filter-band.js'));
		const keys = [...new Set([...block.matchAll(/data-i18n="([^"]+)"/g)].map(m => m[1]))];
		assert.ok(keys.length >= 15);
		for (const lang of LANGS) for (const k of keys) assert.ok(typeof i18n[lang][k] === 'string' && i18n[lang][k], `${lang}.${k}`);
	});
});

describe('i18n label parity (labels show the real preset ranges)', () => {
	it('duration labels carry min-max in every language', () => {
		for (const lang of LANGS) {
			for (const [key, d] of Object.entries(P.DURATION_PRESETS)) {
				assert.ok(enDash(i18n[lang][`duration_${key}`]).includes(`${d.min}-${d.max}`), `${lang}.duration_${key}`);
			}
		}
	});

	it('squad labels carry the player count in every language', () => {
		for (const lang of LANGS) {
			for (const [key, s] of Object.entries(P.SQUAD_PRESETS)) {
				if (key === 'solo') continue; // existing key, not in every file
				const want = s.min === s.max ? `(${s.min})` : `${s.min}-${s.max}`;
				assert.ok(enDash(i18n[lang][`players_${key}`]).includes(want), `${lang}.players_${key}`);
			}
		}
	});

	it('age band labels carry the band range in every language', () => {
		for (const lang of LANGS) {
			for (const [key, b] of Object.entries(P.AGE_BANDS)) {
				const k = `age_band_${key.replace('-', '_')}`;
				assert.ok(enDash(i18n[lang][k]).startsWith(`${b.min}-${b.max}`), `${lang}.${k}`);
			}
		}
	});

	it('methodology badge label exists everywhere', () => {
		for (const lang of LANGS) assert.ok(i18n[lang].methodology_badge, lang);
	});
});

describe('age band picker helpers', () => {
	it('bandForRange maps ranges to presets, empty or custom', () => {
		assert.equal(FilterBand.bandForRange('15', '19', P.AGE_BANDS), '15-19');
		assert.equal(FilterBand.bandForRange('', '', P.AGE_BANDS), '');
		assert.equal(FilterBand.bandForRange('7', '12', P.AGE_BANDS), 'custom');
		assert.equal(FilterBand.bandForRange('9', '', P.AGE_BANDS), 'custom');
	});

	it('orderRange keeps min <= max, the edited side wins', () => {
		assert.deepEqual(FilterBand.orderRange('12', '9', 'min'), { min: '12', max: '12' });
		assert.deepEqual(FilterBand.orderRange('12', '9', 'max'), { min: '9', max: '9' });
		assert.deepEqual(FilterBand.orderRange('8', '', 'min'), { min: '8', max: '' });
	});
});

describe('fallback scorer uses the shared presets', () => {
	const sandbox = { window: {}, console, fetch: () => Promise.reject(new Error('no fetch')) };
	sandbox.self = sandbox.window;
	vm.createContext(sandbox);
	vm.runInContext(read('public/js/filter-presets.js'), sandbox);
	vm.runInContext(read('public/js/game-data.js'), sandbox);
	const { scoreMatch } = sandbox.window.GameData;
	const game = (players, minutes) => ({
		playerCount: { min: players[0], max: players[1] }, duration: { min: minutes[0], max: minutes[1] },
		ageRange: { min: 6, max: 19 }, mode: 'party'
	});

	it('pair prefers a 2-player game over a 20-player game', () => {
		assert.ok(scoreMatch(game([2, 2], [5, 10]), { players: 'pair' }) > scoreMatch(game([10, 20], [5, 10]), { players: 'pair' }));
	});

	it('speedrun prefers a 5-10 min game over a 45 min game', () => {
		assert.ok(scoreMatch(game([2, 6], [5, 10]), { duration: 'speedrun' }) > scoreMatch(game([2, 6], [40, 50]), { duration: 'speedrun' }));
	});

	it('solo is no longer ignored and legacy values still work', () => {
		assert.ok(scoreMatch(game([1, 1], [15, 25]), { players: 'solo' }) > scoreMatch(game([5, 10], [15, 25]), { players: 'solo' }));
		assert.ok(scoreMatch(game([3, 6], [30, 60]), { players: 'small', duration: 'long' }) >= 6);
	});
});

describe('rvp.json stupně include stredni', () => {
	const rvp = JSON.parse(read('public/data/rvp.json'));

	it('has prvni / druhy / stredni matching the presets', () => {
		assert.deepEqual(Object.keys(rvp.stupne), [...P.STUPNE]);
		assert.deepEqual(rvp.stupne.stredni.vek, { min: P.AGE_BANDS['15-19'].min, max: P.AGE_BANDS['15-19'].max });
	});
});

describe('methodology badge rendering', () => {
	const src = read('public/js/game-ui.js');
	const fn = src.slice(src.indexOf('function addMethodologyBadge'), src.indexOf('function addMeta'));

	it('renders AI text without innerHTML and uses the i18n label', () => {
		assert.ok(fn.length > 0);
		assert.ok(!fn.includes('innerHTML'));
		assert.ok(fn.includes('createTextNode'));
		assert.ok(fn.includes("_t('methodology_badge'"));
		assert.ok(src.includes('addMethodologyBadge(badges, game.methodology)'));
	});
});
