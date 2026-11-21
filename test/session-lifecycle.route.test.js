'use strict';

/**
 * Route-level tests for the Phase 6 session state machine
 * (lib/routes/sessions.js) through the real server.js and the in-memory
 * pg fake (test/helpers/economy-harness.js + session-sql-fake.js).
 *
 * Playwright is not installed in this repo, so the two-device flows (host
 * rejoin from another device, a player dropping out and coming back) are
 * covered here at route level.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startEconomyServer } = require('./helpers/economy-harness');

const HOST = 'user-host';
const P1 = 'user-p1';
const P2 = 'user-p2';
const P3 = 'user-p3';
const STRANGER = 'user-stranger';

let h;
const minAgo = (m) => new Date(Date.now() - m * 60000).toISOString();

function profile(id, coins, extra = {}) {
	h.db.state.profiles[id] = { coins, rpg_xp: 0, rpg_avatar_id: null, ...extra };
}

function seed({ id = 'sess-1', code = 'ABC123', status = 'waiting', ...rest } = {}) {
	h.db.state.sessions[id] = {
		id, host_id: HOST, join_code: code, status,
		game_json: { title: 'Test hra', duration: { min: 5, max: 15 }, playerCount: { min: 2, max: 10 }, rvp: { kompetence: ['komunikativni'] } },
		started_at: null, completed_at: null, reward_validation: null,
		expires_at: new Date(Date.now() + 3600000).toISOString(), last_host_seen_at: new Date().toISOString(),
		play_style: 'room', max_players: 10, allow_guests: true, host_xp_awarded: 0,
		...rest,
	};
	return h.db.state.sessions[id];
}

function join(sessionId, userId, extra = {}) {
	h.db.state.participants.push({
		id: `sp-${userId}-${sessionId}`, session_id: sessionId, user_id: userId, is_guest: false, nickname: null,
		coins_paid: 0, reflection_done: false, awarded_competencies: null, joined_at: new Date().toISOString(),
		last_seen_at: new Date().toISOString(), left_at: null, ...extra,
	});
}

const part = (sid, uid) => h.db.part(sid, uid);

before(async () => { h = await startEconomyServer(); });
after(async () => { await h.stop(); });
beforeEach(() => {
	h.db.state = { profiles: {}, sessions: {}, participants: [], tx: [], talents: [], events: [] };
});

describe('create', () => {
	it('stores the play style, lobby size, guest flag and a TTL; clamps reward gates (H2)', async () => {
		profile(HOST, 0);
		const res = await h.call('POST', '/api/sessions', {
			user: HOST,
			body: { game_json: { title: 'Online hra', mode: 'online', playerCount: { min: 1 }, duration: { min: 0 } }, max_players: 6, allow_guests: false },
		});
		assert.equal(res.status, 200, JSON.stringify(res.body));
		assert.equal(res.body.play_style, 'online', 'online mode defaults to the online play style');
		assert.equal(res.body.max_players, 6);
		assert.equal(res.body.allow_guests, false);
		assert.equal(res.body.my_role, 'host');
		const row = h.db.state.sessions[res.body.id];
		assert.equal(row.game_json.playerCount.min, 2);
		assert.equal(row.game_json.duration.min, 3);
		assert.ok(new Date(row.expires_at) > new Date());
	});
});

describe('lobby settings', () => {
	it('the host changes the lobby size, guests and play style before start only', async () => {
		profile(HOST, 0);
		seed();
		const res = await h.call('POST', '/api/sessions/ABC123/settings', { user: HOST, body: { max_players: 4, allow_guests: false, play_style: 'online' } });
		assert.equal(res.status, 200, JSON.stringify(res.body));
		assert.deepEqual([res.body.max_players, res.body.allow_guests, res.body.play_style], [4, false, 'online']);
		assert.equal((await h.call('POST', '/api/sessions/ABC123/settings', { user: P1, body: { max_players: 40 } })).status, 403);
		h.db.session('sess-1').status = 'active';
		assert.equal((await h.call('POST', '/api/sessions/ABC123/settings', { user: HOST, body: { max_players: 40 } })).status, 409);
		assert.equal(h.db.session('sess-1').max_players, 4);
	});
});

describe('transitions', () => {
	it('walks waiting → active → reflection → completed', async () => {
		profile(HOST, 0); profile(P1, 200); profile(P2, 200);
		seed();
		join('sess-1', P1); join('sess-1', P2);

		assert.equal((await h.call('POST', '/api/sessions/ABC123/start', { user: HOST })).status, 200);
		assert.equal(h.db.session('sess-1').status, 'active');
		assert.ok(h.db.session('sess-1').expires_at > h.db.session('sess-1').timer_ends_at, 'TTL moves past the timer');

		const refl = await h.call('POST', '/api/sessions/ABC123/reflection', { user: HOST });
		assert.equal(refl.status, 200);
		assert.equal(h.db.session('sess-1').status, 'reflection');
		assert.ok(h.db.session('sess-1').reflection_ends_at);

		for (const u of [P1, P2]) {
			assert.equal((await h.call('POST', '/api/sessions/ABC123/reflect', { user: u, body: { reflection_data: { a: 1 } } })).status, 200);
		}
		h.db.session('sess-1').started_at = minAgo(20);
		const done = await h.call('POST', '/api/sessions/ABC123/complete', { user: HOST });
		assert.equal(done.status, 200, JSON.stringify(done.body));
		assert.equal(h.db.session('sess-1').status, 'completed');
		const events = h.db.state.events.map((e) => e.event);
		assert.deepEqual(events, ['started', 'reflection', 'completed']);
	});

	it('the server opens reflection by itself once the timer ran out', async () => {
		profile(HOST, 0); profile(P1, 0);
		seed({ status: 'active', started_at: minAgo(20), timer_ends_at: minAgo(1) });
		join('sess-1', P1, { coins_paid: 100 });
		const res = await h.call('GET', '/api/sessions/ABC123', { user: P1 });
		assert.equal(res.status, 200);
		assert.equal(res.body.status, 'reflection');
		assert.ok(res.body.reflection_ends_at);
		assert.equal(h.db.session('sess-1').status, 'reflection');
	});

	it('rejects illegal transitions', async () => {
		profile(HOST, 0);
		seed();
		// waiting → reflection / completing
		assert.equal((await h.call('POST', '/api/sessions/ABC123/reflection', { user: HOST })).body.code, 'WRONG_STATUS');
		assert.equal((await h.call('POST', '/api/sessions/ABC123/complete', { user: HOST })).body.code, 'WRONG_STATUS');
		// completed → anything
		seed({ id: 'sess-2', code: 'DONE22', status: 'completed', completed_at: new Date().toISOString() });
		assert.equal((await h.call('POST', '/api/sessions/DONE22/start', { user: HOST })).status, 409);
		assert.equal((await h.call('POST', '/api/sessions/DONE22/reflection', { user: HOST })).status, 409);
		assert.equal((await h.call('POST', '/api/sessions/DONE22/complete', { user: HOST })).body.code, 'ALREADY_COMPLETED');
		// expired → start / complete
		seed({ id: 'sess-3', code: 'GONE33', status: 'expired' });
		assert.equal((await h.call('POST', '/api/sessions/GONE33/start', { user: HOST })).status, 410);
		assert.equal((await h.call('POST', '/api/sessions/GONE33/complete', { user: HOST })).status, 410);
		// only the host moves the session
		seed({ id: 'sess-4', code: 'ACTV44', status: 'active', started_at: minAgo(1), timer_ends_at: new Date(Date.now() + 600000).toISOString() });
		join('sess-4', P1);
		assert.equal((await h.call('POST', '/api/sessions/ACTV44/reflection', { user: P1 })).status, 403);
		assert.equal(h.db.session('sess-4').status, 'active');
	});

	it('a failed reward transaction returns the session to its exact earlier state', async () => {
		profile(HOST, 0); profile(P1, 0); profile(P2, 0);
		seed({ status: 'reflection', started_at: minAgo(20) });
		join('sess-1', P1, { coins_paid: 100, reflection_done: true });
		join('sess-1', P2, { coins_paid: 100, reflection_done: true });
		const original = h.db.exec.bind(h.db);
		h.db.exec = (sql, params) => {
			if (/SET rpg_xp = LEAST/.test(sql)) throw new Error('boom');
			return original(sql, params);
		};
		try {
			assert.equal((await h.call('POST', '/api/sessions/ABC123/complete', { user: HOST })).status, 500);
			assert.equal(h.db.session('sess-1').status, 'reflection');
		} finally {
			h.db.exec = original;
		}
	});
});

describe('leave and presence before start (H6)', () => {
	it('a player who left before start is not charged', async () => {
		profile(HOST, 0); profile(P1, 300); profile(P2, 300);
		seed();
		join('sess-1', P1); join('sess-1', P2);
		const left = await h.call('POST', '/api/sessions/ABC123/leave', { user: P1 });
		assert.equal(left.status, 200);
		assert.equal(left.body.charged, false);

		const start = await h.call('POST', '/api/sessions/ABC123/start', { user: HOST });
		assert.equal(start.body.participants_charged, 1);
		assert.equal(h.db.state.profiles[P1].coins, 300, 'left player untouched');
		assert.equal(h.db.state.profiles[P2].coins, 200);
	});

	it('a player unseen for too long is marked absent and not charged', async () => {
		profile(HOST, 0); profile(P1, 300); profile(P2, 300);
		seed();
		join('sess-1', P1, { last_seen_at: minAgo(30) });
		join('sess-1', P2);
		const start = await h.call('POST', '/api/sessions/ABC123/start', { user: HOST });
		assert.equal(start.body.participants_absent, 1);
		assert.equal(start.body.participants_charged, 1);
		assert.equal(h.db.state.profiles[P1].coins, 300);
		assert.ok(part('sess-1', P1).left_at);
	});

	it('rejoining before start clears left_at; a heartbeat refreshes presence', async () => {
		profile(HOST, 0); profile(P1, 300);
		seed();
		join('sess-1', P1, { left_at: minAgo(1), last_seen_at: minAgo(10) });
		const rj = await h.call('POST', '/api/sessions/ABC123/join', { user: P1 });
		assert.equal(rj.body.rejoined, true);
		assert.equal(part('sess-1', P1).left_at, null);
		const hb = await h.call('POST', '/api/sessions/ABC123/heartbeat', { user: P1 });
		assert.equal(hb.status, 200);
		assert.equal(hb.body.my_role, 'player');
		assert.ok(Date.now() - new Date(part('sess-1', P1).last_seen_at) < 5000);
	});

	it('the lobby cap is enforced', async () => {
		profile(HOST, 0); profile(P1, 300); profile(P2, 300); profile(P3, 300);
		seed({ max_players: 2 });
		assert.equal((await h.call('POST', '/api/sessions/ABC123/join', { user: P1 })).status, 200);
		assert.equal((await h.call('POST', '/api/sessions/ABC123/join', { user: P2 })).status, 200);
		const full = await h.call('POST', '/api/sessions/ABC123/join', { user: P3 });
		assert.equal(full.status, 409);
		assert.equal(full.body.code, 'LOBBY_FULL');
	});
});

describe('expiry with refund', () => {
	it('an expired active session refunds every unrewarded payer exactly once (lazy check)', async () => {
		profile(HOST, 0); profile(P1, 0); profile(P2, 0);
		seed({ status: 'active', started_at: minAgo(200), expires_at: minAgo(1) });
		join('sess-1', P1, { coins_paid: 100 });
		join('sess-1', P2, { coins_paid: 0 });

		const res = await h.call('GET', '/api/sessions/ABC123', { user: P1 });
		assert.equal(res.body.status, 'expired');
		assert.equal(h.db.state.profiles[P1].coins, 100);
		assert.equal(h.db.state.profiles[P2].coins, 0, 'an unpaid player gets nothing back');
		assert.ok(part('sess-1', P1).refunded_at);
		assert.deepEqual(h.db.state.tx.map((t) => [t.user_id, t.amount, t.action]), [[P1, 100, 'session_refund']]);

		await h.call('GET', '/api/sessions/ABC123', { user: P1 });
		assert.equal(await h.app.locals.sweepExpiredSessions(), 0);
		assert.equal(h.db.state.profiles[P1].coins, 100, 'no double refund');
	});

	it('the sweep expires sessions whose host is gone', async () => {
		profile(HOST, 0); profile(P1, 0);
		seed({ status: 'active', started_at: minAgo(40), last_host_seen_at: minAgo(45) });
		join('sess-1', P1, { coins_paid: 100 });
		assert.equal(await h.app.locals.sweepExpiredSessions(), 1);
		assert.equal(h.db.session('sess-1').status, 'expired');
		assert.equal(h.db.session('sess-1').expire_reason, 'host_absent');
		assert.equal(h.db.state.profiles[P1].coins, 100);
	});

	it('a host phone locked during a long game does not expire it; the host can still complete', async () => {
		profile(HOST, 0); profile(P1, 0); profile(P2, 0);
		// 40-minute room game, started 38 min ago; host unseen since the start.
		seed({
			status: 'active', started_at: minAgo(38), last_host_seen_at: minAgo(38),
			timer_ends_at: new Date(Date.now() + 2 * 60000).toISOString(), expires_at: new Date(Date.now() + 72 * 60000).toISOString(),
			game_json: { title: 'Dlhá hra', duration: { min: 30, max: 40 }, playerCount: { min: 2, max: 10 }, rvp: { kompetence: [] } },
		});
		join('sess-1', P1, { coins_paid: 100, reflection_done: true });
		join('sess-1', P2, { coins_paid: 100, reflection_done: true });
		assert.equal(await h.app.locals.sweepExpiredSessions(), 0);
		const poll = await h.call('POST', '/api/sessions/ABC123/heartbeat', { user: P1 });
		assert.equal(poll.body.status, 'active');

		const done = await h.call('POST', '/api/sessions/ABC123/complete', { user: HOST });
		assert.equal(done.status, 200, JSON.stringify(done.body));
		assert.equal(done.body.participants_rewarded, 2);
	});

	it('the host coming back records presence before the expiry check', async () => {
		profile(HOST, 0); profile(P1, 0);
		// Reflection ended 31 min ago, host unseen since: the host-absent window has passed.
		seed({ status: 'reflection', started_at: minAgo(60), last_host_seen_at: minAgo(55), reflection_ends_at: minAgo(31) });
		join('sess-1', P1, { coins_paid: 100, reflection_done: true });
		const back = await h.call('POST', '/api/sessions/ABC123/heartbeat', { user: HOST });
		assert.equal(back.body.status, 'reflection', 'the host return itself never expires the game');
		assert.equal(h.db.state.profiles[P1].coins, 0, 'no refund');
		assert.ok(Date.now() - new Date(h.db.session('sess-1').last_host_seen_at).getTime() < 5000);
	});

	it('the host can cancel an open session, which refunds payers', async () => {
		profile(HOST, 0); profile(P1, 0);
		seed({ status: 'active', started_at: minAgo(2) });
		join('sess-1', P1, { coins_paid: 100 });
		const res = await h.call('POST', '/api/sessions/ABC123/leave', { user: HOST });
		assert.equal(res.body.cancelled, true);
		assert.equal(h.db.session('sess-1').expire_reason, 'host_cancelled');
		assert.equal(h.db.state.profiles[P1].coins, 100);
	});

	it('rewarded players are never refunded', async () => {
		profile(HOST, 0); profile(P1, 0);
		seed({ status: 'reflection', expires_at: minAgo(1) });
		join('sess-1', P1, { coins_paid: 100, awarded_competencies: { rpg: true } });
		await h.app.locals.sweepExpiredSessions();
		assert.equal(h.db.state.profiles[P1].coins, 0);
	});
});

describe('guests', () => {
	it('join with a nickname, read the session, reflect, and earn nothing', async () => {
		profile(HOST, 0); profile(P1, 0); profile(P2, 0);
		seed();
		const g = await h.call('POST', '/api/sessions/ABC123/join-guest', { body: { nickname: '  Miško ' } });
		assert.equal(g.status, 200, JSON.stringify(g.body));
		assert.equal(g.body.nickname, 'Miško');
		const token = g.body.guest_token;
		assert.ok(token);
		const row = h.db.state.participants.find((p) => p.is_guest);
		assert.notEqual(row.guest_token_hash, token, 'only the hash is stored');

		const view = await h.call('GET', '/api/sessions/ABC123', { guest: token });
		assert.equal(view.body.my_role, 'guest');
		assert.equal(view.body.me.is_guest, true);
		assert.ok(!JSON.stringify(view.body).includes(row.guest_token_hash));

		join('sess-1', P1); join('sess-1', P2);
		h.db.state.profiles[P1].coins = 100; h.db.state.profiles[P2].coins = 100;
		const start = await h.call('POST', '/api/sessions/ABC123/start', { user: HOST });
		assert.equal(start.body.participants_charged, 2, 'the guest is never charged');
		assert.equal(row.coins_paid, 0);

		assert.equal((await h.call('POST', '/api/sessions/ABC123/reflect', { guest: token, body: { reflection_data: { x: 1 } } })).status, 200);
		assert.equal(row.reflection_done, true);
		part('sess-1', P1).reflection_done = true;
		part('sess-1', P2).reflection_done = true;
		h.db.session('sess-1').started_at = minAgo(20);
		const done = await h.call('POST', '/api/sessions/ABC123/complete', { user: HOST });
		assert.equal(done.status, 200, JSON.stringify(done.body));
		assert.equal(done.body.participants_rewarded, 2);
		assert.equal(row.awarded_competencies, null);
	});

	it('are refused when the host disabled them, with a bad nickname, or after start', async () => {
		seed({ allow_guests: false });
		assert.equal((await h.call('POST', '/api/sessions/ABC123/join-guest', { body: { nickname: 'Ema' } })).body.code, 'GUESTS_DISABLED');
		seed({ id: 's2', code: 'OPEN22' });
		assert.equal((await h.call('POST', '/api/sessions/OPEN22/join-guest', { body: { nickname: 'E' } })).body.code, 'BAD_NICKNAME');
		seed({ id: 's3', code: 'RUNS33', status: 'active' });
		assert.equal((await h.call('POST', '/api/sessions/RUNS33/join-guest', { body: { nickname: 'Ema' } })).body.code, 'ALREADY_STARTED');
	});

	it('a made-up guest token is not a member', async () => {
		seed();
		const res = await h.call('GET', '/api/sessions/ABC123', { guest: 'x'.repeat(32) });
		assert.equal(res.body.preview, true);
		assert.equal((await h.call('POST', '/api/sessions/ABC123/heartbeat', { guest: 'x'.repeat(32) })).status, 403);
	});
});

describe('host rewards and caps', () => {
	it('the host earns 50 % of the average participant XP and no coins', async () => {
		profile(HOST, 10); profile(P1, 0); profile(P2, 0);
		seed({ status: 'reflection', started_at: minAgo(20) });
		join('sess-1', P1, { coins_paid: 100, reflection_done: true });
		join('sess-1', P2, { coins_paid: 100, reflection_done: true });
		const res = await h.call('POST', '/api/sessions/ABC123/complete', { user: HOST });
		assert.equal(res.status, 200, JSON.stringify(res.body));
		assert.equal(res.body.host_xp_awarded, 37);
		assert.equal(res.body.rpg_xp_gained, 37);
		assert.equal(h.db.state.profiles[HOST].rpg_xp, 37);
		assert.equal(h.db.state.profiles[HOST].coins, 10, 'host gets no coins');
		assert.equal(h.db.session('sess-1').host_xp_awarded, 37);
	});

	it('a participant over the daily cap gets the stake back but no XP', async () => {
		profile(HOST, 0); profile(P1, 0); profile(P2, 0);
		for (let i = 0; i < 5; i++) h.db.insertTx(P1, 100, 'session_complete', { session_code: `X${i}` });
		seed({ status: 'reflection', started_at: minAgo(20) });
		join('sess-1', P1, { coins_paid: 100, reflection_done: true });
		join('sess-1', P2, { coins_paid: 100, reflection_done: true });
		const res = await h.call('POST', '/api/sessions/ABC123/complete', { user: HOST });
		assert.equal(res.status, 200);
		assert.equal(h.db.state.profiles[P1].coins, 100);
		assert.equal(h.db.state.profiles[P1].rpg_xp, 0);
		assert.equal(part('sess-1', P1).awarded_competencies.capped, true);
		assert.equal(h.db.state.profiles[P2].rpg_xp, 75);
		assert.equal(res.body.host_xp_awarded, 0, 'only one player earned XP → no host reward');
	});
});

describe('membership, rejoin and rate limit (M11)', () => {
	it('non-members only get a preview without the game or players', async () => {
		profile(HOST, 0); profile(P1, 0);
		seed();
		join('sess-1', P1);
		const res = await h.call('GET', '/api/sessions/ABC123', { user: STRANGER });
		assert.equal(res.status, 200);
		assert.equal(res.body.preview, true);
		assert.equal(res.body.player_count, 1);
		assert.equal(res.body.game_json, undefined);
		assert.equal(res.body.participants, undefined);
	});

	it('the host rejoins from another device by host_id (no storage needed)', async () => {
		profile(HOST, 0); profile(P1, 0);
		seed({ status: 'active', started_at: minAgo(5), last_host_seen_at: minAgo(20) });
		join('sess-1', P1, { coins_paid: 100 });
		const rj = await h.call('POST', '/api/sessions/ABC123/join', { user: HOST });
		assert.equal(rj.status, 200);
		assert.equal(rj.body.role, 'host');
		assert.ok(Date.now() - new Date(h.db.session('sess-1').last_host_seen_at) < 5000, 'presence refreshed');
		const view = await h.call('GET', '/api/sessions/ABC123', { user: HOST });
		assert.equal(view.body.my_role, 'host');
		assert.equal(view.body.participants.length, 1);
		assert.equal(h.db.state.participants.length, 1, 'host never becomes a participant');
	});

	it('a player who joined rejoins a running session from a second device without a new charge', async () => {
		profile(HOST, 0); profile(P1, 0);
		seed({ status: 'active', started_at: minAgo(5) });
		join('sess-1', P1, { coins_paid: 100 });
		const rj = await h.call('POST', '/api/sessions/ABC123/join', { user: P1 });
		assert.equal(rj.status, 200);
		assert.equal(rj.body.rejoined, true);
		assert.equal(rj.body.paid, true);
		assert.equal(h.db.state.tx.length, 0);
	});

	it('GET /:code answers 429 after too many reads from one caller', async () => {
		profile(HOST, 0);
		seed();
		let last;
		for (let i = 0; i < 41; i++) last = await h.call('GET', '/api/sessions/ABC123', { user: 'user-spammer' });
		assert.equal(last.status, 429);
		assert.equal(last.body.code, 'RATE_LIMITED');
		const other = await h.call('GET', '/api/sessions/ABC123', { user: HOST });
		assert.equal(other.status, 200, 'other callers are unaffected');
	});

	it('reading without a token or with an unknown non-member action is refused', async () => {
		seed();
		assert.equal((await h.call('GET', '/api/sessions/ABC123')).status, 401);
		assert.equal((await h.call('POST', '/api/sessions/ABC123/reflect', { user: STRANGER, body: { reflection_data: {} } })).status, 409);
		seed({ id: 's2', code: 'ACTV22', status: 'active', started_at: minAgo(1), timer_ends_at: new Date(Date.now() + 600000).toISOString() });
		const r = await h.call('POST', '/api/sessions/ACTV22/reflect', { user: STRANGER, body: { reflection_data: {} } });
		assert.equal(r.status, 403);
		assert.equal(r.body.code, 'NOT_PARTICIPANT');
	});
});
