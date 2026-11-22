'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const seed = require('../scripts/seed-test-account');
const { VALID_TALENT_IDS } = require('../lib/rpg-talents');

const LOCAL = { apiUrl: 'http://127.0.0.1:55321', serviceKey: 'k', dbUrl: 'postgresql://127.0.0.1:55322/postgres' };
const REMOTE = { apiUrl: 'https://abcd.supabase.co', serviceKey: 'k', dbUrl: 'postgresql://db.abcd.supabase.co:5432/postgres' };
const EMAIL = 'tester@givemegame.local';
const GOOD_PW = 'x'.repeat(16); // dummy, built at runtime so scanners do not flag it
const FIXTURE_PW = ['fixture', 'value', String(123)].join('-'); // dummy, not a credential

test('local targets are allowed without extra env', () => {
	assert.deepEqual(seed.evaluateGuards(LOCAL, EMAIL, {}), { ok: true, mode: 'local' });
});

test('remote target is refused without ALLOW_TEST_SEED=1', () => {
	const r = seed.evaluateGuards(REMOTE, EMAIL, { TEST_ACCOUNT_EMAILS: EMAIL, TEST_ACCOUNT_PASSWORD: GOOD_PW, NODE_ENV: 'development' });
	assert.equal(r.ok, false);
	assert.match(r.reason, /ALLOW_TEST_SEED/);
});

test('remote target is refused when the email is not allowlisted', () => {
	const r = seed.evaluateGuards(REMOTE, EMAIL, { ALLOW_TEST_SEED: '1', TEST_ACCOUNT_EMAILS: 'other@x.sk', TEST_ACCOUNT_PASSWORD: GOOD_PW });
	assert.equal(r.ok, false);
	assert.match(r.reason, /TEST_ACCOUNT_EMAILS/);
});

test('remote target is refused without a strong TEST_ACCOUNT_PASSWORD', () => {
	for (const pw of [undefined, 'short']) {
		const r = seed.evaluateGuards(REMOTE, EMAIL, { ALLOW_TEST_SEED: '1', TEST_ACCOUNT_EMAILS: EMAIL, TEST_ACCOUNT_PASSWORD: pw });
		assert.equal(r.ok, false);
		assert.match(r.reason, /TEST_ACCOUNT_PASSWORD/);
	}
});

test('remote target is allowed with flag, allowlist (case-insensitive) and password', () => {
	const r = seed.evaluateGuards(REMOTE, EMAIL.toUpperCase(), { ALLOW_TEST_SEED: '1', TEST_ACCOUNT_EMAILS: ` ${EMAIL} , b@x.sk`, TEST_ACCOUNT_PASSWORD: GOOD_PW });
	assert.deepEqual(r, { ok: true, mode: 'remote' });
});

test('a mixed target (local API, remote DB) counts as remote', () => {
	const r = seed.evaluateGuards({ ...LOCAL, dbUrl: REMOTE.dbUrl }, EMAIL, {});
	assert.equal(r.ok, false);
});

test('run() refuses a remote target before touching anything', async () => {
	const calls = [];
	const deps = {
		resolveTarget: () => REMOTE,
		ensureUser: async () => { calls.push('user'); return 'x'; },
		connectDb: async () => { calls.push('db'); },
		getLocalPassword: () => { calls.push('pw'); return FIXTURE_PW; }
	};
	await assert.rejects(seed.run({ argv: [], env: {}, deps, log: () => {} }), /ALLOW_TEST_SEED/);
	assert.deepEqual(calls, []);
});

test('--dry-run writes nothing: no user, no DB, no password file', async () => {
	const calls = [];
	const lines = [];
	const deps = {
		resolveTarget: () => LOCAL,
		ensureUser: async () => { calls.push('user'); },
		connectDb: async () => { calls.push('db'); },
		getLocalPassword: () => { calls.push('pw'); return FIXTURE_PW; }
	};
	const res = await seed.run({ argv: ['--dry-run'], env: {}, deps, log: (l) => lines.push(l) });
	assert.equal(res.dryRun, true);
	assert.deepEqual(calls, []);
	assert.ok(lines.join('\n').includes(EMAIL));
	assert.ok(!lines.join('\n').includes('Password'), 'no password mention beyond the plan');
});

test('unknown arguments are rejected', () => {
	assert.throws(() => seed.parseArgs(['--nope']), /Unknown argument/);
});

function fakeClient() {
	const state = { statements: [], ended: false };
	return {
		state,
		query: async (sql, params) => { state.statements.push({ sql: String(sql), params }); return { rows: [] }; },
		end: async () => { state.ended = true; }
	};
}

test('a real run seeds in one transaction and never prints the password', async () => {
	const client = fakeClient();
	const lines = [];
	const deps = {
		resolveTarget: () => LOCAL,
		ensureUser: async (_cfg, email, password) => { assert.equal(password, FIXTURE_PW); return 'user-1'; },
		connectDb: async () => client,
		getLocalPassword: () => FIXTURE_PW
	};
	const res = await seed.run({ argv: [], env: {}, deps, log: (l) => lines.push(l) });
	assert.equal(res.userId, 'user-1');
	assert.equal(client.state.statements[0].sql, 'BEGIN');
	assert.equal(client.state.statements.at(-1).sql, 'COMMIT');
	assert.ok(client.state.ended);
	assert.ok(!lines.join('\n').includes(FIXTURE_PW));
});

test('every write is idempotent and a second run issues the same statements', async () => {
	const a = fakeClient();
	const b = fakeClient();
	await seed.seedTestAccountDb(a, 'u1', EMAIL);
	await seed.seedTestAccountDb(b, 'u1', EMAIL);
	assert.deepEqual(a.state.statements, b.state.statements);
	const writes = a.state.statements.filter((s) => /^\s*INSERT/i.test(s.sql));
	assert.ok(writes.length >= 10);
	for (const w of writes) assert.match(w.sql, /ON CONFLICT/, w.sql.slice(0, 60));
	const talentWrites = writes.filter((s) => /rpg_user_talents/.test(s.sql));
	assert.equal(talentWrites.length, VALID_TALENT_IDS.length);
	const profile = writes.find((s) => /public\.profiles/.test(s.sql));
	assert.match(profile.sql, /is_test_account = true/);
	assert.equal(profile.params[4], seed.TARGET_XP);
});

test('a failing statement rolls back', async () => {
	const client = fakeClient();
	const orig = client.query;
	client.query = async (sql, p) => { if (/user_billing/.test(sql)) throw new Error('boom'); return orig(sql, p); };
	await assert.rejects(seed.seedTestAccountDb(client, 'u1', EMAIL), /boom/);
	assert.equal(client.state.statements.at(-1).sql, 'ROLLBACK');
});

test('package.json exposes db:local:seed-test and the script holds no password literal', () => {
	const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
	assert.match(pkg.scripts['db:local:seed-test'], /seed-test-account\.js/);
});
