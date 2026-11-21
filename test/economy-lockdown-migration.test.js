'use strict';

// Static checks for 036_revoke_client_economy_writes.sql (C2 + M6) and for the
// browser code that used to depend on client coin writes.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const sql = read('supabase/migrations/036_revoke_client_economy_writes.sql');
const code = sql.replace(/--[^\n]*/g, '');

function grantedColumns(privilege) {
	const re = new RegExp(`GRANT\\s+${privilege}\\s*\\(([^)]*)\\)\\s*ON\\s+public\\.profiles\\s+TO\\s+authenticated`, 'i');
	const m = code.match(re);
	assert.ok(m, `expected a column-level ${privilege} grant on profiles`);
	return m[1].split(',').map((c) => c.trim()).filter(Boolean);
}

describe('036 economy lockdown migration', () => {
	it('revokes table-level INSERT/UPDATE on profiles before re-granting columns', () => {
		const revoke = code.search(/REVOKE\s+INSERT,\s*UPDATE\s+ON\s+public\.profiles\s+FROM\s+authenticated/i);
		const grant = code.search(/GRANT\s+INSERT\s*\(/i);
		assert.ok(revoke >= 0, 'missing REVOKE INSERT, UPDATE ... FROM authenticated');
		assert.ok(grant > revoke, 'column grants must come after the table-level revoke');
		assert.match(code, /REVOKE\s+INSERT,\s*UPDATE\s+ON\s+public\.profiles\s+FROM\s+anon/i);
	});

	it('never grants coins or rpg_avatar_id (or other server-owned columns) to the browser', () => {
		for (const priv of ['INSERT', 'UPDATE']) {
			const cols = grantedColumns(priv);
			for (const forbidden of ['coins', 'rpg_avatar_id', 'rpg_xp', 'competency_points', 'tier', 'email']) {
				assert.ok(!cols.includes(forbidden), `${priv} must not include ${forbidden}`);
			}
		}
		assert.doesNotMatch(code, /GRANT[^;]*\bcoins\b[^;]*ON\s+public\.profiles/i);
	});

	it('keeps every column the browser still writes', () => {
		const expected = ['id', 'display_name', 'avatar_url', 'bio', 'updated_at', 'games_generated',
			'games_exported', 'narrator_lang', 'narrator_styles', 'smarta_styles'];
		assert.deepEqual(grantedColumns('INSERT').sort(), [...expected].sort());
		assert.deepEqual(grantedColumns('UPDATE').sort(), [...expected].sort());
	});

	it('adds the pending-perk partial unique index only when the table exists', () => {
		assert.match(code, /to_regclass\('public\.rpg_perk_uses'\)\s+IS\s+NULL/i);
		assert.match(code, /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+uq_rpg_perk_uses_one_pending\s+ON\s+public\.rpg_perk_uses\s*\(user_id,\s*perk_key\)\s+WHERE\s+status\s*=\s*'pending'/i);
	});
});

describe('browser code does not write server-owned profile columns', () => {
	const files = [
		'public/js/coins.js', 'public/script.js', 'public/login.html', 'login.html',
		'public/gIVEME/script.js', 'public/js/rpg-avatar.js',
	];

	it('no supabase-js profiles upsert/update/insert payload contains coins or rpg_avatar_id', () => {
		for (const rel of files) {
			const src = read(rel);
			const writes = [...src.matchAll(/from\(['"]profiles['"]\)\s*\.(upsert|update|insert)\(\s*\{([\s\S]*?)\}/g)];
			for (const w of writes) {
				assert.doesNotMatch(w[2], /\bcoins\s*:/, `${rel} writes profiles.coins`);
				assert.doesNotMatch(w[2], /\brpg_avatar_id\s*:/, `${rel} writes profiles.rpg_avatar_id`);
			}
		}
	});

	it('coins.js never writes profiles at all', () => {
		const src = read('public/js/coins.js');
		assert.doesNotMatch(src, /from\(['"]profiles['"]\)\s*\.(upsert|update|insert)/);
	});
});
