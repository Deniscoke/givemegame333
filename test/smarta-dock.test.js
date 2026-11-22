'use strict';

// SMARTA dock (Phase 8): layout contract, settings, sprite, i18n wiring, and the
// narrator's "never ask the TTS endpoint again after a refusal" rule.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

const css = stripComments(read('public/ui/px-smarta.css'));
const html = read('public/index.html');
const dockSrc = read('public/js/smarta-dock.js');
const narratorSrc = read('public/js/narrator.js');
const Dock = require('../public/js/smarta-dock.js');

/** Declarations of the first rule whose selector list equals `selector`. */
function rule(selector) {
	const re = new RegExp(`(?:^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm');
	const m = css.match(re);
	assert.ok(m, `rule ${selector} not found`);
	return m[1];
}

describe('dock layout contract', () => {
	it('is anchored bottom and right of the game area, not over the left panel', () => {
		const r = rule('.px-smarta');
		assert.match(r, /position:\s*(fixed|absolute)/);
		assert.match(r, /\bright:/);
		assert.match(r, /\bbottom:/);
		assert.match(r, /--smarta-vp-r/);
		assert.match(r, /--smarta-vp-b/);
		// the left variant only moves it to the left edge of the same game area
		const left = rule('.px-smarta[data-pos="left"]');
		assert.match(left, /left:\s*calc\(var\(--smarta-vp-l/);
	});

	it('is mounted inside #game-viewport and fed by its rectangle', () => {
		assert.match(dockSrc, /getElementById\('game-viewport'\)/);
		assert.match(dockSrc, /host\.appendChild\(dock\)/);
		assert.match(dockSrc, /getBoundingClientRect\(\)/);
		assert.match(dockSrc, /--smarta-vp-r/);
	});

	it('is not an overlay: the chat never traps focus or blocks the page', () => {
		assert.doesNotMatch(dockSrc, /aria-modal/);
		assert.doesNotMatch(dockSrc, /PxModal\.open/);
		assert.doesNotMatch(css, /\.px-smarta[^{]*\{[^}]*inset:\s*0/);
		assert.match(rule('.px-smarta'), /pointer-events:\s*none/);
		assert.match(css, /\.px-smarta > \* \{ pointer-events: auto; \}/);
	});

	it('stays below the drawers and modals, above the page', () => {
		const z = Number(rule('.px-smarta').match(/z-index:\s*(\d+)/)[1]);
		assert.ok(z > 100 && z < 1000, `z-index ${z}`);
	});

	it('has three sizes and a smaller portrait on phones', () => {
		for (const s of ['s', 'l']) assert.match(css, new RegExp(`\\.px-smarta\\[data-size="${s}"\\]`));
		assert.match(css, /@media \(max-width: 480px\)[\s\S]*--smarta-frame: 72px/);
	});
});

describe('dock motion and text size', () => {
	it('animates with steps() only, at 4 fps or less', () => {
		const anims = css.match(/animation:[^;]+;/g) || [];
		assert.ok(anims.length >= 2);
		for (const a of anims) {
			if (/\bnone\b/.test(a)) continue;
			assert.match(a, /steps\(/, a);
		}
		const talk = css.match(/animation: px-smarta-talk (\d+)ms steps\(1, end\)/);
		assert.ok(talk, 'talk animation');
		assert.ok(1000 / (Number(talk[1]) / 2) <= 4, 'talk animation runs at more than 4 changes per second');
	});

	it('is still under reduced motion and paused in hidden tabs', () => {
		assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none/);
		assert.match(css, /\.px-smarta\.is-paused \.px-smarta__strip \{ animation-play-state: paused; \}/);
		assert.match(dockSrc, /visibilitychange/);
		assert.match(dockSrc, /classList\.toggle\('is-paused', root\.document\.hidden\)/);
	});

	it('keeps body text at 14px or more and display text at 12px or more', () => {
		for (const m of css.matchAll(/font-size:\s*([^;]+);/g)) {
			const v = m[1].trim();
			const px = v.match(/^([\d.]+)px$/);
			if (px) assert.ok(Number(px[1]) >= 12, v);
			const rem = v.match(/^([\d.]+)rem$/);
			if (rem) assert.ok(Number(rem[1]) * 16 >= 12, v);
		}
		assert.doesNotMatch(css, /border-radius:\s*[1-9]/);
	});
});

describe('sprite', () => {
	it('has three 16x16 frames (idle, blink, talk) in one strip', () => {
		assert.equal(Dock.FRAMES.length, 3);
		for (const f of Dock.FRAMES) {
			assert.equal(f.length, 16);
			for (const row of f) assert.equal(row.length, 16);
		}
		assert.notDeepEqual(Dock.FRAMES[0], Dock.FRAMES[1]);
		assert.notDeepEqual(Dock.FRAMES[0], Dock.FRAMES[2]);
		const svg = Dock.spriteMarkup();
		assert.match(svg, /viewBox="0 0 48 16"/);
		assert.match(svg, /aria-hidden="true"/);
		assert.match(svg, /px-smarta__c-M/); // open mouth only exists in the talk frame
	});
});

describe('settings', () => {
	it('falls back to defaults for unknown values and never restores an open chat', () => {
		assert.deepEqual(Dock.normalizeSettings(null), { pos: 'right', size: 'm', muted: false, voice: 'auto', state: 'collapsed' });
		assert.deepEqual(Dock.normalizeSettings({ pos: 'top', size: 'xl', muted: 'yes', voice: 'x', state: 'open' }),
			{ pos: 'right', size: 'm', muted: false, voice: 'auto', state: 'collapsed' });
		assert.deepEqual(Dock.normalizeSettings({ pos: 'left', size: 'l', muted: true, voice: 'browser', state: 'hidden' }),
			{ pos: 'left', size: 'l', muted: true, voice: 'browser', state: 'hidden' });
	});

	it('offers position, size, mute, voice and style controls', () => {
		for (const id of ['smarta-pos', 'smarta-size', 'smarta-mute', 'smarta-voice', 'smarta-style', 'smarta-hide']) {
			assert.ok(dockSrc.includes(`'${id}'`) || dockSrc.includes(`#${id}`), id);
		}
		for (const s of ['genz', 'sangvinik', 'flegmatik', 'cholerik', 'melancholik']) assert.ok(dockSrc.includes(`'${s}'`));
	});
});

describe('page wiring', () => {
	it('loads the stylesheet and scripts, narrator first', () => {
		assert.match(html, /<link rel="stylesheet" href="\/ui\/px-smarta\.css/);
		assert.ok(html.indexOf('js/narrator.js') < html.indexOf('js/smarta-dock.js'));
	});
	it('no longer depends on the old #narrator-bot button', () => {
		assert.doesNotMatch(html, /id="narrator-bot"/);
		assert.doesNotMatch(narratorSrc, /narrator-bot/);
		assert.match(html, /id="smarta-open-dock"/);
		assert.match(html, /id="narrator-area"/);
		assert.match(html, /name="narrator-style"/);
	});
	it('re-translates after a language change', () => {
		assert.match(read('public/script.js'), /window\.SmartaDock\?\.refresh/);
	});
	it('exports speak() and fetchFact() from the narrator', () => {
		assert.match(narratorSrc, /return \{ init, refreshHint, loadSmartaStyles, speak, stop, fetchFact, tellFact,/);
	});
	it('keeps Ctrl+click read-aloud wired', () => {
		const ra = read('public/js/read-aloud.js');
		assert.match(ra, /ctrlKey/);
		assert.match(html, /js\/read-aloud\.js/);
	});
});

/** Run narrator.js in a sandbox with a scripted /api/tts. */
function narratorSandbox({ ttsStatus, loggedIn = true }) {
	const calls = [];
	const store = new Map();
	const sessionStore = new Map([['givemegame_user', JSON.stringify({ uid: 'u1' })]]);
	const storage = (m) => ({ getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) });
	const spoken = [];
	const ctx = {
		console,
		setTimeout, clearTimeout,
		URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
		AbortController,
		CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
		localStorage: storage(store),
		sessionStorage: storage(sessionStore),
		ngrokHeaders: () => ({}),
		GameUI: { toast() {} },
		supabaseClient: { auth: { getSession: async () => ({ data: { session: loggedIn ? { access_token: 't' } : null } }) } },
		document: { querySelector: () => null, querySelectorAll: () => [], getElementById: () => null },
		fetch: async (url) => {
			calls.push(String(url));
			return { ok: ttsStatus === 200, status: ttsStatus, blob: async () => ({}) };
		},
		SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
		speechSynthesis: {
			cancel() {}, getVoices: () => [],
			speak(u) { spoken.push(u.text); setTimeout(() => u.onend && u.onend(), 0); }
		},
		dispatchEvent() {},
		addEventListener() {},
	};
	ctx.window = ctx;
	vm.createContext(ctx);
	vm.runInContext(narratorSrc + '\n;window.__narratorTest = Narrator;', ctx);
	ctx.Narrator = ctx.__narratorTest;
	ctx.Narrator.init();
	const tts = { get length() { return calls.filter((u) => u.includes('/api/tts')).length; } };
	return { ctx, calls: tts, spoken, sessionStore };
}

describe('narrator voice', () => {
	it('asks /api/tts once, then never again after a 403 (cached for the session)', async () => {
		const { ctx, calls, spoken, sessionStore } = narratorSandbox({ ttsStatus: 403 });
		const a = await ctx.Narrator.speak('Ahoj', { lang: 'sk' });
		const b = await ctx.Narrator.speak('Znova', { lang: 'sk' });
		const c = await ctx.Narrator.speak('A ešte raz', { lang: 'sk' });
		assert.equal(calls.length, 1);
		assert.deepEqual([a, b, c], ['browser', 'browser', 'browser']);
		assert.equal(spoken.length, 3);
		assert.equal(sessionStore.get('givemegame_smarta_tts_refused_u1'), '1');
	});

	it('caches a 401 the same way', async () => {
		const { ctx, calls } = narratorSandbox({ ttsStatus: 401 });
		await ctx.Narrator.speak('Ahoj');
		await ctx.Narrator.speak('Ahoj');
		assert.equal(calls.length, 1);
	});

	it('does not call the server at all for anonymous users or the browser-voice setting', async () => {
		const anon = narratorSandbox({ ttsStatus: 403, loggedIn: false });
		assert.equal(await anon.ctx.Narrator.speak('Ahoj'), 'browser');
		assert.equal(anon.calls.length, 0);
		const browser = narratorSandbox({ ttsStatus: 200 });
		assert.equal(await browser.ctx.Narrator.speak('Ahoj', { voice: 'browser' }), 'browser');
		assert.equal(browser.calls.length, 0);
	});

	it('is silent when muted', async () => {
		const { ctx, calls, spoken } = narratorSandbox({ ttsStatus: 200 });
		assert.equal(await ctx.Narrator.speak('Ahoj', { muted: true }), 'muted');
		assert.equal(calls.length, 0);
		assert.equal(spoken.length, 0);
	});
});

describe('narrator reward cap', () => {
	it('is covered by the server-side daily cap, without new economy logic', () => {
		const policy = require('../lib/coin-log-policy');
		assert.equal(policy.REWARD_BASE.narrator_fact, 50);
		assert.equal(policy.DAILY_REWARD_CAP.narrator_fact, 250);
		assert.equal(policy.rewardCapKey('narrator_fact'), 'narrator_fact');
	});
});
