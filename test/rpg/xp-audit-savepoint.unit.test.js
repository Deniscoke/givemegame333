'use strict';

/**
 * M3: a failed audit INSERT inside awardXpInTransaction must not abort the
 * caller's transaction. The mock below behaves like Postgres: after a failed
 * statement every further statement fails until ROLLBACK [TO SAVEPOINT].
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { awardXpInTransaction } = require('../../lib/rpg-progression');

function buildPgLikeClient({ failAudit }) {
	const calls = [];
	let aborted = false;
	const savepoints = [];
	return {
		calls,
		get aborted() { return aborted; },
		async query(sql) {
			const s = sql.replace(/\s+/g, ' ').trim();
			calls.push(s);
			const sp = s.match(/^ROLLBACK TO SAVEPOINT (\w+)/);
			if (sp) {
				assert.ok(savepoints.includes(sp[1]), 'rollback to an unknown savepoint');
				aborted = false;
				return { rows: [] };
			}
			if (aborted) throw new Error('current transaction is aborted, commands ignored until end of transaction block');
			if (s.startsWith('SAVEPOINT ')) { savepoints.push(s.slice(10)); return { rows: [] }; }
			if (s.startsWith('RELEASE SAVEPOINT ')) return { rows: [] };
			if (s.includes('UPDATE public.profiles')) return { rows: [{ rpg_xp: 75 }] };
			if (s.includes('INSERT INTO public.coin_transactions') && failAudit) {
				aborted = true;
				throw new Error('simulated audit failure');
			}
			return { rows: [] };
		},
	};
}

describe('awardXpInTransaction audit savepoint (M3)', () => {
	it('keeps the transaction usable when the audit INSERT fails', async () => {
		const client = buildPgLikeClient({ failAudit: true });
		const result = await awardXpInTransaction(client, 'uid', 75, 'session_complete');
		assert.equal(result.rpg_xp, 75);
		assert.equal(client.aborted, false, 'transaction must not stay aborted');
		assert.ok(client.calls.includes('SAVEPOINT rpg_xp_audit'));
		assert.ok(client.calls.includes('ROLLBACK TO SAVEPOINT rpg_xp_audit'));
		// A follow-up statement in the same transaction still works.
		await client.query('UPDATE public.sessions SET status = \'completed\' WHERE id = $1');
	});

	it('releases the savepoint when the audit INSERT succeeds', async () => {
		const client = buildPgLikeClient({ failAudit: false });
		await awardXpInTransaction(client, 'uid', 75, 'session_complete');
		assert.ok(client.calls.includes('RELEASE SAVEPOINT rpg_xp_audit'));
		assert.ok(!client.calls.some((c) => c.startsWith('ROLLBACK TO SAVEPOINT')));
	});
});
