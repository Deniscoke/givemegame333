'use strict';

// Static checks for 039_play_tickets_and_stat_xp.sql (Phase 5).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { STAT_XP_KEYS } = require('../lib/attribute-map');
const { SUPPORTED_MIGRATION_ORDER } = require('../scripts/run-supabase-migrations');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const sql = read('supabase/migrations/039_play_tickets_and_stat_xp.sql').replace(/--[^\n]*/g, '');
const TABLES = ['play_tickets', 'reflections', 'user_stat_xp'];

describe('039 play tickets, reflections, stat XP', () => {
	it('creates the three tables idempotently', () => {
		for (const t of TABLES) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${t} \\(`), t);
		assert.match(sql, /PRIMARY KEY \(user_id, stat\)/);
		assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS uq_reflections_ticket/);
		// Constraints are added only when missing.
		const adds = sql.match(/ADD CONSTRAINT (\w+)/g) || [];
		for (const a of adds) {
			const name = a.split(' ').pop();
			assert.match(sql, new RegExp(`conname = '${name}'`), `${name} guarded`);
		}
	});

	it('enables RLS and revokes every browser grant (server-only tables)', () => {
		for (const t of TABLES) {
			assert.match(sql, new RegExp(`ALTER TABLE public\\.${t}\\s+ENABLE ROW LEVEL SECURITY`), t);
			for (const role of ['PUBLIC', 'anon', 'authenticated']) {
				assert.match(sql, new RegExp(`REVOKE ALL ON public\\.${t}\\s+FROM ${role};`), `${t} ${role}`);
			}
		}
		assert.doesNotMatch(sql, /\bGRANT\b/i);
		assert.doesNotMatch(sql, /CREATE POLICY/i);
	});

	it('stat check lists exactly the attribute-map keys', () => {
		const m = sql.match(/stat IN \(([^)]*)\)/);
		assert.ok(m);
		const keys = m[1].split(',').map((s) => s.trim().replace(/'/g, ''));
		assert.deepEqual(keys, [...STAT_XP_KEYS]);
	});

	it('is registered in the migration runner and the legacy release', () => {
		assert.equal(SUPPORTED_MIGRATION_ORDER.at(-1), '039_play_tickets_and_stat_xp.sql');
		const runner = read('scripts/run-supabase-migrations.js');
		assert.equal((runner.match(/'039_play_tickets_and_stat_xp\.sql'/g) || []).length, 2);
		assert.match(runner, /legacy-016-to-039/);
		assert.match(read('docs/ENV_SETUP.md'), /legacy-016-to-039/);
	});
});
