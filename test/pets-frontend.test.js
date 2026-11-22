'use strict';

/**
 * Phase 9 frontend: pet unlock thresholds and state machine, the performance
 * rules of pets.js (no rAF, no work while hidden), and the gIVEMEGOCHI
 * postMessage link (origin + source checks, milestones only).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const Pets = require('../public/js/pets.js');
const petsData = require('../public/data/pets.json');

describe('pet species data', () => {
	it('has 3-5 species with unique ids, rising unlock levels and valid sprites', () => {
		const sp = petsData.species;
		assert.ok(sp.length >= 3 && sp.length <= 5);
		assert.equal(new Set(sp.map((s) => s.id)).size, sp.length);
		for (let i = 1; i < sp.length; i++) assert.ok(sp[i].unlockLevel > sp[i - 1].unlockLevel);
		for (const s of sp) {
			assert.ok(s.unlockLevel >= 1 && s.unlockLevel <= 10);
			assert.equal(s.frames.length, 2);
			for (const rows of s.frames) {
				assert.equal(rows.length, petsData.grid, `${s.id} rows`);
				for (const row of rows) {
					assert.equal(row.length, petsData.grid, `${s.id} row ${row}`);
					for (const ch of row) assert.ok(ch === '.' || s.palette[ch], `${s.id} palette ${ch}`);
				}
			}
		}
	});
});

describe('unlock thresholds', () => {
	const sp = petsData.species;
	it('unlocks species exactly at their level', () => {
		assert.deepEqual(Pets.unlockedSpecies(sp, 1).map((s) => s.id), ['frog']);
		assert.deepEqual(Pets.unlockedSpecies(sp, 2).map((s) => s.id), ['frog']);
		assert.deepEqual(Pets.unlockedSpecies(sp, 3).map((s) => s.id), ['frog', 'cat']);
		assert.equal(Pets.unlockedSpecies(sp, 10).length, sp.length);
	});
	it('clamps bad levels (guests, NaN) to level 1', () => {
		assert.equal(Pets.clampLevel(undefined), 1);
		assert.equal(Pets.clampLevel(-4), 1);
		assert.equal(Pets.clampLevel(99), 10);
		assert.deepEqual(Pets.unlockedSpecies(sp, 'x').map((s) => s.id), ['frog']);
	});
	it('settings: off shows none, one shows a single pet, all caps at 3', () => {
		assert.deepEqual(Pets.visibleSpecies(sp, 10, { mode: 'off' }), []);
		assert.deepEqual(Pets.visibleSpecies(sp, 10, { mode: 'one', chosen: 'cat' }).map((s) => s.id), ['cat']);
		// a chosen pet that is still locked falls back to the newest unlocked one
		assert.deepEqual(Pets.visibleSpecies(sp, 3, { mode: 'one', chosen: 'dragon' }).map((s) => s.id), ['cat']);
		assert.equal(Pets.visibleSpecies(sp, 10, { mode: 'all' }).length, Pets.MAX_VISIBLE);
	});
	it('normalizes junk settings', () => {
		assert.deepEqual(Pets.normalizeSettings({ mode: 'x', quiet: 'yes', chosen: '<b>', seenLevel: 99 }),
			{ mode: 'all', quiet: false, chosen: null, seenLevel: 0 });
		assert.equal(Pets.normalizeSettings(null).mode, 'all');
	});
	it('language fallback: cs -> sk, everything else -> en', () => {
		assert.equal(Pets.langFile('sk'), 'sk');
		assert.equal(Pets.langFile('cs-CZ'), 'sk');
		for (const l of ['en', 'de', 'es', 'tr', '', undefined]) assert.equal(Pets.langFile(l), 'en');
	});
});

describe('pet state machine', () => {
	it('only moves between known states and returns bounded durations', () => {
		const states = new Set(['idle', 'walk', 'sleep', 'peek']);
		for (const cur of states) {
			for (let i = 0; i < 200; i++) {
				const n = Pets.pickNext(cur, Math.random);
				assert.ok(states.has(n.state));
				assert.ok(n.ticks >= 10 && n.ticks <= 150);
			}
		}
	});
	it('a sleeping pet always wakes to idle', () => {
		assert.equal(Pets.pickNext('sleep', () => 0.99).state, 'idle');
	});
	it('updates at most 5 times per second', () => {
		assert.ok(1000 / Pets.TICK_MS <= 5);
	});
});

describe('pets.js performance rules (static)', () => {
	const src = read('public/js/pets.js');
	it('has no requestAnimationFrame loop', () => {
		assert.ok(!/requestAnimationFrame/.test(src));
		assert.ok(!/setInterval/.test(src));
	});
	it('checks document.hidden and stops its timer when hidden', () => {
		assert.ok(/doc\.hidden/.test(src));
		assert.ok(/visibilitychange/.test(src));
	});
	it('is static under reduced motion and sleeps after inactivity', () => {
		assert.ok(/prefers-reduced-motion/.test(src));
		assert.ok(/INACTIVITY_MS/.test(src));
	});
	it('css: overlay takes no clicks, pets sit below the panels and the SMARTA dock', () => {
		const css = read('public/ui/px-pets.css');
		assert.match(css, /\.px-pets\s*\{[^}]*pointer-events:\s*none/);
		assert.match(css, /\.px-pet\s*\{[^}]*pointer-events:\s*auto/);
		const overlayZ = Number(css.match(/\.px-pets\s*\{[^}]*z-index:\s*(\d+)/)[1]);
		const panelZ = Number(css.match(/aside\.right-panel\s*\{[^}]*z-index:\s*(\d+)/)[1]);
		const smartaZ = Number(read('public/ui/px-smarta.css').match(/\.px-smarta\s*\{[^}]*z-index:\s*(\d+)/)[1]);
		assert.ok(overlayZ < panelZ, 'pets below side panels');
		assert.ok(overlayZ < smartaZ, 'pets below the SMARTA dock');
	});
	it('index.html loads the pet assets', () => {
		const html = read('public/index.html');
		assert.match(html, /px-pets\.css/);
		assert.match(html, /js\/pets\.js/);
	});
});

describe('Phase 9 review fixes', () => {
	const petsSrc = read('public/js/pets.js');
	const css = read('public/ui/px-pets.css');

	it('pets stay behind the left panel from 601px and behind the right panel from 1101px', () => {
		assert.match(css, /@media \(min-width: 601px\) \{\s*aside\.left-panel \{[^}]*z-index: 5/);
		assert.match(css, /@media \(min-width: 1101px\) \{\s*aside\.right-panel \{[^}]*z-index: 5/);
	});

	it('pet settings are reachable from the right panel even when all pets are off', () => {
		assert.match(read('public/index.html'), /id="pets-panel-settings"/);
		assert.match(petsSrc, /getElementById\('pets-panel-settings'\)/);
		assert.match(petsSrc, /function renderPanelSettings/);
	});

	it('the tip bubble is clamped between the side panels', () => {
		assert.match(petsSrc, /e\.min \+ 8/);
		assert.match(petsSrc, /e\.max - w - 8/);
	});
});

describe('pets are animals that hop, fly and can be picked up', () => {
	const src = read('public/js/pets.js');
	const css = read('public/ui/px-pets.css');
	it('no robot or slime; every species has a movement kind', () => {
		const ids = petsData.species.map((x) => x.id);
		assert.ok(!ids.includes('robot') && !ids.includes('slime'));
		for (const x of petsData.species) assert.ok(['walk', 'hop', 'fly'].includes(x.move), x.id);
		assert.ok(petsData.species.some((x) => x.move === 'fly'));
		assert.ok(petsData.species.some((x) => x.move === 'hop'));
	});
	it('drag: pointer capture, a drop falls onto a visible button or the floor, the click after a drag is ignored', () => {
		assert.match(src, /setPointerCapture/);
		assert.match(src, /function findPerch\(/);
		assert.match(src, /elementFromPoint/);
		assert.match(src, /if \(!p\.dragged\) onPetClick\(p\)/);
		assert.match(css, /\.px-pet \{ touch-action: none; \}/);
	});
	it('hop, fly and drag animations stop under reduced motion', () => {
		assert.match(css, /@keyframes px-pet-hop/);
		assert.match(css, /@keyframes px-pet-flap/);
		assert.match(css, /prefers-reduced-motion: reduce\) \{[^}]*\}\s*\.px-pet svg, \.px-pet\[data-state\] svg \{ animation: none !important; \}/);
	});
	it('the gIVEMEGOCHI tab holds the care panel instead of the iframe', () => {
		const html = read('public/index.html');
		assert.match(html, /id="pets-care"/);
		assert.doesNotMatch(html, /tamagochi-iframe|tamagochi-bridge/);
	});
});

describe('pet care (needs, poop, XP)', () => {
	const H = 3600 * 1000;
	const T0 = 1_700_000_000_000;
	it('needs fall over real time and poop appears every few hours', () => {
		const c = Pets.decayCare(Pets.defaultCare(T0), T0 + 10 * H);
		assert.ok(c.food < 80 && c.clean < 80 && c.fun < 80);
		assert.equal(c.poop, 2);
		assert.equal(c.gone, false);
	});
	it('a pet whose needs all reach zero leaves; recall halves its XP', () => {
		const c = Pets.decayCare({ ...Pets.defaultCare(T0), xp: 90 }, T0 + 200 * H);
		assert.equal(c.gone, true);
		assert.equal(Pets.moodOf(c), 0);
		const back = Pets.recall(c, T0 + 200 * H);
		assert.equal(back.gone, false);
		assert.equal(back.xp, 45);
	});
	it('care actions raise a need and give XP only when needed', () => {
		const hungry = { ...Pets.defaultCare(T0), food: 20 };
		const fed = Pets.applyCare(hungry, 'feed', T0);
		assert.equal(fed.ok, true);
		assert.equal(fed.care.food, 55);
		assert.equal(fed.care.xp, 2);
		const full = Pets.applyCare({ ...Pets.defaultCare(T0), food: 99 }, 'feed', T0);
		assert.equal(full.ok, false);
		assert.equal(full.care.xp, 0);
		assert.equal(Pets.applyCare(Pets.defaultCare(T0), 'scoop', T0).ok, false);
		assert.equal(Pets.applyCare(Pets.defaultCare(T0), 'hack', T0).ok, false);
	});
	it('riddles give pet XP; levels cap at 10', () => {
		assert.equal(Pets.addXp(Pets.defaultCare(T0), Pets.RIDDLE_XP).xp, 10);
		assert.equal(Pets.petLevel(0), 1);
		assert.equal(Pets.petLevel(Pets.XP_PER_LEVEL), 2);
		assert.equal(Pets.petLevel(99999), 10);
	});
	it('normalizeCare rejects junk and future timestamps', () => {
		const c = Pets.normalizeCare({ xp: -5, food: 900, poop: 99, t: T0 + H, gone: 'yes' }, T0);
		assert.deepEqual([c.xp, c.food, c.poop, c.t, c.gone], [0, 100, Pets.MAX_POOP, T0, false]);
	});
	it('urgentNeed picks the lowest need under 30, poop first', () => {
		assert.equal(Pets.urgentNeed({ ...Pets.defaultCare(T0), fun: 10, food: 20 }), 'fun');
		assert.equal(Pets.urgentNeed({ ...Pets.defaultCare(T0), poop: 2, food: 5 }), 'poop');
		assert.equal(Pets.urgentNeed(Pets.defaultCare(T0)), null);
	});
});
