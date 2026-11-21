'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sql = fs.readFileSync(
	path.join(__dirname, '..', 'supabase', 'migrations', '033_security_lockdown.sql'),
	'utf8'
);
// Strip line comments so assertions only match executable SQL.
const code = sql.replace(/--[^\n]*/g, '');

function grantedProfileColumns() {
	const match = code.match(/GRANT\s+SELECT\s*\(([^)]*)\)\s*ON\s+public\.profiles\s+TO\s+authenticated/i);
	assert.ok(match, 'expected a column-level SELECT grant on profiles for authenticated');
	return match[1].split(',').map((c) => c.trim()).filter(Boolean);
}

describe('033 security lockdown migration', () => {
	it('removes anonymous profile access and the USING (true) public policy', () => {
		assert.match(code, /DROP\s+POLICY\s+IF\s+EXISTS\s+"Profiles are viewable by everyone"\s+ON\s+public\.profiles/i);
		assert.match(code, /REVOKE\s+ALL\s+ON\s+public\.profiles\s+FROM\s+anon/i);
		assert.match(code, /CREATE\s+POLICY\s+"profiles_select_authenticated"\s+ON\s+public\.profiles\s+FOR\s+SELECT\s+TO\s+authenticated/i);
		assert.match(code, /REVOKE\s+SELECT\s+ON\s+public\.profiles\s+FROM\s+authenticated/i);
		assert.doesNotMatch(code, /GRANT[^;]*ON\s+public\.profiles\s+TO[^;]*\banon\b/i);
	});

	it('limits authenticated profile reads to the columns the browser uses', () => {
		const columns = grantedProfileColumns();
		for (const needed of ['id', 'display_name', 'avatar_url', 'bio', 'coins', 'games_generated', 'games_exported', 'updated_at']) {
			assert.ok(columns.includes(needed), `missing ${needed}`);
		}
		for (const secret of ['email', 'tier', 'daily_games_count', 'withdrawal_consent_ip', 'withdrawal_consent_text', 'tos_version', 'privacy_version']) {
			assert.ok(!columns.includes(secret), `${secret} must not be readable by clients`);
		}
	});

	it('keeps client coin writes (coins.js upserts coins) instead of silently breaking them', () => {
		assert.doesNotMatch(code, /REVOKE\s+UPDATE\s*\([^)]*coins/i);
		assert.match(sql, /coins\.js/);
	});

	it('removes direct client writes to sessions and session_participants', () => {
		for (const name of ['Host can insert session', 'Host can update session']) {
			assert.match(code, new RegExp(`DROP\\s+POLICY\\s+IF\\s+EXISTS\\s+"${name}"\\s+ON\\s+public\\.sessions`, 'i'));
		}
		for (const name of ['Participants insert own row', 'Participants update own row']) {
			assert.match(code, new RegExp(`DROP\\s+POLICY\\s+IF\\s+EXISTS\\s+"${name}"\\s+ON\\s+public\\.session_participants`, 'i'));
		}
		assert.match(code, /REVOKE\s+INSERT,\s*UPDATE,\s*DELETE[^;]*ON\s+public\.sessions\s+FROM\s+authenticated/i);
		assert.match(code, /REVOKE\s+INSERT,\s*UPDATE,\s*DELETE[^;]*ON\s+public\.session_participants\s+FROM\s+authenticated/i);
		assert.doesNotMatch(code, /CREATE\s+POLICY[^;]*ON\s+public\.session(s|_participants)\s+FOR\s+(INSERT|UPDATE)/i);
	});

	it('enables RLS on plan_usage_daily without client policies', () => {
		assert.match(code, /ALTER\s+TABLE\s+public\.plan_usage_daily\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i);
		assert.match(code, /REVOKE\s+ALL\s+ON\s+public\.plan_usage_daily\s+FROM\s+anon,\s*authenticated/i);
		assert.doesNotMatch(code, /CREATE\s+POLICY[^;]*ON\s+public\.plan_usage_daily/i);
	});

	it('constrains gIVEME image_data to bounded base64 image data URLs', () => {
		assert.match(code, /ADD\s+CONSTRAINT\s+giveme_posts_image_data_format\s+CHECK/i);
		assert.match(code, /image_data\s+IS\s+NULL/i);
		assert.match(code, /char_length\(image_data\)\s*<=\s*2000000/i);
		assert.match(code, /\^data:image\/\(png\|jpeg\|jpg\|gif\|webp\);base64,/);
		const constraintBlock = code.match(/giveme_posts_image_data_format\s+CHECK[\s\S]*?NOT\s+VALID/i);
		assert.ok(constraintBlock, 'image_data constraint must be NOT VALID');
	});

	it('closes the open edu_schools insert policy and the recursive membership policy', () => {
		assert.match(code, /DROP\s+POLICY\s+IF\s+EXISTS\s+"edu_schools_insert"\s+ON\s+public\.edu_schools/i);
		assert.doesNotMatch(code, /CREATE\s+POLICY\s+"edu_schools_insert"/i);
		const sm = code.match(/CREATE\s+POLICY\s+"edu_sm_select"[\s\S]*?;/i);
		assert.ok(sm);
		assert.doesNotMatch(sm[0], /edu_school_memberships\s+sm2/i, 'policy must not query its own table');
	});

	it('removes direct client writes to rpg_perk_uses', () => {
		assert.match(code, /DROP\s+POLICY\s+IF\s+EXISTS\s+"perk uses own insert"/i);
		assert.match(code, /DROP\s+POLICY\s+IF\s+EXISTS\s+"perk uses teacher decide"/i);
	});

	it('is idempotent: every policy/constraint change is guarded', () => {
		const created = [...code.matchAll(/CREATE\s+POLICY\s+"([^"]+)"\s+ON\s+(public\.\w+)/gi)];
		assert.ok(created.length > 0);
		for (const [, name, table] of created) {
			const drop = new RegExp(`DROP\\s+POLICY\\s+IF\\s+EXISTS\\s+"${name}"\\s+ON\\s+${table.replace('.', '\\.')}`, 'i');
			assert.match(code, drop, `CREATE POLICY "${name}" needs a preceding DROP POLICY IF EXISTS`);
		}
		assert.doesNotMatch(code, /DROP\s+POLICY\s+(?!IF\s+EXISTS)/i);
		const constraints = [...code.matchAll(/ADD\s+CONSTRAINT\s+(\w+)/gi)].map((m) => m[1]);
		assert.ok(constraints.length >= 1);
		for (const name of constraints) {
			assert.match(code, new RegExp(`IF\\s+NOT\\s+EXISTS\\s*\\([\\s\\S]*?conname\\s*=\\s*'${name}'`, 'i'), `${name} needs an existence guard`);
		}
		const addConstraintCount = constraints.length;
		const notValidCount = (code.match(/NOT\s+VALID/gi) || []).length;
		assert.equal(notValidCount, addConstraintCount, 'every new constraint must be NOT VALID');
		assert.doesNotMatch(code, /CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)/i);
	});

	it('keeps the UPDATE privilege the gIVEME like upsert (ON CONFLICT DO UPDATE) needs', () => {
		const frontend = fs.readFileSync(path.join(__dirname, '..', 'public', 'gIVEME', 'script.js'), 'utf8');
		const usesUpsert = /from\(['"]giveme_likes['"]\)\s*\.upsert\(/.test(frontend);
		const tableRevokes = [...code.matchAll(/REVOKE\s+([^;]*?)\s+ON\s+([^;]*?)\s+FROM\s+([^;]*);/gi)]
			.filter(([, privs, tables, roles]) => /\bUPDATE\b|\bALL\b/i.test(privs)
				&& /public\.giveme_likes\b/i.test(tables)
				&& /\bauthenticated\b/i.test(roles));
		if (usesUpsert || tableRevokes.length > 0) {
			assert.match(code, /GRANT\s+UPDATE\s*\(\s*post_id\s*,\s*user_id\s*\)\s*ON\s+public\.giveme_likes\s+TO\s+authenticated/i,
				'authenticated must keep UPDATE (post_id, user_id) on giveme_likes for the double-tap upsert');
			// The column grant must come after every table-level revoke, or the revoke wipes it.
			const grantAt = code.search(/GRANT\s+UPDATE\s*\(\s*post_id/i);
			for (const r of tableRevokes) {
				assert.ok(code.indexOf(r[0]) < grantAt, 'UPDATE revoke on giveme_likes must precede the column grant');
			}
		}
		assert.doesNotMatch(code, /CREATE\s+POLICY[^;]*ON\s+public\.giveme_likes\s+FOR\s+(UPDATE|ALL)/i);
	});

	it('removes anonymous access to assessment tables and hides correct_answer', () => {
		assert.match(code, /REVOKE\s+ALL\s+ON\s+public\.assessments,\s*public\.assessment_questions,\s*public\.assessment_attempts,\s*public\.assessment_answers\s+FROM\s+PUBLIC,\s*anon/i);
		assert.match(code, /REVOKE\s+SELECT\s+ON\s+public\.assessment_questions\s+FROM\s+authenticated/i);
		const m = code.match(/GRANT\s+SELECT\s*\(([^)]*)\)\s*ON\s+public\.assessment_questions\s+TO\s+authenticated/i);
		assert.ok(m, 'expected column-level SELECT on assessment_questions');
		const cols = m[1].split(',').map((c) => c.trim());
		assert.ok(cols.includes('prompt') && cols.includes('options'));
		assert.ok(!cols.includes('correct_answer'), 'correct_answer must not be client-readable');
		assert.ok(code.search(/REVOKE\s+SELECT\s+ON\s+public\.assessment_questions/i)
			< code.search(/GRANT\s+SELECT\s*\([^)]*\)\s*ON\s+public\.assessment_questions/i));
	});

	it('does not drop tables, columns or data', () => {
		assert.doesNotMatch(code, /\bDROP\s+(TABLE|COLUMN|SCHEMA)\b/i);
		assert.doesNotMatch(code, /\b(DELETE\s+FROM|TRUNCATE\s+(TABLE\s+)?public)\b/i);
	});
});
