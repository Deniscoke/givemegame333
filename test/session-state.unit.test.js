'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const State = require('../lib/session-state');
const { createRateLimiter } = require('../lib/simple-rate-limit');

describe('session state machine', () => {
	it('allows exactly the planned transitions', () => {
		const allowed = [
			['waiting', 'active'], ['waiting', 'expired'],
			['active', 'reflection'], ['active', 'completing'], ['active', 'expired'],
			['reflection', 'completing'], ['reflection', 'expired'],
			['completing', 'completed'], ['completing', 'active'], ['completing', 'reflection'],
		];
		for (const from of State.STATUSES) {
			for (const to of State.STATUSES) {
				const expected = allowed.some(([a, b]) => a === from && b === to);
				assert.equal(State.canTransition(from, to), expected, `${from} → ${to}`);
			}
		}
	});

	it('rejects illegal and unknown transitions', () => {
		assert.equal(State.canTransition('waiting', 'completed'), false);
		assert.equal(State.canTransition('waiting', 'reflection'), false);
		assert.equal(State.canTransition('completed', 'active'), false);
		assert.equal(State.canTransition('expired', 'waiting'), false);
		assert.equal(State.canTransition('reflection', 'active'), false);
		assert.equal(State.canTransition('nope', 'active'), false);
		assert.equal(State.canTransition('__proto__', 'active'), false);
	});
});

describe('expiry and timers', () => {
	const now = new Date('2026-11-21T12:00:00Z');
	const ago = (min) => new Date(now.getTime() - min * 60000).toISOString();

	it('expires open sessions after the TTL or a long host absence', () => {
		assert.equal(State.expiryReason({ status: 'waiting', expires_at: ago(1) }, now), 'ttl');
		assert.equal(State.expiryReason({ status: 'active', expires_at: ago(-60), last_host_seen_at: ago(31) }, now), 'host_absent');
		assert.equal(State.expiryReason({ status: 'reflection', expires_at: ago(-5), last_host_seen_at: ago(2) }, now), null);
	});

	it('counts host absence only after the current phase should be over', () => {
		// A 40-minute game: the host phone was locked at the start, the timer still runs.
		const running = { status: 'active', expires_at: ago(-120), last_host_seen_at: ago(35), timer_ends_at: ago(-5) };
		assert.equal(State.expiryReason(running, now), null, 'a locked host phone during the game is fine');
		// Timer ended 20 min ago, host unseen for 60 min: still inside the 30-min window after the phase end.
		assert.equal(State.expiryReason({ ...running, timer_ends_at: ago(20) }, now), null);
		assert.equal(State.expiryReason({ ...running, timer_ends_at: ago(31) }, now), 'host_absent');
		// Reflection: measured from reflection_ends_at.
		const refl = { status: 'reflection', expires_at: ago(-60), last_host_seen_at: ago(50), reflection_ends_at: ago(10) };
		assert.equal(State.expiryReason(refl, now), null);
		assert.equal(State.expiryReason({ ...refl, reflection_ends_at: ago(30) }, now), 'host_absent');
		// Waiting lobby: just the last heartbeat.
		assert.equal(State.expiryReason({ status: 'waiting', expires_at: ago(-60), last_host_seen_at: ago(31) }, now), 'host_absent');
		assert.equal(State.hostAbsentSince({ status: 'active', timer_ends_at: ago(1) }), null, 'no heartbeat stamp, no absence');
	});

	it('never expires closed sessions or rows without timestamps (pre-040)', () => {
		assert.equal(State.expiryReason({ status: 'completed', expires_at: ago(100) }, now), null);
		assert.equal(State.expiryReason({ status: 'completing', expires_at: ago(100) }, now), null);
		assert.equal(State.expiryReason({ status: 'active' }, now), null);
	});

	it('opens reflection only for an active session whose timer ran out', () => {
		assert.equal(State.timerElapsed({ status: 'active', timer_ends_at: ago(0.1) }, now), true);
		assert.equal(State.timerElapsed({ status: 'active', timer_ends_at: ago(-1) }, now), false);
		assert.equal(State.timerElapsed({ status: 'reflection', timer_ends_at: ago(5) }, now), false);
		assert.equal(State.timerElapsed({ status: 'active', timer_ends_at: null }, now), false);
	});

	it('computes TTL timestamps from the timer', () => {
		const t = '2026-11-21T12:15:00.000Z';
		const expected = State.REFLECTION_WINDOW_MIN + State.AFTER_REFLECTION_GRACE_MIN;
		assert.equal((State.activeExpiry(t) - new Date(t)) / 60000, expected);
		assert.equal((State.waitingExpiry(now) - now) / 60000, State.WAITING_TTL_MIN);
	});
});

describe('host reward', () => {
	it('is 50 % of the average participant XP with at least two earners', () => {
		assert.equal(State.computeHostXp([75, 75]), 37);
		assert.equal(State.computeHostXp([75, 75, 0]), 37, 'capped players (0 XP) do not count');
		assert.equal(State.computeHostXp([100, 50]), 37);
	});
	it('is 0 with fewer than two earners', () => {
		assert.equal(State.computeHostXp([75]), 0);
		assert.equal(State.computeHostXp([75, 0]), 0);
		assert.equal(State.computeHostXp([]), 0);
	});
});

describe('input normalisation', () => {
	it('clamps the reward gate fields of a client game (H2)', () => {
		const r = State.sanitizeSessionGame({ title: ' Hra ', playerCount: { min: 1, max: 999 }, duration: { min: 0, max: 1 } });
		assert.equal(r.ok, true);
		assert.equal(r.game.title, 'Hra');
		assert.deepEqual(r.game.playerCount, { min: 2, max: 40 });
		assert.deepEqual(r.game.duration, { min: 3, max: 3 });
	});
	it('rejects a missing title and oversized games', () => {
		assert.deepEqual(State.sanitizeSessionGame(null), { ok: false, code: 'MISSING_GAME' });
		assert.deepEqual(State.sanitizeSessionGame({ title: '  ' }), { ok: false, code: 'MISSING_GAME' });
		const big = { title: 'x', blob: 'a'.repeat(State.MAX_GAME_JSON_BYTES) };
		assert.deepEqual(State.sanitizeSessionGame(big), { ok: false, code: 'GAME_TOO_LARGE' });
	});
	it('picks the play style and lobby size', () => {
		assert.equal(State.normalizePlayStyle('online'), 'online');
		assert.equal(State.normalizePlayStyle('bogus', 'online'), 'online');
		assert.equal(State.normalizePlayStyle(undefined, 'party'), 'room');
		assert.equal(State.normalizeMaxPlayers('6'), 6);
		assert.equal(State.normalizeMaxPlayers(1), 2);
		assert.equal(State.normalizeMaxPlayers(500), 40);
		assert.equal(State.normalizeMaxPlayers(undefined, { playerCount: { max: 12 } }), 12);
	});
	it('cleans nicknames', () => {
		assert.equal(State.normalizeNickname('  Ľuboš   K. '), 'Ľuboš K.');
		assert.equal(State.normalizeNickname('<script>'), 'script');
		assert.equal(State.normalizeNickname('a'), null);
		assert.equal(State.normalizeNickname(42), null);
		assert.equal(State.normalizeNickname('x'.repeat(40)).length, 24);
	});
	it('guest tokens are random and stored only as a hash', () => {
		const a = State.createGuestToken();
		const b = State.createGuestToken();
		assert.notEqual(a, b);
		assert.equal(State.isGuestTokenShape(a), true);
		assert.equal(State.isGuestTokenShape('short'), false);
		assert.match(State.hashGuestToken(a), /^[0-9a-f]{64}$/);
		assert.notEqual(State.hashGuestToken(a), a);
	});
});

describe('rate limiter', () => {
	it('blocks after the limit within the window', () => {
		const rl = createRateLimiter({ limit: 2, windowMs: 60000 });
		assert.equal(rl.check('k').ok, true);
		assert.equal(rl.check('k').ok, true);
		const third = rl.check('k');
		assert.equal(third.ok, false);
		assert.ok(third.retryAfterSec >= 1);
		assert.equal(rl.check('other').ok, true);
	});
});
