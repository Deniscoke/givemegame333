'use strict';

/**
 * Rate limits on /api/sessions (Phase 6 review fixes). Kept in its own file
 * because it exhausts the per-IP bucket of the shared harness server (every
 * request comes from 127.0.0.1).
 *
 *   - a class of guests on one school IP can all join the same lobby;
 *   - made-up guest tokens or Bearer values do not get a fresh bucket each;
 *   - verified callers (real account, real guest member) keep their own bucket.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startEconomyServer } = require('./helpers/economy-harness');

const HOST = 'user-host';
let h;

function seed({ id, code, maxPlayers = 40 }) {
	h.db.state.sessions[id] = {
		id, host_id: HOST, join_code: code, status: 'waiting',
		game_json: { title: 'Test hra', duration: { min: 5, max: 15 }, playerCount: { min: 2, max: 40 } },
		started_at: null, completed_at: null, reward_validation: null,
		expires_at: new Date(Date.now() + 3600000).toISOString(), last_host_seen_at: new Date().toISOString(),
		play_style: 'online', max_players: maxPlayers, allow_guests: true, host_xp_awarded: 0,
	};
}

const randomToken = () => require('node:crypto').randomBytes(18).toString('base64url');

before(async () => {
	h = await startEconomyServer();
	h.db.state = { profiles: { [HOST]: { coins: 0, rpg_xp: 0, rpg_avatar_id: null } }, sessions: {}, participants: [], tx: [], talents: [], events: [] };
});
after(async () => { await h.stop(); });

describe('session rate limits', () => {
	it('25 guests from one school IP can all join the same lobby', async () => {
		seed({ id: 'class-1', code: 'CLASS1' });
		const tokens = [];
		for (let i = 0; i < 25; i++) {
			const res = await h.call('POST', '/api/sessions/CLASS1/join-guest', { body: { nickname: `Žiak ${i + 1}` } });
			assert.equal(res.status, 200, `guest ${i + 1}: ${JSON.stringify(res.body)}`);
			tokens.push(res.body.guest_token);
		}
		assert.equal(h.db.state.participants.filter((p) => p.session_id === 'class-1').length, 25);
		// Each joined guest polls with its own bucket.
		for (const t of tokens.slice(0, 5)) {
			assert.equal((await h.call('POST', '/api/sessions/CLASS1/heartbeat', { guest: t })).status, 200);
		}
		h.classTokens = tokens;
	});

	it('made-up guest tokens share one per-IP bucket and get 429; verified callers are unaffected', async () => {
		seed({ id: 'probe-1', code: 'PROBE1' });
		let last;
		let n = 0;
		for (; n < 200; n++) {
			last = await h.call('GET', '/api/sessions/PROBE1', { guest: randomToken() });
			if (last.status === 429) break;
		}
		assert.equal(last.status, 429, 'random tokens are eventually refused');
		assert.equal(last.body.code, 'RATE_LIMITED');
		assert.ok(n <= 120, `blocked after ${n} requests`);
		// Fake Bearer values are refused by the same bucket before any auth lookup.
		const fakeBearer = await h.call('GET', '/api/sessions/PROBE1', { user: `x-${randomToken()}` });
		assert.equal(fakeBearer.status, 429);
		const fakeHeartbeat = await h.call('POST', '/api/sessions/PROBE1/heartbeat', { guest: randomToken() });
		assert.equal(fakeHeartbeat.status, 429);

		// A guest who really joined (verified by its earlier heartbeat) still gets through.
		assert.equal((await h.call('POST', '/api/sessions/CLASS1/heartbeat', { guest: h.classTokens[0] })).status, 200);
	});

	it('guest joins are limited per IP and join code, not per IP alone', async () => {
		seed({ id: 'big-1', code: 'BIGBIG', maxPlayers: 40 });
		seed({ id: 'big-2', code: 'BIGTWO', maxPlayers: 40 });
		let lastA;
		for (let i = 0; i < 61; i++) {
			lastA = await h.call('POST', '/api/sessions/BIGBIG/join-guest', { body: { nickname: `Hráč ${i}` } });
		}
		assert.equal(lastA.status, 429, 'one lobby from one IP is capped');
		const otherLobby = await h.call('POST', '/api/sessions/BIGTWO/join-guest', { body: { nickname: 'Ema' } });
		assert.equal(otherLobby.status, 200, 'another class on the same IP can still join its lobby');
	});
});
