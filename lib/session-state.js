'use strict';

/**
 * gIVEMEGAME.IO — multiplayer session state machine (Phase 6a).
 *
 * Pure functions and constants only. lib/routes/sessions.js turns each
 * allowed transition into a compare-and-swap UPDATE
 * (`... WHERE id = $1 AND status = <from>`), so two racing requests can
 * never both move a session.
 *
 *   waiting ──start──▶ active ──timer / host──▶ reflection
 *      │                 │  ╲                      │
 *      │                 │   ╲──complete──▶ completing ◀──complete──┘
 *      │                 │                      │  (rollback → back to the earlier state)
 *      ▼                 ▼                      ▼
 *   expired ◀────────────┴─── (TTL / host gone)  completed
 */

const crypto = require('node:crypto');

/** @typedef {'waiting'|'active'|'reflection'|'completing'|'completed'|'expired'} SessionStatus */
/** @typedef {'room'|'online'|'async'} PlayStyle */

const STATUSES = Object.freeze(['waiting', 'active', 'reflection', 'completing', 'completed', 'expired']);
const OPEN_STATUSES = Object.freeze(['waiting', 'active', 'reflection']);
const PLAY_STYLES = Object.freeze(['room', 'online', 'async']);

/** Allowed transitions: from → [to]. */
const TRANSITIONS = Object.freeze({
	waiting: Object.freeze(['active', 'expired']),
	active: Object.freeze(['reflection', 'completing', 'expired']),
	reflection: Object.freeze(['completing', 'expired']),
	completing: Object.freeze(['completed', 'active', 'reflection']),
	completed: Object.freeze([]),
	expired: Object.freeze([]),
});

/** Timing (minutes unless noted). */
const WAITING_TTL_MIN = 120;          // an unstarted lobby closes after 2 h
const REFLECTION_WINDOW_MIN = 10;     // reflection phase length set by the server
const AFTER_REFLECTION_GRACE_MIN = 60; // host still has 1 h to confirm completion
const HOST_ABSENT_MIN = 30;           // host gone 30 min after the later of: last heartbeat, end of the current phase
const PRESENCE_STALE_SEC = 300;       // a player unseen for 5 min is not charged at start
const ONLINE_WINDOW_SEC = 60;         // "online" dot in the lobby

/** Lobby size choices offered in the UI (host-selectable). */
const MAX_PLAYER_CHOICES = Object.freeze([2, 4, 6, 8, 10, 15, 20, 30, 40]);
const MIN_PLAYERS_FLOOR = 2;
const MAX_PLAYERS_CAP = 40;

/** Economy. */
const HOST_XP_SHARE = 0.5;            // host earns 50 % of the average participant XP
const HOST_XP_MIN_PLAYERS = 2;        // … only when at least 2 players earned XP
const SESSION_XP_REWARDS_PER_DAY = 5; // per participant (coins are still returned)
const HOST_XP_SESSIONS_PER_DAY = 5;   // host rewards per UTC day

const MAX_GAME_JSON_BYTES = 64 * 1024;
const NICKNAME_MIN = 2;
const NICKNAME_MAX = 24;

/**
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
function canTransition(from, to) {
	return Object.prototype.hasOwnProperty.call(TRANSITIONS, from) && TRANSITIONS[from].includes(to);
}

/** @param {string} status */
function isOpen(status) {
	return OPEN_STATUSES.includes(status);
}

function clampInt(value, min, max, fallback) {
	const n = Number.parseInt(value, 10);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}

/**
 * @param {unknown} value
 * @param {string} [gameMode]
 * @returns {PlayStyle}
 */
function normalizePlayStyle(value, gameMode) {
	if (typeof value === 'string' && PLAY_STYLES.includes(value)) return /** @type {PlayStyle} */ (value);
	return gameMode === 'online' ? 'online' : 'room';
}

/**
 * Host-selected lobby cap. Falls back to the game's playerCount.max.
 * @param {unknown} value
 * @param {{ playerCount?: { max?: unknown } }} [game]
 * @returns {number}
 */
function normalizeMaxPlayers(value, game) {
	const fallback = clampInt(game?.playerCount?.max, MIN_PLAYERS_FLOOR, MAX_PLAYERS_CAP, 10);
	return clampInt(value, MIN_PLAYERS_FLOOR, MAX_PLAYERS_CAP, fallback);
}

/**
 * H2 (short term): the session game still comes from the browser, but the
 * fields the reward gates read are clamped to server floors, and oversized
 * payloads are rejected. A host can no longer post playerCount.min 1 or
 * duration.min 0 to farm rewards with one alt account.
 *
 * @param {unknown} raw
 * @returns {{ ok: true, game: Record<string, any> } | { ok: false, code: 'MISSING_GAME' | 'GAME_TOO_LARGE' }}
 */
function sanitizeSessionGame(raw) {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, code: 'MISSING_GAME' };
	const title = typeof raw.title === 'string' ? raw.title.trim() : '';
	if (!title) return { ok: false, code: 'MISSING_GAME' };
	let json;
	try { json = JSON.stringify(raw); } catch { return { ok: false, code: 'MISSING_GAME' }; }
	if (Buffer.byteLength(json, 'utf8') > MAX_GAME_JSON_BYTES) return { ok: false, code: 'GAME_TOO_LARGE' };

	const game = JSON.parse(json);
	game.title = title.slice(0, 200);
	const pcMin = clampInt(game.playerCount?.min, MIN_PLAYERS_FLOOR, MAX_PLAYERS_CAP, MIN_PLAYERS_FLOOR);
	const pcMax = clampInt(game.playerCount?.max, pcMin, MAX_PLAYERS_CAP, Math.max(pcMin, 10));
	game.playerCount = { min: pcMin, max: pcMax };
	const dMin = clampInt(game.duration?.min, 3, 120, 5);
	const dMax = clampInt(game.duration?.max, dMin, 120, Math.max(dMin, 15));
	game.duration = { min: dMin, max: dMax };
	return { ok: true, game };
}

/**
 * Nickname for a guest without an account: plain letters, digits, spaces and
 * a few marks; 2-24 characters. Returns null when unusable.
 * @param {unknown} raw
 * @returns {string|null}
 */
function normalizeNickname(raw) {
	if (typeof raw !== 'string') return null;
	const cleaned = raw.normalize('NFC')
		.replace(/[^\p{L}\p{N} ._\-]/gu, '')
		.replace(/\s+/g, ' ')
		.trim();
	if (cleaned.length < NICKNAME_MIN) return null;
	return cleaned.slice(0, NICKNAME_MAX);
}

/** @returns {string} random guest token (shown once to the guest device) */
function createGuestToken() {
	return crypto.randomBytes(24).toString('base64url');
}

/** @param {string} token @returns {string} sha256 hex stored in the DB */
function hashGuestToken(token) {
	return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** @param {unknown} token */
function isGuestTokenShape(token) {
	return typeof token === 'string' && /^[A-Za-z0-9_-]{20,64}$/.test(token);
}

function addMinutes(date, min) {
	return new Date(new Date(date).getTime() + min * 60000);
}

/** expires_at for a new lobby. */
function waitingExpiry(now = new Date()) {
	return addMinutes(now, WAITING_TTL_MIN);
}

/** expires_at once the game runs (timer + reflection + grace). */
function activeExpiry(timerEndsAt) {
	return addMinutes(timerEndsAt, REFLECTION_WINDOW_MIN + AFTER_REFLECTION_GRACE_MIN);
}

/** reflection_ends_at when reflection opens now. */
function reflectionEnds(now = new Date()) {
	return addMinutes(now, REFLECTION_WINDOW_MIN);
}

/** expires_at once reflection runs. */
function reflectionExpiry(reflectionEndsAt) {
	return addMinutes(reflectionEndsAt, AFTER_REFLECTION_GRACE_MIN);
}

/**
 * Since when the host counts as absent (ms), or null when unknown.
 *
 * A host phone that is locked or a hidden tab sends no heartbeat, often for
 * the whole game. So absence only starts once the current phase should be
 * over: the timer end while active, the reflection end during reflection.
 * In the waiting lobby it is simply the last heartbeat.
 *
 * @param {{ status: string, last_host_seen_at?: string|Date|null,
 *           timer_ends_at?: string|Date|null, reflection_ends_at?: string|Date|null }} session
 * @returns {number|null}
 */
function hostAbsentSince(session) {
	if (!session || !session.last_host_seen_at) return null;
	let since = new Date(session.last_host_seen_at).getTime();
	const phaseEnd = session.status === 'active' ? session.timer_ends_at
		: session.status === 'reflection' ? session.reflection_ends_at
			: null;
	if (phaseEnd) since = Math.max(since, new Date(phaseEnd).getTime());
	return Number.isFinite(since) ? since : null;
}

/**
 * Why an open session should expire now, or null.
 * Missing timestamps (rows from before 040) never trigger expiry.
 *
 * @param {{ status: string, expires_at?: string|Date|null, last_host_seen_at?: string|Date|null,
 *           timer_ends_at?: string|Date|null, reflection_ends_at?: string|Date|null }} session
 * @param {Date} [now]
 * @returns {'ttl'|'host_absent'|null}
 */
function expiryReason(session, now = new Date()) {
	if (!session || !isOpen(session.status)) return null;
	const t = now.getTime();
	if (session.expires_at && new Date(session.expires_at).getTime() <= t) return 'ttl';
	const absentSince = hostAbsentSince(session);
	if (absentSince != null && t - absentSince >= HOST_ABSENT_MIN * 60000) return 'host_absent';
	return null;
}

/**
 * The active timer ran out, so the server opens reflection.
 * @param {{ status: string, timer_ends_at?: string|Date|null }} session
 * @param {Date} [now]
 */
function timerElapsed(session, now = new Date()) {
	return session?.status === 'active' && !!session.timer_ends_at
		&& new Date(session.timer_ends_at).getTime() <= now.getTime();
}

/**
 * Host reward (owner decision): 50 % of the average XP the participants got,
 * only when at least HOST_XP_MIN_PLAYERS of them got XP. No coins.
 * @param {number[]} participantXp — XP each rewarded participant received
 * @returns {number} whole XP for the host (0 = none)
 */
function computeHostXp(participantXp) {
	const earners = (participantXp || []).filter((x) => Number(x) > 0);
	if (earners.length < HOST_XP_MIN_PLAYERS) return 0;
	const avg = earners.reduce((a, x) => a + Number(x), 0) / earners.length;
	return Math.max(0, Math.floor(avg * HOST_XP_SHARE));
}

/**
 * @param {string|Date|null|undefined} lastSeenAt
 * @param {Date} [now]
 */
function isOnline(lastSeenAt, now = new Date()) {
	if (!lastSeenAt) return false;
	return now.getTime() - new Date(lastSeenAt).getTime() < ONLINE_WINDOW_SEC * 1000;
}

module.exports = {
	STATUSES,
	OPEN_STATUSES,
	PLAY_STYLES,
	TRANSITIONS,
	WAITING_TTL_MIN,
	REFLECTION_WINDOW_MIN,
	AFTER_REFLECTION_GRACE_MIN,
	HOST_ABSENT_MIN,
	PRESENCE_STALE_SEC,
	ONLINE_WINDOW_SEC,
	MAX_PLAYER_CHOICES,
	MIN_PLAYERS_FLOOR,
	MAX_PLAYERS_CAP,
	HOST_XP_SHARE,
	HOST_XP_MIN_PLAYERS,
	SESSION_XP_REWARDS_PER_DAY,
	HOST_XP_SESSIONS_PER_DAY,
	MAX_GAME_JSON_BYTES,
	canTransition,
	isOpen,
	normalizePlayStyle,
	normalizeMaxPlayers,
	sanitizeSessionGame,
	normalizeNickname,
	createGuestToken,
	hashGuestToken,
	isGuestTokenShape,
	waitingExpiry,
	activeExpiry,
	reflectionEnds,
	reflectionExpiry,
	hostAbsentSince,
	expiryReason,
	timerElapsed,
	computeHostXp,
	isOnline,
};
