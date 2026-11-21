'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
	utcDayKey,
	nextUtcMidnightIsoAt,
	parseLimit,
	createDailyCounter,
	admitAiGeneration,
	hashIp,
	MAX_FILTER_STRING,
	cleanText,
	sanitizeGenerateFilters,
	sanitizeRemix,
	normalizeLangCode,
	resolveOutputLanguage,
	isAuthOutage,
	createCachedProbe,
	cacheControlForPath,
} = require('../lib/ai-guard');

const T0 = Date.UTC(2026, 10, 21, 12, 0, 0); // 2026-11-21 12:00 UTC
function clock(start = T0) {
	let t = start;
	const now = () => t;
	now.set = (v) => { t = v; };
	return now;
}

describe('ai-guard: UTC day helpers', () => {
	it('utcDayKey / nextUtcMidnightIsoAt', () => {
		assert.equal(utcDayKey(T0), '2026-11-21');
		assert.equal(nextUtcMidnightIsoAt(T0), '2026-11-22T00:00:00.000Z');
		assert.equal(nextUtcMidnightIsoAt(Date.UTC(2026, 11, 31, 23, 59)), '2027-01-01T00:00:00.000Z');
	});

	it('parseLimit: defaults, zero, garbage', () => {
		assert.equal(parseLimit(undefined, 5), 5);
		assert.equal(parseLimit('', 5), 5);
		assert.equal(parseLimit('12', 5), 12);
		assert.equal(parseLimit(' 0 ', 5), 0);
		assert.equal(parseLimit('-3', 5), 5);
		assert.equal(parseLimit('abc', 5), 5);
		assert.equal(parseLimit('2.5', 5), 5);
	});
});

describe('ai-guard: createDailyCounter', () => {
	it('counts per key and blocks at the limit', () => {
		const c = createDailyCounter({ limit: 2, now: clock() });
		assert.equal(c.peek('a').allowed, true);
		c.consume('a');
		c.consume('a');
		const p = c.peek('a');
		assert.equal(p.allowed, false);
		assert.equal(p.used, 2);
		assert.equal(p.resetsAtUtc, '2026-11-22T00:00:00.000Z');
		assert.equal(c.peek('b').allowed, true);
	});

	it('peek never creates keys', () => {
		const c = createDailyCounter({ limit: 2, now: clock() });
		c.peek('x'); c.peek('y');
		assert.equal(c.size(), 0);
	});

	it('resets at UTC midnight', () => {
		const now = clock();
		const c = createDailyCounter({ limit: 1, now });
		c.consume('a');
		assert.equal(c.peek('a').allowed, false);
		now.set(Date.UTC(2026, 10, 22, 0, 0, 1));
		assert.equal(c.peek('a').allowed, true);
		assert.equal(c.size(), 0);
	});

	it('limit 0 refuses everything', () => {
		const c = createDailyCounter({ limit: 0, now: clock() });
		assert.equal(c.peek('a').allowed, false);
	});
});

describe('ai-guard: admitAiGeneration', () => {
	function setup(guestLimit = 2, globalLimit = 3) {
		const now = clock();
		return {
			guestCounter: createDailyCounter({ limit: guestLimit, now }),
			globalCounter: createDailyCounter({ limit: globalLimit, now }),
		};
	}

	it('guest is capped per IP with 429 GUEST_AI_DAILY_LIMIT + resetsAtUtc', () => {
		const s = setup(2, 100);
		assert.equal(admitAiGeneration({ ...s, isGuest: true, ipKey: 'ip:1' }).ok, true);
		assert.equal(admitAiGeneration({ ...s, isGuest: true, ipKey: 'ip:1' }).ok, true);
		const r = admitAiGeneration({ ...s, isGuest: true, ipKey: 'ip:1' });
		assert.equal(r.ok, false);
		assert.equal(r.status, 429);
		assert.equal(r.body.code, 'GUEST_AI_DAILY_LIMIT');
		assert.equal(r.body.resetsAtUtc, '2026-11-22T00:00:00.000Z');
		assert.equal(admitAiGeneration({ ...s, isGuest: true, ipKey: 'ip:2' }).ok, true);
	});

	it('logged-in (non-guest) requests skip the guest counter', () => {
		const s = setup(1, 100);
		for (let i = 0; i < 5; i++) {
			assert.equal(admitAiGeneration({ ...s, isGuest: false, ipKey: 'ip:1' }).ok, true);
		}
		assert.equal(s.guestCounter.size(), 0);
	});

	it('global breaker returns 503 AI_DAILY_CAPACITY for everyone', () => {
		const s = setup(10, 2);
		admitAiGeneration({ ...s, isGuest: false, ipKey: 'ip:1' });
		admitAiGeneration({ ...s, isGuest: true, ipKey: 'ip:2' });
		const r1 = admitAiGeneration({ ...s, isGuest: false, ipKey: 'ip:3' });
		const r2 = admitAiGeneration({ ...s, isGuest: true, ipKey: 'ip:4' });
		assert.equal(r1.status, 503);
		assert.equal(r1.body.code, 'AI_DAILY_CAPACITY');
		assert.equal(r2.status, 503);
	});

	it('refused requests do not consume slots', () => {
		const s = setup(1, 1);
		assert.equal(admitAiGeneration({ ...s, isGuest: true, ipKey: 'ip:1' }).ok, true);
		// global now full → guest ip:2 refused with 503, and its guest slot is untouched
		assert.equal(admitAiGeneration({ ...s, isGuest: true, ipKey: 'ip:2' }).status, 503);
		assert.equal(s.guestCounter.peek('ip:2').used, 0);
	});
});

describe('ai-guard: hashIp', () => {
	it('is stable, short and does not contain the IP', () => {
		const h = hashIp('203.0.113.7');
		assert.equal(h, hashIp('203.0.113.7'));
		assert.equal(h.length, 12);
		assert.ok(!h.includes('203'));
		assert.notEqual(h, hashIp('203.0.113.8'));
	});
});

describe('ai-guard: sanitizeGenerateFilters', () => {
	it('missing filters → empty object', () => {
		assert.deepEqual(sanitizeGenerateFilters(undefined), { ok: true, filters: {} });
		assert.deepEqual(sanitizeGenerateFilters(null), { ok: true, filters: {} });
	});

	it('rejects non-object filters', () => {
		for (const bad of ['x', 5, [], true]) {
			const r = sanitizeGenerateFilters(bad);
			assert.equal(r.ok, false);
			assert.equal(r.status, 400);
			assert.equal(r.code, 'INVALID_FILTERS');
		}
	});

	it('rejects non-string field types', () => {
		for (const bad of [{ description: { a: 1 } }, { aiLanguage: ['Slovak'] }, { mode: 5 }, { lang: true }]) {
			const r = sanitizeGenerateFilters(bad);
			assert.equal(r.ok, false, JSON.stringify(bad));
			assert.equal(r.status, 400);
		}
	});

	it('accepts numeric ages, players and duration as strings', () => {
		const r = sanitizeGenerateFilters({ ageMin: 8, ageMax: '12', players: 4, duration: 15 });
		assert.deepEqual(r.filters, { ageMin: '8', ageMax: '12', players: '4', duration: '15' });
		assert.equal(sanitizeGenerateFilters({ ageMin: NaN }).ok, false);
		assert.equal(sanitizeGenerateFilters({ players: Infinity }).ok, false);
	});

	it('clamps strings to 300 chars and trims', () => {
		const r = sanitizeGenerateFilters({ description: '  ' + 'a'.repeat(1000) + '  ' });
		assert.equal(r.ok, true);
		assert.equal(r.filters.description.length, MAX_FILTER_STRING);
	});

	it('strips control characters, keeps newlines', () => {
		const r = sanitizeGenerateFilters({ description: 'a\u0000b\u0007c\nd' });
		assert.equal(r.filters.description, 'abc\nd');
	});

	it('drops unknown keys and empty strings', () => {
		const r = sanitizeGenerateFilters({ mode: 'party', evil: 'x', players: '' });
		assert.deepEqual(r.filters, { mode: 'party' });
	});

	it('rejects payloads over 8 KB with 413', () => {
		const r = sanitizeGenerateFilters({ junk: 'x'.repeat(9000) });
		assert.equal(r.ok, false);
		assert.equal(r.status, 413);
		assert.equal(r.code, 'FILTERS_TOO_LARGE');
	});

	it('passes a realistic frontend payload unchanged', () => {
		const payload = {
			mode: 'classroom', lang: 'sk', aiLanguage: 'Slovak', ageMin: '10', ageMax: '14',
			players: 'medium', duration: 'quick', setting: 'any', energy: 'medium',
			stupen: 'druhy', kompetence: 'k-uceni', oblast: '', description: 'Téma: vesmír'
		};
		const r = sanitizeGenerateFilters(payload);
		assert.equal(r.ok, true);
		const { oblast, ...rest } = payload;
		assert.deepEqual(r.filters, rest);
	});
});

describe('ai-guard: cleanText', () => {
	it('clamps by code points (no broken surrogate pairs)', () => {
		const s = cleanText('😀'.repeat(400));
		assert.equal(Array.from(s).length, 300);
		assert.ok(!/[\uD800-\uDBFF]$/.test(s));
	});
});

describe('ai-guard: sanitizeRemix', () => {
	it('keeps only prompt fields, clamped', () => {
		const r = sanitizeRemix({
			title: 'T'.repeat(500), mode: 'party',
			rvp: { kompetence: ['k-uceni', 5, 'digitalni'] },
			learningGoals: ['a', 'b', 'c', 'd'], instructions: ['ignored']
		});
		assert.equal(r.title.length, 300);
		assert.deepEqual(r.kompetence, ['k-uceni', 'digitalni']);
		assert.deepEqual(r.learningGoals, ['a', 'b', 'c']);
		assert.equal(r.instructions, undefined);
	});

	it('returns null without a string title', () => {
		assert.equal(sanitizeRemix(null), null);
		assert.equal(sanitizeRemix({ title: 5 }), null);
		assert.equal(sanitizeRemix({ title: '   ' }), null);
		assert.equal(sanitizeRemix('x'), null);
	});
});

describe('ai-guard: resolveOutputLanguage', () => {
	it('honours `language` code (API clients) — the sk→Czech bug', () => {
		assert.deepEqual(resolveOutputLanguage({ language: 'sk' }), { code: 'sk', name: 'Slovak' });
	});

	it('honours `lang` code (frontend) over aiLanguage', () => {
		assert.deepEqual(resolveOutputLanguage({ lang: 'de', aiLanguage: 'Czech' }), { code: 'de', name: 'German' });
	});

	it('maps aiLanguage names when no code is given', () => {
		assert.equal(resolveOutputLanguage({ aiLanguage: 'Czech' }).code, 'cs');
		assert.equal(resolveOutputLanguage({ aiLanguage: 'Turkish' }).code, 'tr');
		assert.equal(resolveOutputLanguage({ language: 'Slovenčina' }).code, 'sk');
	});

	it('defaults to Slovak for missing / invalid input', () => {
		assert.equal(resolveOutputLanguage({}).code, 'sk');
		assert.equal(resolveOutputLanguage(undefined).code, 'sk');
		assert.equal(resolveOutputLanguage({ lang: 'xx', aiLanguage: 'Klingon' }).code, 'sk');
	});

	it('supports all six codes', () => {
		for (const c of ['sk', 'cs', 'en', 'de', 'es', 'tr']) {
			assert.equal(resolveOutputLanguage({ lang: c }).code, c);
		}
	});

	it('normalizeLangCode handles region suffixes and cz', () => {
		assert.equal(normalizeLangCode('sk-SK'), 'sk');
		assert.equal(normalizeLangCode('CS_cz'), 'cs');
		assert.equal(normalizeLangCode('cz'), 'cs');
		assert.equal(normalizeLangCode('fr'), null);
		assert.equal(normalizeLangCode(5), null);
	});
});

describe('ai-guard: isAuthOutage', () => {
	it('5xx / 429 / thrown fetch are outages; 401/403 are not', () => {
		assert.equal(isAuthOutage({ status: 500 }), true);
		assert.equal(isAuthOutage({ status: 503 }), true);
		assert.equal(isAuthOutage({ status: 429 }), true);
		assert.equal(isAuthOutage({ status: 401 }), false);
		assert.equal(isAuthOutage({ status: 403 }), false);
		assert.equal(isAuthOutage({ error: Object.assign(new Error('x'), { name: 'AbortError' }) }), true);
		assert.equal(isAuthOutage({}), false);
	});
});

describe('ai-guard: createCachedProbe', () => {
	it('returns ok and caches for ttl', async () => {
		const now = clock();
		let calls = 0;
		const check = createCachedProbe({ probe: async () => { calls++; }, ttlMs: 30000, timeoutMs: 50, now });
		assert.equal(await check(), 'ok');
		assert.equal(await check(), 'ok');
		assert.equal(calls, 1);
		now.set(T0 + 31000);
		await check();
		assert.equal(calls, 2);
	});

	it('returns down on rejection without leaking the error', async () => {
		const check = createCachedProbe({ probe: async () => { throw new Error('password=secret'); }, timeoutMs: 50 });
		assert.equal(await check(), 'down');
	});

	it('returns down on timeout', async () => {
		const check = createCachedProbe({ probe: () => new Promise(() => {}), timeoutMs: 20 });
		assert.equal(await check(), 'down');
	});

	it('shares one in-flight probe between concurrent callers', async () => {
		let calls = 0;
		const check = createCachedProbe({
			probe: () => new Promise(r => { calls++; setTimeout(r, 10); }), timeoutMs: 200
		});
		const [a, b] = await Promise.all([check(), check()]);
		assert.equal(a, 'ok');
		assert.equal(b, 'ok');
		assert.equal(calls, 1);
	});
});

describe('ai-guard: cacheControlForPath', () => {
	it('html/js/css revalidate, media cache 1 h, others untouched', () => {
		assert.equal(cacheControlForPath('/x/public/index.html'), 'no-cache');
		assert.equal(cacheControlForPath('C:\\x\\public\\edu\\INDEX.HTML'), 'no-cache');
		assert.equal(cacheControlForPath('/x/script.js'), 'public, max-age=0, must-revalidate');
		assert.equal(cacheControlForPath('/x/style.css'), 'public, max-age=0, must-revalidate');
		assert.equal(cacheControlForPath('/x/img/a.webp'), 'public, max-age=3600');
		assert.equal(cacheControlForPath('/x/fonts/a.woff2'), 'public, max-age=3600');
		assert.equal(cacheControlForPath('/x/data/i18n/sk.json'), null);
		assert.equal(cacheControlForPath('/x/README'), null);
	});
});
