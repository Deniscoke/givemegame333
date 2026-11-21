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
		const fn = script.slice(script.indexOf('async function _playStartOnce'), script.indexOf('async function sendSoloReflection'));
		assert.match(fn, /isInSession/);
		assert.match(fn, /'\/api\/play\/start'/);
		assert.match(fn, /game_id: game\._savedId/);
		assert.match(fn, /ticket_id: generatedTicket/);
		assert.match(fn, /local: true/);
		assert.match(fn, /Timer\.persist\(\)/);
	});

	it('completion sends only a ticket the server confirmed as started', () => {
		const flow = script.slice(script.indexOf('Timer.setOnComplete('), script.indexOf('// Photo verification'));
		assert.match(flow, /const ticketId = playTicketForCompletion\(window\.currentGame\)/);
	});
});

/** Runs startPlayTicket from script.js against a scripted fetch. */
function loadPlayTicketFns({ token = 'tok', responses = [] } = {}) {
	const src = script.slice(script.indexOf('async function _playToken'), script.indexOf('async function sendSoloReflection'));
	const calls = [];
	const queue = [...responses];
	let persisted = 0;
	const window = { Session: { isInSession: () => false }, Timer: { persist: () => { persisted++; } } };
	const ctx = {
		window,
		Timer: window.Timer,
		supabaseClient: { auth: { getSession: async () => ({ data: { session: token ? { access_token: token } : null } }) } },
		withTimeout: (p) => p,
		AbortController,
		setTimeout,
		clearTimeout,
		fetch: async (url, opts) => {
			calls.push({ url, body: JSON.parse(opts.body) });
			const next = queue.shift();
			if (!next || next === 'throw') throw new Error('network down');
			return { ok: next.status === 200, status: next.status, json: async () => next.body || {} };
		},
	};
	vm.createContext(ctx);
	vm.runInContext(`${src}\nthis.startPlayTicket = startPlayTicket; this.playTicketForCompletion = playTicketForCompletion;`, ctx);
	return { ctx, window, calls, persisted: () => persisted };
}

describe('startPlayTicket behaviour', () => {
	const NEW_ID = '6f1c2b8e-1b2c-4d5e-8f90-123456789abc';

	it('a confirmed start marks the ticket as started', async () => {
		const t = loadPlayTicketFns({ responses: [{ status: 200, body: { ticket_id: 'gen-1' } }] });
		const game = { title: 'A', _play_ticket: 'gen-1' };
		t.window.currentGame = game;
		await t.ctx.startPlayTicket();
		assert.deepEqual(t.calls.map((c) => c.body), [{ ticket_id: 'gen-1' }]);
		assert.equal(t.ctx.playTicketForCompletion(game), 'gen-1');
		assert.equal(t.persisted(), 1);
	});

	it('a network error is retried once; if both fail nothing counts as started', async () => {
		const t = loadPlayTicketFns({ responses: ['throw', 'throw'] });
		const game = { title: 'A', _play_ticket: 'gen-1' };
		t.window.currentGame = game;
		await t.ctx.startPlayTicket();
		assert.equal(t.calls.length, 2);
		assert.equal(t.ctx.playTicketForCompletion(game), null, 'complete-solo will not send an unstarted ticket');

		const retry = loadPlayTicketFns({ responses: ['throw', { status: 200, body: { ticket_id: 'gen-1' } }] });
		const g2 = { title: 'A', _play_ticket: 'gen-1' };
		retry.window.currentGame = g2;
		await retry.ctx.startPlayTicket();
		assert.equal(retry.ctx.playTicketForCompletion(g2), 'gen-1');
	});

	it('without a token nothing is started or sent', async () => {
		const t = loadPlayTicketFns({ token: null });
		const game = { title: 'A', _play_ticket: 'gen-1', _play_ticket_started: true };
		t.window.currentGame = game;
		await t.ctx.startPlayTicket();
		assert.equal(t.calls.length, 0);
		assert.equal(t.ctx.playTicketForCompletion(game), null);
	});

	it('a library game drops the old ticket id from its saved copy, even when the start fails', async () => {
		const t = loadPlayTicketFns({ responses: [{ status: 429, body: { code: 'TICKET_DAILY_LIMIT' } }] });
		const game = { title: 'A', _savedId: 'saved-1', _play_ticket: 'old-used', _play_ticket_started: true };
		t.window.currentGame = game;
		await t.ctx.startPlayTicket();
		assert.deepEqual(t.calls.map((c) => c.body), [{ game_id: 'saved-1' }]);
		assert.equal(game._play_ticket, undefined);
		assert.equal(t.ctx.playTicketForCompletion(game), null);
	});

	it('a game without a server copy starts a local ticket; a lost generated ticket falls back to one', async () => {
		const t = loadPlayTicketFns({ responses: [{ status: 200, body: { ticket_id: NEW_ID } }] });
		const local = { title: 'Záložná hra' };
		t.window.currentGame = local;
		await t.ctx.startPlayTicket();
		assert.deepEqual(t.calls.map((c) => c.body), [{ local: true, title: 'Záložná hra' }]);
		assert.equal(t.ctx.playTicketForCompletion(local), NEW_ID);

		const lost = loadPlayTicketFns({ responses: [{ status: 404 }, { status: 200, body: { ticket_id: NEW_ID } }] });
		const g = { title: 'B', _play_ticket: 'gone' };
		lost.window.currentGame = g;
		await lost.ctx.startPlayTicket();
		assert.deepEqual(lost.calls.map((c) => c.body), [{ ticket_id: 'gone' }, { local: true, title: 'B' }]);
		assert.equal(lost.ctx.playTicketForCompletion(g), NEW_ID);
	});

	it('a used generated ticket is not replaced by a local one', async () => {
		const t = loadPlayTicketFns({ responses: [{ status: 409, body: { code: 'TICKET_USED' } }] });
		const game = { title: 'A', _play_ticket: 'gen-1' };
		t.window.currentGame = game;
		await t.ctx.startPlayTicket();
		assert.equal(t.calls.length, 1);
		assert.equal(t.ctx.playTicketForCompletion(game), null);
	});
});

describe('script.js play ticket flow (completion)', () => {

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
			fetch: null,
			AbortController, setTimeout, clearTimeout, console, Promise,
		};
		sb.window.fetch = () => new Promise((resolve) => {
			const id = ++n;
			pending.push(() => resolve({ ok: true, status: 200, json: async () => ({ version: id }) }));
		});
		vm.createContext(sb);
		vm.runInContext(read('public/js/rpg-net.js'), sb);
		vm.runInContext(read('public/js/rpg-talents.js'), sb);
		const R = sb.window.RpgTalents;
		const firstR = R.loadResult();
		const secondR = R.loadResult();
		const thirdR = R.loadResult();
		assert.equal(secondR, thirdR, 'callers during one in-flight load share the follow-up');
		const first = firstR.then((r) => r.data);
		const second = secondR.then((r) => r.data);
		while (pending.length < 1) await new Promise((r) => setImmediate(r));
		pending.shift()();
		assert.equal((await first).version, 1);
		while (pending.length < 1) await new Promise((r) => setImmediate(r));
		pending.shift()();
		assert.equal((await second).version, 2, 'second caller gets data fetched after it asked');
	});
});
