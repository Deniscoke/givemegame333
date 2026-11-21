'use strict';

/**
 * Tiny fixed-window, in-memory rate limiter (per process). Good enough for
 * cheap abuse protection on a single Node instance; on serverless every
 * instance keeps its own window.
 */

/**
 * @param {{ limit: number, windowMs: number, maxKeys?: number }} opts
 * @returns {{ check: (key: string) => { ok: boolean, retryAfterSec: number }, reset: () => void }}
 */
function createRateLimiter({ limit, windowMs, maxKeys = 10000 }) {
	const buckets = new Map();

	function prune(now) {
		for (const [key, b] of buckets) {
			if (b.resetAt <= now) buckets.delete(key);
		}
	}

	function check(key) {
		const now = Date.now();
		if (buckets.size > maxKeys) prune(now);
		const b = buckets.get(key);
		if (!b || b.resetAt <= now) {
			buckets.set(key, { count: 1, resetAt: now + windowMs });
			return { ok: true, retryAfterSec: 0 };
		}
		if (b.count >= limit) {
			return { ok: false, retryAfterSec: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) };
		}
		b.count += 1;
		return { ok: true, retryAfterSec: 0 };
	}

	return { check, reset: () => buckets.clear() };
}

module.exports = { createRateLimiter };
