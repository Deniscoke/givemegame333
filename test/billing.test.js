/**
 * gIVEMEGAME.IO — Unit tests for billing helpers
 * Run: node --test test/billing.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { hasPaidAccess } = require('../lib/billing');

describe('hasPaidAccess', () => {
	it('returns false for null/undefined', () => {
		assert.strictEqual(hasPaidAccess(null), false);
		assert.strictEqual(hasPaidAccess(undefined), false);
	});

	it('returns false for empty object', () => {
		assert.strictEqual(hasPaidAccess({}), false);
	});

	it('returns true for active subscription', () => {
		assert.strictEqual(hasPaidAccess({ subscription_status: 'active' }), true);
	});

	it('returns true for trialing subscription', () => {
		assert.strictEqual(hasPaidAccess({ subscription_status: 'trialing' }), true);
	});

	it('returns false for canceled subscription', () => {
		assert.strictEqual(hasPaidAccess({ subscription_status: 'canceled' }), false);
	});

	it('returns false for unpaid subscription', () => {
		assert.strictEqual(hasPaidAccess({ subscription_status: 'unpaid' }), false);
	});

	it('returns false for past_due (strict for MVP)', () => {
		assert.strictEqual(hasPaidAccess({ subscription_status: 'past_due' }), false);
	});

	it('returns false for none', () => {
		assert.strictEqual(hasPaidAccess({ subscription_status: 'none' }), false);
	});
});
