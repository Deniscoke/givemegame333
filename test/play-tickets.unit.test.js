'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const PT = require('../lib/play-tickets');
const { computeSoloXpFromDurationMax } = require('../lib/rpg-progression');

const GOOD = {
	ratings: { 'k-uceni': 4, pracovni: 5, pad_general: 3 },
	texts: {
		darilo: 'Podarilo sa mi nakrájať zeleninu sám.',
		zlepsit: 'Nabudúce si lepšie prečítam celý recept.',
	},
};

describe('feature flag and legacy window', () => {
	it('PLAY_TICKETS_ENABLED is on by default and can be switched off', () => {
		assert.equal(PT.playTicketsEnabled({}), true);
		assert.equal(PT.playTicketsEnabled({ PLAY_TICKETS_ENABLED: '1' }), true);
		for (const v of ['0', 'false', 'OFF', 'no']) assert.equal(PT.playTicketsEnabled({ PLAY_TICKETS_ENABLED: v }), false);
	});

	it('legacy complete-solo is allowed until PLAY_TICKETS_LEGACY_UNTIL (default two weeks)', () => {
		const until = new Date(PT.DEFAULT_LEGACY_UNTIL);
		assert.equal(PT.legacyCompleteSoloAllowed({}, new Date(until.getTime() - 1)), true);
		assert.equal(PT.legacyCompleteSoloAllowed({}, until), false);
		const env = { PLAY_TICKETS_LEGACY_UNTIL: '2020-01-01' };
		assert.equal(PT.legacyCompleteSoloAllowed(env, new Date('2019-12-31')), true);
		assert.equal(PT.legacyCompleteSoloAllowed(env, new Date('2020-01-02')), false);
		assert.equal(PT.legacyUntil({ PLAY_TICKETS_LEGACY_UNTIL: 'nonsense' }).toISOString(),
			new Date(PT.DEFAULT_LEGACY_UNTIL).toISOString());
	});
});

describe('ticket fields come from the server copy of the game', () => {
	it('clamps durations, filters competencies and validates the mode', () => {
		const f = PT.ticketFieldsFromGame({
			duration: { min: 0, max: 999 },
			rvp: { kompetence: ['k-uceni', 'bogus', 'k-uceni', 'pracovni'] },
		}, { mode: 'cooking' });
		assert.equal(f.duration_min, 1);
		assert.equal(f.duration_max, 180);
		assert.deepEqual(f.kompetence, ['k-uceni', 'pracovni']);
		assert.equal(f.mode, 'cooking');
		assert.match(f.game_hash, /^[0-9a-f]{64}$/);
		assert.equal(PT.ticketFieldsFromGame({}, { mode: 'hacking' }).mode, null);
		assert.equal(PT.ticketFieldsFromGame({ mode: 'online' }).mode, 'online');
		const g = PT.ticketFieldsFromGame({ duration: { min: 20, max: 10 } });
		assert.ok(g.duration_max >= g.duration_min);
	});

	it('recognises ticket ids', () => {
		assert.equal(PT.isTicketId('6f1c2b8e-1b2c-4d5e-8f90-123456789abc'), true);
		assert.equal(PT.isTicketId('nope'), false);
		assert.equal(PT.isTicketId(42), false);
	});
});

describe('reflection quality gate', () => {
	const komps = ['k-uceni', 'pracovni'];

	it('accepts complete, thoughtful answers', () => {
		const r = PT.validateReflection(GOOD, komps, []);
		assert.equal(r.ok, true);
		assert.deepEqual(r.ratings, GOOD.ratings);
		assert.equal(r.texts.darilo, GOOD.texts.darilo);
	});

	it('requires every rating, including each ticket competency', () => {
		assert.equal(PT.validateReflection({ ...GOOD, ratings: { 'k-uceni': 4, a: 3 } }, komps).code, 'REFLECTION_INCOMPLETE');
		const missing = PT.validateReflection({ ...GOOD, ratings: { 'k-uceni': 4, x: 3, y: 2 } }, komps);
		assert.equal(missing.code, 'REFLECTION_INCOMPLETE');
		assert.equal(missing.field, 'pracovni');
		assert.equal(PT.validateReflection({ ...GOOD, ratings: { ...GOOD.ratings, pracovni: 9 } }, komps).code, 'REFLECTION_INVALID_RATING');
		assert.equal(PT.validateReflection({ ...GOOD, ratings: { ...GOOD.ratings, pracovni: '5' } }, komps).code, 'REFLECTION_INVALID_RATING');
		assert.equal(PT.validateReflection({ ratings: [], texts: GOOD.texts }, komps).code, 'REFLECTION_INCOMPLETE');
	});

	it('open answers need at least 20 characters of real text', () => {
		const short = PT.validateReflection({ ...GOOD, texts: { ...GOOD.texts, zlepsit: 'nič' } }, komps);
		assert.equal(short.code, 'REFLECTION_TOO_SHORT');
		assert.equal(short.field, 'zlepsit');
		assert.equal(PT.validateReflection({ ...GOOD, texts: { ...GOOD.texts, darilo: 'a'.repeat(30) } }, komps).code, 'REFLECTION_TOO_SHORT');
		assert.equal(PT.validateReflection({ ...GOOD, texts: { darilo: GOOD.texts.darilo } }, komps).code, 'REFLECTION_INCOMPLETE');
	});

	it('rejects repeating an answer from the last 5 reflections or the same answer twice', () => {
		const prev = [{ darilo: 'iné', zlepsit: 'Nabudúce si LEPŠIE prečítam celý recept!' }];
		const rep = PT.validateReflection(GOOD, komps, prev);
		assert.equal(rep.code, 'REFLECTION_REPEAT');
		assert.equal(rep.field, 'zlepsit');
		const older = [{}, {}, {}, {}, {}, { darilo: GOOD.texts.darilo }];
		assert.equal(PT.validateReflection(GOOD, komps, older).ok, true, 'only the last 5 count');
		const same = PT.validateReflection({ ...GOOD, texts: { darilo: GOOD.texts.darilo, zlepsit: GOOD.texts.darilo } }, komps);
		assert.equal(same.code, 'REFLECTION_REPEAT');
	});
});

describe('ticket reward', () => {
	it('participation XP uses the 30-120 curve on validated minutes; reflection adds 25 %', () => {
		const plain = PT.computeTicketReward({ durationMax: 15, elapsedMin: 40, reflected: false, mode: 'cooking', kompetence: [] });
		assert.equal(plain.validated_min, 15, 'capped at the game length');
		assert.equal(plain.participation_xp, computeSoloXpFromDurationMax(15));
		assert.equal(plain.reflection_bonus_xp, 0);
		const refl = PT.computeTicketReward({ durationMax: 15, elapsedMin: 15.9, reflected: true, mode: 'cooking', kompetence: [] });
		assert.equal(refl.reflection_bonus_xp, Math.round(refl.participation_xp * 0.25));
		assert.equal(refl.total_xp, refl.participation_xp + refl.reflection_bonus_xp);
	});

	it('a bought boost multiplies total XP but not stat XP', () => {
		const r = PT.computeTicketReward({ durationMax: 15, elapsedMin: 15, reflected: true, multiplier: 2, mode: 'cooking', kompetence: [] });
		assert.equal(r.total_xp, r.base_xp * 2);
		assert.equal(r.stat_xp.focus + r.stat_xp.strategy, r.base_xp);
		assert.deepEqual(r.trained_stats, ['focus', 'strategy']);
		assert.ok(r.stat_xp.motorika > 0 && r.stat_xp.vyziva > 0);
		assert.equal(PT.computeTicketReward({ durationMax: 15, elapsedMin: 15, reflected: false, multiplier: 7.5 }).xp_multiplier, 1);
	});

	it('is deterministic and never uses the "unknown duration" default for short plays', () => {
		const a = PT.computeTicketReward({ durationMax: 10, elapsedMin: 0, reflected: false });
		assert.equal(a.participation_xp, 30);
		const input = { durationMax: 25, elapsedMin: 25, reflected: true, mode: 'party', kompetence: ['k-uceni'] };
		assert.deepEqual(PT.computeTicketReward(input), PT.computeTicketReward(input));
	});
});
