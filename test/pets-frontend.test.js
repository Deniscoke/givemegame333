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
const Bridge = require('../public/js/tamagochi-bridge.js');
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
		assert.deepEqual(Pets.unlockedSpecies(sp, 1).map((s) => s.id), ['slime']);
		assert.deepEqual(Pets.unlockedSpecies(sp, 2).map((s) => s.id), ['slime']);
		assert.deepEqual(Pets.unlockedSpecies(sp, 3).map((s) => s.id), ['slime', 'cat']);
		assert.equal(Pets.unlockedSpecies(sp, 10).length, sp.length);
	});
	it('clamps bad levels (guests, NaN) to level 1', () => {
		assert.equal(Pets.clampLevel(undefined), 1);
		assert.equal(Pets.clampLevel(-4), 1);
		assert.equal(Pets.clampLevel(99), 10);
		assert.deepEqual(Pets.unlockedSpecies(sp, 'x').map((s) => s.id), ['slime']);
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

describe('gIVEMEGOCHI postMessage link', () => {
	const ORIGIN = 'https://givemegame.test';
	const frameWin = {};
	const iframe = { contentWindow: frameWin };
	const ev = (over) => ({ origin: ORIGIN, source: frameWin, data: { type: 'tamagochi_coin', action: 'levelup' }, ...over });

	it('rejects a foreign origin, a foreign source and a missing iframe', () => {
		assert.equal(Bridge.isTrustedMessage(ev(), frameWin, ORIGIN), true);
		assert.equal(Bridge.isTrustedMessage(ev({ origin: 'https://evil.test' }), frameWin, ORIGIN), false);
		assert.equal(Bridge.isTrustedMessage(ev({ origin: 'null' }), frameWin, ORIGIN), false);
		assert.equal(Bridge.isTrustedMessage(ev({ source: {} }), frameWin, ORIGIN), false);
		assert.equal(Bridge.isTrustedMessage(ev(), null, ORIGIN), false);
		assert.equal(Bridge.isTrustedMessage(ev(), frameWin, 'null'), false);
	});

	function handler(now) {
		const awards = [];
		const h = Bridge.createMessageHandler({ getIframe: () => iframe, origin: ORIGIN, award: (s) => awards.push(s), now });
		return { h, awards };
	}

	it('awards only for milestones from the trusted iframe', () => {
		let t = 0;
		const { h, awards } = handler(() => t);
		assert.equal(h(ev({ origin: 'https://evil.test' })), false);
		assert.equal(h(ev({ source: {} })), false);
		assert.equal(h(ev({ data: { type: 'tamagochi_coin', action: 'tap' } })), false);
		assert.equal(h(ev({ data: { type: 'tamagochi_coin' } })), false);
		assert.equal(h(ev({ data: { type: 'other', action: 'levelup' } })), false);
		assert.deepEqual(awards, []);
		assert.equal(h(ev()), true);
		assert.deepEqual(awards, ['tamagochi_coin']);
	});

	it('limits a runaway child to one milestone per 2 seconds', () => {
		let t = 10000;
		const { h, awards } = handler(() => t);
		assert.equal(h(ev()), true);
		t += 500;
		assert.equal(h(ev({ data: { type: 'tamagochi_coin', action: 'minigame' } })), false);
		t += Bridge.MIN_GAP_MS;
		assert.equal(h(ev({ data: { type: 'tamagochi_coin', action: 'minigame' } })), true);
		assert.equal(awards.length, 2);
	});

	it('answers pet_requestSync only for the trusted iframe', () => {
		let synced = 0;
		const h = Bridge.createMessageHandler({ getIframe: () => iframe, origin: ORIGIN, award() {}, sync: () => { synced++; } });
		h(ev({ origin: 'https://evil.test', data: { type: 'pet_requestSync' } }));
		assert.equal(synced, 0);
		h(ev({ data: { type: 'pet_requestSync' } }));
		assert.equal(synced, 1);
	});

	it('buildSync sanitizes the user and level', () => {
		const m = Bridge.buildSync({ user: { uid: 'abc-123', name: '<img onerror=x> Eva' }, rpgLevel: 99, avatarId: '../x' });
		assert.equal(m.type, 'pet_syncUser');
		assert.equal(m.rpgLevel, 10);
		assert.equal(m.avatarId, null);
		assert.ok(!/[<>=]/.test(m.user.name));
		assert.equal(Bridge.buildSync({ user: null, rpgLevel: 0, avatarId: null }).user, null);
		assert.equal(Bridge.buildSync({ user: { uid: 'guest!' }, rpgLevel: 3 }).user, null);
	});

	it('the child posts to its exact origin, awards on milestones only, and filters incoming messages', () => {
		const html = read('public/tamagochi/index.html');
		assert.ok(!/postMessage\([^)]*'\*'/.test(html), 'no wildcard targetOrigin');
		assert.match(html, /postMessage\(\{ type: 'tamagochi_coin', action \}, location\.origin\)/);
		assert.match(html, /event\.origin !== location\.origin \|\| event\.source !== window\.parent/);
		assert.ok(!/notifyParentCoin/.test(html), 'no per-tap coin');
		assert.equal((html.match(/notifyParentMilestone\('/g) || []).length, 2);
		assert.ok(!/tailwind/i.test(html), 'Tailwind CDN removed');
		assert.match(html, /givemegochi_pet_v1_/);
	});

	it('the parent page no longer trusts a bare window message for coins', () => {
		const script = read('public/script.js');
		assert.ok(!/type === 'tamagochi_coin'/.test(script));
		const html = read('public/index.html');
		assert.match(html, /<iframe id="tamagochi-iframe"[^>]*tamagochi\/index\.html\?embed=1/);
		assert.match(html, /tamagochi-fullscreen[^>]*target="_blank"|target="_blank"[^>]*tamagochi-fullscreen/);
	});
});

describe('Phase 9 review fixes', () => {
	const tama = read('public/tamagochi/index.html');
	const petsSrc = read('public/js/pets.js');
	const css = read('public/ui/px-pets.css');

	it('tamagochi: no decay and no save while hidden or off screen; reload when visible again', () => {
		assert.match(tama, /function gameTick\(\) \{\n\s*if \(unattended\(\)\) return;/);
		assert.match(tama, /function unattended\(\) \{ return document\.hidden \|\| !inView; \}/);
		assert.match(tama, /function savePet\(force\) \{\n\s*if \(!force && unattended\(\)\) return;/);
		assert.match(tama, /addEventListener\('storage'/);
		assert.match(tama, /function reloadPet\(\)/);
		assert.match(tama, /else reloadPet\(\)/);
	});

	it('tamagochi: the full-screen tab reads ?uid= with the same validation as the sync', () => {
		assert.match(tama, /URLSearchParams\(location\.search\)\.get\('uid'\)/);
		assert.match(tama, /UID_RE\.test\(urlUid\)/);
		assert.equal(Bridge.fullScreenHref('abc-123'), 'tamagochi/index.html?uid=abc-123');
		assert.equal(Bridge.fullScreenHref(null), 'tamagochi/index.html');
		assert.equal(Bridge.fullScreenHref('a b&x=1'), 'tamagochi/index.html');
	});

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
