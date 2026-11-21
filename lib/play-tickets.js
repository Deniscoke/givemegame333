'use strict';

/**
 * lib/play-tickets.js — verifiable solo play (Phase 5).
 *
 * A play ticket is the server's own copy of a game a user plays solo. It is
 * issued when the game is generated (or taken from the user's library) and
 * started when the timer starts. /api/profile/complete-solo then takes only
 * the ticket id: duration, mode and competencies come from the ticket row,
 * never from the browser. A ticket pays out once.
 *
 * Rewards (all server-side):
 *   participation XP  — the existing 30-120 curve on validated minutes
 *   reflection bonus  — +25 % when a reflection passed the quality gate
 *   boost             — xp_boost_2x uses read from the coin ledger
 *   stat XP           — participation + bonus (never the bought boost) split
 *                       across attributes by lib/attribute-map.js
 *
 * DB helpers take a pg client / pool; the caller owns BEGIN / COMMIT.
 */

const crypto = require('node:crypto');
const FilterPresets = require('./filter-presets');
const { computeSoloXpFromDurationMax } = require('./rpg-progression');
const { splitStatXp, STAT_XP_KEYS } = require('./attribute-map');
const { STAT_KEYS } = require('./rpg-progression');

/** Reflection bonus on top of participation XP. */
const REFLECTION_BONUS_RATE = 0.25;
/** Open reflection answers must be at least this long (trimmed). */
const REFLECTION_MIN_CHARS = 20;
const REFLECTION_MAX_CHARS = 300;
/** A reflection may not repeat any answer from the user's last N reflections. */
const REFLECTION_HISTORY = 5;
/** Open answers the solo reflection form asks for. */
const REFLECTION_TEXT_KEYS = Object.freeze(['darilo', 'zlepsit']);
/** The form shows 3 rating questions (competencies first, padded to 3). */
const REFLECTION_MIN_RATINGS = 3;
const REFLECTION_MAX_RATINGS = 6;
/** Tickets a user may open from the library per UTC day. */
const MAX_LIBRARY_TICKETS_PER_DAY = 100;
/** Competency keys a generated game may carry (server.js VALID_COMPETENCY_KEYS). */
const VALID_GAME_COMPETENCIES = Object.freeze([
	'k-uceni', 'k-reseni-problemu', 'komunikativni',
	'socialni-personalni', 'obcanske', 'pracovni', 'digitalni',
]);
/** Default end of the two-week window in which complete-solo still accepts game_json. */
const DEFAULT_LEGACY_UNTIL = '2026-12-05T00:00:00Z';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RATING_KEY_RE = /^[a-z0-9_-]{1,40}$/i;

// ─── Feature flag and deprecation window ────────────────────────────────────

/** PLAY_TICKETS_ENABLED defaults to ON; "0", "false", "off" or "no" turn it off. */
function playTicketsEnabled(env = process.env) {
	const raw = String(env.PLAY_TICKETS_ENABLED ?? '').trim().toLowerCase();
	return !['0', 'false', 'off', 'no'].includes(raw);
}

/** End of the legacy window (PLAY_TICKETS_LEGACY_UNTIL, ISO date). */
function legacyUntil(env = process.env) {
	const raw = env.PLAY_TICKETS_LEGACY_UNTIL;
	const d = raw ? new Date(raw) : null;
	return d && !Number.isNaN(d.getTime()) ? d : new Date(DEFAULT_LEGACY_UNTIL);
}

/** While true, complete-solo without a ticket still runs the old game_json path. */
function legacyCompleteSoloAllowed(env = process.env, now = new Date()) {
	return now.getTime() < legacyUntil(env).getTime();
}

function isTicketId(v) {
	return typeof v === 'string' && UUID_RE.test(v);
}

// ─── Ticket fields from a game ──────────────────────────────────────────────

function clampInt(v, lo, hi, fallback) {
	const n = parseInt(v, 10);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(lo, Math.min(hi, n));
}

/** Stable short fingerprint of the game JSON (audit, not security). */
function gameHash(game) {
	return crypto.createHash('sha256').update(JSON.stringify(game ?? null)).digest('hex');
}

/**
 * Normalised ticket columns for a game the server already holds.
 * @param {object} game — server-generated or library game_json
 * @param {{ mode?: unknown }} [opts] — mode from the request filters / saved row
 */
function ticketFieldsFromGame(game, { mode } = {}) {
	const g = game && typeof game === 'object' ? game : {};
	const pick = [mode, g.mode].find((m) => FilterPresets.isMode(m));
	const durationMin = clampInt(g.duration?.min, 1, 180, 5);
	const durationMax = Math.max(durationMin, clampInt(g.duration?.max, 1, 180, Math.max(durationMin, 15)));
	const raw = Array.isArray(g.rvp?.kompetence) ? g.rvp.kompetence : [];
	const kompetence = [...new Set(raw.filter((k) => VALID_GAME_COMPETENCIES.includes(k)))];
	return {
		game_hash: gameHash(g),
		mode: pick || null,
		duration_min: durationMin,
		duration_max: durationMax,
		kompetence,
	};
}

// ─── Reflection quality gate ────────────────────────────────────────────────

/** Lower-case, letters and digits only, single spaces. */
function normalizeAnswer(s) {
	return String(s ?? '')
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

/**
 * @param {{ ratings?: unknown, texts?: unknown }} body
 * @param {string[]} ticketKompetence — the ticket's competencies (rating keys the form shows first)
 * @param {Array<Record<string, string>>} previousTexts — texts of the user's last reflections
 * @returns {{ ok: true, ratings: Record<string, number>, texts: Record<string, string> }
 *         | { ok: false, code: string, field?: string }}
 */
function validateReflection(body, ticketKompetence, previousTexts = []) {
	const ratingsIn = body?.ratings;
	const textsIn = body?.texts;
	if (!ratingsIn || typeof ratingsIn !== 'object' || Array.isArray(ratingsIn)) {
		return { ok: false, code: 'REFLECTION_INCOMPLETE', field: 'ratings' };
	}
	if (!textsIn || typeof textsIn !== 'object' || Array.isArray(textsIn)) {
		return { ok: false, code: 'REFLECTION_INCOMPLETE', field: 'texts' };
	}

	const entries = Object.entries(ratingsIn);
	if (entries.length < REFLECTION_MIN_RATINGS || entries.length > REFLECTION_MAX_RATINGS) {
		return { ok: false, code: 'REFLECTION_INCOMPLETE', field: 'ratings' };
	}
	const ratings = {};
	for (const [k, v] of entries) {
		if (!RATING_KEY_RE.test(k) || !Number.isInteger(v) || v < 1 || v > 5) {
			return { ok: false, code: 'REFLECTION_INVALID_RATING', field: k };
		}
		ratings[k] = v;
	}
	for (const k of (ticketKompetence || []).slice(0, REFLECTION_MIN_RATINGS)) {
		if (!Object.hasOwn(ratings, k)) return { ok: false, code: 'REFLECTION_INCOMPLETE', field: k };
	}

	const texts = {};
	for (const k of REFLECTION_TEXT_KEYS) {
		const v = textsIn[k];
		if (typeof v !== 'string') return { ok: false, code: 'REFLECTION_INCOMPLETE', field: k };
		const t = v.trim().replace(/\s+/g, ' ');
		if (t.length > REFLECTION_MAX_CHARS * 2) return { ok: false, code: 'REFLECTION_TOO_LONG', field: k };
		// Twenty characters of one letter ("aaaa…") is not an answer.
		if (t.length < REFLECTION_MIN_CHARS || new Set(normalizeAnswer(t).replace(/ /g, '')).size < 5) {
			return { ok: false, code: 'REFLECTION_TOO_SHORT', field: k };
		}
		texts[k] = t.slice(0, REFLECTION_MAX_CHARS);
	}

	const mine = REFLECTION_TEXT_KEYS.map((k) => normalizeAnswer(texts[k]));
	if (mine[0] === mine[1]) return { ok: false, code: 'REFLECTION_REPEAT', field: REFLECTION_TEXT_KEYS[1] };
	const seen = new Set();
	for (const prev of (previousTexts || []).slice(0, REFLECTION_HISTORY)) {
		if (!prev || typeof prev !== 'object') continue;
		for (const v of Object.values(prev)) if (typeof v === 'string') seen.add(normalizeAnswer(v));
	}
	for (let i = 0; i < mine.length; i++) {
		if (seen.has(mine[i])) return { ok: false, code: 'REFLECTION_REPEAT', field: REFLECTION_TEXT_KEYS[i] };
	}
	return { ok: true, ratings, texts };
}

// ─── Reward ─────────────────────────────────────────────────────────────────

/**
 * @param {{ durationMax: number, elapsedMin: number, reflected: boolean,
 *           multiplier?: number, mode?: unknown, kompetence?: string[] }} input
 * @returns {{ participation_xp: number, reflection_bonus_xp: number, base_xp: number,
 *             xp_multiplier: number, total_xp: number, stat_xp: Record<string, number>,
 *             trained_stats: string[], validated_min: number }}
 */
function computeTicketReward({ durationMax, elapsedMin, reflected, multiplier = 1, mode, kompetence }) {
	const maxMin = clampInt(durationMax, 1, 180, 15);
	const validatedMin = Math.max(0, Math.min(maxMin, Math.floor(Number(elapsedMin) || 0)));
	// The curve treats 0 as "unknown" (15 min); a validated play is never below 1.
	const participation = computeSoloXpFromDurationMax(Math.max(1, validatedMin));
	const bonus = reflected ? Math.round(participation * REFLECTION_BONUS_RATE) : 0;
	const base = participation + bonus;
	const mul = Number.isInteger(multiplier) && multiplier > 1 ? multiplier : 1;
	const statXp = splitStatXp(base, { mode, kompetence });
	return {
		participation_xp: participation,
		reflection_bonus_xp: bonus,
		base_xp: base,
		xp_multiplier: mul,
		total_xp: base * mul,
		stat_xp: statXp,
		trained_stats: STAT_KEYS.filter((k) => statXp[k] > 0),
		validated_min: validatedMin,
	};
}

// ─── DB helpers ─────────────────────────────────────────────────────────────

const TICKET_COLS = 'user_id, source, game_hash, game_json, mode, duration_min, duration_max, kompetence';

/**
 * @param {{ query: Function }} db
 * @param {string} userId
 * @param {object} game
 * @param {{ source: 'generated'|'library'|'replay', mode?: unknown, start?: boolean }} opts
 * @returns {Promise<{ id: string, started_at: Date|null }>}
 */
async function insertTicket(db, userId, game, { source, mode, start = false }) {
	const f = ticketFieldsFromGame(game, { mode });
	const sql = start
		? `INSERT INTO public.play_tickets (${TICKET_COLS}, started_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW()) RETURNING id, started_at`
		: `INSERT INTO public.play_tickets (${TICKET_COLS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, started_at`;
	const { rows } = await db.query(sql, [
		userId, source, f.game_hash, JSON.stringify(game), f.mode, f.duration_min, f.duration_max, f.kompetence,
	]);
	return rows[0];
}

/**
 * Best-effort ticket for a freshly generated game; never fails generation.
 * @returns {Promise<string|null>} ticket id
 */
async function issueGenerationTicket(db, userId, game, mode, log = console) {
	try {
		const row = await insertTicket(db, userId, game, { source: 'generated', mode });
		return row?.id || null;
	} catch (err) {
		log.warn?.('[PlayTickets] generation ticket failed:', err.message);
		return null;
	}
}

async function libraryTicketsToday(db, userId) {
	const { rows } = await db.query(
		`SELECT COUNT(*)::int AS cnt FROM public.play_tickets
		  WHERE user_id = $1 AND source <> 'generated' AND created_at >= CURRENT_DATE`,
		[userId]
	);
	return rows[0]?.cnt || 0;
}

/**
 * Start a ticket (sets started_at once). Starting again returns the first start.
 * @returns {Promise<{ status: 'ok', id: string, started_at: Date } | { status: 'not_found' } | { status: 'completed' }>}
 */
async function startTicket(db, userId, ticketId) {
	const { rows } = await db.query(
		`UPDATE public.play_tickets SET started_at = NOW()
		  WHERE id = $1 AND user_id = $2 AND started_at IS NULL AND completed_at IS NULL
		  RETURNING id, started_at`,
		[ticketId, userId]
	);
	if (rows.length) return { status: 'ok', id: rows[0].id, started_at: rows[0].started_at };
	const { rows: cur } = await db.query(
		'SELECT id, started_at, completed_at FROM public.play_tickets WHERE id = $1 AND user_id = $2',
		[ticketId, userId]
	);
	if (!cur.length) return { status: 'not_found' };
	if (cur[0].completed_at) return { status: 'completed' };
	return { status: 'ok', id: cur[0].id, started_at: cur[0].started_at };
}

async function lockTicket(client, userId, ticketId) {
	const { rows } = await client.query(
		`SELECT id, mode, duration_min, duration_max, kompetence, started_at, completed_at, reflection_id
		   FROM public.play_tickets WHERE id = $1 AND user_id = $2 FOR UPDATE`,
		[ticketId, userId]
	);
	return rows[0] || null;
}

/** True when another ticket of the user was completed after this one started (parallel play). */
async function overlapsCompletedTicket(client, userId, ticket) {
	const { rows } = await client.query(
		`SELECT 1 FROM public.play_tickets
		  WHERE user_id = $1 AND id <> $2 AND completed_at > $3 LIMIT 1`,
		[userId, ticket.id, ticket.started_at]
	);
	return rows.length > 0;
}

/** Single-use flip; returns false when someone else already completed it. */
async function markTicketCompleted(client, userId, ticketId, reward) {
	const { rows } = await client.query(
		`UPDATE public.play_tickets SET completed_at = NOW(), reward = $3
		  WHERE id = $1 AND user_id = $2 AND completed_at IS NULL
		  RETURNING completed_at`,
		[ticketId, userId, JSON.stringify(reward)]
	);
	return rows.length > 0;
}

/** Add XP per stat / sub-tag in one statement. Unknown keys are dropped. */
async function addStatXp(client, userId, statXp) {
	const keys = STAT_XP_KEYS.filter((k) => Number.isInteger(statXp?.[k]) && statXp[k] > 0);
	if (!keys.length) return;
	await client.query(
		`INSERT INTO public.user_stat_xp (user_id, stat, xp)
		 SELECT $1, s.stat, s.xp FROM unnest($2::text[], $3::int[]) AS s(stat, xp)
		 ON CONFLICT (user_id, stat) DO UPDATE
		   SET xp = LEAST(public.user_stat_xp.xp + EXCLUDED.xp, 999999), updated_at = NOW()`,
		[userId, keys, keys.map((k) => statXp[k])]
	);
}

async function recentReflectionTexts(client, userId) {
	const { rows } = await client.query(
		`SELECT texts FROM public.reflections WHERE user_id = $1
		  ORDER BY created_at DESC LIMIT ${REFLECTION_HISTORY}`,
		[userId]
	);
	return rows.map((r) => r.texts || {});
}

async function insertReflection(client, userId, ticketId, { ratings, texts }) {
	const { rows } = await client.query(
		'INSERT INTO public.reflections (user_id, ticket_id, ratings, texts) VALUES ($1, $2, $3, $4) RETURNING id',
		[userId, ticketId, JSON.stringify(ratings), JSON.stringify(texts)]
	);
	await client.query('UPDATE public.play_tickets SET reflection_id = $1 WHERE id = $2', [rows[0].id, ticketId]);
	return rows[0].id;
}

/**
 * Data for the RPG panel: XP per stat / sub-tag, per-competency game counts
 * and average self-rating from reflections.
 */
async function readPlayAttributes(db, userId) {
	const { rows: statRows } = await db.query(
		'SELECT stat, xp FROM public.user_stat_xp WHERE user_id = $1',
		[userId]
	);
	const { rows: compRows } = await db.query(
		`SELECT k AS key, COUNT(*)::int AS games,
		        ROUND(AVG((r.ratings->>k)::numeric), 1) AS avg_rating
		   FROM public.play_tickets t
		   CROSS JOIN LATERAL unnest(t.kompetence) AS k
		   LEFT JOIN public.reflections r ON r.id = t.reflection_id
		  WHERE t.user_id = $1 AND t.completed_at IS NOT NULL
		  GROUP BY k ORDER BY games DESC, k`,
		[userId]
	);
	const { rows: totals } = await db.query(
		`SELECT COUNT(*)::int AS games, COUNT(reflection_id)::int AS reflected
		   FROM public.play_tickets WHERE user_id = $1 AND completed_at IS NOT NULL`,
		[userId]
	);
	const statXp = {};
	for (const r of statRows) if (STAT_XP_KEYS.includes(r.stat)) statXp[r.stat] = parseInt(r.xp, 10) || 0;
	return {
		stat_xp: statXp,
		competencies: compRows.map((r) => ({
			key: r.key,
			games: parseInt(r.games, 10) || 0,
			avg_rating: r.avg_rating == null ? null : Number(r.avg_rating),
		})),
		games: totals[0]?.games || 0,
		reflected: totals[0]?.reflected || 0,
	};
}

module.exports = {
	REFLECTION_BONUS_RATE,
	REFLECTION_MIN_CHARS,
	REFLECTION_MAX_CHARS,
	REFLECTION_HISTORY,
	REFLECTION_TEXT_KEYS,
	REFLECTION_MIN_RATINGS,
	MAX_LIBRARY_TICKETS_PER_DAY,
	VALID_GAME_COMPETENCIES,
	DEFAULT_LEGACY_UNTIL,
	playTicketsEnabled,
	legacyUntil,
	legacyCompleteSoloAllowed,
	isTicketId,
	gameHash,
	ticketFieldsFromGame,
	normalizeAnswer,
	validateReflection,
	computeTicketReward,
	insertTicket,
	issueGenerationTicket,
	libraryTicketsToday,
	startTicket,
	lockTicket,
	overlapsCompletedTicket,
	markTicketCompleted,
	addStatXp,
	recentReflectionTexts,
	insertReflection,
	readPlayAttributes,
};
