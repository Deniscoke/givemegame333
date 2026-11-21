'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const {
	PRODUCTION_SUPABASE_URL,
	PRODUCTION_SUPABASE_ANON_KEY,
	buildSupabasePublicConfig,
	renderSupabaseConfigScript,
	extraCspOrigin
} = require('../lib/supabase-public-config');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function listFiles(dir, ext) {
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...listFiles(full, ext));
		else if (entry.name.endsWith(ext)) out.push(full);
	}
	return out;
}

test('buildSupabasePublicConfig falls back to production when env is missing', () => {
	const cfg = buildSupabasePublicConfig({});
	assert.deepEqual(cfg, {
		url: PRODUCTION_SUPABASE_URL,
		anonKey: PRODUCTION_SUPABASE_ANON_KEY,
		passwordLogin: false
	});
	assert.match(PRODUCTION_SUPABASE_URL, /^https:\/\/[a-z0-9]+\.supabase\.co$/);
});

test('buildSupabasePublicConfig uses env and enables password login only for local hosts', () => {
	const local = buildSupabasePublicConfig({
		SUPABASE_URL: 'http://127.0.0.1:55321',
		SUPABASE_ANON_KEY: 'local.anon.key'
	});
	assert.deepEqual(local, { url: 'http://127.0.0.1:55321', anonKey: 'local.anon.key', passwordLogin: true });

	assert.equal(buildSupabasePublicConfig({
		SUPABASE_URL: 'http://localhost:55321/', SUPABASE_ANON_KEY: 'k'
	}).passwordLogin, true);

	const remote = buildSupabasePublicConfig({
		SUPABASE_URL: 'https://abcd.supabase.co', SUPABASE_ANON_KEY: 'remote-key'
	});
	assert.deepEqual(remote, { url: 'https://abcd.supabase.co', anonKey: 'remote-key', passwordLogin: false });
});

test('buildSupabasePublicConfig rejects unsafe or incomplete env values', () => {
	const fallbacks = [
		{ SUPABASE_URL: 'http://evil.example.com', SUPABASE_ANON_KEY: 'k' },
		{ SUPABASE_URL: 'javascript:alert(1)', SUPABASE_ANON_KEY: 'k' },
		{ SUPABASE_URL: 'https://user:pw@abcd.supabase.co', SUPABASE_ANON_KEY: 'k' },
		{ SUPABASE_URL: 'https://abcd.supabase.co', SUPABASE_ANON_KEY: '' },
		{ SUPABASE_URL: 'https://abcd.supabase.co', SUPABASE_ANON_KEY: 'bad"key' },
		{ SUPABASE_URL: 'not a url', SUPABASE_ANON_KEY: 'k' }
	];
	for (const env of fallbacks) {
		assert.equal(buildSupabasePublicConfig(env).url, PRODUCTION_SUPABASE_URL, JSON.stringify(env));
		assert.equal(buildSupabasePublicConfig(env).passwordLogin, false);
	}
});

test('renderSupabaseConfigScript produces a frozen window.GMG_SUPABASE object', () => {
	const js = renderSupabaseConfigScript({ url: 'http://127.0.0.1:55321', anonKey: 'a.b', passwordLogin: true, extra: 'x' });
	const ctx = { window: {} };
	vm.createContext(ctx);
	vm.runInContext(js, ctx);
	assert.equal(ctx.window.GMG_SUPABASE.url, 'http://127.0.0.1:55321');
	assert.equal(ctx.window.GMG_SUPABASE.anonKey, 'a.b');
	assert.equal(ctx.window.GMG_SUPABASE.passwordLogin, true);
	assert.equal(ctx.window.GMG_SUPABASE.extra, undefined);
	assert.ok(Object.isFrozen(ctx.window.GMG_SUPABASE));
	assert.ok(!renderSupabaseConfigScript({ url: '</script>', anonKey: 'k' }).includes('<'));
});

test('extraCspOrigin only adds origins not covered by https://*.supabase.co', () => {
	assert.equal(extraCspOrigin({ url: 'https://abcd.supabase.co' }), '');
	assert.equal(extraCspOrigin({ url: 'http://127.0.0.1:55321' }), 'http://127.0.0.1:55321');
	assert.equal(extraCspOrigin({ url: 'bogus' }), '');
});

test('server serves /supabase-config.js with no-cache JS and extends CSP for the configured origin', () => {
	const server = read('server.js');
	assert.match(server, /app\.get\('\/supabase-config\.js'/);
	assert.match(server, /application\/javascript; charset=utf-8/);
	assert.match(server, /'Cache-Control', 'no-cache'/);
	assert.match(server, /connect-src 'self' \$\{SUPABASE_CSP_SOURCES\}/);
	assert.match(server, /script-src 'self'/);
	const routeIdx = server.indexOf("app.get('/supabase-config.js'");
	const staticIdx = server.indexOf('app.use(express.static(PUBLIC_DIR');
	assert.ok(routeIdx > 0 && routeIdx < staticIdx, 'config route must be registered before static files');
});

test('every page that loads supabase-js also loads /supabase-config.js right after it', () => {
	const htmlFiles = listFiles(path.join(ROOT, 'public'), '.html');
	let pages = 0;
	for (const file of htmlFiles) {
		const html = fs.readFileSync(file, 'utf8');
		const sdk = html.indexOf('supabase-js@2/dist/umd/supabase.min.js');
		if (sdk === -1) continue;
		pages += 1;
		const cfg = html.indexOf('<script src="/supabase-config.js"></script>');
		assert.ok(cfg > sdk, `${path.relative(ROOT, file)} must include /supabase-config.js after the SDK`);
		const between = html.slice(sdk, cfg);
		assert.equal((between.match(/<script/g) || []).length, 0, `${path.relative(ROOT, file)}: config must directly follow the SDK`);
	}
	assert.ok(pages >= 10, 'expected the Supabase pages to be found');
});

test('frontend Supabase constants read window.GMG_SUPABASE with the production fallback', () => {
	const files = listFiles(path.join(ROOT, 'public'), '.js')
		.concat(listFiles(path.join(ROOT, 'public'), '.html'))
		.filter((f) => fs.readFileSync(f, 'utf8').includes(PRODUCTION_SUPABASE_URL));
	assert.ok(files.length >= 8);
	for (const file of files) {
		const src = fs.readFileSync(file, 'utf8');
		const rel = path.relative(ROOT, file);
		assert.match(src, /const SUPABASE_URL\s*= .*GMG_SUPABASE.*\.url\) \|\| 'https:\/\//, `${rel} URL`);
		assert.match(src, /const SUPABASE_ANON_KEY = .*GMG_SUPABASE.*\.anonKey\) \|\| 'eyJ/, `${rel} anon key`);
		assert.doesNotMatch(src, /const SUPABASE_URL\s*= 'https:/, `${rel} still hard-codes the URL`);
	}
});

test('login.html shows the email/password form only when passwordLogin is true', () => {
	const login = read('public/login.html');
	assert.match(login, /<form class="local-login" id="local-login" hidden/);
	assert.match(login, /cfg\.passwordLogin !== true/);
	assert.match(login, /signInWithPassword\(\{ email, password \}\)/);
	assert.match(login, /await saveUserAndRedirect\(data\.user\)/);
	for (const lang of ['sk', 'cs', 'en', 'de', 'es', 'tr']) {
		const strings = JSON.parse(read(`public/data/i18n/${lang}.json`));
		for (const key of ['login_local_title', 'login_local_hint', 'login_local_email',
			'login_local_password', 'login_local_submit', 'login_local_failed']) {
			assert.equal(typeof strings[key], 'string', `${lang}.${key}`);
			assert.ok(strings[key].length > 0);
			assert.match(login, new RegExp(`data-login-i18n="${key}"|'${key}'`), `login.html uses ${key}`);
		}
	}
});
