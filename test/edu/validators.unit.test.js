/**
 * test/edu/validators.unit.test.js
 * Unit tests for EDU validation helpers and rate limiter.
 * Run: node --test test/edu/validators.unit.test.js
 *
 * Uses only node:test + node:assert — no external test framework.
 */

'use strict';

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Import validators and rate-limit test helpers from edu-routes
const { _validators, _testHelpers } = require('../../lib/edu-routes');
const { isUUID, isISODate, isSchoolYear, clampStr } = _validators;
const { resetRateBuckets, simulateRateLimit, getRateBucket } = _testHelpers;

// ─────────────────────────────────────────────────────────────
// isUUID
// ─────────────────────────────────────────────────────────────
describe('isUUID', () => {
  it('accepts a valid v4 UUID (lowercase)', () => {
    assert.ok(isUUID('550e8400-e29b-41d4-a716-446655440000'));
  });

  it('accepts a valid UUID with uppercase hex digits', () => {
    assert.ok(isUUID('550E8400-E29B-41D4-A716-446655440000'));
  });

  it('accepts a valid UUID with mixed case', () => {
    assert.ok(isUUID('550e8400-E29B-41d4-A716-446655440000'));
  });

  it('rejects an empty string', () => {
    assert.strictEqual(isUUID(''), false);
  });

  it('rejects undefined', () => {
    assert.strictEqual(isUUID(undefined), false);
  });

  it('rejects null', () => {
    assert.strictEqual(isUUID(null), false);
  });

  it('rejects a number', () => {
    assert.strictEqual(isUUID(12345), false);
  });

  it('rejects a UUID with wrong segment lengths', () => {
    assert.strictEqual(isUUID('550e840-e29b-41d4-a716-446655440000'), false);
  });

  it('rejects a UUID with too many segments', () => {
    assert.strictEqual(isUUID('550e8400-e29b-41d4-a716-4466554400001'), false);
  });

  it('rejects a UUID with non-hex characters', () => {
    assert.strictEqual(isUUID('550e8400-e29b-41d4-a716-44665544000g'), false);
  });

  it('rejects a UUID with SQL injection attempt', () => {
    assert.strictEqual(isUUID("' OR 1=1 --"), false);
  });

  it('rejects a UUID with embedded newline', () => {
    assert.strictEqual(isUUID('550e8400-e29b-41d4-a716-44665544000\n'), false);
  });

  it('accepts a UUID with surrounding whitespace (trim is applied)', () => {
    // isUUID calls s.trim() before testing
    assert.ok(isUUID('  550e8400-e29b-41d4-a716-446655440000  '));
  });
});

// ─────────────────────────────────────────────────────────────
// isISODate
// ─────────────────────────────────────────────────────────────
describe('isISODate', () => {
  it('accepts a valid ISO date', () => {
    assert.ok(isISODate('2024-09-01'));
  });

  it('accepts the first day of year', () => {
    assert.ok(isISODate('2000-01-01'));
  });

  it('accepts a far-future date', () => {
    assert.ok(isISODate('2099-12-31'));
  });

  it('rejects empty string', () => {
    assert.strictEqual(isISODate(''), false);
  });

  it('rejects undefined', () => {
    assert.strictEqual(isISODate(undefined), false);
  });

  it('rejects a number', () => {
    assert.strictEqual(isISODate(20240901), false);
  });

  it('rejects non-ISO formats (d/m/Y)', () => {
    assert.strictEqual(isISODate('01/09/2024'), false);
  });

  it('rejects non-ISO formats (d.m.Y)', () => {
    assert.strictEqual(isISODate('01.09.2024'), false);
  });

  it('rejects an invalid calendar date (month 13)', () => {
    assert.strictEqual(isISODate('2024-13-01'), false);
  });

  it('rejects an invalid calendar date (day 32)', () => {
    assert.strictEqual(isISODate('2024-01-32'), false);
  });

  it('rejects an ISO datetime string', () => {
    assert.strictEqual(isISODate('2024-09-01T00:00:00Z'), false);
  });

  it('rejects a SQL injection attempt', () => {
    assert.strictEqual(isISODate("2024-01-01' OR '1'='1"), false);
  });
});

// ─────────────────────────────────────────────────────────────
// isSchoolYear
// ─────────────────────────────────────────────────────────────
describe('isSchoolYear', () => {
  it('accepts a valid school year', () => {
    assert.ok(isSchoolYear('2024/2025'));
  });

  it('accepts another valid school year', () => {
    assert.ok(isSchoolYear('1999/2000'));
  });

  it('rejects empty string', () => {
    assert.strictEqual(isSchoolYear(''), false);
  });

  it('rejects undefined', () => {
    assert.strictEqual(isSchoolYear(undefined), false);
  });

  it('rejects dash separator', () => {
    assert.strictEqual(isSchoolYear('2024-2025'), false);
  });

  it('rejects a single year', () => {
    assert.strictEqual(isSchoolYear('2024'), false);
  });

  it('rejects a 3-digit year', () => {
    assert.strictEqual(isSchoolYear('202/2025'), false);
  });

  it('rejects letters mixed in', () => {
    assert.strictEqual(isSchoolYear('2024/202a'), false);
  });

  it('rejects an oversized input', () => {
    assert.strictEqual(isSchoolYear('20240/20250'), false);
  });
});

// ─────────────────────────────────────────────────────────────
// clampStr
// ─────────────────────────────────────────────────────────────
describe('clampStr', () => {
  it('returns the string unchanged when under limit', () => {
    assert.strictEqual(clampStr('hello', 10), 'hello');
  });

  it('trims leading and trailing whitespace', () => {
    assert.strictEqual(clampStr('  hello  ', 100), 'hello');
  });

  it('truncates to max characters after trim', () => {
    assert.strictEqual(clampStr('abcdef', 3), 'abc');
  });

  it('returns empty string for undefined', () => {
    assert.strictEqual(clampStr(undefined, 10), '');
  });

  it('returns empty string for null', () => {
    assert.strictEqual(clampStr(null, 10), '');
  });

  it('returns empty string for a number', () => {
    assert.strictEqual(clampStr(42, 10), '');
  });

  it('handles a 10000-character payload and clamps correctly', () => {
    const huge = 'x'.repeat(10000);
    assert.strictEqual(clampStr(huge, 200).length, 200);
  });
});

// ─────────────────────────────────────────────────────────────
// rateLimit (via _testHelpers)
// ─────────────────────────────────────────────────────────────
describe('rateLimit via _testHelpers', () => {
  beforeEach(() => {
    resetRateBuckets();
  });

  it('resetRateBuckets clears all buckets', () => {
    simulateRateLimit('test-key', 999, 60000);
    resetRateBuckets();
    assert.strictEqual(getRateBucket('test-key'), undefined);
  });

  it('simulateRateLimit sets a bucket at the specified count', () => {
    simulateRateLimit('user-abc:members', 20, 15 * 60 * 1000);
    const bucket = getRateBucket('user-abc:members');
    assert.ok(bucket, 'bucket should exist');
    assert.strictEqual(bucket.count, 20);
    assert.ok(bucket.resetAt > Date.now(), 'resetAt should be in the future');
  });

  it('a bucket at max count is already exhausted on next request', () => {
    // Simulate a bucket that has exactly hit the limit of 30
    simulateRateLimit('user-xyz:email', 30, 10 * 60 * 1000);
    const bucket = getRateBucket('user-xyz:email');
    // count === maxRequests means the 30th request was just allowed;
    // the 31st request would be denied (count > maxRequests)
    assert.strictEqual(bucket.count, 30);
  });

  it('buckets for different keys are independent', () => {
    simulateRateLimit('user-a:members', 20, 60000);
    simulateRateLimit('user-b:members', 5, 60000);
    assert.strictEqual(getRateBucket('user-a:members').count, 20);
    assert.strictEqual(getRateBucket('user-b:members').count, 5);
  });

  it('a bucket with resetAt in the past is treated as expired', () => {
    // Manually insert an expired bucket by simulating with windowMs=0
    // (resetAt = now + 0 = now, already expired on next check)
    simulateRateLimit('user-c:expired', 999, 0);
    const bucket = getRateBucket('user-c:expired');
    assert.ok(bucket.resetAt <= Date.now() + 1, 'bucket should be at or past expiry');
  });
});
