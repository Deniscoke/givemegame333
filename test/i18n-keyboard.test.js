'use strict';

// Phase 1 — i18n order and keyboard fixes:
//  - scripts/check-i18n.js (key parity + every used key exists)
//  - init() applies translations before any database call settles (H8)
//  - data-i18n-placeholder / -aria-label are applied (M17)
//  - Space/Enter only generate when nothing is focused; shortcuts need Alt+Shift (H7)
//  - Slovak HTML defaults, no double robot emoji, no Cyrillic, no Czech in JS (LOW)
//  - German/Turkish SMARTA facts are not requested in Czech (M18)

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const checker = require('../scripts/check-i18n.js');
const LANGS = checker.LANGS;
const dicts = checker.loadDictionaries();

function extractFn(rel, name) {
	const src = read(rel);
	const m = src.match(new RegExp(`// BEGIN ${name}[^\\n]*\\n([\\s\\S]*?)// END ${name}`));
	assert.ok(m, `${rel} is missing the BEGIN/END ${name} markers`);
	return vm.runInNewContext(`${m[1]}\n${name}`, { setTimeout, clearTimeout, Promise, Error });
}

describe('scripts/check-i18n.js', () => {
	test('the repository passes the check (CLI exits 0)', () => {
		const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-i18n.js')], { encoding: 'utf8' });
		assert.equal(r.status, 0, r.stderr);
		assert.match(r.stdout, /i18n OK/);
	});

	test('all six language files have exactly the same keys', () => {
		const { missing, empty } = checker.findParityProblems(dicts);
		assert.deepEqual(missing, {});
		assert.deepEqual(empty, {});
		const sizes = new Set(LANGS.map((l) => Object.keys(dicts[l]).length));
		assert.equal(sizes.size, 1, 'key counts differ between languages');
	});

	test('every key used in public/ exists in every language', () => {
		assert.deepEqual(checker.findUnknownKeys(dicts, checker.listSourceFiles()), []);
	});

	test('findParityProblems reports missing and empty keys per language', () => {
		const sample = {
			sk: { a: 'A', b: 'B', _meta: {} },
			cs: { a: 'A' },
			en: { a: 'A', b: '' }
		};
		const { missing, empty } = checker.findParityProblems(sample);
		assert.deepEqual(missing, { cs: ['b'] });
		assert.deepEqual(empty, { en: ['b'] });
	});

	test('extractKeys finds t()/_t()/givemegame_t()/data-i18n* keys and skips dynamic ones', () => {
		const src = [
			"t('plain_key', 'x')",
			"_t(\"double_key\")",
			"window.givemegame_t('global_key', 'x')",
			"(window.givemegame_t || ((k,f)=>f||k))('narrator_key', 'x')",
			'<span data-i18n="html_key">x</span>',
			'<input data-i18n-placeholder="ph_key" data-i18n-aria-label="aria_key" data-i18n-title="title_key">',
			"t(`mode_${mode}`, mode)",
			"t('assess_type_' + type)",
			"setTimeout(() => {}, 10); const t = setTimeout(fn, 5);",
			"format('not_a_key')"
		].join('\n');
		assert.deepEqual(checker.extractKeys(src).sort(), [
			'aria_key', 'double_key', 'global_key', 'html_key', 'narrator_key', 'ph_key', 'plain_key', 'title_key'
		]);
	});

	test('DE, ES and TR are real translations for the newly added UI keys', () => {
		for (const key of ['tools_button', 'settings', 'join_session', 'export_materials', 'game_tools_title', 'edit_title']) {
			for (const lang of ['en', 'de', 'es', 'tr']) {
				assert.notEqual(dicts[lang][key], dicts.sk[key], `${lang}.json "${key}" is the Slovak text`);
			}
		}
	});
});

// ─── Minimal DOM + browser stubs to run public/script.js in a vm ───
function makeElement(tag, attrs = {}, text = '') {
	const el = {
		tagName: tag.toUpperCase(),
		_attrs: { ...attrs },
		textContent: text,
		innerHTML: text,
		style: {},
		dataset: {},
		children: [],
		classList: {
			_s: new Set(),
			add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
			toggle(c, on) { if (on === undefined ? !this._s.has(c) : on) this._s.add(c); else this._s.delete(c); },
			contains(c) { return this._s.has(c); }
		},
		getAttribute(n) { return n in this._attrs ? this._attrs[n] : null; },
		setAttribute(n, v) { this._attrs[n] = String(v); if (n === 'placeholder') this.placeholder = String(v); if (n === 'title') this.title = String(v); },
		hasAttribute(n) { return n in this._attrs; },
		addEventListener() {}, removeEventListener() {},
		querySelector() { return null; }, querySelectorAll() { return []; },
		appendChild(c) { this.children.push(c); return c; },
		append(...c) { this.children.push(...c); },
		replaceChildren(...c) { this.children = c; this.textContent = c.map((x) => x.textContent || '').join(''); },
		remove() {}, focus() {}, click() {}
	};
	if ('placeholder' in attrs) el.placeholder = attrs.placeholder;
	return el;
}

function loadScriptInVm({ initialized = false } = {}) {
	const cookingLabel = makeElement('span', { 'data-i18n': 'mode_cooking', class: 'mode-name' }, 'Vaření');
	const description = makeElement('textarea', { 'data-i18n-placeholder': 'description_placeholder', placeholder: 'Krátký popis nebo zadání hry...' });
	const filtersBtn = makeElement('button', { 'data-i18n-aria-label': 'filters', 'aria-label': 'Filtry' });
	const badge = makeElement('div', { id: 'game-mode-badge' });
	const all = [cookingLabel, description, filtersBtn, badge];
	const htmlEl = makeElement('html', { lang: 'cs' });
	const body = makeElement('body');

	const document = {
		documentElement: htmlEl,
		body,
		activeElement: body,
		readyState: 'complete',
		get lang() { return htmlEl.lang; },
		getElementById: (id) => all.find((e) => e._attrs.id === id) || null,
		querySelector: () => null,
		querySelectorAll(sel) {
			const m = sel.match(/^\[([a-z0-9-]+)\]$/);
			return m ? all.filter((e) => e.hasAttribute(m[1])) : [];
		},
		createElement: (tag) => makeElement(tag),
		createTextNode: (text) => ({ textContent: text }),
		addEventListener() {}, removeEventListener() {}, dispatchEvent() {}
	};
	Object.defineProperty(htmlEl, 'lang', { get() { return this._attrs.lang; }, set(v) { this._attrs.lang = v; } });

	const never = new Promise(() => {});
	const networkCalls = [];
	const toasts = [];
	const awards = [];
	const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
	const localStorage = store();
	const supabaseClient = {
		auth: {
			getSession: () => { networkCalls.push('auth.getSession'); return never; },
			getUser: () => { networkCalls.push('auth.getUser'); return never; },
			onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } })
		},
		from: () => { networkCalls.push('from'); return { select: () => ({ eq: () => ({ single: () => never }) }) }; }
	};

	const ctx = {
		console: { log() {}, warn() {}, error() {}, info() {} },
		document,
		navigator: { languages: ['sk-SK'], language: 'sk-SK', userAgent: 'node' },
		location: { host: 'localhost:3000', href: 'http://localhost:3000/', search: '', pathname: '/' },
		localStorage,
		sessionStorage: store(),
		// Timers never fire: only promise ordering matters, and nothing may hang the test run
		setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
		requestAnimationFrame: () => 0,
		fetch: (url) => {
			const m = String(url).match(/data\/i18n\/([a-z]+)\.json$/);
			if (m) {
				const data = JSON.parse(read(`public/data/i18n/${m[1]}.json`));
				return Promise.resolve({ ok: true, status: 200, json: async () => data });
			}
			networkCalls.push(String(url));
			return never;
		},
		URLSearchParams,
		CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
		AbortController: class { constructor() { this.signal = {}; } abort() {} },
		GameUI: { initTools() {}, toast: (msg) => toasts.push(msg), setStatus() {}, updateStats() {}, loadHistory() {} },
		GameData: { load: () => never },
		GameAPI: { checkServer: () => never },
		Coins: { load: () => never, award: (reason) => awards.push(reason) },
		Timer: { setOnComplete() {} },
		supabase: { createClient: () => supabaseClient }
	};
	ctx.window = ctx;
	ctx.globalThis = ctx;
	ctx.addEventListener = () => {};
	ctx.removeEventListener = () => {};
	vm.createContext(ctx);
	let src = read('public/script.js');
	if (initialized) {
		// Simulate the state after init() has finished (the DB stubs never settle in this vm)
		assert.ok(src.includes('let isInitializing = true;'), 'isInitializing declaration not found');
		src = src.replace('let isInitializing = true;', 'let isInitializing = false;');
	}
	vm.runInContext(`${src}\n;globalThis.__App = App;`, ctx, { filename: 'public/script.js' });
	return { ctx, App: ctx.__App, cookingLabel, description, filtersBtn, htmlEl, networkCalls, toasts, awards, localStorage };
}

const flush = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

describe('H8 / M17: translations before the database', () => {
	test('init() applies Slovak text, placeholder and aria-label while every DB call is still pending', async () => {
		const env = loadScriptInVm();
		let settled = false;
		env.App.init().then(() => { settled = true; }, () => { settled = true; });
		await flush();

		assert.equal(settled, false, 'init() should still be waiting on the (never-settling) database');
		assert.ok(env.networkCalls.includes('auth.getSession'), 'the auth call should have started');
		assert.equal(env.cookingLabel.textContent, dicts.sk.mode_cooking);
		assert.equal(env.cookingLabel.textContent, 'Varenie');
		assert.equal(env.description.placeholder, dicts.sk.description_placeholder);
		assert.equal(env.filtersBtn.getAttribute('aria-label'), dicts.sk.filters);
		assert.equal(env.htmlEl.lang, 'sk');
		assert.deepEqual(env.toasts.filter((t) => t.startsWith('🌐')), [], 'startup must not toast the language');
		assert.equal(env.localStorage.getItem('givemegame_preferred_lang'), null, 'startup must not pin the browser language');
	});

	test('applyInitialLanguage() runs before syncAuthFromSupabase, loadStats and UserPreferences in init()', () => {
		const src = read('public/script.js');
		const start = src.indexOf('async function init()');
		const body = src.slice(start, src.indexOf('\n\t}\n', start));
		const i18n = body.indexOf('await applyInitialLanguage()');
		assert.ok(i18n > 0);
		for (const later of ['await syncAuthFromSupabase', 'await GameData.load()', 'await loadStats()', 'await UserPreferences.load()']) {
			assert.ok(body.indexOf(later) > i18n, `${later} must come after applyInitialLanguage()`);
		}
	});

	test('loadStats() wraps the profiles query in a timeout', () => {
		const src = read('public/script.js');
		const fn = src.slice(src.indexOf('async function loadStats()'), src.indexOf('function saveStats('));
		assert.match(fn, /withTimeout\(\s*supabaseClient\.from\('profiles'\)/);
	});

	test('setLang() re-renders the game card mode badge', () => {
		const src = read('public/script.js');
		const fn = src.slice(src.indexOf('async function setLang('), src.indexOf('async function applyInitialLanguage'));
		assert.match(fn, /renderModeBadge\(\)/);
	});

	test('applyAttributeTranslations sets title, placeholder and aria-label, leaving unknown keys alone', () => {
		const apply = extractFn('public/script.js', 'applyAttributeTranslations');
		const input = makeElement('input', { 'data-i18n-placeholder': 'ph', placeholder: 'old' });
		const btn = makeElement('button', { 'data-i18n-title': 'tt', 'data-i18n-aria-label': 'al', title: 'old', 'aria-label': 'old' });
		const other = makeElement('button', { 'data-i18n-title': 'missing', title: 'keep' });
		const els = [input, btn, other];
		const root = { querySelectorAll: (sel) => els.filter((e) => e.hasAttribute(sel.slice(1, -1))) };
		apply(root, { ph: 'Nový', tt: 'Titulok', al: 'Popis' });
		assert.equal(input.getAttribute('placeholder'), 'Nový');
		assert.equal(btn.getAttribute('title'), 'Titulok');
		assert.equal(btn.getAttribute('aria-label'), 'Popis');
		assert.equal(other.getAttribute('title'), 'keep');
	});

	test('withTimeout resolves with the value or rejects after the limit', async () => {
		const withTimeout = extractFn('public/script.js', 'withTimeout');
		assert.equal(await withTimeout(Promise.resolve(42), 1000, 'x'), 42);
		await assert.rejects(withTimeout(new Promise(() => {}), 10, 'slow'), /slow timeout/);
	});
});

describe('H7: keyboard handler', () => {
	const keyboardAction = extractFn('public/script.js', 'keyboardAction');
	const body = { tagName: 'BODY' };
	const html = { tagName: 'HTML' };
	const button = { tagName: 'BUTTON' };
	const ctx = (over = {}) => ({ activeElement: body, body, documentElement: html, hasGame: true, hasSelection: false, ...over });
	const key = (k, over = {}) => ({ key: k, code: '', target: body, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...over });

	test('Space/Enter generate only when nothing is focused', () => {
		assert.equal(keyboardAction(key('Enter'), ctx()), 'generate');
		assert.equal(keyboardAction(key(' '), ctx()), 'generate');
		assert.equal(keyboardAction(key('Enter'), ctx({ activeElement: null })), 'generate');
		assert.equal(keyboardAction(key('Enter'), ctx({ activeElement: html })), 'generate');
	});

	test('Enter/Space on a focused button, link or summary keeps native behaviour', () => {
		for (const tagName of ['BUTTON', 'A', 'SUMMARY']) {
			const el = { tagName };
			assert.equal(keyboardAction(key('Enter', { target: el }), ctx({ activeElement: el })), null, `Enter on ${tagName}`);
			assert.equal(keyboardAction(key(' ', { target: el }), ctx({ activeElement: el })), null, `Space on ${tagName}`);
		}
	});

	const chip = (cls, tagName = 'BUTTON') => ({ tagName, classList: { contains: (c) => c === cls } });

	test('Space/Enter after a mouse click on a .btn-mode or .btn-toggle generates instead of re-clicking it', () => {
		for (const cls of ['btn-mode', 'btn-toggle']) {
			const el = chip(cls);
			for (const k of [' ', 'Enter']) {
				assert.equal(keyboardAction(key(k, { target: el }), ctx({ activeElement: el, pointerFocused: true })), 'generate', `${JSON.stringify(k)} on mouse-focused .${cls}`);
			}
		}
	});

	test('a keyboard-focused .btn-mode (Tab) still activates natively', () => {
		const el = chip('btn-mode');
		assert.equal(keyboardAction(key(' ', { target: el }), ctx({ activeElement: el, pointerFocused: false })), null);
		assert.equal(keyboardAction(key('Enter', { target: el }), ctx({ activeElement: el })), null);
	});

	test('mouse focus on an ordinary button or link keeps native behaviour', () => {
		for (const el of [chip('btn-retro'), chip('other', 'A'), { tagName: 'BUTTON' }]) {
			assert.equal(keyboardAction(key(' ', { target: el }), ctx({ activeElement: el, pointerFocused: true })), null);
		}
	});

	test('bindKeyboard tracks pointer focus on mode/filter chips and passes it to keyboardAction', () => {
		const src = read('public/script.js');
		const fn = src.slice(src.indexOf('function bindKeyboard()'), src.indexOf('// ─── Zavírání modalů'));
		assert.match(fn, /addEventListener\('pointerdown'/);
		assert.match(fn, /closest\('\.btn-mode, \.btn-toggle'\)/);
		assert.match(fn, /addEventListener\('focusout'/);
		assert.match(fn, /pointerFocused: !!pointerFocusEl && active === pointerFocusEl/);
	});

	test('form fields are never hijacked', () => {
		for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
			const el = { tagName };
			assert.equal(keyboardAction(key('Enter', { target: el }), ctx({ activeElement: el })), null);
			assert.equal(keyboardAction(key('S', { code: 'KeyS', altKey: true, shiftKey: true, target: el }), ctx({ activeElement: el })), null);
		}
		const editable = { tagName: 'DIV', isContentEditable: true };
		assert.equal(keyboardAction(key('Enter', { target: editable }), ctx({ activeElement: editable })), null);
	});

	test('single-letter shortcuts need Alt+Shift (WCAG 2.1.4)', () => {
		for (const k of ['s', 'S', 't', 'T', 'm', 'M']) {
			assert.equal(keyboardAction(key(k, { code: `Key${k.toUpperCase()}` }), ctx()), null, `bare ${k}`);
			assert.equal(keyboardAction(key(k, { code: `Key${k.toUpperCase()}`, shiftKey: true }), ctx()), null, `Shift+${k}`);
		}
		const alt = (code) => key('x', { code, altKey: true, shiftKey: true });
		assert.equal(keyboardAction(alt('KeyS'), ctx()), 'surprise');
		assert.equal(keyboardAction(alt('KeyT'), ctx()), 'theme');
		assert.equal(keyboardAction(alt('KeyM'), ctx()), 'music');
		assert.equal(keyboardAction(alt('KeyS'), ctx({ activeElement: button })), 'surprise', 'modifier shortcuts work from any focus');
		assert.equal(keyboardAction(alt('KeyQ'), ctx()), null);
		assert.equal(keyboardAction(key('Enter', { shiftKey: true }), ctx()), null);
	});

	test('Ctrl/Cmd+C copies the game only when there is a game and no text selection', () => {
		assert.equal(keyboardAction(key('c', { ctrlKey: true }), ctx()), 'copy');
		assert.equal(keyboardAction(key('c', { metaKey: true }), ctx()), 'copy');
		assert.equal(keyboardAction(key('c', { ctrlKey: true }), ctx({ hasSelection: true })), null);
		assert.equal(keyboardAction(key('c', { ctrlKey: true }), ctx({ hasGame: false })), null);
	});

	test('the help modal lists the new modifier shortcuts', () => {
		const html = read('public/index.html');
		for (const k of ['S', 'T', 'M']) assert.ok(html.includes(`<span class="help-key">Alt+Shift+${k}</span>`), `Alt+Shift+${k}`);
		for (const lang of LANGS) assert.match(dicts[lang].welcome_hint, /Alt\+Shift\+S/, `${lang} welcome_hint`);
	});
});

describe('setMode: repeat activation of the same mode', () => {
	test('selecting the current mode again does not award mode_click, toast or re-run anything', () => {
		const env = loadScriptInVm({ initialized: true });
		env.App.setMode('party');
		assert.deepEqual(env.awards, [], 'party is already the current mode');
		env.App.setMode('cooking');
		assert.deepEqual(env.awards, ['mode_click']);
		const toastsAfterSwitch = env.toasts.length;
		for (let i = 0; i < 30; i++) env.App.setMode('cooking'); // held Enter on the focused button
		assert.deepEqual(env.awards, ['mode_click'], 'repeat activations must not request more awards');
		assert.equal(env.toasts.length, toastsAfterSwitch, 'no repeat toast');
		env.App.setMode('party');
		assert.deepEqual(env.awards, ['mode_click', 'mode_click']);
	});

	test('the first setMode during init still applies the default mode', () => {
		const src = read('public/script.js');
		const fn = src.slice(src.indexOf('function setMode(mode)'), src.indexOf('function getMode()'));
		assert.match(fn, /if \(mode === currentMode && !isInitializing\) return;/);
	});
});

describe('Slovak defaults and LOW i18n items', () => {
	const html = read('public/index.html');

	test('data-i18n fallback text in index.html is the Slovak translation', () => {
		const HTML_KEYS = new Set(['welcome_text']);
		const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
		// The age/players/duration selects (filter block) are owned by the generation phase.
		const filterStart = html.indexOf('data-i18n="age"');
		const filterEnd = html.indexOf('data-i18n="setting"');
		const re = /data-i18n="([a-z0-9_]+)"[^>]*>([^<]*)<\//g;
		let m;
		let checked = 0;
		while ((m = re.exec(html)) !== null) {
			if (m.index >= filterStart && m.index < filterEnd) continue;
			if (HTML_KEYS.has(m[1])) continue;
			assert.equal(decode(m[2]), dicts.sk[m[1]], `fallback for "${m[1]}"`);
			checked++;
		}
		assert.ok(checked > 100, `only ${checked} fallbacks checked`);
		assert.ok(html.includes(`data-i18n="welcome_text">${dicts.sk.welcome_text}</p>`));
	});

	test('acceptance strings are Slovak on first paint', () => {
		assert.match(html, /data-i18n="mode_cooking">Varenie</);
		assert.match(html, /data-i18n="mode_classroom">Trieda</);
		assert.match(html, /data-i18n-placeholder="description_placeholder" placeholder="Krátky popis alebo zadanie hry\.\.\."/);
		assert.match(html, /<title data-i18n="page_title">gIVEMEGAME\.IO — Generátor vzdelávacích hier<\/title>/);
	});

	test('previously hardcoded strings now have i18n hooks', () => {
		for (const key of ['tools_button', 'settings', 'advanced_options', 'game_tools_title', 'tool_tab_history', 'tool_tab_stats',
			'profile_progress', 'profile_login_text', 'profile_logout', 'coin_tab_history', 'coin_earn_title', 'library_title',
			'lib_sort_newest', 'edit_title', 'edit_name', 'help_key_left_panel', 'help_key_card', 'join_session', 'refl_submit']) {
			assert.ok(html.includes(`data-i18n="${key}"`), `data-i18n="${key}"`);
		}
		assert.ok(html.includes('data-i18n-aria-label="settings_menu_aria"'));
		assert.ok(html.includes('data-i18n-placeholder="lib_search_placeholder"'));
	});

	test('the Challenge pill shows one robot emoji', () => {
		const pill = html.slice(html.indexOf('id="btn-robot-challenge"'), html.indexOf('</button>', html.indexOf('id="btn-robot-challenge"')));
		assert.equal((pill.match(/🤖/g) || []).length, 1, pill);
		for (const lang of LANGS) assert.equal((dicts[lang].robot_challenge.match(/🤖/g) || []).length, 1);
	});

	test('no Cyrillic letters in index.html or the language files ("Talenты")', () => {
		const cyr = /[Ѐ-ӿ]/;
		assert.ok(!cyr.test(html), 'index.html contains Cyrillic');
		assert.ok(html.includes('⚔️ Talenty'));
		for (const lang of LANGS) assert.ok(!cyr.test(JSON.stringify(dicts[lang])), `${lang}.json contains Cyrillic`);
	});

	test('help modal mode names come from the translated descriptions (no Czech <strong> labels)', () => {
		for (const czech of ['Třída', 'Reflexe', 'Vaření', 'Meditace', 'Levý panel', 'Tlačítko']) {
			assert.ok(!html.includes(czech), `index.html still contains "${czech}"`);
		}
	});

	test('game-ui.js and the script.js export use t() instead of hardcoded Czech', () => {
		const gameUi = read('public/js/game-ui.js');
		for (const czech of ['Uvnitř', 'Kdekoli', 'hráčů', "'Věk", 'Věk ', "'Délka'", "'Prostředí'", 'se zobrazí zde']) {
			assert.ok(!gameUi.includes(czech), `game-ui.js still contains "${czech}"`);
		}
		const script = read('public/script.js');
		const exportSrc = script.slice(script.indexOf('function settingLabel('), script.indexOf('function downloadFile('));
		for (const czech of ['Hráči:', 'Věk', 'Délka', 'Prostředí', 'POMŮCKY', 'VZDĚLÁVACÍ', 'BEZPEČNOSTNÍ', 'Očekávané', 'Vygenerováno', 'Uvnitř']) {
			assert.ok(!exportSrc.includes(czech), `script.js export still contains "${czech}"`);
		}
		assert.match(exportSrc, /t\('export_materials'/);
	});

	test('game-ui.js renders badges in the active language', () => {
		const src = read('public/js/game-ui.js');
		const calls = [];
		const el = () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild(c) { calls.push(c); }, set innerHTML(v) { calls.push(v); }, set textContent(v) { calls.push(v); }, querySelector: () => null, querySelectorAll: () => [] });
		const ctx = {
			window: {},
			document: {
				getElementById: () => el(),
				createElement: () => ({ ...el(), set innerHTML(v) { calls.push(v); }, set className(v) {} }),
				querySelectorAll: () => [],
				querySelector: () => null,
				addEventListener() {}
			},
			console, setTimeout, clearTimeout
		};
		ctx.window.givemegame_t = (k, f) => (dicts.en[k] !== undefined ? dicts.en[k] : f);
		vm.createContext(ctx);
		vm.runInContext(`${src}\n;globalThis.__GameUI = GameUI;`, ctx);
		const game = {
			title: 'T', pitch: 'P', setting: 'outdoor', playerCount: { min: 2, max: 5 }, duration: { min: 10, max: 20 },
			ageRange: { min: 8, max: 12 }, materials: [], instructions: [], learningGoals: [], reflectionPrompts: [],
			safetyNotes: [], adaptationTips: [], facilitatorNotes: ''
		};
		try { ctx.__GameUI.renderGame(game); } catch (e) { /* later sections need more DOM; badges render first */ }
		const out = calls.filter((c) => typeof c === 'string').join('\n');
		assert.match(out, /2–5 players/);
		assert.match(out, /Outdoor/);
		assert.match(out, /Age 8–12/);
	});
});

describe('M18: SMARTA fact language map', () => {
	test('the random-fact language map includes German and Turkish', () => {
		const src = read('server.js');
		const m = src.match(/const langMap = \{([^}]*)\};\s*\n\s*const tgtLang = langMap\[lang\]/);
		assert.ok(m, 'langMap not found');
		assert.match(m[1], /de: 'German'/);
		assert.match(m[1], /tr: 'Turkish'/);
	});
});
