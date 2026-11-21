'use strict';

// Static checks for the P0 review migrations (037 donations server-only,
// 038 one-time balance reconciliation) and the gIVEME donation client.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripComments = (sql) => sql.replace(/--[^\n]*/g, '');
const m037 = stripComments(read('supabase/migrations/037_giveme_donations_server_only.sql'));
const m038 = stripComments(read('supabase/migrations/038_reconcile_browser_only_balances.sql'));
const giveme = read('public/gIVEME/script.js');

describe('037 gIVEME donations are server-only', () => {
	it('revokes browser INSERT on giveme_coin_donations and drops the insert policy', () => {
		for (const role of ['PUBLIC', 'anon', 'authenticated']) {
			assert.match(m037, new RegExp(`REVOKE\\s+INSERT[^;]*ON\\s+public\\.giveme_coin_donations\\s+FROM\\s+${role}\\s*;`, 'i'), role);
		}
		assert.match(m037, /DROP POLICY IF EXISTS "Users can insert own donation" ON public\.giveme_coin_donations/);
		assert.doesNotMatch(m037, /GRANT\s+[^;]*INSERT[^;]*giveme_coin_donations/i);
	});

	it('is guarded for databases without the table', () => {
		assert.match(m037, /to_regclass\('public\.giveme_coin_donations'\) IS NULL/);
	});

	it('the gIVEME client donates through the server route, not a direct insert', () => {
		assert.doesNotMatch(giveme, /from\('giveme_coin_donations'\)\s*\.insert/);
		assert.match(giveme, /fetch\('\/api\/giveme\/donate'/);
		const send = giveme.slice(giveme.indexOf('async function sendCoins'), giveme.indexOf('function sendCustomCoins'));
		assert.doesNotMatch(send, /spendAmount|localStorage\.setItem/, 'no local-only deduction');
	});
});

describe('038 one-time balance reconciliation', () => {
	it('runs once, guarded by a marker row', () => {
		assert.match(m038, /CREATE TABLE IF NOT EXISTS public\.economy_migration_markers/);
		assert.match(m038, /IF EXISTS \(SELECT 1 FROM public\.economy_migration_markers WHERE key = '038_reconcile_browser_only_balances'\)/);
		assert.match(m038, /INSERT INTO public\.economy_migration_markers/);
		assert.match(m038, /REVOKE ALL ON public\.economy_migration_markers FROM authenticated/);
	});

	it('uses ledger evidence with donations, never lowers and never exceeds the ceiling', () => {
		assert.match(m038, /SUM\(amount\)[\s\S]*FROM public\.coin_transactions/);
		assert.match(m038, /ledger_sum - donated \+ received/);
		assert.match(m038, /reconcile_ceiling CONSTANT integer := 25000/);
		assert.match(m038, /LEAST\(ledger_sum - donated \+ received, reconcile_ceiling\) > previous_coins/);
		assert.doesNotMatch(m038, /localStorage/i);
	});

	it('records every raise as an auditable balance_reconcile ledger row', () => {
		assert.match(m038, /'balance_reconcile'/);
		assert.match(m038, /'previous_coins', previous_coins/);
	});
});
