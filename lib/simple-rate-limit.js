'use strict';

/**
 * Tiny fixed-window, in-memory rate limiter (per process). Good enough for
 * cheap abuse protection on a single Node instance; on serverless every
 * instance keeps its own window.
 *
 * Memory is bounded: past maxKeys, expired windows are dropped first, then
 * the oldest windows (Map insertion order), so a flood of fresh keys cannot
 * grow the map without limit.
 */

/**
 * @param {{ limit: number, windowMs: number, maxKeys?: number }} opts
 * @returns {{ check: (key: string) => { ok: boolean, retryAfterSec: number }, reset: () => void, size: () => number }}
 */
function createRateLimiter({ limit, windowMs, maxKeys = 10000 }) {
	const buckets = new Map();

	function prune(now) {
		for (const [key, b] of buckets) {
			if (b.resetAt <= now) buckets.delete(key);
		}
		// Still full: evict the oldest windows.
		for (const key of buckets.keys()) {
			if (buckets.size < maxKeys) break;
			buckets.delete(key);
		}
	}

	function check(key) {
		const now = Date.now();
		const b = buckets.get(key);
		if (!b || b.resetAt <= now) {
			if (b) buckets.delete(key); // re-insert at the end (newest)
			else if (buckets.size >= maxKeys) prune(now);
			buckets.set(key, { count: 1, resetAt: now + windowMs });
			return { ok: true, retryAfterSec: 0 };
		}
		if (b.count >= limit) {
			return { ok: false, retryAfterSec: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) };
		}
		b.count += 1;
		return { ok: true, retryAfterSec: 0 };
	}

	return { check, reset: () => buckets.clear(), size: () => buckets.size };
}

module.exports = { createRateLimiter };
