'use strict';

// Static checks for 040_session_state_machine.sql (Phase 6).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const sql = read('supabase/migrations/040_session_state_machine.sql').replace(/--[^\n]*/g, '');
const runner = read('scripts/run-supabase-migrations.js');

describe('040 session state machine migration', () => {
	it('adds the expired status and keeps every earlier status', () => {
		assert.match(sql, /DROP CONSTRAINT IF EXISTS sessions_status_check/);
		for (const s of ['waiting', 'active', 'reflection', 'completing', 'completed', 'expired']) {
			assert.match(sql, new RegExp(`CHECK \\(status IN \\([^)]*'${s}'`), s);
		}
	});

	it('adds presence, expiry, play style and guest columns idempotently', () => {
		for (const col of ['last_host_seen_at', 'expires_at', 'play_style', 'reflection_ends_at', 'max_players',
			'allow_guests', 'host_xp_awarded', 'is_guest', 'nickname', 'guest_token_hash', 'left_at', 'last_seen_at', 'refunded_at']) {
			assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS ${col}\\b`), col);
		}
		assert.doesNotMatch(sql, /ADD COLUMN (?!IF NOT EXISTS)/);
		assert.doesNotMatch(sql, /CREATE TABLE (?!IF NOT EXISTS)/);
		assert.doesNotMatch(sql, /CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/);
	});

	it('guests can never pay, so they can never be rewarded', () => {
		assert.match(sql, /CHECK \(NOT is_guest OR coins_paid = 0\)/);
		assert.match(sql, /is_guest AND user_id IS NULL AND guest_token_hash IS NOT NULL/);
	});

	it('session_events is server-only (RLS on, no browser grants)', () => {
		assert.match(sql, /ALTER TABLE public\.session_events ENABLE ROW LEVEL SECURITY/);
		for (const role of ['PUBLIC', 'anon', 'authenticated']) {
			assert.match(sql, new RegExp(`REVOKE ALL ON public\\.session_events FROM ${role};`), role);
		}
		assert.doesNotMatch(sql, /GRANT [^;]*session_events/i);
		assert.doesNotMatch(sql, /GRANT [^;]*TO (anon|authenticated)/i, 'no new browser grants');
	});

	it('is registered in both migration orders', () => {
		const supported = runner.slice(runner.indexOf('SUPPORTED_MIGRATION_ORDER'), runner.indexOf('LEGACY_016_RELEASE_ORDER'));
		const legacy = runner.slice(runner.indexOf('LEGACY_016_RELEASE_ORDER'), runner.indexOf('LEGACY_016_USER_BILLING_COLUMNS'));
		assert.match(supported, /'040_session_state_machine\.sql'/);
		assert.match(legacy, /'040_session_state_machine\.sql'/);
		assert.match(runner, /legacy-016-to-040/);
	});
});
