'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
	XP_BOOST_MULTIPLIER,
	PHOTO_VERIFY_DAILY_ATTEMPTS,
	PHOTO_VERIFY_DAILY_REWARDS,
	buildCompletionValidation,
	resolveSoloXpMultiplier,
	photoVerifyAttemptAllowed,
	photoVerifyRewardAllowed,
} = require('../lib/session-economy');
const { validateDurationGate, validateParticipantGate } = require('../lib/reward-validation');
const { talentIdsToTalents } = require('../lib/rpg-talents');
const { getEffectiveStats } = require('../lib/rpg-progression');

describe('buildCompletionValidation (C1)', () => {
	it('takes the required values from the gate results', () => {
		const started = new Date(Date.now() - 12.34 * 60000);
		const dur = validateDurationGate(started, { duration: { min: 7 } });
		const part = validateParticipantGate(3, { playerCount: { min: 2 } });
		assert.ok(dur.pass && part.pass);
		const now = new Date('2026-11-21T10:00:00Z');
		const v = buildCompletionValidation({
			durationValidation: dur.validation,
			participantValidation: part.validation,
			hostSessionsLastHour: 1,
			competencies: ['komunikativni'],
			participantsRewarded: 3,
			now,
		});
		assert.equal(v.duration_required_min, 7);
		assert.equal(v.participants_required, 2);
		assert.equal(v.participants_actual, 3);
		assert.ok(Math.abs(v.duration_actual_min - 12.3) < 0.15);
		assert.equal(v.duration_actual_min, Math.round(v.duration_actual_min * 10) / 10);
		assert.equal(v.passed, true);
		assert.equal(v.validated_at, now.toISOString());
		assert.deepEqual(v.competencies_awarded, ['komunikativni']);
		assert.equal(v.participants_rewarded, 3);
	});

	it('server.js /complete only references variables that exist in its scope', () => {
		const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
		const start = src.indexOf("app.post('/api/sessions/:code/complete'");
		const end = src.indexOf("app.get('/api/sessions/:code/my-reward'");
		assert.ok(start > 0 && end > start);
		// Line comments may mention the old names; only code counts.
		const route = src.slice(start, end).replace(/\/\/[^\n]*/g, '');
		assert.doesNotMatch(route, /\brequiredMin\b/);
		assert.doesNotMatch(route, /\brequiredPlayers\b/);
		assert.match(route, /buildCompletionValidation\(/);
		assert.match(route, /coins_paid > 0`/, 'reward loop requires a paid participant (M2)');
	});
});

describe('resolveSoloXpMultiplier (H3)', () => {
	it('is 1 without remaining boost uses, whatever the client sends', () => {
		for (const req of [5, '5', 2, 100, -3, null, undefined, 'abc', 1.9]) {
			assert.equal(resolveSoloXpMultiplier(req, 0), 1, String(req));
		}
	});

	it('is capped at the boost multiplier when uses remain', () => {
		assert.equal(resolveSoloXpMultiplier(5, 1), XP_BOOST_MULTIPLIER);
		assert.equal(resolveSoloXpMultiplier(2, 3), 2);
		assert.equal(resolveSoloXpMultiplier(1, 3), 1);
		assert.equal(resolveSoloXpMultiplier(undefined, 3), 1);
	});
});

describe('photo verification caps (H4)', () => {
	it('allows attempts up to and including the cap', () => {
		assert.equal(photoVerifyAttemptAllowed(1), true);
		assert.equal(photoVerifyAttemptAllowed(PHOTO_VERIFY_DAILY_ATTEMPTS), true);
		assert.equal(photoVerifyAttemptAllowed(PHOTO_VERIFY_DAILY_ATTEMPTS + 1), false);
	});

	it('pays rewards only below the reward cap', () => {
		assert.equal(photoVerifyRewardAllowed(0), true);
		assert.equal(photoVerifyRewardAllowed(PHOTO_VERIFY_DAILY_REWARDS - 1), true);
		assert.equal(photoVerifyRewardAllowed(PHOTO_VERIFY_DAILY_REWARDS), false);
	});
});

describe('talentIdsToTalents (M4)', () => {
	it('maps ids to talent objects and drops unknown ids', () => {
		const talents = talentIdsToTalents([201, '202', 9999]);
		assert.deepEqual(talents.map((t) => t.id), [201, 202]);
	});

	it('makes talent bonuses count in effective stats', () => {
		const withIds = getEffectiveStats(2, [201]).effective;
		const withObjects = getEffectiveStats(2, talentIdsToTalents([201])).effective;
		assert.equal(withObjects.focus, withIds.focus + 3);
	});
});
