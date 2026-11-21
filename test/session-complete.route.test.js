'use strict';

/**
 * Route-level tests for the Phase 0 session economy fixes:
 *   C1  /complete pays rewards and marks the session completed (it used to
 *       throw a ReferenceError and always answer 500)
 *   H1  /start charges only participants who can pay
 *   M1  a double /start charges once; errors do not leak err.message
 *   M2  unpaid participants are never rewarded
 *   M4  stats_after holds flat stat values including talent bonuses
 *   M9  session create answers (instead of hanging) when the DB fails
 *
 * Uses test/helpers/economy-harness.js (real server.js, in-memory pg fake).
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startEconomyServer } = require('./helpers/economy-harness');

const HOST = 'user-host';
const P1 = 'user-p1';
const P2 = 'user-p2';
const POOR = 'user-poor';

let h;

function seedSession(db, { id = 'sess-1', code = 'ABC123', status = 'waiting', startedMinAgo = null, game = {} } = {}) {
	db.state.sessions[id] = {
		id,
		host_id: HOST,
		join_code: code,
		status,
		game_json: {
			title: 'Test hra',
			duration: { min: 5, max: 15 },
			playerCount: { min: 2, max: 10 },
			rvp: { kompetence: ['komunikativni', 'k-reseni-problemu', 'neplatny-kluc'] },
			...game,
		},
		started_at: startedMinAgo == null ? null : new Date(Date.now() - startedMinAgo * 60000).toISOString(),
		completed_at: null,
		reward_validation: null,
	};
	return db.state.sessions[id];
}

function join(db, sessionId, userId, extra = {}) {
	db.state.participants.push({
		session_id: sessionId, user_id: userId, coins_paid: 0, reflection_done: false,
		awarded_competencies: null, joined_at: new Date().toISOString(), ...extra,
	});
}

function profile(db, id, coins, extra = {}) {
	db.state.profiles[id] = { coins, rpg_xp: 0, rpg_avatar_id: null, ...extra };
}

before(async () => { h = await startEconomyServer(); });
after(async () => { await h.stop(); });
beforeEach(() => {
	h.db.state = { profiles: {}, sessions: {}, participants: [], tx: [], talents: [] };
});

describe('POST /api/sessions/:code/start', () => {
	it('charges every participant who can pay and skips the one who cannot (H1)', async () => {
		const { db } = h;
		profile(db, HOST, 0);
		profile(db, P1, 150);
		profile(db, POOR, 40);
		seedSession(db);
		join(db, 'sess-1', P1);
		join(db, 'sess-1', POOR);

		const res = await h.call('POST', '/api/sessions/ABC123/start', { user: HOST });
		assert.equal(res.status, 200, JSON.stringify(res.body));
		assert.equal(res.body.participants_charged, 1);
		assert.equal(res.body.participants_unpaid, 1);
		assert.equal(db.state.profiles[P1].coins, 50);
		assert.equal(db.state.profiles[POOR].coins, 40, 'no GREATEST(0, …) clamp: the poor player is not touched');
		assert.equal(db.part('sess-1', POOR).coins_paid, 0, 'unpaid player keeps coins_paid = 0');
		assert.equal(db.part('sess-1', P1).coins_paid, 100);
		assert.deepEqual(db.state.tx.map((t) => [t.user_id, t.amount, t.action]), [[P1, -100, 'session_join']]);
		assert.equal(db.session('sess-1').status, 'active');
	});

	it('a second /start (sequential or parallel) charges nobody again (M1)', async () => {
		const { db } = h;
		profile(db, HOST, 0);
		profile(db, P1, 500);
		seedSession(db);
		join(db, 'sess-1', P1);

		const [a, b] = await Promise.all([
			h.call('POST', '/api/sessions/ABC123/start', { user: HOST }),
			h.call('POST', '/api/sessions/ABC123/start', { user: HOST }),
		]);
		const statuses = [a.status, b.status].sort();
		assert.deepEqual(statuses, [200, 409]);
		const again = await h.call('POST', '/api/sessions/ABC123/start', { user: HOST });
		assert.equal(again.status, 409);
		assert.equal(db.state.profiles[P1].coins, 400, 'charged exactly once');
		assert.equal(db.state.tx.filter((t) => t.action === 'session_join').length, 1);
	});

	it('five lobbies with one 100-coin player make at most one payer', async () => {
		const { db } = h;
		profile(db, HOST, 0);
		profile(db, P1, 100);
		for (let i = 0; i < 5; i++) {
			seedSession(db, { id: `s${i}`, code: `CODE${i}` });
			join(db, `s${i}`, P1);
		}
		await Promise.all([0, 1, 2, 3, 4].map((i) => h.call('POST', `/api/sessions/CODE${i}/start`, { user: HOST })));
		const paid = db.state.participants.filter((p) => p.coins_paid > 0).length;
		assert.equal(paid, 1);
		assert.equal(db.state.profiles[P1].coins, 0);
	});

	it('does not leak internal error messages', async () => {
		const { db } = h;
		profile(db, HOST, 0);
		seedSession(db);
		join(db, 'sess-1', 'user-ghost'); // no profile row → the fake UPDATE finds nothing → unpaid, fine
		const original = db.exec.bind(db);
		db.exec = (sql, params) => {
			if (/SET status = 'active', timer_ends_at/.test(sql)) throw new Error('secret internal detail');
			return original(sql, params);
		};
		try {
			const res = await h.call('POST', '/api/sessions/ABC123/start', { user: HOST });
			assert.equal(res.status, 500);
			assert.equal(res.body.code, 'START_ERROR');
			assert.ok(!JSON.stringify(res.body).includes('secret internal detail'));
			assert.equal(db.session('sess-1').status, 'waiting');
		} finally {
			db.exec = original;
		}
	});
});

describe('POST /api/sessions/:code/complete (C1)', () => {
	it('passing gates pays every reflecting payer +100 coins and +75 XP and completes the session', async () => {
		const { db } = h;
		profile(db, HOST, 0, { rpg_avatar_id: 2 });
		profile(db, P1, 0);
		profile(db, P2, 0);
		db.state.talents.push({ user_id: HOST, talent_id: 201 });
		seedSession(db, { status: 'active', startedMinAgo: 20 });
		join(db, 'sess-1', P1, { coins_paid: 100, reflection_done: true });
		join(db, 'sess-1', P2, { coins_paid: 100, reflection_done: true });

		const res = await h.call('POST', '/api/sessions/ABC123/complete', { user: HOST });
		assert.equal(res.status, 200, JSON.stringify(res.body));
		assert.equal(res.body.ok, true);
		assert.equal(res.body.participants_rewarded, 2);
		assert.equal(db.session('sess-1').status, 'completed');
		for (const id of [P1, P2]) {
			assert.equal(db.state.profiles[id].coins, 100, `${id} coins`);
			assert.equal(db.state.profiles[id].rpg_xp, 75, `${id} xp`);
		}
		const v = db.session('sess-1').reward_validation;
		assert.equal(v.passed, true);
		assert.equal(v.duration_required_min, 5);
		assert.equal(v.participants_required, 2);
		assert.equal(v.participants_actual, 2);
		assert.deepEqual(v.competencies_awarded, ['komunikativni', 'k-reseni-problemu']);
		assert.deepEqual(res.body.validation, v);

		// M4: flat stats with the talent bonus (201 = ucenie tier 1 → focus +3 over the base 10).
		assert.equal(typeof res.body.stats_after.focus, 'number');
		assert.ok(!('effective' in res.body.stats_after));
		assert.equal(res.body.stats_after.focus, 13);
	});

	it('never rewards a reflecting participant who did not pay (M2)', async () => {
		const { db } = h;
		profile(db, HOST, 0);
		profile(db, P1, 0);
		profile(db, P2, 0);
		profile(db, POOR, 0);
		seedSession(db, { status: 'reflection', startedMinAgo: 20 });
		join(db, 'sess-1', P1, { coins_paid: 100, reflection_done: true });
		join(db, 'sess-1', P2, { coins_paid: 100, reflection_done: true });
		join(db, 'sess-1', POOR, { coins_paid: 0, reflection_done: true });

		const res = await h.call('POST', '/api/sessions/ABC123/complete', { user: HOST });
		assert.equal(res.status, 200, JSON.stringify(res.body));
		assert.equal(res.body.participants_rewarded, 2);
		assert.equal(db.state.profiles[POOR].coins, 0);
		assert.equal(db.state.profiles[POOR].rpg_xp, 0);
		assert.equal(db.part('sess-1', POOR).awarded_competencies, null);
	});

	it('fails the participant gate when only one player paid', async () => {
		const { db } = h;
		profile(db, HOST, 0);
		profile(db, P1, 0);
		seedSession(db, { status: 'active', startedMinAgo: 20 });
		join(db, 'sess-1', P1, { coins_paid: 100, reflection_done: true });
		const res = await h.call('POST', '/api/sessions/ABC123/complete', { user: HOST });
		assert.equal(res.status, 422);
		assert.equal(res.body.code, 'NOT_ENOUGH_PLAYERS');
		assert.equal(db.session('sess-1').status, 'active');
	});

	it('rolls back and frees the session when the reward transaction fails', async () => {
		const { db } = h;
		profile(db, HOST, 0);
		profile(db, P1, 0);
		profile(db, P2, 0);
		seedSession(db, { status: 'active', startedMinAgo: 20 });
		join(db, 'sess-1', P1, { coins_paid: 100, reflection_done: true });
		join(db, 'sess-1', P2, { coins_paid: 100, reflection_done: true });
		const original = db.exec.bind(db);
		let n = 0;
		db.exec = (sql, params) => {
			if (/SET rpg_xp = LEAST/.test(sql) && ++n === 2) throw new Error('boom');
			return original(sql, params);
		};
		try {
			const res = await h.call('POST', '/api/sessions/ABC123/complete', { user: HOST });
			assert.equal(res.status, 500);
			assert.equal(db.session('sess-1').status, 'active');
			assert.equal(db.state.profiles[P1].coins, 0, 'first payer rolled back');
		} finally {
			db.exec = original;
		}
	});
});

describe('POST /api/sessions (M9)', () => {
	it('answers 500 instead of hanging when the join-code lookup fails', async () => {
		const { db } = h;
		const original = db.exec.bind(db);
		db.exec = (sql, params) => {
			if (/FROM public\.sessions WHERE join_code/.test(sql)) throw new Error('db down');
			return original(sql, params);
		};
		try {
			const ctrl = AbortSignal.timeout(3000);
			const res = await fetch(`${h.baseUrl}/api/sessions`, {
				method: 'POST', signal: ctrl,
				headers: { 'content-type': 'application/json', Authorization: `Bearer ${HOST}` },
				body: JSON.stringify({ game_json: { title: 'X' } }),
			});
			assert.equal(res.status, 500);
			assert.equal((await res.json()).code, 'CREATE_ERROR');
		} finally {
			db.exec = original;
		}
	});
});
