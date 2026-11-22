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

	it('allows local tickets and indexes generated tickets by content hash', () => {
		assert.match(sql, /CHECK \(source IN \('generated', 'library', 'replay', 'local'\)\)/);
		// An older copy of the check without 'local' is replaced on re-run.
		assert.match(sql, /pg_get_constraintdef\(oid\) LIKE '%local%'/);
		assert.match(sql, /DROP CONSTRAINT IF EXISTS play_tickets_source_check/);
		assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_play_tickets_generated_hash ON public\.play_tickets \(game_hash\)\s+WHERE source = 'generated'/);
	});

	it('stat check lists exactly the attribute-map keys', () => {
		const m = sql.match(/stat IN \(([^)]*)\)/);
		assert.ok(m);
		const keys = m[1].split(',').map((s) => s.trim().replace(/'/g, ''));
		assert.deepEqual(keys, [...STAT_XP_KEYS]);
	});

	it('is registered in the migration runner and the legacy release', () => {
		assert.ok(SUPPORTED_MIGRATION_ORDER.includes('039_play_tickets_and_stat_xp.sql'));
		const runner = read('scripts/run-supabase-migrations.js');
		assert.equal((runner.match(/'039_play_tickets_and_stat_xp\.sql'/g) || []).length, 2);
		assert.match(runner, /legacy-016-to-0(39|40|41)/);
		assert.match(read('docs/ENV_SETUP.md'), /legacy-016-to-0(39|40|41)/);
	});
});

describe('Phase 5 rollout docs', () => {
	it('documents the flag and the two-week legacy window', () => {
		const env = read('docs/ENV_SETUP.md');
		const { DEFAULT_LEGACY_UNTIL } = require('../lib/play-tickets');
		assert.match(env, /PLAY_TICKETS_ENABLED/);
		assert.match(env, /PLAY_TICKETS_LEGACY_UNTIL/);
		assert.ok(env.includes(DEFAULT_LEGACY_UNTIL), 'docs name the default end date');
		assert.match(read('.env.example'), /PLAY_TICKETS_ENABLED/);
	});
});
