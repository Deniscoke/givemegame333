'use strict';

/**
 * Route-level tests for Phase 5 (verifiable play):
 *   - /api/play/start issues / starts tickets (generated, library, public link)
 *   - /api/play/:ticket/reflect quality gate, one reflection per ticket
 *   - /api/profile/complete-solo with ticket_id: single use, duration gate,
 *     +25 % reflection bonus, stat XP rows, forged game_json ignored
 *   - PLAY_TICKETS_ENABLED off and the two-week legacy window
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startEconomyServer } = require('./helpers/economy-harness');
const PT = require('../lib/play-tickets');
const { computeSoloXpFromDurationMax } = require('../lib/rpg-progression');

const U = 'user-player';
const OTHER = 'user-other';
const SAVED_ID = '11111111-2222-4333-8444-555555555555';
const PUBLIC_ID = '99999999-2222-4333-8444-555555555555';
let h;

const COOKING = {
	title: 'Zeleninový šalát',
	mode: 'cooking',
	duration: { min: 10, max: 15 },
	rvp: { kompetence: ['k-uceni', 'pracovni'] },
};
const REFLECTION = {
	ratings: { 'k-uceni': 4, pracovni: 5, pad_general: 4 },
	texts: {
		darilo: 'Sám som nakrájal uhorku a papriku.',
		zlepsit: 'Nabudúce si pripravím všetko vopred.',
	},
};

function profile(id = U, extra = {}) {
	h.db.state.profiles[id] = { coins: 0, rpg_xp: 0, rpg_avatar_id: null, ...extra };
}

/** Issue a generated ticket the way /api/generate-game does. */
async function generatedTicket(game = COOKING, mode = 'cooking', user = U) {
	const id = await PT.issueGenerationTicket({ query: async (sql, p) => h.db.exec(sql, p) }, user, game, mode);
	assert.ok(id);
	return id;
}

function backdate(ticketId, minutes) {
	const t = h.db.state.tickets.find((x) => x.id === ticketId);
	t.started_at = new Date(Date.now() - minutes * 60000).toISOString();
}

async function startAndPlay(ticketId, minutes = 16) {
	const r = await h.call('POST', '/api/play/start', { user: U, body: { ticket_id: ticketId } });
	assert.equal(r.status, 200, JSON.stringify(r.body));
	backdate(ticketId, minutes);
}

before(async () => { h = await startEconomyServer(); });
after(async () => { await h.stop(); });
beforeEach(() => {
	h.db.state = { profiles: {}, sessions: {}, participants: [], tx: [], talents: [] };
	delete process.env.PLAY_TICKETS_ENABLED;
	delete process.env.PLAY_TICKETS_LEGACY_UNTIL;
});

describe('generation ticket', () => {
	it('stores the server copy of the game with mode, durations and valid competencies', async () => {
		const id = await generatedTicket({ ...COOKING, rvp: { kompetence: ['k-uceni', 'fake'] } });
		const t = h.db.state.tickets.find((x) => x.id === id);
		assert.equal(t.source, 'generated');
		assert.equal(t.mode, 'cooking');
		assert.equal(t.duration_min, 10);
		assert.deepEqual(t.kompetence, ['k-uceni']);
		assert.equal(t.started_at, null);
	});

	it('never breaks generation when the insert fails', async () => {
		const warn = [];
		const id = await PT.issueGenerationTicket({ query: async () => { throw new Error('db down'); } },
			U, COOKING, 'cooking', { warn: (...a) => warn.push(a) });
		assert.equal(id, null);
		assert.equal(warn.length, 1);
	});
});

describe('POST /api/play/start', () => {
	it('starts a ticket once; a second start keeps the first start time', async () => {
		profile();
		const id = await generatedTicket();
		const a = await h.call('POST', '/api/play/start', { user: U, body: { ticket_id: id } });
		assert.equal(a.status, 200);
		const b = await h.call('POST', '/api/play/start', { user: U, body: { ticket_id: id } });
		assert.equal(b.body.started_at, a.body.started_at);
	});

	it("cannot start another user's ticket", async () => {
		profile(); profile(OTHER);
		const id = await generatedTicket(COOKING, 'cooking', OTHER);
		const r = await h.call('POST', '/api/play/start', { user: U, body: { ticket_id: id } });
		assert.equal(r.status, 404);
		assert.equal(r.body.code, 'TICKET_NOT_FOUND');
	});

	it('creates a started ticket from an own library game or a shared link, not from a stranger\'s game', async () => {
		profile();
		h.db.state.savedGames = {
			[SAVED_ID]: { user_id: OTHER, mode: 'circus', game_json: COOKING, public_token: PUBLIC_ID },
		};
		const notMine = await h.call('POST', '/api/play/start', { user: U, body: { game_id: SAVED_ID } });
		assert.equal(notMine.status, 404);
		const shared = await h.call('POST', '/api/play/start', { user: U, body: { public_id: PUBLIC_ID } });
		assert.equal(shared.status, 200, JSON.stringify(shared.body));
		const t = h.db.state.tickets.find((x) => x.id === shared.body.ticket_id);
		assert.equal(t.source, 'library');
		assert.equal(t.mode, 'circus', 'mode from the saved row');
		assert.ok(t.started_at);

		h.db.state.savedGames[SAVED_ID].user_id = U;
		const own = await h.call('POST', '/api/play/start', { user: U, body: { game_id: SAVED_ID } });
		assert.equal(own.status, 200);
	});

	it('rejects a body without a game, and a client-sent game is never accepted', async () => {
		profile();
		const r = await h.call('POST', '/api/play/start', { user: U, body: { game: COOKING } });
		assert.equal(r.status, 400);
		assert.equal(r.body.code, 'MISSING_GAME');
		assert.equal((h.db.state.tickets || []).length, 0);
	});

	it('requires login', async () => {
		const r = await h.call('POST', '/api/play/start', { body: { ticket_id: SAVED_ID } });
		assert.equal(r.status, 401);
	});
});

describe('POST /api/play/:ticket/reflect', () => {
	it('stores a quality reflection once per ticket', async () => {
		profile();
		const id = await generatedTicket();
		await startAndPlay(id, 1);
		const ok = await h.call('POST', `/api/play/${id}/reflect`, { user: U, body: REFLECTION });
		assert.equal(ok.status, 200, JSON.stringify(ok.body));
		assert.equal(h.db.state.tickets.find((x) => x.id === id).reflection_id, ok.body.reflection_id);
		const again = await h.call('POST', `/api/play/${id}/reflect`, { user: U, body: REFLECTION });
		assert.equal(again.status, 409);
		assert.equal(again.body.code, 'REFLECTION_EXISTS');
	});

	it('rejects short answers, missing ratings and a not-started ticket', async () => {
		profile();
		const id = await generatedTicket();
		const early = await h.call('POST', `/api/play/${id}/reflect`, { user: U, body: REFLECTION });
		assert.equal(early.body.code, 'TICKET_NOT_STARTED');
		await startAndPlay(id, 1);
		const short = await h.call('POST', `/api/play/${id}/reflect`, {
			user: U, body: { ...REFLECTION, texts: { darilo: 'dobre', zlepsit: 'nič' } },
		});
		assert.equal(short.status, 422);
		assert.equal(short.body.code, 'REFLECTION_TOO_SHORT');
		assert.equal(short.body.min_chars, 20);
		const noRating = await h.call('POST', `/api/play/${id}/reflect`, {
			user: U, body: { ...REFLECTION, ratings: { pad_a: 3, pad_b: 3, pad_c: 3 } },
		});
		assert.equal(noRating.body.code, 'REFLECTION_INCOMPLETE');
		assert.equal(h.db.state.reflections.length, 0);
	});

	it('rejects copying an answer from a previous reflection', async () => {
		profile();
		const first = await generatedTicket();
		await startAndPlay(first, 16);
		assert.equal((await h.call('POST', `/api/play/${first}/reflect`, { user: U, body: REFLECTION })).status, 200);
		assert.equal((await h.call('POST', '/api/profile/complete-solo', { user: U, body: { ticket_id: first } })).status, 200);

		const second = await generatedTicket();
		await startAndPlay(second, 1);
		const rep = await h.call('POST', `/api/play/${second}/reflect`, { user: U, body: REFLECTION });
		assert.equal(rep.status, 422);
		assert.equal(rep.body.code, 'REFLECTION_REPEAT');
	});
});

describe('complete-solo with a ticket', () => {
	it('cooking + valid reflection: participation XP +25 %, focus/strategy rows and sub-tags grow', async () => {
		profile();
		const id = await generatedTicket();
		await startAndPlay(id, 16);
		assert.equal((await h.call('POST', `/api/play/${id}/reflect`, { user: U, body: REFLECTION })).status, 200);

		const r = await h.call('POST', '/api/profile/complete-solo', { user: U, body: { ticket_id: id } });
		assert.equal(r.status, 200, JSON.stringify(r.body));
		const participation = computeSoloXpFromDurationMax(15);
		assert.equal(r.body.participation_xp, participation);
		assert.equal(r.body.reflection_bonus_xp, Math.round(participation * 0.25));
		assert.equal(r.body.rpg_xp_gained, participation + Math.round(participation * 0.25));
		assert.equal(r.body.reflection_counted, true);
		assert.equal(r.body.xp_multiplier_applied, 1);
		assert.deepEqual(r.body.trained_stats, ['focus', 'strategy']);
		assert.equal(h.db.state.profiles[U].rpg_xp, r.body.rpg_xp_gained);
		assert.equal(h.db.state.profiles[U].coins, 100);

		const rows = h.db.state.statXp[U];
		assert.ok(rows.focus > 0 && rows.strategy > 0);
		assert.equal(rows.focus + rows.strategy, r.body.rpg_xp_gained);
		assert.equal(rows.motorika, rows.focus);
		assert.equal(rows.vyziva, rows.strategy);
		assert.deepEqual(r.body.stat_xp_gained, rows);

		const t = h.db.state.tickets.find((x) => x.id === id);
		assert.ok(t.completed_at);
		assert.equal(t.reward.reflection_bonus_xp, r.body.reflection_bonus_xp);
		const tx = h.db.state.tx.find((x) => x.action === 'solo_complete');
		assert.equal(tx.metadata.ticket_id, id);
		assert.equal(tx.metadata.reflection, true);
	});

	it('without a reflection there is no bonus', async () => {
		profile();
		const id = await generatedTicket();
		await startAndPlay(id, 16);
		const r = await h.call('POST', '/api/profile/complete-solo', { user: U, body: { ticket_id: id } });
		assert.equal(r.body.reflection_bonus_xp, 0);
		assert.equal(r.body.rpg_xp_gained, computeSoloXpFromDurationMax(15));
	});

	it('replaying the same ticket returns 409 and pays nothing', async () => {
		profile();
		const id = await generatedTicket();
		await startAndPlay(id, 16);
		assert.equal((await h.call('POST', '/api/profile/complete-solo', { user: U, body: { ticket_id: id } })).status, 200);
		const xp = h.db.state.profiles[U].rpg_xp;
		const again = await h.call('POST', '/api/profile/complete-solo', { user: U, body: { ticket_id: id } });
		assert.equal(again.status, 409);
		assert.equal(again.body.code, 'TICKET_USED');
		assert.equal(h.db.state.profiles[U].rpg_xp, xp);
		assert.equal(h.db.state.tx.filter((x) => x.action === 'solo_complete').length, 1);
	});

	it('duration gate: too early fails and leaves the ticket usable', async () => {
		profile();
		const id = await generatedTicket();
		await startAndPlay(id, 2);
		const early = await h.call('POST', '/api/profile/complete-solo', { user: U, body: { ticket_id: id } });
		assert.equal(early.status, 400);
		assert.equal(early.body.code, 'DURATION_TOO_SHORT');
		assert.equal(early.body.duration_required_min, 10);
		assert.equal(h.db.state.profiles[U].rpg_xp, 0);
		backdate(id, 12);
		const later = await h.call('POST', '/api/profile/complete-solo', { user: U, body: { ticket_id: id } });
		assert.equal(later.status, 200);
		assert.equal(later.body.participation_xp, computeSoloXpFromDurationMax(12), 'validated minutes, not the game length');
	});

	it('a ticket that was never started cannot pay out', async () => {
		profile();
		const id = await generatedTicket();
		const r = await h.call('POST', '/api/profile/complete-solo', { user: U, body: { ticket_id: id } });
		assert.equal(r.status, 409);
		assert.equal(r.body.code, 'TICKET_NOT_STARTED');
	});

	it('a forged game_json and xp_multiplier have no effect', async () => {
		profile();
		const id = await generatedTicket();
		await startAndPlay(id, 16);
		const forged = { duration: { min: 0, max: 180 }, rvp: { kompetence: ['digitalni', 'obcanske', 'komunikativni'] } };
		const r = await h.call('POST', '/api/profile/complete-solo', {
			user: U, body: { ticket_id: id, game_json: forged, xp_multiplier: 5 },
		});
		assert.equal(r.status, 200);
		assert.equal(r.body.rpg_xp_gained, computeSoloXpFromDurationMax(15));
		assert.equal(r.body.xp_multiplier_applied, 1);
		assert.deepEqual(r.body.trained_stats, ['focus', 'strategy']);
		assert.equal(h.db.state.statXp[U].insight, undefined);
	});

	it('a boost bought in the shop doubles XP without the client asking, but not stat XP', async () => {
		profile(U, { coins: 2000 });
		assert.equal((await h.call('POST', '/api/shop/purchase', { user: U, body: { item_id: 'xp_boost_2x' } })).status, 200);
		const id = await generatedTicket();
		await startAndPlay(id, 16);
		const r = await h.call('POST', '/api/profile/complete-solo', { user: U, body: { ticket_id: id } });
		assert.equal(r.body.xp_multiplier_applied, 2);
		assert.equal(r.body.rpg_xp_gained, computeSoloXpFromDurationMax(15) * 2);
		const rows = h.db.state.statXp[U];
		assert.equal(rows.focus + rows.strategy, computeSoloXpFromDurationMax(15));
	});

	it('two tickets played at the same time pay out only once', async () => {
		profile();
		const a = await generatedTicket();
		const b = await generatedTicket();
		await startAndPlay(a, 16);
		await startAndPlay(b, 16);
		assert.equal((await h.call('POST', '/api/profile/complete-solo', { user: U, body: { ticket_id: a } })).status, 200);
		const second = await h.call('POST', '/api/profile/complete-solo', { user: U, body: { ticket_id: b } });
		assert.equal(second.status, 409);
		assert.equal(second.body.code, 'TICKET_OVERLAP');
	});

	it('rejects a malformed or foreign ticket', async () => {
		profile(); profile(OTHER);
		const bad = await h.call('POST', '/api/profile/complete-solo', { user: U, body: { ticket_id: 'abc' } });
		assert.equal(bad.body.code, 'INVALID_TICKET');
		const id = await generatedTicket(COOKING, 'cooking', OTHER);
		backdate(id, 20);
		const foreign = await h.call('POST', '/api/profile/complete-solo', { user: U, body: { ticket_id: id } });
		assert.equal(foreign.status, 404);
	});
});

describe('GET /api/play/attributes', () => {
	it('returns stat XP, per-competency counts with average self-rating, and the mode rationale', async () => {
		profile();
		const id = await generatedTicket();
		await startAndPlay(id, 16);
		await h.call('POST', `/api/play/${id}/reflect`, { user: U, body: REFLECTION });
		await h.call('POST', '/api/profile/complete-solo', { user: U, body: { ticket_id: id } });

		const r = await h.call('GET', '/api/play/attributes', { user: U });
		assert.equal(r.status, 200, JSON.stringify(r.body));
		assert.equal(r.body.enabled, true);
		assert.equal(r.body.games, 1);
		assert.equal(r.body.reflected, 1);
		assert.ok(r.body.stat_xp.focus > 0);
		assert.deepEqual(r.body.competencies, [
			{ key: 'k-uceni', games: 1, avg_rating: 4 },
			{ key: 'pracovni', games: 1, avg_rating: 5 },
		]);
		assert.match(r.body.manifest.modes.cooking.rationale, /motoriku/);
		assert.deepEqual(r.body.manifest.modes.online.subtags, ['digitalna']);
	});
});

describe('flag and backwards compatibility', () => {
	const LEGACY_BODY = { game_json: { duration: { min: 5, max: 15 }, rvp: { kompetence: ['komunikativni'] } } };

	it('flag off: play routes are off, the old game_json path still pays', async () => {
		process.env.PLAY_TICKETS_ENABLED = 'false';
		profile();
		const start = await h.call('POST', '/api/play/start', { user: U, body: { game_id: SAVED_ID } });
		assert.equal(start.status, 404);
		assert.equal(start.body.code, 'PLAY_TICKETS_DISABLED');
		const attrs = await h.call('GET', '/api/play/attributes', { user: U });
		assert.equal(attrs.body.enabled, false);
		const r = await h.call('POST', '/api/profile/complete-solo', { user: U, body: LEGACY_BODY });
		assert.equal(r.status, 200, JSON.stringify(r.body));
		assert.equal(r.body.legacy, true);
	});

	it('flag on: a client without a ticket still works during the two-week window, with a deprecation header', async () => {
		process.env.PLAY_TICKETS_LEGACY_UNTIL = new Date(Date.now() + 86400000).toISOString();
		profile();
		const res = await fetch(`${h.baseUrl}/api/profile/complete-solo`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', Authorization: `Bearer ${U}` },
			body: JSON.stringify(LEGACY_BODY),
		});
		assert.equal(res.status, 200);
		assert.equal(res.headers.get('deprecation'), 'true');
		assert.ok(res.headers.get('sunset'));
		assert.equal((await res.json()).legacy, true);
	});

	it('flag on: after the window a ticket is required', async () => {
		process.env.PLAY_TICKETS_LEGACY_UNTIL = '2020-01-01T00:00:00Z';
		profile();
		const r = await h.call('POST', '/api/profile/complete-solo', { user: U, body: LEGACY_BODY });
		assert.equal(r.status, 400);
		assert.equal(r.body.code, 'TICKET_REQUIRED');
		assert.equal(h.db.state.profiles[U].rpg_xp, 0);
	});
});
