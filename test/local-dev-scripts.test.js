'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { isLocalUrl, parseEnvOutput, resolveConfig, ACCOUNTS } = require('../scripts/seed-local');

test('seed-local only accepts local hosts', () => {
	assert.equal(isLocalUrl('http://127.0.0.1:55321'), true);
	assert.equal(isLocalUrl('postgresql://postgres:postgres@localhost:55322/postgres'), true);
	assert.equal(isLocalUrl('https://abcd.supabase.co'), false);
	assert.equal(isLocalUrl('postgresql://u:p@db.abcd.supabase.co:5432/postgres'), false);
	assert.equal(isLocalUrl('garbage'), false);
	assert.throws(() => resolveConfig({
		LOCAL_SUPABASE_URL: 'https://abcd.supabase.co',
		LOCAL_SUPABASE_SERVICE_ROLE_KEY: 'x',
		LOCAL_SUPABASE_DB_URL: 'postgresql://postgres:postgres@127.0.0.1:55322/postgres'
	}), /not 127\.0\.0\.1\/localhost/);
	const ok = resolveConfig({
		LOCAL_SUPABASE_URL: 'http://127.0.0.1:55321/',
		LOCAL_SUPABASE_SERVICE_ROLE_KEY: 'x',
		LOCAL_SUPABASE_DB_URL: 'postgresql://postgres:postgres@127.0.0.1:55322/postgres'
	});
	assert.equal(ok.apiUrl, 'http://127.0.0.1:55321');
});

test('seed-local parses `supabase status -o env` output', () => {
	const parsed = parseEnvOutput('API_URL="http://127.0.0.1:55321"\r\nDB_URL="postgresql://x@127.0.0.1:55322/postgres"\nnoise line\n');
	assert.equal(parsed.API_URL, 'http://127.0.0.1:55321');
	assert.equal(parsed.DB_URL, 'postgresql://x@127.0.0.1:55322/postgres');
});

test('seed-local creates the four documented test accounts with valid school roles', () => {
	assert.deepEqual(ACCOUNTS.map((a) => a.email).sort(), [
		'admin@givemegame.local', 'student2@givemegame.local', 'student@givemegame.local', 'teacher@givemegame.local'
	]);
	for (const a of ACCOUNTS) assert.ok(['admin', 'teacher', 'student'].includes(a.schoolRole));
});

test('local-env preload refuses a non-local database URL', () => {
	const result = spawnSync(process.execPath, ['-r', './scripts/load-local-env.js', '-e', 'console.log("ran")'], {
		cwd: ROOT,
		env: { ...process.env, SUPABASE_DB_URL: 'postgresql://u:p@db.abcd.supabase.co:5432/postgres', SUPABASE_URL: '' },
		encoding: 'utf8'
	});
	if (fs.existsSync(path.join(ROOT, '.env.local'))) {
		// .env.local overrides the inherited variable with the local URL.
		assert.equal(result.status, 0);
	} else {
		assert.equal(result.status, 1);
		assert.match(result.stderr, /not a local address/);
	}
});

test('local Supabase config is isolated from other projects and leaves migrations to our runner', () => {
	const toml = fs.readFileSync(path.join(ROOT, 'supabase', 'config.toml'), 'utf8');
	assert.match(toml, /^project_id = "givemegame"$/m);
	const ports = [...toml.matchAll(/^(?:port|shadow_port) = (\d+)$/gm)].map((m) => Number(m[1]));
	assert.ok(ports.length >= 6);
	for (const port of ports) assert.ok(port >= 55300 && port < 55400, `port ${port} outside 553xx`);
	const section = (name) => {
		const header = `\n[${name}]\n`;
		const start = toml.indexOf(header);
		assert.ok(start >= 0, `missing [${name}]`);
		const next = toml.indexOf('\n[', start + header.length);
		return toml.slice(start, next === -1 ? undefined : next);
	};
	assert.match(section('db.migrations'), /\nenabled = false/);
	assert.match(section('db.seed'), /\nenabled = false/);
	assert.match(section('auth.email'), /\nenable_confirmations = false/);
	const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
	assert.match(pkg.scripts['db:local:stop'], /--workdir \./);
	assert.doesNotMatch(pkg.scripts['db:local:stop'], /--all/);
	assert.match(pkg.scripts['dev:local'], /load-local-env\.js server\.js/);
});
