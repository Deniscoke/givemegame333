/**
 * gIVEMEGAME.IO — Plan entitlements
 * Run: node --test test/plan-entitlements.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { entitlementsForPlan, nextUtcMidnightIso } = require('../lib/plan-entitlements');

describe('entitlementsForPlan', () => {
	it('free tier has caps and no giveme', () => {
		const e = entitlementsForPlan(false);
		assert.strictEqual(e.planKey, 'free');
		assert.strictEqual(e.givemeSocial, false);
		assert.strictEqual(e.smartaOpenAiAndTts, false);
		assert.strictEqual(e.aiGamesPerUtcDay, 2);
		assert.strictEqual(e.robotCompletionsPer24h, 1);
		assert.strictEqual(e.soloCompletionsPer24h, 5);
		assert.strictEqual(e.generatePerMinute, 8);
	});

	it('pro tier relaxes limits', () => {
		const e = entitlementsForPlan(true);
		assert.strictEqual(e.planKey, 'pro');
		assert.strictEqual(e.givemeSocial, true);
		assert.strictEqual(e.smartaOpenAiAndTts, true);
		assert.strictEqual(e.aiGamesPerUtcDay, null);
		assert.strictEqual(e.robotCompletionsPer24h, null);
		assert.strictEqual(e.soloCompletionsPer24h, 25);
		assert.strictEqual(e.generatePerMinute, 30);
	});

	it('nextUtcMidnightIso is valid ISO', () => {
		const iso = nextUtcMidnightIso();
		assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(iso));
		assert.ok(!Number.isNaN(Date.parse(iso)));
	});
});
