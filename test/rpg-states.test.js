'use strict';

/**
 * RPG profile states (docs/redesign/PLAN.md phase 3):
 *   5xx / timeout / no network → "Server nedostupný" + "Skúsiť znova"
 *   401 / no session           → "Prihlás sa"
 *   "Nie si členom školy"      → only from the server flag is_school_member:false
 * plus the server side of that flag (lib/rpg-membership.js) and M13.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const { rpgMembershipFields, rpgDisplayClassId } = require('../lib/rpg-membership');
const sk = JSON.parse(read('public/data/i18n/sk.json'));

// ─── minimal DOM ────────────────────────────────────────────────────
function makeEl(id) {
	const el = {
		id, style: {}, hidden: false, dataset: {}, listeners: {},
		_html: '', buttons: {},
		classList: { set: new Set(), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, toggle(c, on) { (on ? this.add(c) : this.remove(c)); }, contains(c) { return this.set.has(c); } },
		addEventListener(type, fn) { (el.listeners[type] ||= []).push(fn); },
		focus() {},
		querySelectorAll() { return []; },
		querySelector(sel) {
			const m = /data-rpg-action="(\w+)"/.exec(sel);
			if (m && el._html.includes(`data-rpg-action="${m[1]}"`)) {
				return (el.buttons[m[1]] ||= { listeners: [], addEventListener(t, fn) { this.listeners.push(fn); }, click() { this.listeners.forEach((f) => f()); } });
			}
			if (sel === '[data-rpg-avatar-state]' && el._html.includes('data-rpg-avatar-state')) return (el.child ||= makeEl('avatar-state'));
			return null;
		},
	};
	Object.defineProperty(el, 'innerHTML', { get() { return el._html; }, set(v) { el._html = String(v); el.buttons = {}; } });
	// like the DOM: setting textContent makes innerHTML the escaped text (used by _esc helpers)
	let text = '';
	Object.defineProperty(el, 'textContent', { get() { return text; }, set(v) { text = v == null ? '' : String(v); el._html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); } });
	return el;
}

function makeContext({ responses = [], session = 'tok', ids = [] } = {}) {
	const els = new Map(ids.map((id) => [id, makeEl(id)]));
	const calls = [];
	const ctx = {
		console,
		setTimeout, clearTimeout, AbortController, Promise,
		document: {
			body: { style: {}, dataset: {} },
			getElementById: (id) => els.get(id) || null,
			querySelectorAll: () => [],
			createElement: () => makeEl('tmp'),
			addEventListener() {},
		},
		supabaseClient: session === undefined ? undefined : {
			auth: {
				getSession: () => (session instanceof Error ? Promise.reject(session) : Promise.resolve({ data: { session: session ? { access_token: session } : null } })),
			},
		},
		fetch: async (url, opts) => {
			calls.push({ url, opts });
			const r = responses.length > 1 ? responses.shift() : responses[0];
			if (r instanceof Error) throw r;
			return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body };
		},
	};
	ctx.window = ctx;
	vm.createContext(ctx);
	return { ctx, els, calls };
}

function load(ctx, files) {
	for (const f of files) vm.runInContext(`${read(f)}\n;this.RpgTalents = typeof RpgTalents !== 'undefined' ? RpgTalents : this.RpgTalents;
this.RpgAvatar = typeof RpgAvatar !== 'undefined' ? RpgAvatar : this.RpgAvatar;
this.RpgScreen = typeof RpgScreen !== 'undefined' ? RpgScreen : this.RpgScreen;`, ctx, { filename: f });
}

const MEMBER = { eligible: true, is_school_member: true, membership: { role: 'student', school_name: 'ZŠ Lipa' }, role: 'student', school_name: 'ZŠ Lipa', class_id: 7, coins: 120, talents: [], unlocked: [], avatar_meta: { label: 'Sage', theme: 'sage', flavor: 'x' } };
const NON_MEMBER = { ...MEMBER, is_school_member: false, membership: null, role: 'player', school_name: null };

// ─── server helpers ─────────────────────────────────────────────────
describe('server: membership flag', () => {
	test('rpgMembershipFields sends an explicit flag', () => {
		assert.deepEqual(rpgMembershipFields({ role: 'teacher', school_name: 'ZŠ' }), {
			is_school_member: true, membership: { role: 'teacher', school_name: 'ZŠ' }, role: 'teacher', school_name: 'ZŠ',
		});
		for (const none of [null, undefined, {}]) {
			assert.deepEqual(rpgMembershipFields(none), { is_school_member: false, membership: null, role: 'player', school_name: null });
		}
	});

	test('rpgDisplayClassId shows an owned avatar to everyone (M13)', () => {
		assert.equal(rpgDisplayClassId({ rpg_avatar_id: 7 }), 7);
		assert.equal(rpgDisplayClassId({ rpg_avatar_id: '3' }), 3);
		for (const v of [null, undefined, '', 0, -1, 'x', 2.5]) assert.equal(rpgDisplayClassId({ rpg_avatar_id: v }), null, String(v));
		assert.equal(rpgDisplayClassId(null), null);
	});

	test('both GET routes use the helpers; unlock keeps its 403 gate', () => {
		const server = read('server.js');
		const avatar = server.slice(server.indexOf("app.get('/api/rpg/avatar'"), server.indexOf("app.patch('/api/rpg/avatar'"));
		const talents = server.slice(server.indexOf("app.get('/api/rpg/talents'"), server.indexOf("app.post('/api/rpg/talents/unlock'"));
		const unlock = server.slice(server.indexOf("app.post('/api/rpg/talents/unlock'"), server.indexOf("app.post('/api/rpg/talents/unlock'") + 600);
		assert.match(avatar, /\.\.\.rpgMembershipFields\(membership\)/);
		assert.match(talents, /\.\.\.rpgMembershipFields\(membership\)/);
		assert.match(talents, /const class_id = rpgDisplayClassId\(profile\);/);
		assert.doesNotMatch(talents, /membership \? \(profile\.rpg_avatar_id/);
		assert.match(unlock, /if \(!membership\) \{\s*return res\.status\(403\)/);
	});
});

// ─── RpgNet ─────────────────────────────────────────────────────────
describe('RpgNet', () => {
	const RpgNet = require('../public/js/rpg-net.js');

	test('classifyStatus', () => {
		assert.equal(RpgNet.classifyStatus(200), 'ok');
		assert.equal(RpgNet.classifyStatus(401), 'login');
		for (const s of [500, 502, 503, 504, 0]) assert.equal(RpgNet.classifyStatus(s), 'offline', String(s));
		for (const s of [400, 403, 404, 429]) assert.equal(RpgNet.classifyStatus(s), 'error', String(s));
	});

	const cases = [
		['401 → login', { responses: [{ status: 401, body: { error: 'x' } }] }, 'login'],
		['503 → offline', { responses: [{ status: 503, body: {} }] }, 'offline'],
		['network error → offline', { responses: [new Error('Failed to fetch')] }, 'offline'],
		['200 with broken body → offline', { responses: [{ status: 200, body: null }] }, 'offline'],
		['no session → login (no request)', { responses: [{ status: 200, body: {} }], session: null }, 'login'],
		['auth client fails/times out → offline', { responses: [{ status: 200, body: {} }], session: new Error('timeout') }, 'offline'],
		['200 → ok', { responses: [{ status: 200, body: { a: 1 } }] }, 'ok'],
	];
	for (const [name, opts, kind] of cases) {
		test(name, async () => {
			const { ctx, calls } = makeContext(opts);
			load(ctx, ['public/js/rpg-net.js']);
			const r = await ctx.RpgNet.request('/api/rpg/talents');
			assert.equal(r.kind, kind);
			if (opts.session === null) assert.equal(calls.length, 0);
			if (kind === 'ok') assert.equal(calls[0].opts.headers.Authorization, 'Bearer tok');
		});
	}

	test('withTimeout rejects slow promises and clears its timer', async () => {
		await assert.rejects(RpgNet.withTimeout(new Promise(() => {}), 5), /timeout/);
		assert.equal(await RpgNet.withTimeout(Promise.resolve(3), 50), 3);
	});

	test('roleLabel covers player and unknown roles', () => {
		assert.equal(RpgNet.roleLabel('player'), sk.rpg_role_player);
		assert.equal(RpgNet.roleLabel('student'), sk.rpg_role_student);
		assert.equal(RpgNet.roleLabel('parent'), sk.rpg_role_player);
		assert.equal(RpgNet.roleLabel(undefined), sk.rpg_role_player);
	});

	test('fallback texts equal the Slovak i18n strings', () => {
		const src = read('public/js/rpg-net.js');
		for (const [key, value] of [...src.matchAll(/t\('(rpg_[\w]+)', '([^']+)'\)/g)].map((m) => [m[1], m[2]])) {
			assert.equal(value, sk[key], key);
		}
	});
});

// ─── RpgTalents ─────────────────────────────────────────────────────
describe('RpgTalents states', () => {
	const files = ['public/js/rpg-net.js', 'public/js/rpg-talents.js'];

	test('parallel loads share one request', async () => {
		const { ctx, calls } = makeContext({ responses: [{ status: 200, body: MEMBER }] });
		load(ctx, files);
		const [a, b] = await Promise.all([ctx.RpgTalents.load(), ctx.RpgTalents.load()]);
		assert.equal(calls.length, 1);
		assert.equal(a.class_id, 7);
		assert.equal(b, a);
	});

	test('503 shows "Server nedostupný" with a retry that reloads', async () => {
		const fresh = makeContext({ responses: [{ status: 503, body: {} }, { status: 200, body: MEMBER }], ids: ['panel'] });
		load(fresh.ctx, files);
		const r = await fresh.ctx.RpgTalents.loadResult();
		assert.equal(r.kind, 'offline');
		assert.equal(r.data, null);
		const panel = fresh.els.get('panel');
		fresh.ctx.RpgTalents.render('panel');
		assert.match(panel.innerHTML, new RegExp(sk.rpg_state_offline_title));
		assert.match(panel.innerHTML, new RegExp(sk.rpg_retry));
		assert.doesNotMatch(panel.innerHTML, /Prihlás sa|Nie si členom/);
		panel.querySelector('[data-rpg-action="retry"]').click();
		await new Promise((r2) => setTimeout(r2, 10));
		assert.equal(fresh.calls.length, 2);
		assert.doesNotMatch(panel.innerHTML, new RegExp(sk.rpg_state_offline_title));
	});

	test('401 shows "Prihlás sa" and only then', async () => {
		const { ctx, els } = makeContext({ responses: [{ status: 401, body: {} }], ids: ['panel'] });
		load(ctx, files);
		await ctx.RpgTalents.loadResult();
		ctx.RpgTalents.render('panel');
		assert.match(els.get('panel').innerHTML, new RegExp(sk.rpg_state_login_title));
		assert.doesNotMatch(els.get('panel').innerHTML, new RegExp(sk.rpg_state_offline_title));
	});

	test('logged-in user without avatar sees "Bez avatara", not a membership error', async () => {
		const { ctx, els } = makeContext({ responses: [{ status: 200, body: { ...NON_MEMBER, class_id: null } }], ids: ['panel'] });
		load(ctx, files);
		await ctx.RpgTalents.loadResult();
		ctx.RpgTalents.render('panel');
		const html = els.get('panel').innerHTML;
		assert.match(html, new RegExp(sk.rpg_no_class));
		assert.doesNotMatch(html, /Prihlás sa|Načítavam|Bez triedy|musíš byť členom/);
	});

	test('non-member with an avatar sees the tree plus the membership note from the flag', async () => {
		const { ctx, els } = makeContext({ responses: [{ status: 200, body: NON_MEMBER }], ids: ['panel'] });
		load(ctx, files);
		await ctx.RpgTalents.loadResult();
		ctx.RpgTalents.render('panel');
		assert.match(els.get('panel').innerHTML, /rpg-talent-member-note/);
		const member = makeContext({ responses: [{ status: 200, body: MEMBER }], ids: ['panel'] });
		load(member.ctx, files);
		await member.ctx.RpgTalents.loadResult();
		member.ctx.RpgTalents.render('panel');
		assert.doesNotMatch(member.els.get('panel').innerHTML, /rpg-talent-member-note/);
	});
});

// ─── RpgAvatar (profile modal card) ─────────────────────────────────
describe('RpgAvatar profile card', () => {
	const files = ['public/js/rpg-net.js', 'public/js/rpg-avatar.js'];

	test('offline shows retry, not "Prihlás sa"', async () => {
		const { ctx, els } = makeContext({ responses: [{ status: 502, body: {} }], ids: ['box'] });
		load(ctx, files);
		await ctx.RpgAvatar.loadResult();
		ctx.RpgAvatar.renderProfileAvatar('box');
		const state = els.get('box').child.innerHTML;
		assert.match(state, new RegExp(sk.rpg_state_offline_title));
		assert.doesNotMatch(els.get('box').innerHTML + state, /Prihl\S*s sa a vyber|font-size:9px|font-size:11px/);
	});

	test('member gets a translated role badge; non-member reads as player', async () => {
		const m = makeContext({ responses: [{ status: 200, body: { ...MEMBER, current_avatar_id: 7 } }], ids: ['box'] });
		load(m.ctx, files);
		await m.ctx.RpgAvatar.loadResult();
		m.ctx.RpgAvatar.renderProfileAvatar('box');
		assert.match(m.els.get('box').innerHTML, new RegExp(`>${sk.rpg_role_student}<`));
		assert.match(m.els.get('box').innerHTML, /ZŠ Lipa/);
		const n = makeContext({ responses: [{ status: 200, body: { ...NON_MEMBER, current_avatar_id: 7 } }], ids: ['box'] });
		load(n.ctx, files);
		await n.ctx.RpgAvatar.loadResult();
		n.ctx.RpgAvatar.renderProfileAvatar('box');
		assert.match(n.els.get('box').innerHTML, new RegExp(`>${sk.rpg_role_player}<`));
	});
});

// ─── RpgScreen sidebar ──────────────────────────────────────────────
describe('RpgScreen sidebar', () => {
	const files = ['public/js/rpg-net.js', 'public/js/rpg-talents.js', 'public/js/rpg-screen.js'];
	const ids = ['rpg-screen', 'rpg-sidebar-avatar', 'rpg-sidebar-class', 'rpg-sidebar-flavor', 'rpg-sidebar-meta',
		'rpg-sidebar-coins', 'rpg-sidebar-level', 'rpg-sidebar-picker-btn', 'rpg-screen-logo', 'rpg-screen-flavor',
		'rpg-panel-talents', 'rpg-panel-stats', 'rpg-panel-perks'];

	async function openWith(body, status = 200) {
		const env = makeContext({ responses: [{ status, body }], ids });
		load(env.ctx, files);
		env.ctx.RpgScreen.open();
		await new Promise((r) => setTimeout(r, 10));
		return env;
	}

	test('logged-in member: role + school, never "Prihlás sa" / "Bez triedy" / "Načítavam…"', async () => {
		const { els } = await openWith(MEMBER);
		const meta = els.get('rpg-sidebar-meta').innerHTML;
		assert.match(meta, new RegExp(sk.rpg_role_student));
		assert.match(meta, /ZŠ Lipa/);
		assert.equal(els.get('rpg-sidebar-class').textContent, 'Sage');
		const all = ids.map((id) => els.get(id).innerHTML + els.get(id).textContent).join(' ');
		assert.doesNotMatch(all, /Prihlás sa|Bez triedy|Načítavam…|Nie si členom/);
	});

	test('"Nie si členom školy" appears only when the server flag says false', async () => {
		const non = await openWith(NON_MEMBER);
		assert.match(non.els.get('rpg-sidebar-meta').innerHTML, new RegExp(sk.rpg_not_member));
		assert.match(non.els.get('rpg-sidebar-meta').innerHTML, new RegExp(sk.rpg_role_player));
		const noFlag = await openWith({ ...MEMBER, is_school_member: undefined, membership: undefined, role: 'player' });
		assert.doesNotMatch(noFlag.els.get('rpg-sidebar-meta').innerHTML, /Nie si členom/);
	});

	test('5xx: offline state with retry in the panel, sidebar stays empty', async () => {
		const { els } = await openWith({}, 503);
		assert.match(els.get('rpg-panel-talents').innerHTML, new RegExp(sk.rpg_state_offline_title));
		assert.equal(els.get('rpg-sidebar-meta').innerHTML, '');
		assert.equal(els.get('rpg-sidebar-coins').textContent, '');
		assert.doesNotMatch(els.get('rpg-sidebar-class').textContent, /Bez/);
	});

	test('retry after 5xx refreshes the sidebar too', async () => {
		const env = makeContext({ responses: [{ status: 503, body: {} }, { status: 200, body: MEMBER }], ids });
		load(env.ctx, files);
		env.ctx.RpgScreen.open();
		await new Promise((r) => setTimeout(r, 10));
		assert.equal(env.ctx.RpgScreen.isOpen(), true);
		env.els.get('rpg-panel-talents').querySelector('[data-rpg-action="retry"]').click();
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(env.els.get('rpg-sidebar-class').textContent, 'Sage');
		assert.match(env.els.get('rpg-sidebar-meta').innerHTML, /ZŠ Lipa/);
		env.ctx.RpgScreen.close();
		assert.equal(env.ctx.RpgScreen.isOpen(), false);
	});

	test('uses PxModal for the focus trap and has no Cyrillic or raw fetch token helper', () => {
		const src = read('public/js/rpg-screen.js');
		assert.match(src, /PxModal\.open\(screen, \{ display: 'flex', closeOnBackdrop: false, onClose: _cleanup \}\)/);
		assert.doesNotMatch(src, /[Ѐ-ӿ]/);
		assert.match(src, /player: 'Hráč'/);
		assert.doesNotMatch(src, /async function _token\(/);
		assert.match(src, /new AbortController\(\)/);
		const html = read('public/index.html');
		assert.ok(html.indexOf('js/rpg-net.js') < html.indexOf('js/rpg-avatar.js'));
		assert.ok(html.indexOf('js/px-modal.js') < html.indexOf('js/rpg-screen.js'));
	});
});
