'use strict';

/**
 * Pure helpers that protect the AI generation endpoint (/api/generate-game):
 *  - in-memory daily counters (guest per-IP cap + per-instance global breaker)
 *  - request filter sanitizer (type checks, length clamps, payload size)
 *  - output-language resolution
 *  - small infra helpers (IP hashing for logs, auth-failure classification,
 *    cached health probe, static cache headers)
 *
 * Everything here is deterministic given its inputs (clock is injectable) so
 * it can be unit-tested without Express, OpenAI or Postgres.
 */

const crypto = require('crypto');

// ─── Daily counters ──────────────────────────────────────────────────────────

/** 'YYYY-MM-DD' for the UTC day containing `ms`. */
function utcDayKey(ms) {
	return new Date(ms).toISOString().slice(0, 10);
}

/** ISO timestamp of the next UTC midnight after `ms`. */
function nextUtcMidnightIsoAt(ms) {
	const d = new Date(ms);
	return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
}

/**
 * Parse a positive integer limit from an env-style string.
 * Returns `fallback` for missing / non-numeric / negative values. 0 is allowed
 * (it means "disabled": every request is refused).
 */
function parseLimit(raw, fallback) {
	if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
	const n = Number(String(raw).trim());
	if (!Number.isInteger(n) || n < 0) return fallback;
	return n;
}

/**
 * Per-instance, in-memory counter that resets at UTC midnight.
 *
 * This is a SOFT cap: each serverless instance (Vercel lambda) has its own
 * memory, so the effective ceiling is limit × number of warm instances. The
 * real hard ceiling is the OpenAI project budget.
 *
 * Memory is bounded: the whole map is dropped when the UTC day changes, and
 * keys are only created by consume(), which callers gate behind the global
 * breaker — so at most `global limit` keys exist per day.
 *
 * @param {{ limit: number, now?: () => number }} opts
 */
function createDailyCounter({ limit, now = Date.now }) {
	let day = utcDayKey(now());
	let counts = new Map();

	function roll() {
		const today = utcDayKey(now());
		if (today !== day) {
			day = today;
			counts = new Map();
		}
	}

	/** @returns {{ allowed: boolean, used: number, limit: number, resetsAtUtc: string }} */
	function peek(key) {
		roll();
		const used = counts.get(key) || 0;
		return { allowed: used < limit, used, limit, resetsAtUtc: nextUtcMidnightIsoAt(now()) };
	}

	/** Records one use (even past the limit — callers peek first). */
	function consume(key) {
		roll();
		const used = (counts.get(key) || 0) + 1;
		counts.set(key, used);
		return { used, limit, resetsAtUtc: nextUtcMidnightIsoAt(now()) };
	}

	return { peek, consume, get limit() { return limit; }, size: () => counts.size };
}

/**
 * Admission decision for one AI generation.
 *
 * Order matters: the global breaker is checked first (503), then the guest
 * per-IP cap (429). Nothing is consumed unless every applicable check passes,
 * so a refused request never burns a slot.
 *
 * @param {object} p
 * @param {ReturnType<typeof createDailyCounter>} p.globalCounter
 * @param {ReturnType<typeof createDailyCounter>} p.guestCounter
 * @param {boolean} p.isGuest   true when no DB-backed per-user quota applies
 * @param {string}  p.ipKey     stable key for the client IP
 * @returns {{ ok: true } | { ok: false, status: number, body: object }}
 */
function admitAiGeneration({ globalCounter, guestCounter, isGuest, ipKey }) {
	const g = globalCounter.peek('global');
	if (!g.allowed) {
		return {
			ok: false,
			status: 503,
			body: {
				error: 'AI generovanie je dnes dočasne vyčerpané. Skúste znova neskôr.',
				code: 'AI_DAILY_CAPACITY',
				resetsAtUtc: g.resetsAtUtc
			}
		};
	}
	if (isGuest) {
		const q = guestCounter.peek(ipKey);
		if (!q.allowed) {
			return {
				ok: false,
				status: 429,
				body: {
					error: `Denný limit AI hier pre neprihlásených: ${q.used}/${q.limit}. Prihláste sa alebo skúste zajtra.`,
					code: 'GUEST_AI_DAILY_LIMIT',
					limit: q.limit,
					used: q.used,
					resetsAtUtc: q.resetsAtUtc
				}
			};
		}
		guestCounter.consume(ipKey);
	}
	globalCounter.consume('global');
	return { ok: true };
}

/** Short, non-reversible IP fingerprint for logs (never log raw IPs). */
function hashIp(ip) {
	return crypto.createHash('sha256').update(String(ip || 'unknown')).digest('hex').slice(0, 12);
}

// ─── Filter sanitizer ────────────────────────────────────────────────────────

const MAX_FILTER_STRING = 300;
const MAX_FILTERS_JSON_BYTES = 8 * 1024;

/** Every filter field the server reads. Unknown keys are dropped. */
const FILTER_STRING_FIELDS = [
	'mode', 'lang', 'language', 'langCode', 'locale', 'aiLanguage',
	'ageMin', 'ageMax', 'players', 'duration', 'setting', 'energy',
	'activity', 'depth', 'cuisine', 'focus',
	'stupen', 'kompetence', 'oblast', 'description'
];
/** Fields where a finite number is also accepted (converted to a string). */
const NUMERIC_OK_FIELDS = new Set(['ageMin', 'ageMax', 'players', 'duration']);

// C0 control chars except \t \n \r, plus DEL.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Trim, strip control characters, clamp to `max` chars (code points). */
function cleanText(value, max = MAX_FILTER_STRING) {
	const s = String(value).replace(CONTROL_CHARS, '').trim();
	const chars = Array.from(s);
	return chars.length > max ? chars.slice(0, max).join('') : s;
}

function isPlainObject(v) {
	return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Validate and normalise the `filters` object from POST /api/generate-game.
 *
 * @param {unknown} raw
 * @returns {{ ok: true, filters: Record<string,string> } |
 *           { ok: false, status: number, code: string, error: string }}
 */
function sanitizeGenerateFilters(raw) {
	if (raw === undefined || raw === null) return { ok: true, filters: {} };
	if (!isPlainObject(raw)) {
		return { ok: false, status: 400, code: 'INVALID_FILTERS', error: 'filters musí byť objekt' };
	}
	let size;
	try {
		size = Buffer.byteLength(JSON.stringify(raw), 'utf8');
	} catch {
		return { ok: false, status: 400, code: 'INVALID_FILTERS', error: 'filters nie je platný JSON' };
	}
	if (size > MAX_FILTERS_JSON_BYTES) {
		return { ok: false, status: 413, code: 'FILTERS_TOO_LARGE', error: `filters prekračuje ${MAX_FILTERS_JSON_BYTES} bajtov` };
	}
	const out = {};
	for (const key of FILTER_STRING_FIELDS) {
		const v = raw[key];
		if (v === undefined || v === null) continue;
		if (typeof v === 'string') {
			const cleaned = cleanText(v);
			if (cleaned) out[key] = cleaned;
			continue;
		}
		if (NUMERIC_OK_FIELDS.has(key) && typeof v === 'number' && Number.isFinite(v)) {
			out[key] = String(v);
			continue;
		}
		return { ok: false, status: 400, code: 'INVALID_FILTERS', error: `filters.${key} musí byť text` };
	}
	return { ok: true, filters: out };
}

/**
 * Reduce a remix source game to the few fields the prompt uses, clamped.
 * Returns null when there is nothing usable (no string title).
 */
function sanitizeRemix(raw) {
	if (!isPlainObject(raw) || typeof raw.title !== 'string') return null;
	const title = cleanText(raw.title);
	if (!title) return null;
	const strList = (arr, n) => (Array.isArray(arr) ? arr : [])
		.filter(x => typeof x === 'string')
		.slice(0, n)
		.map(x => cleanText(x))
		.filter(Boolean);
	return {
		title,
		mode: typeof raw.mode === 'string' ? cleanText(raw.mode) : '',
		kompetence: strList(isPlainObject(raw.rvp) ? raw.rvp.kompetence : null, 10),
		learningGoals: strList(raw.learningGoals, 3)
	};
}

// ─── Output language ─────────────────────────────────────────────────────────

const LANGUAGE_NAMES = Object.freeze({
	sk: 'Slovak', cs: 'Czech', en: 'English', de: 'German', es: 'Spanish', tr: 'Turkish'
});
const DEFAULT_LANGUAGE = 'sk';

// Language names (English + native, as i18n `_meta.ai_language` may send) → code.
const NAME_TO_CODE = {
	slovak: 'sk', 'slovenčina': 'sk', slovencina: 'sk', 'slovenský': 'sk',
	czech: 'cs', 'čeština': 'cs', cestina: 'cs', 'český': 'cs',
	english: 'en',
	german: 'de', deutsch: 'de',
	spanish: 'es', 'español': 'es', espanol: 'es',
	turkish: 'tr', 'türkçe': 'tr', turkce: 'tr'
};

/** 'sk', 'SK', 'sk-SK', 'cs_CZ', 'cz' → supported code, or null. */
function normalizeLangCode(value) {
	if (typeof value !== 'string') return null;
	const base = value.trim().toLowerCase().split(/[-_]/)[0];
	if (base === 'cz') return 'cs';
	return Object.prototype.hasOwnProperty.call(LANGUAGE_NAMES, base) ? base : null;
}

/**
 * Decide the output language for a generation request.
 * The frontend sends `lang` (UI code) + `aiLanguage` (English name); API
 * clients often send `language`. Codes win over names; default is Slovak.
 *
 * @returns {{ code: string, name: string }}
 */
function resolveOutputLanguage(filters) {
	const f = isPlainObject(filters) ? filters : {};
	for (const field of ['lang', 'language', 'langCode', 'locale']) {
		const code = normalizeLangCode(f[field]);
		if (code) return { code, name: LANGUAGE_NAMES[code] };
	}
	for (const field of ['aiLanguage', 'language']) {
		if (typeof f[field] === 'string') {
			const code = NAME_TO_CODE[f[field].trim().toLowerCase()];
			if (code) return { code, name: LANGUAGE_NAMES[code] };
		}
	}
	return { code: DEFAULT_LANGUAGE, name: LANGUAGE_NAMES[DEFAULT_LANGUAGE] };
}

// ─── Auth failure classification ─────────────────────────────────────────────

/**
 * Is a Supabase /auth/v1/user failure an outage (→ 503) rather than a bad
 * token (→ 401/403)? Network errors, timeouts/aborts, 429 and 5xx are outages.
 *
 * @param {{ status?: number, error?: unknown }} p
 */
function isAuthOutage({ status, error } = {}) {
	if (typeof status === 'number') return status >= 500 || status === 429;
	return Boolean(error); // fetch threw: DNS / connection / AbortError
}

// ─── Cached health probe ─────────────────────────────────────────────────────

/**
 * Wrap an async probe so it runs at most once per `ttlMs`, times out after
 * `timeoutMs`, and concurrent callers share one in-flight run.
 * Resolves to 'ok' | 'down' (never rejects, never exposes error details).
 *
 * @param {{ probe: () => Promise<unknown>, ttlMs?: number, timeoutMs?: number, now?: () => number }} opts
 */
function createCachedProbe({ probe, ttlMs = 30000, timeoutMs = 2000, now = Date.now }) {
	let cached = null; // { value, at }
	let inflight = null;

	function runOnce() {
		let timer;
		const timeout = new Promise(resolve => {
			timer = setTimeout(() => resolve('down'), timeoutMs);
			if (timer.unref) timer.unref();
		});
		const attempt = Promise.resolve()
			.then(() => probe())
			.then(() => 'ok', () => 'down');
		return Promise.race([attempt, timeout]).finally(() => clearTimeout(timer));
	}

	return async function check() {
		if (cached && now() - cached.at < ttlMs) return cached.value;
		if (!inflight) {
			inflight = runOnce().then(value => {
				cached = { value, at: now() };
				inflight = null;
				return value;
			});
		}
		return inflight;
	};
}

// ─── Static asset caching ────────────────────────────────────────────────────

// Many pages (edu/, student/, institution/) load scripts without a ?v=N query,
// so code and styles always revalidate (cheap 304 via ETag) to avoid running
// stale JS against fresh HTML after a deploy.
const REVALIDATE_EXT = new Set(['.js', '.mjs', '.css', '.map']);

const LONG_CACHE_EXT = new Set([
	'.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.avif', '.ico',
	'.woff', '.woff2', '.ttf', '.otf', '.eot',
	'.mp3', '.wav', '.ogg', '.mp4', '.webm'
]);

/**
 * Cache-Control value for a static file path, or null to keep Express' default.
 * HTML, JS and CSS always revalidate (so deploys are picked up immediately);
 * images, fonts and media may be cached for an hour.
 */
function cacheControlForPath(filePath) {
	const m = /\.[a-z0-9]+$/i.exec(String(filePath || ''));
	const ext = m ? m[0].toLowerCase() : '';
	if (ext === '.html' || ext === '.htm') return 'no-cache';
	if (REVALIDATE_EXT.has(ext)) return 'public, max-age=0, must-revalidate';
	if (LONG_CACHE_EXT.has(ext)) return 'public, max-age=3600';
	return null;
}

module.exports = {
	utcDayKey,
	nextUtcMidnightIsoAt,
	parseLimit,
	createDailyCounter,
	admitAiGeneration,
	hashIp,
	MAX_FILTER_STRING,
	MAX_FILTERS_JSON_BYTES,
	FILTER_STRING_FIELDS,
	cleanText,
	sanitizeGenerateFilters,
	sanitizeRemix,
	LANGUAGE_NAMES,
	DEFAULT_LANGUAGE,
	normalizeLangCode,
	resolveOutputLanguage,
	isAuthOutage,
	createCachedProbe,
	cacheControlForPath
};
