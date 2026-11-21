'use strict';

/**
 * Phase 6b client checks: the Online mode button and its wiring, guest join,
 * the slow heartbeat poll that keeps running in every phase, and honest
 * reflection auth for guests.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

describe('Online mode wiring', () => {
	it('has a mode button inside the mode grid', () => {
		const html = read('public/index.html');
		const grid = html.slice(html.indexOf('id="mode-grid"'), html.indexOf('<!-- MAIN FILTERS -->'));
		assert.match(grid, /data-mode="online" onclick="App\.setMode\('online'\)"/);
		assert.match(grid, /data-i18n="mode_online"/);
		assert.match(html, /data-i18n="help_mode_online"/);
	});

	it('the client accepts the mode and both filter-preset copies stay identical', () => {
		assert.match(read('public/script.js'), /const MODES = \[[^\]]*'online'[^\]]*\]/);
		assert.equal(read('public/js/filter-presets.js'), read('lib/filter-presets.js'));
		const FilterPresets = require('../lib/filter-presets');
		assert.equal(FilterPresets.isMode('online'), true);
	});

	it('the game prompt asks for remote-safe mechanics in online mode', () => {
		const src = read('lib/game-prompt.js');
		assert.match(src, /online: 'THEME: Online \/ remote game/);
		assert.match(src, /remote-safe/);
	});

	it('has translations in all six languages', () => {
		for (const lang of ['sk', 'cs', 'en', 'de', 'es', 'tr']) {
			const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/i18n', `${lang}.json`), 'utf8'));
			for (const key of ['mode_online', 'help_mode_online', 'sess_guest_hint', 'sess_style_online', 'sess_max_label']) {
				assert.ok(dict[key], `${lang}:${key}`);
			}
		}
	});
});

function makeContext({ fetchImpl, timeouts }) {
	const store = new Map();
	const elements = new Map();
	const makeElement = () => ({
		hidden: false, className: '', innerHTML: '', style: {}, children: [],
		addEventListener() {}, focus() {}, contains: () => false, querySelectorAll: () => [],
	});
	const document = {
		body: {
			children: [],
			classList: { toggle() {}, remove() {} },
			appendChild(el) { if (el.id) elements.set(el.id, el); },
		},
		createElement: makeElement,
		getElementById: (id) => elements.get(id) || null,
	};
	return vm.createContext({
		window: { location: { origin: 'https://example.test', search: '', pathname: '/', hash: '' } },
		document,
		localStorage: {
			getItem: (k) => store.get(k) ?? null,
			setItem: (k, v) => store.set(k, String(v)),
			removeItem: (k) => store.delete(k),
		},
		sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
		GameUI: { toast() {} },
		setTimeout: (cb, ms) => { if (ms >= 10000) timeouts.push({ cb, ms }); return timeouts.length; },
		clearTimeout() {},
		setInterval: () => 1,
		clearInterval() {},
		URLSearchParams,
		AbortController,
		fetch: fetchImpl,
		_store: store,
	});
}

describe('guest join and the slow poll', () => {
	it('a guest joins with a nickname, keeps the token, and polls with a heartbeat', async () => {
		const calls = [];
		const timeouts = [];
		const fetchImpl = async (url, opts = {}) => {
			calls.push({ url, opts });
			if (url.endsWith('/join-guest')) {
				return { ok: true, status: 200, json: async () => ({ ok: true, session_id: 's1', role: 'guest', guest_token: 'tok_abcdefghijklmnopqrstuv', status: 'waiting' }) };
			}
			if (url.endsWith('/heartbeat')) {
				return { ok: true, status: 200, json: async () => ({ ok: true, status: 'waiting', my_role: 'guest' }) };
			}
			return { ok: true, status: 200, json: async () => ({ status: 'waiting', my_role: 'guest', participants: [] }) };
		};
		const ctx = makeContext({ fetchImpl, timeouts });
		vm.runInContext(read('public/js/session.js'), ctx, { filename: 'session.js' });

		await ctx.window.Session.join('ab12cd', { nickname: 'Miško' });
		const joinCall = calls.find((c) => c.url === '/api/sessions/AB12CD/join-guest');
		assert.ok(joinCall, 'guest join route used without an account');
		assert.deepEqual(JSON.parse(joinCall.opts.body), { nickname: 'Miško' });
		assert.deepEqual({ ...(await ctx.window.Session.authHeaders()) }, { 'X-Guest-Token': 'tok_abcdefghijklmnopqrstuv' });
		assert.match(ctx._store.get('givemegame_active_session'), /"guestToken":"tok_abcdefghijklmnopqrstuv"/);

		const slow = timeouts.find((t) => t.ms === 10000);
		assert.ok(slow, 'slow poll scheduled');
		await slow.cb();
		const hb = calls.find((c) => c.url === '/api/sessions/AB12CD/heartbeat');
		assert.ok(hb);
		assert.equal(hb.opts.headers['X-Guest-Token'], 'tok_abcdefghijklmnopqrstuv');
		assert.ok(timeouts.filter((t) => t.ms === 10000).length >= 2, 'the slow poll reschedules itself');
	});

	it('without an account or nickname the join asks for one and calls nothing', async () => {
		const calls = [];
		const ctx = makeContext({ fetchImpl: async (url) => { calls.push(url); return { ok: true, json: async () => ({}) }; }, timeouts: [] });
		vm.runInContext(read('public/js/session.js'), ctx, { filename: 'session.js' });
		await ctx.window.Session.join('AB12CD');
		assert.deepEqual(calls, []);
	});

	it('the active phase keeps the slow poll (M10) and opens reflection when time is up', () => {
		const src = read('public/js/session.js');
		const onActive = src.slice(src.indexOf('function _onActive('), src.indexOf('function _onReflection('));
		assert.doesNotMatch(onActive, /_stopSlowPoll\(\)/);
		assert.match(onActive, /if \(!\(secLeft > 0\)\) \{\s*_onReflection\(session\);/);
		assert.match(src, /document\.addEventListener\('visibilitychange', _onVisibility\)/);
		assert.match(src, /navigator\.wakeLock\.request\('screen'\)/);
	});

	it('reflection uses the session auth headers so guests can submit', () => {
		const src = read('public/js/reflection.js');
		assert.match(src, /window\.Session\.authHeaders\(\)/);
		assert.match(src, /headers: \{ 'Content-Type': 'application\/json', \.\.\.authH \}/);
	});

	it('every dynamic name in the lobby is escaped', () => {
		const src = read('public/js/session.js');
		const render = src.slice(src.indexOf('function _renderParticipants('), src.indexOf('function _closeLobby('));
		assert.match(render, /esc\(p\.display_name \|\| nameFb\)/);
		assert.doesNotMatch(render, /\$\{p\.display_name/);
	});
});
