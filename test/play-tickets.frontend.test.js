'use strict';

// Phase 5 client wiring: ticket start on READY, solo reflection to the server,
// completion sends ticket_id, reward breakdown, RPG panel, HUD reload race.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { MODE_ATTRIBUTES } = require('../lib/attribute-map');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const script = read('public/script.js');

describe('script.js play ticket flow', () => {
	it('starts the ticket when the timer starts (solo only) and re-saves the running game', () => {
		assert.match(script, /Timer\.setOnStart\(\(\) => \{ startPlayTicket\(\)/);
		const fn = script.slice(script.indexOf('async function startPlayTicket'), script.indexOf('async function sendSoloReflection'));
		assert.match(fn, /isInSession/);
		assert.match(fn, /'\/api\/play\/start'/);
		assert.match(fn, /game_id: game\._savedId/);
		assert.match(fn, /ticket_id: game\._play_ticket/);
		assert.match(fn, /Timer\.persist\(\)/);
	});

	it('sends the solo reflection to the server before completing, then completes with ticket_id', () => {
		const flow = script.slice(script.indexOf('Timer.setOnComplete('), script.indexOf('// Photo verification'));
		const reflectAt = flow.indexOf('sendSoloReflection(ticketId');
		const completeAt = flow.indexOf("fetch('/api/profile/complete-solo'");
		assert.ok(reflectAt > 0 && completeAt > reflectAt);
		assert.match(flow, /bodyPayload\.ticket_id = ticketId/);
		assert.match(flow, /data\.participation_xp != null/);
		assert.match(flow, /completionErrorMessage\(data\)/);
		// xpBoost must be in scope where the server's answer is handled.
		assert.ok(flow.indexOf('const xpBoost') < flow.indexOf('try {\n\t\t\t\t\t\t\t// With a ticket'));
	});

	it('the reflection payload drops the private photo field and splits ratings from texts', () => {
		const fn = script.slice(script.indexOf('async function sendSoloReflection'), script.indexOf('function reflectionBonusMessage'));
		assert.match(fn, /k\.startsWith\('_'\)/);
		assert.match(fn, /\/api\/play\/\$\{encodeURIComponent\(ticketId\)\}\/reflect/);
	});
});

describe('reflection, game card and RPG panel', () => {
	it('solo reflection shows the +25 % bonus rule; session reflection does not', () => {
		const src = read('public/js/reflection.js');
		assert.match(src, /if \(!sessionCode\) \{\n\t\t\tconst hint = document\.createElement\('p'\);/);
		assert.match(src, /hint\.textContent = _t\('play_refl_hint'/);
	});

	it('game card shows participation / reflection XP and stat XP with textContent', () => {
		const src = read('public/js/game-ui.js');
		const fn = src.slice(src.indexOf('function updateGameCardStats'), src.indexOf('function renderRpgHudFromTalents'));
		assert.match(fn, /play_xp_participation/);
		assert.match(fn, /play_xp_reflection/);
		assert.match(fn, /stat_xp_gained/);
		assert.doesNotMatch(fn, /innerHTML/);
	});

	it('RPG panel loads /api/play/attributes and escapes every value', () => {
		const src = read('public/js/rpg-screen.js');
		const seg = src.slice(src.indexOf('// ─── Training from play'), src.indexOf('// ─── DOM wiring'));
		assert.match(seg, /fetch\('\/api\/play\/attributes'/);
		assert.match(seg, /rationale_key/);
		assert.match(seg, /title="\$\{_escq\(why\)\}"/);
		assert.doesNotMatch(seg, /\$\{_esc\(/, 'uses the quote-safe escaper');
	});

	it('every mode rationale has an i18n key whose Slovak text matches the server map', () => {
		const sk = JSON.parse(read('public/data/i18n/sk.json'));
		for (const m of Object.values(MODE_ATTRIBUTES)) assert.equal(sk[m.rationale_key], m.rationale);
	});
});

describe('timer onStart hook', () => {
	it('runs the start callback once when READY is pressed', () => {
		const els = {};
		const el = () => ({ style: {}, textContent: '', className: '', disabled: false });
		let calls = 0;
		const sb = {
			window: {}, console,
			document: { getElementById: (id) => els[id] || (els[id] = el()) },
			localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
			GameUI: { toast() {} },
			setInterval: () => 1, clearInterval() {},
			Date,
		};
		vm.createContext(sb);
		vm.runInContext(read('public/js/timer.js'), sb);
		const T = sb.window.Timer;
		T.setOnStart(() => { calls += 1; });
		T.setup({ max: 10 });
		T.start();
		T.start();
		assert.equal(calls, 1);
		assert.equal(typeof T.persist, 'function');
	});
});

describe('RpgTalents.load reload race', () => {
	it('a load during an in-flight load waits and returns fresh data, not the stale cache', async () => {
		let n = 0;
		const pending = [];
		const sb = {
			window: { supabaseClient: { auth: { getSession: async () => ({ data: { session: { access_token: 't' } } }) } } },
			document: { createElement: () => ({ textContent: '', innerHTML: '' }), addEventListener() {} },
			fetch: () => new Promise((resolve) => {
				const id = ++n;
				pending.push(() => resolve({ ok: true, json: async () => ({ version: id }) }));
			}),
			AbortController, setTimeout, clearTimeout, console, Promise,
		};
		vm.createContext(sb);
		vm.runInContext(read('public/js/rpg-talents.js'), sb);
		const R = sb.window.RpgTalents;
		const first = R.load();
		const second = R.load();
		const third = R.load();
		assert.equal(second, third, 'callers during one in-flight load share the follow-up');
		while (pending.length < 1) await new Promise((r) => setImmediate(r));
		pending.shift()();
		assert.equal((await first).version, 1);
		while (pending.length < 1) await new Promise((r) => setImmediate(r));
		pending.shift()();
		assert.equal((await second).version, 2, 'second caller gets data fetched after it asked');
	});
});
