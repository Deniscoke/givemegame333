'use strict';

// Static + small behavioural tests for the frontend-ux hardening:
//  - honest AI fallback messages (public/js/game-api.js)
//  - login probe when Supabase Auth is down (public/login.html)
//  - Slovak default language (public/script.js, public/index.html, public/login.html)
//  - i18n coverage for every new / referenced key

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const LANGS = ['sk', 'cs', 'en', 'de', 'es', 'tr'];
const dicts = Object.fromEntries(LANGS.map((l) => [l, JSON.parse(read(`public/data/i18n/${l}.json`))]));

const FILES = {
	gameApi: 'public/js/game-api.js',
	script: 'public/script.js',
	index: 'public/index.html',
	login: 'public/login.html'
};

const NEW_KEYS = [
	'ai_fallback_daily_limit', 'ai_fallback_busy', 'ai_fallback_network', 'ai_fallback_generic',
	'ai_remix_daily_limit', 'ai_remix_busy', 'ai_remix_network', 'ai_remix_generic',
	'login_auth_unavailable', 'login_sdk_failed', 'login_open_via_web', 'login_failed',
	'share_link_copied', 'share_link_copy_manual', 'share_link_hint'
];

describe('frontend-ux i18n coverage', () => {
	test('every new key exists as a non-empty string in all 6 languages', () => {
		for (const key of NEW_KEYS) {
			for (const lang of LANGS) {
				const v = dicts[lang][key];
				assert.equal(typeof v, 'string', `${lang}.json missing "${key}"`);
				assert.ok(v.trim().length > 0, `${lang}.json has empty "${key}"`);
			}
		}
	});

	test('new keys are actually translated (not copied from Slovak) in en/de/es/tr', () => {
		for (const key of NEW_KEYS) {
			for (const lang of ['en', 'de', 'es', 'tr']) {
				assert.notEqual(dicts[lang][key], dicts.sk[key], `${lang}.json "${key}" equals Slovak text`);
			}
		}
	});

	test('the keys used in game-api.js / login.html are all in the NEW_KEYS list', () => {
		const used = new Set();
		const gameApi = read(FILES.gameApi);
		for (const m of gameApi.matchAll(/\['(ai_(?:fallback|remix)_[a-z_]+)'/g)) used.add(m[1]);
		const login = read(FILES.login);
		for (const m of login.matchAll(/showErrorKey\('([a-z_]+)'/g)) used.add(m[1]);
		assert.ok(used.size >= 12);
		for (const k of used) assert.ok(NEW_KEYS.includes(k), `key ${k} not covered by test list`);
	});

	test('every t()/givemegame_t()/data-i18n key referenced in my files exists in all 6 languages', () => {
		const keys = new Set();
		for (const rel of Object.values(FILES)) {
			const src = read(rel);
			for (const m of src.matchAll(/\b(?:givemegame_t|_t|t)\(\s*['"]([a-zA-Z0-9_.-]+)['"]/g)) keys.add(m[1]);
			for (const m of src.matchAll(/data-i18n(?:-title)?=["']([^"']+)["']/g)) keys.add(m[1]);
		}
		const missing = [];
		for (const k of keys) {
			for (const lang of LANGS) if (dicts[lang][k] === undefined) missing.push(`${lang}:${k}`);
		}
		assert.deepEqual(missing, []);
	});
});

describe('no developer-only hints in user-facing messages', () => {
	test('no localhost in toasts or login errors', () => {
		for (const rel of Object.values(FILES)) {
			const lines = read(rel).split(/\r?\n/);
			lines.forEach((line, i) => {
				if (/toast\(|showError|title=/.test(line)) {
					assert.ok(!/localhost/i.test(line), `${rel}:${i + 1} user-facing localhost hint: ${line.trim()}`);
				}
			});
		}
	});

	test('game-api.js and login.html mention neither localhost nor .env / OPENAI_API_KEY in UI text', () => {
		for (const rel of [FILES.gameApi, FILES.login]) {
			const src = read(rel);
			assert.ok(!/localhost/i.test(src), `${rel} still mentions localhost`);
			assert.ok(!/toast\([^)]*(\.env|OPENAI_API_KEY)/.test(src), `${rel} toast mentions .env`);
		}
	});
});

function loadGameApi(translations) {
	const toasts = [];
	const window = { givemegame_t: translations ? (k, f) => (translations[k] ?? f) : undefined };
	const ctx = {
		window,
		console: { log() {}, warn() {}, error() {} },
		GameUI: { toast: (m) => toasts.push(m) },
		GameData: { generate: (f) => ({ title: 'Library game', filters: f }) },
		document: { getElementById: () => null },
		fetch: async () => { throw new TypeError('Failed to fetch'); },
		AbortController,
		setTimeout,
		clearTimeout
	};
	vm.createContext(ctx);
	vm.runInContext(read(FILES.gameApi), ctx, { filename: FILES.gameApi });
	return { api: ctx.window.GameAPI, toasts };
}

describe('GameAPI.classifyAiError / describeAiError', () => {
	const { api } = loadGameApi();
	const err = (props) => Object.assign(new Error(props.message || 'x'), props);

	test('daily limit codes', () => {
		assert.equal(api.classifyAiError(err({ code: 'PLAN_AI_DAILY_LIMIT', status: 429 })), 'daily_limit');
		assert.equal(api.classifyAiError(err({ code: 'GUEST_AI_DAILY_LIMIT', status: 429 })), 'daily_limit');
	});

	test('service busy: AI_DAILY_CAPACITY or HTTP 503', () => {
		assert.equal(api.classifyAiError(err({ code: 'AI_DAILY_CAPACITY', status: 429 })), 'busy');
		assert.equal(api.classifyAiError(err({ status: 503 })), 'busy');
	});

	test('timeout and network errors', () => {
		const abort = new Error('The operation was aborted');
		abort.name = 'AbortError';
		assert.equal(api.classifyAiError(abort), 'network');
		assert.equal(api.classifyAiError(new TypeError('Failed to fetch')), 'network');
		assert.equal(api.classifyAiError(err({ status: 504 })), 'network');
	});

	test('everything else is generic', () => {
		assert.equal(api.classifyAiError(err({ code: 'NO_API_KEY', status: 400 })), 'generic');
		assert.equal(api.classifyAiError(err({ status: 500 })), 'generic');
		assert.equal(api.classifyAiError(null), 'generic');
	});

	test('describeAiError returns the required Slovak daily-limit text by default', () => {
		const msg = api.describeAiError(err({ code: 'PLAN_AI_DAILY_LIMIT' }), 'fallback');
		assert.match(msg, /Dnešný limit AI hier je vyčerpaný, zobrazujem hru z knižnice/);
	});

	test('describeAiError uses window.givemegame_t translations', () => {
		const { api: apiEn } = loadGameApi(dicts.en);
		assert.equal(apiEn.describeAiError(err({ status: 503 }), 'remix'), dicts.en.ai_remix_busy);
	});

	test('generateGame keeps the library fallback but tells the user why', async () => {
		const { api: a, toasts } = loadGameApi(dicts.sk);
		const game = await a.generateGame({ age: 8 });
		assert.equal(game.title, 'Library game');
		assert.equal(toasts.length, 1);
		assert.ok(toasts[0].includes(dicts.sk.ai_fallback_network));
	});
});

function extractResolver(rel) {
	const src = read(rel);
	const m = src.match(/\/\/ BEGIN resolveInitialLang[^\n]*\n([\s\S]*?)\/\/ END resolveInitialLang/);
	assert.ok(m, `${rel} missing resolveInitialLang markers`);
	const body = m[1].replace(/^\s+/gm, '');
	return { body, fn: vm.runInNewContext(`(${m[1].trim()})`) };
}

describe('default language', () => {
	const fromScript = extractResolver(FILES.script);
	const fromLogin = extractResolver(FILES.login);

	test('script.js and login.html carry identical resolver copies', () => {
		assert.equal(fromScript.body, fromLogin.body);
	});

	for (const [label, { fn }] of [['script.js', fromScript], ['login.html', fromLogin]]) {
		test(`${label}: saved choice wins`, () => {
			assert.equal(fn('cs', ['en-US']), 'cs');
			assert.equal(fn('tr', ['sk']), 'tr');
		});
		test(`${label}: supported browser language is respected`, () => {
			assert.equal(fn(null, ['cs-CZ']), 'cs');
			assert.equal(fn(null, ['de-AT', 'en']), 'de');
			assert.equal(fn(null, ['pl-PL', 'es-ES']), 'es');
			assert.equal(fn(null, 'en-GB'), 'en');
		});
		test(`${label}: unsupported / missing falls back to Slovak`, () => {
			assert.equal(fn(null, ['pl-PL', 'hu']), 'sk');
			assert.equal(fn('xx', []), 'sk');
			assert.equal(fn(undefined, undefined), 'sk');
		});
	}

	test('index.html defaults to Slovak markup', () => {
		const html = read(FILES.index);
		assert.match(html, /<html lang="sk">/);
		assert.match(html, /class="btn-lang active" data-lang="sk"/);
	});

	test('script.js no longer hard-codes Czech as the default', () => {
		assert.ok(!/givemegame_preferred_lang'\)\s*\|\|\s*'cs'/.test(read(FILES.script)));
		assert.ok(!/givemegame_preferred_lang'\)\s*\|\|\s*'cs'/.test(read(FILES.login)));
	});

	test('<html lang> is updated when the language changes', () => {
		assert.match(read(FILES.script), /document\.documentElement\.lang = lang;/);
		assert.match(read(FILES.login), /document\.documentElement\.lang = lang;/);
	});
});

describe('login auth health probe', () => {
	const login = read(FILES.login);

	test('probes /auth/v1/health with apikey header and a 4 s timeout before OAuth', () => {
		assert.match(login, /SUPABASE_URL \+ '\/auth\/v1\/health'/);
		assert.match(login, /apikey: SUPABASE_ANON_KEY/);
		assert.match(login, /AUTH_HEALTH_TIMEOUT_MS = 4000/);
		const probeIdx = login.indexOf('await isAuthReachable()');
		const oauthIdx = login.indexOf('signInWithOAuth(');
		assert.ok(probeIdx > 0 && oauthIdx > probeIdx, 'health probe must run before signInWithOAuth');
	});

	test('unreachable auth shows translated message and highlights the guest option', () => {
		const block = login.slice(login.indexOf('await isAuthReachable()'), login.indexOf('signInWithOAuth('));
		assert.match(block, /showErrorKey\('login_auth_unavailable'/);
		assert.match(block, /highlightGuestOption\(\)/);
		assert.match(block, /return;/);
	});
});
