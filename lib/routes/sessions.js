'use strict';

/**
 * gIVEMEGAME.IO — multiplayer session routes (/api/sessions/*).
 *
 * Extracted from server.js (Phase 6) to cut merge conflicts. Every server
 * dependency is injected, so tests still boot it through server.js
 * (test/helpers/economy-harness.js).
 *
 * Phase 6a — server-side state machine (lib/session-state.js):
 *   - every status change is a compare-and-swap UPDATE;
 *   - the server opens reflection when the timer runs out (or on host action);
 *   - leave / heartbeat endpoints, presence check before charging at start;
 *   - host rejoin from any device (identity = sessions.host_id, not storage);
 *   - guests (nickname, no account) join with a one-time token, earn nothing;
 *   - expiry with automatic refund of coins_paid (sweep + lazy check);
 *   - host reward = 50 % of the average participant XP, no coins;
 *   - per-participant daily XP cap;
 *   - GET /:code is rate-limited and returns details only to members.
 */

const express = require('express');
const crypto = require('node:crypto');
const { validateDurationGate, validateParticipantGate, validateHostCooldownGate } = require('../reward-validation');
const { computeRpgLevel, getEffectiveStats, awardXpInTransaction } = require('../rpg-progression');
const { talentIdsToTalents } = require('../rpg-talents');
const { buildCompletionValidation, startSessionAndCharge } = require('../session-economy');
const State = require('../session-state');
const { createRateLimiter } = require('../simple-rate-limit');

const SESSION_COLUMNS = 'id, host_id, game_json, join_code, status, timer_ends_at, started_at, created_at, '
	+ 'completed_at, expires_at, last_host_seen_at, play_style, reflection_ends_at, max_players, allow_guests, '
	+ 'host_xp_awarded, expired_at, expire_reason';
const PARTICIPANT_COLUMNS = 'id, user_id, is_guest, nickname, coins_paid, reflection_done, left_at, awarded_competencies';
const MAX_REFLECTION_BYTES = 16 * 1024;

/**
 * @typedef {{ kind: 'user', userId: string } | { kind: 'guest', tokenHash: string }} Actor
 * @typedef {{ role: 'host'|'player'|'guest'|null, participant: any|null }} Membership
 */

/**
 * @param {{
 *   coinApiReady: () => boolean,
 *   respondCoinApiDisabled: (res: import('express').Response) => unknown,
 *   requireSupabaseUser: (req: import('express').Request, res: import('express').Response) => Promise<{id: string}|null>,
 *   queryCoinsDb: (text: string, params?: unknown[]) => Promise<{rows: any[], rowCount: number}>,
 *   getPool: () => import('pg').Pool | null,
 *   generateJoinCode: () => string,
 *   constants: {
 *     SESSION_JOIN_COST: number, COMPLETION_BONUS: number, SESSION_XP_AWARD: number,
 *     HOST_COOLDOWN_MAX: number, VALID_COMPETENCY_KEYS: string[], GAME_KOMP_TO_STAT: Record<string, string>
 *   },
 *   rateLimits?: { read?: { limit: number, windowMs: number }, heartbeat?: { limit: number, windowMs: number },
 *                  guestJoin?: { limit: number, windowMs: number } }
 * }} deps
 * @returns {import('express').Router & { sweepExpired: () => Promise<number> }}
 */
function createSessionsRouter(deps) {
	const {
		coinApiReady,
		respondCoinApiDisabled,
		requireSupabaseUser,
		queryCoinsDb,
		generateJoinCode,
	} = deps;
	const {
		SESSION_JOIN_COST,
		COMPLETION_BONUS,
		SESSION_XP_AWARD,
		HOST_COOLDOWN_MAX,
		VALID_COMPETENCY_KEYS,
		GAME_KOMP_TO_STAT,
	} = deps.constants;
	const limits = deps.rateLimits || {};
	// M11: GET /:code (and the heartbeat, which doubles as the slow poll) are
	// rate-limited per caller; guest joins per IP.
	const readLimiter = createRateLimiter(limits.read || { limit: 40, windowMs: 60 * 1000 });
	const heartbeatLimiter = createRateLimiter(limits.heartbeat || { limit: 30, windowMs: 60 * 1000 });
	const guestJoinLimiter = createRateLimiter(limits.guestJoin || { limit: 10, windowMs: 10 * 60 * 1000 });
	const router = express.Router();

	// ─── helpers ─────────────────────────────────────────────────────

	const codeOf = (req) => String(req.params.code || '').toUpperCase().trim().slice(0, 12);

	function callerKey(req) {
		const auth = req.headers.authorization || '';
		const guest = req.headers['x-guest-token'] || '';
		const raw = auth || (guest ? `guest:${guest}` : `ip:${req.ip}`);
		return crypto.createHash('sha256').update(String(raw)).digest('hex').slice(0, 32);
	}

	function limited(res, limiter, key) {
		const r = limiter.check(key);
		if (r.ok) return false;
		res.set('Retry-After', String(r.retryAfterSec));
		res.status(429).json({ error: 'Príliš veľa požiadaviek. Skús to o chvíľu.', code: 'RATE_LIMITED' });
		return true;
	}

	/**
	 * A signed-in user (Bearer token) or a guest (X-Guest-Token). Responds and
	 * returns null when neither is valid.
	 * @returns {Promise<Actor|null>}
	 */
	async function resolveActor(req, res) {
		if ((req.headers.authorization || '').startsWith('Bearer ')) {
			const user = await requireSupabaseUser(req, res);
			return user ? { kind: 'user', userId: user.id } : null;
		}
		const token = req.headers['x-guest-token'];
		if (State.isGuestTokenShape(token)) return { kind: 'guest', tokenHash: State.hashGuestToken(token) };
		res.status(401).json({ error: 'Authorization header missing', code: 'NO_TOKEN' });
		return null;
	}

	async function loadSession(code) {
		const { rows } = await queryCoinsDb(
			`SELECT ${SESSION_COLUMNS} FROM public.sessions WHERE join_code = $1`, [code]
		);
		return rows[0] || null;
	}

	/** @returns {Promise<Membership>} */
	async function loadMembership(session, actor) {
		if (actor.kind === 'user') {
			if (session.host_id === actor.userId) return { role: 'host', participant: null };
			const { rows } = await queryCoinsDb(
				`SELECT ${PARTICIPANT_COLUMNS} FROM public.session_participants WHERE session_id = $1 AND user_id = $2`,
				[session.id, actor.userId]
			);
			return rows[0] ? { role: 'player', participant: rows[0] } : { role: null, participant: null };
		}
		const { rows } = await queryCoinsDb(
			`SELECT ${PARTICIPANT_COLUMNS} FROM public.session_participants WHERE session_id = $1 AND guest_token_hash = $2`,
			[session.id, actor.tokenHash]
		);
		return rows[0] ? { role: 'guest', participant: rows[0] } : { role: null, participant: null };
	}

	/** Best-effort audit row (never blocks the request). */
	async function logEvent(sessionId, actorId, actorKind, event, detail = null) {
		try {
			await queryCoinsDb(
				`INSERT INTO public.session_events (session_id, actor_id, actor_kind, event, detail)
				 VALUES ($1, $2, $3, $4, $5)`,
				[sessionId, actorId, actorKind, event, detail == null ? null : JSON.stringify(detail)]
			);
		} catch (err) {
			console.warn('[Sessions] event log failed:', err.message);
		}
	}

	/**
	 * Expire an open session and refund every unrewarded payer, atomically.
	 * Compare-and-swap: only one caller (sweep or lazy check) wins.
	 * @returns {Promise<boolean>} true if this call expired it
	 */
	async function expireSession(sessionId, reason, actor = { id: null, kind: 'system' }) {
		const client = await deps.getPool().connect();
		let refunded = 0;
		try {
			await client.query('BEGIN');
			const { rows: locked } = await client.query(
				`UPDATE public.sessions SET status = 'expired', expired_at = NOW(), expire_reason = $2
				  WHERE id = $1 AND status IN ('waiting', 'active', 'reflection')
				  RETURNING id, join_code`,
				[sessionId, reason]
			);
			if (!locked.length) {
				await client.query('ROLLBACK');
				return false;
			}
			const { rows: payers } = await client.query(
				`SELECT id, user_id, coins_paid FROM public.session_participants
				  WHERE session_id = $1 AND coins_paid > 0 AND refunded_at IS NULL AND awarded_competencies IS NULL
				  FOR UPDATE`,
				[sessionId]
			);
			for (const p of payers) {
				const amount = parseInt(p.coins_paid, 10) || 0;
				if (amount <= 0 || !p.user_id) continue;
				await client.query('UPDATE public.profiles SET coins = COALESCE(coins, 0) + $1 WHERE id = $2', [amount, p.user_id]);
				await client.query('UPDATE public.session_participants SET refunded_at = NOW() WHERE id = $1', [p.id]);
				await client.query(
					'INSERT INTO public.coin_transactions (user_id, amount, action, metadata) VALUES ($1, $2, $3, $4)',
					[p.user_id, amount, 'session_refund', JSON.stringify({ session_code: locked[0].join_code, reason })]
				);
				refunded += 1;
			}
			await client.query('COMMIT');
		} catch (err) {
			try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
			throw err;
		} finally {
			client.release();
		}
		await logEvent(sessionId, actor.id, actor.kind, 'expired', { reason, refunded });
		return true;
	}

	async function openReflection(session, actor) {
		const endsAt = State.reflectionEnds();
		const { rows } = await queryCoinsDb(
			`UPDATE public.sessions SET status = 'reflection', reflection_ends_at = $2, expires_at = $3
			  WHERE id = $1 AND status = 'active'
			  RETURNING status, reflection_ends_at, expires_at`,
			[session.id, endsAt.toISOString(), State.reflectionExpiry(endsAt).toISOString()]
		);
		if (!rows.length) return null;
		await logEvent(session.id, actor.id, actor.kind, 'reflection');
		return { ...session, ...rows[0] };
	}

	/**
	 * The host is here: record it before any expiry check, so the host's own
	 * return (after a locked phone or a hidden tab) never expires the game.
	 */
	async function touchHost(session) {
		if (!State.isOpen(session.status)) return session;
		await queryCoinsDb('UPDATE public.sessions SET last_host_seen_at = NOW() WHERE id = $1', [session.id]);
		return { ...session, last_host_seen_at: new Date().toISOString() };
	}

	const isHostActor = (session, actor) => !!actor && actor.kind === 'user' && session.host_id === actor.userId;

	/**
	 * Lazy maintenance on every session request, so expiry and the
	 * server-set reflection also work on serverless hosts without the sweep.
	 * Pass the actor so a host request first records the host's presence.
	 * @param {any} session
	 * @param {Actor|null} [actor]
	 */
	async function advance(session, actor = null) {
		if (isHostActor(session, actor)) session = await touchHost(session);
		const reason = State.expiryReason(session);
		if (reason) {
			await expireSession(session.id, reason);
			return (await loadSession(session.join_code)) || session;
		}
		if (State.timerElapsed(session)) {
			const next = await openReflection(session, { id: null, kind: 'system' });
			return next || (await loadSession(session.join_code)) || session;
		}
		return session;
	}

	/** Periodic sweep (server.js interval). Returns how many sessions expired. */
	async function sweepExpired() {
		if (!coinApiReady()) return 0;
		const { rows } = await queryCoinsDb(
			`SELECT id, status, expires_at, last_host_seen_at, timer_ends_at, reflection_ends_at FROM public.sessions
			  WHERE status IN ('waiting', 'active', 'reflection')
			    AND (expires_at <= NOW()
			         OR (last_host_seen_at IS NOT NULL
			             AND GREATEST(last_host_seen_at,
			                          CASE status WHEN 'active' THEN timer_ends_at
			                                      WHEN 'reflection' THEN reflection_ends_at END)
			                 <= NOW() - make_interval(mins => $1)))
			  LIMIT 50`,
			[State.HOST_ABSENT_MIN]
		);
		let n = 0;
		for (const row of rows) {
			try {
				if (await expireSession(row.id, State.expiryReason(row) || 'ttl')) n += 1;
			} catch (err) {
				console.error('[Sessions] sweep failed for one session:', err.message);
			}
		}
		return n;
	}

	function actorRef(actor, membership) {
		if (actor.kind === 'user') return { id: actor.userId, kind: membership.role === 'host' ? 'host' : 'player' };
		return { id: membership.participant?.id || null, kind: 'guest' };
	}

	function respondGone(res) {
		return res.status(410).json({ error: 'Session vypršala. Mince boli vrátené.', code: 'EXPIRED' });
	}

	function publicState(session, membership) {
		return {
			status: session.status,
			timer_ends_at: session.timer_ends_at || null,
			reflection_ends_at: session.reflection_ends_at || null,
			expires_at: session.expires_at || null,
			expire_reason: session.expire_reason || null,
			my_role: membership.role,
			server_time: new Date().toISOString(),
		};
	}

	async function countActivePlayers(sessionId) {
		const { rows } = await queryCoinsDb(
			'SELECT COUNT(*)::int AS cnt FROM public.session_participants WHERE session_id = $1 AND left_at IS NULL',
			[sessionId]
		);
		return rows[0]?.cnt || 0;
	}

	// ─── create ──────────────────────────────────────────────────────

	router.post('/', async (req, res) => {
		if (!coinApiReady()) return respondCoinApiDisabled(res);
		const user = await requireSupabaseUser(req, res);
		if (!user) return;

		const body = req.body || {};
		const clean = State.sanitizeSessionGame(body.game_json);
		if (!clean.ok) {
			if (clean.code === 'GAME_TOO_LARGE') {
				return res.status(413).json({ error: 'Hra je príliš veľká', code: 'GAME_TOO_LARGE' });
			}
			return res.status(400).json({ error: 'game_json je povinné', code: 'MISSING_GAME' });
		}
		const game = clean.game;
		const playStyle = State.normalizePlayStyle(body.play_style, game.mode);
		const maxPlayers = State.normalizeMaxPlayers(body.max_players, game);
		const allowGuests = body.allow_guests !== false;

		// M9: the join-code lookup hits the DB too, so it must sit inside the try —
		// Express 4 does not catch a rejected async handler and the request hangs.
		try {
			let join_code;
			for (let attempt = 0; attempt < 10; attempt++) {
				const candidate = generateJoinCode();
				const { rows } = await queryCoinsDb(
					'SELECT id FROM public.sessions WHERE join_code = $1', [candidate]
				);
				if (rows.length === 0) { join_code = candidate; break; }
			}
			if (!join_code) {
				return res.status(500).json({ error: 'Nepodarilo sa vygenerovať unikátny kód', code: 'CODE_GEN_ERROR' });
			}

			const { rows } = await queryCoinsDb(
				`INSERT INTO public.sessions (host_id, game_json, join_code, play_style, max_players, allow_guests, expires_at, last_host_seen_at)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
				 RETURNING id, join_code, status, created_at, play_style, max_players, allow_guests, expires_at`,
				[user.id, JSON.stringify(game), join_code, playStyle, maxPlayers, allowGuests, State.waitingExpiry().toISOString()]
			);
			await logEvent(rows[0].id, user.id, 'host', 'created', { play_style: playStyle, max_players: maxPlayers });
			res.json({ ...rows[0], my_role: 'host' });
		} catch (err) {
			console.error('[Sessions] create failed:', err.message);
			res.status(500).json({ error: 'Nepodarilo sa vytvoriť session', code: 'CREATE_ERROR' });
		}
	});

	// ─── read (members get details, others a small preview) ──────────

	router.get('/:code', async (req, res) => {
		if (!coinApiReady()) return respondCoinApiDisabled(res);
		if (limited(res, readLimiter, callerKey(req))) return;
		const actor = await resolveActor(req, res);
		if (!actor) return;

		const code = codeOf(req);
		if (!code) return res.status(400).json({ error: 'Kód je povinný', code: 'MISSING_CODE' });

		try {
			let session = await loadSession(code);
			if (!session) return res.status(404).json({ error: 'Session nenájdená', code: 'NOT_FOUND' });
			session = await advance(session, actor);
			const membership = await loadMembership(session, actor);

			const { rows: pRows } = await queryCoinsDb(
				`SELECT sp.id, sp.user_id, sp.is_guest, sp.nickname, sp.coins_paid, sp.reflection_done,
				        sp.joined_at, sp.left_at, sp.last_seen_at, p.display_name
				 FROM public.session_participants sp
				 LEFT JOIN public.profiles p ON p.id = sp.user_id
				 WHERE sp.session_id = $1
				 ORDER BY sp.joined_at ASC`,
				[session.id]
			);
			const activeCount = pRows.filter((p) => !p.left_at).length;

			// M11: non-members only see what they need to decide whether to join.
			if (!membership.role) {
				return res.json({
					preview: true,
					join_code: session.join_code,
					status: session.status,
					title: String(session.game_json?.title || '').slice(0, 200),
					play_style: session.play_style || 'room',
					allow_guests: session.allow_guests !== false,
					max_players: session.max_players || null,
					player_count: activeCount,
					my_role: null,
				});
			}

			const myId = membership.participant?.id || null;
			const participants = pRows.map((p) => ({
				id: p.id || null,
				display_name: p.is_guest ? p.nickname : (p.display_name || null),
				is_guest: !!p.is_guest,
				paid: (parseInt(p.coins_paid, 10) || 0) > 0,
				coins_paid: parseInt(p.coins_paid, 10) || 0,
				reflection_done: !!p.reflection_done,
				left: !!p.left_at,
				online: State.isOnline(p.last_seen_at),
				joined_at: p.joined_at,
				is_me: !!myId && p.id === myId,
			}));

			res.json({
				id: session.id,
				host_id: session.host_id,
				join_code: session.join_code,
				game_json: session.game_json,
				created_at: session.created_at,
				started_at: session.started_at || null,
				play_style: session.play_style || 'room',
				allow_guests: session.allow_guests !== false,
				max_players: session.max_players || null,
				host_online: State.isOnline(session.last_host_seen_at),
				player_count: activeCount,
				...publicState(session, membership),
				me: membership.participant ? {
					paid: (parseInt(membership.participant.coins_paid, 10) || 0) > 0,
					reflection_done: !!membership.participant.reflection_done,
					left: !!membership.participant.left_at,
					is_guest: !!membership.participant.is_guest,
					nickname: membership.participant.nickname || null,
				} : null,
				participants,
			});
		} catch (err) {
			console.error('[Sessions] get failed:', err.message);
			res.status(500).json({ error: 'Nepodarilo sa načítať session', code: 'FETCH_ERROR' });
		}
	});

	// ─── join (account) — also host rejoin and second-device rejoin ──

	router.post('/:code/join', async (req, res) => {
		if (!coinApiReady()) return respondCoinApiDisabled(res);
		const user = await requireSupabaseUser(req, res);
		if (!user) return;

		const code = codeOf(req);
		try {
			let sess = await loadSession(code);
			if (!sess) return res.status(404).json({ error: 'Session nenájdená', code: 'NOT_FOUND' });
			sess = await advance(sess, { kind: 'user', userId: user.id });
			if (sess.status === 'expired') return respondGone(res);

			// Host rejoin from any device: identity is host_id, not localStorage.
			// advance() already recorded the host's presence.
			if (sess.host_id === user.id) {
				return res.json({ ok: true, session_id: sess.id, role: 'host', status: sess.status });
			}

			const { rows: existing } = await queryCoinsDb(
				`SELECT ${PARTICIPANT_COLUMNS} FROM public.session_participants WHERE session_id = $1 AND user_id = $2`,
				[sess.id, user.id]
			);
			if (existing[0]) {
				// Already a member (e.g. second device): never a new row, never a new charge.
				const mine = existing[0];
				if (mine.left_at && sess.status === 'waiting') {
					await queryCoinsDb(
						'UPDATE public.session_participants SET left_at = NULL, last_seen_at = NOW() WHERE id = $1', [mine.id]
					);
				} else {
					await queryCoinsDb('UPDATE public.session_participants SET last_seen_at = NOW() WHERE id = $1', [mine.id]);
				}
				return res.json({
					ok: true, session_id: sess.id, role: 'player', status: sess.status, rejoined: true,
					paid: (parseInt(mine.coins_paid, 10) || 0) > 0,
				});
			}

			if (sess.status !== 'waiting') {
				return res.status(409).json({ error: 'Session už beží alebo skončila', code: 'ALREADY_STARTED' });
			}
			if (sess.max_players && (await countActivePlayers(sess.id)) >= sess.max_players) {
				return res.status(409).json({ error: 'Lobby je plné', code: 'LOBBY_FULL' });
			}

			const { rows: pRows } = await queryCoinsDb(
				'SELECT coins FROM public.profiles WHERE id = $1', [user.id]
			);
			const coins = parseInt(pRows[0]?.coins, 10) || 0;
			if (coins < SESSION_JOIN_COST) {
				return res.status(402).json({
					error: `Potrebuješ aspoň ${SESSION_JOIN_COST} coinov pre vstup`,
					code: 'INSUFFICIENT_COINS'
				});
			}

			await queryCoinsDb(
				`INSERT INTO public.session_participants (session_id, user_id, last_seen_at)
				 VALUES ($1, $2, NOW()) ON CONFLICT (session_id, user_id) DO NOTHING`,
				[sess.id, user.id]
			);
			await logEvent(sess.id, user.id, 'player', 'joined');
			res.json({ ok: true, session_id: sess.id, role: 'player', status: sess.status });
		} catch (err) {
			console.error('[Sessions] join failed:', err.message);
			res.status(500).json({ error: 'Nepodarilo sa pripojiť', code: 'JOIN_ERROR' });
		}
	});

	// ─── guest join (nickname, no account, no coins, no XP) ──────────

	router.post('/:code/join-guest', async (req, res) => {
		if (!coinApiReady()) return respondCoinApiDisabled(res);
		if (limited(res, guestJoinLimiter, `ip:${req.ip}`)) return;

		const code = codeOf(req);
		const nickname = State.normalizeNickname(req.body?.nickname);
		if (!nickname) {
			return res.status(400).json({ error: 'Prezývka musí mať 2 až 24 znakov', code: 'BAD_NICKNAME' });
		}
		try {
			let sess = await loadSession(code);
			if (!sess) return res.status(404).json({ error: 'Session nenájdená', code: 'NOT_FOUND' });
			sess = await advance(sess);
			if (sess.status === 'expired') return respondGone(res);
			if (sess.status !== 'waiting') {
				return res.status(409).json({ error: 'Session už beží alebo skončila', code: 'ALREADY_STARTED' });
			}
			if (sess.allow_guests === false) {
				return res.status(403).json({ error: 'Hostiteľ nepovolil hostí bez účtu', code: 'GUESTS_DISABLED' });
			}
			if (sess.max_players && (await countActivePlayers(sess.id)) >= sess.max_players) {
				return res.status(409).json({ error: 'Lobby je plné', code: 'LOBBY_FULL' });
			}

			const token = State.createGuestToken();
			const { rows } = await queryCoinsDb(
				`INSERT INTO public.session_participants (session_id, is_guest, nickname, guest_token_hash, last_seen_at)
				 VALUES ($1, true, $2, $3, NOW())
				 RETURNING id`,
				[sess.id, nickname, State.hashGuestToken(token)]
			);
			await logEvent(sess.id, rows[0]?.id || null, 'guest', 'joined');
			res.json({ ok: true, session_id: sess.id, role: 'guest', nickname, guest_token: token, status: sess.status });
		} catch (err) {
			console.error('[Sessions] guest join failed:', err.message);
			res.status(500).json({ error: 'Nepodarilo sa pripojiť', code: 'JOIN_ERROR' });
		}
	});

	// ─── leave (player) / cancel (host) ──────────────────────────────

	router.post('/:code/leave', async (req, res) => {
		if (!coinApiReady()) return respondCoinApiDisabled(res);
		const actor = await resolveActor(req, res);
		if (!actor) return;

		const code = codeOf(req);
		try {
			let sess = await loadSession(code);
			if (!sess) return res.status(404).json({ error: 'Session nenájdená', code: 'NOT_FOUND' });
			sess = await advance(sess, actor);
			const membership = await loadMembership(sess, actor);
			if (!membership.role) return res.status(403).json({ error: 'Nie si v tejto session', code: 'NOT_PARTICIPANT' });

			if (membership.role === 'host') {
				// The host cancels: an open session expires and every payer gets coins back.
				if (!State.isOpen(sess.status)) {
					return res.status(409).json({ error: 'Session sa už nedá zrušiť', code: 'WRONG_STATUS' });
				}
				const done = await expireSession(sess.id, 'host_cancelled', { id: actor.userId, kind: 'host' });
				return res.json({ ok: true, role: 'host', cancelled: done });
			}

			const p = membership.participant;
			await queryCoinsDb(
				'UPDATE public.session_participants SET left_at = NOW() WHERE id = $1 AND left_at IS NULL', [p.id]
			);
			const ref = actorRef(actor, membership);
			await logEvent(sess.id, ref.id, ref.kind, 'left', { status: sess.status });
			// H6: leaving before start means start never charges this player.
			res.json({ ok: true, role: membership.role, charged: (parseInt(p.coins_paid, 10) || 0) > 0 });
		} catch (err) {
			console.error('[Sessions] leave failed:', err.message);
			res.status(500).json({ error: 'Nepodarilo sa odísť zo session', code: 'LEAVE_ERROR' });
		}
	});

	// ─── heartbeat (presence + slow poll) ────────────────────────────

	router.post('/:code/heartbeat', async (req, res) => {
		if (!coinApiReady()) return respondCoinApiDisabled(res);
		if (limited(res, heartbeatLimiter, callerKey(req))) return;
		const actor = await resolveActor(req, res);
		if (!actor) return;

		const code = codeOf(req);
		try {
			let sess = await loadSession(code);
			if (!sess) return res.status(404).json({ error: 'Session nenájdená', code: 'NOT_FOUND' });
			sess = await advance(sess, actor);
			const membership = await loadMembership(sess, actor);
			if (!membership.role) return res.status(403).json({ error: 'Nie si v tejto session', code: 'NOT_PARTICIPANT' });

			// The host's presence was already recorded by advance().
			if (State.isOpen(sess.status) && membership.role !== 'host') {
				await queryCoinsDb('UPDATE public.session_participants SET last_seen_at = NOW() WHERE id = $1', [membership.participant.id]);
			}
			res.json({ ok: true, ...publicState(sess, membership) });
		} catch (err) {
			console.error('[Sessions] heartbeat failed:', err.message);
			res.status(500).json({ error: 'Spojenie so session zlyhalo', code: 'HEARTBEAT_ERROR' });
		}
	});

	// ─── lobby settings (host, while waiting) ─────────────────────────

	router.post('/:code/settings', async (req, res) => {
		if (!coinApiReady()) return respondCoinApiDisabled(res);
		const user = await requireSupabaseUser(req, res);
		if (!user) return;

		const code = codeOf(req);
		const body = req.body || {};
		try {
			let sess = await loadSession(code);
			if (!sess) return res.status(404).json({ error: 'Session nenájdená', code: 'NOT_FOUND' });
			if (sess.host_id !== user.id) {
				return res.status(403).json({ error: 'Nastavenia mení len host', code: 'NOT_HOST' });
			}
			sess = await advance(sess, { kind: 'user', userId: user.id });
			if (sess.status !== 'waiting') {
				return res.status(409).json({ error: 'Nastavenia sa dajú meniť len pred štartom', code: 'WRONG_STATUS' });
			}
			const maxPlayers = body.max_players === undefined
				? (sess.max_players || State.normalizeMaxPlayers(undefined, sess.game_json))
				: State.normalizeMaxPlayers(body.max_players, sess.game_json);
			const allowGuests = body.allow_guests === undefined ? sess.allow_guests !== false : body.allow_guests === true;
			const playStyle = State.normalizePlayStyle(body.play_style === undefined ? sess.play_style : body.play_style, sess.game_json?.mode);
			const { rows } = await queryCoinsDb(
				`UPDATE public.sessions SET max_players = $2, allow_guests = $3, play_style = $4
				  WHERE id = $1 AND status = 'waiting'
				  RETURNING max_players, allow_guests, play_style`,
				[sess.id, maxPlayers, allowGuests, playStyle]
			);
			if (!rows.length) {
				return res.status(409).json({ error: 'Nastavenia sa dajú meniť len pred štartom', code: 'WRONG_STATUS' });
			}
			res.json({ ok: true, ...rows[0] });
		} catch (err) {
			console.error('[Sessions] settings failed:', err.message);
			res.status(500).json({ error: 'Nepodarilo sa uložiť nastavenia', code: 'SETTINGS_ERROR' });
		}
	});

	// ─── start ───────────────────────────────────────────────────────

	router.post('/:code/start', async (req, res) => {
		if (!coinApiReady()) return respondCoinApiDisabled(res);
		const user = await requireSupabaseUser(req, res);
		if (!user) return;

		const code = codeOf(req);
		let client;
		try {
			let sess = await loadSession(code);
			if (!sess) return res.status(404).json({ error: 'Session nenájdená', code: 'NOT_FOUND' });
			if (sess.host_id !== user.id) {
				return res.status(403).json({ error: 'Len host môže štartovať session', code: 'NOT_HOST' });
			}
			sess = await advance(sess, { kind: 'user', userId: user.id });
			if (sess.status === 'expired') return respondGone(res);
			if (sess.status !== 'waiting') {
				return res.status(409).json({ error: 'Session už beží', code: 'ALREADY_STARTED' });
			}

			const game = State.sanitizeSessionGame(sess.game_json).game || sess.game_json || {};
			const durationMin = game.duration?.max || 15;
			const timerEndsAt = new Date(Date.now() + durationMin * 60 * 1000).toISOString();

			// M1 + H1: status compare-and-swap and conditional charges in one
			// transaction. A second /start charges nobody; a participant without
			// enough coins is skipped and stays unpaid (never rewarded). H6: players
			// who left or were unseen for PRESENCE_STALE_SEC are not charged.
			client = await deps.getPool().connect();
			await client.query('BEGIN');
			const result = await startSessionAndCharge(client, {
				sessionId: sess.id,
				hostId: user.id,
				code,
				cost: SESSION_JOIN_COST,
				timerEndsAt,
				expiresAt: State.activeExpiry(timerEndsAt).toISOString(),
				presenceStaleSec: State.PRESENCE_STALE_SEC,
			});
			if (!result.started) {
				await client.query('ROLLBACK');
				return res.status(409).json({ error: 'Session už beží', code: 'ALREADY_STARTED' });
			}
			await client.query('COMMIT');
			await logEvent(sess.id, user.id, 'host', 'started', {
				charged: result.charged.length, unpaid: result.unpaid.length, absent: result.absent,
			});

			res.json({
				ok: true,
				timer_ends_at: timerEndsAt,
				participants_charged: result.charged.length,
				participants_unpaid: result.unpaid.length,
				participants_absent: result.absent,
			});
		} catch (err) {
			if (client) { try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ } }
			console.error('[Sessions] start failed:', err.message);
			res.status(500).json({ error: 'Nepodarilo sa štartovať session', code: 'START_ERROR' });
		} finally {
			if (client) client.release();
		}
	});

	// ─── host opens reflection early ─────────────────────────────────

	router.post('/:code/reflection', async (req, res) => {
		if (!coinApiReady()) return respondCoinApiDisabled(res);
		const user = await requireSupabaseUser(req, res);
		if (!user) return;

		const code = codeOf(req);
		try {
			let sess = await loadSession(code);
			if (!sess) return res.status(404).json({ error: 'Session nenájdená', code: 'NOT_FOUND' });
			if (sess.host_id !== user.id) {
				return res.status(403).json({ error: 'Len host môže otvoriť reflexiu', code: 'NOT_HOST' });
			}
			sess = await advance(sess, { kind: 'user', userId: user.id });
			if (sess.status === 'expired') return respondGone(res);
			if (sess.status === 'reflection') return res.json({ ok: true, status: 'reflection', reflection_ends_at: sess.reflection_ends_at });
			if (!State.canTransition(sess.status, 'reflection')) {
				return res.status(409).json({ error: 'Reflexiu teraz nemožno otvoriť', code: 'WRONG_STATUS' });
			}
			const next = await openReflection(sess, { id: user.id, kind: 'host' });
			if (!next) return res.status(409).json({ error: 'Reflexiu teraz nemožno otvoriť', code: 'WRONG_STATUS' });
			res.json({ ok: true, status: next.status, reflection_ends_at: next.reflection_ends_at });
		} catch (err) {
			console.error('[Sessions] reflection failed:', err.message);
			res.status(500).json({ error: 'Nepodarilo sa otvoriť reflexiu', code: 'REFLECTION_ERROR' });
		}
	});

	// ─── reflect (player or guest) ───────────────────────────────────

	router.post('/:code/reflect', async (req, res) => {
		if (!coinApiReady()) return respondCoinApiDisabled(res);
		const actor = await resolveActor(req, res);
		if (!actor) return;

		const code = codeOf(req);
		const { reflection_data } = req.body || {};
		if (!reflection_data || typeof reflection_data !== 'object' || Array.isArray(reflection_data)) {
			return res.status(400).json({ error: 'reflection_data (object) je povinné', code: 'MISSING_DATA' });
		}
		const payload = JSON.stringify(reflection_data);
		if (Buffer.byteLength(payload, 'utf8') > MAX_REFLECTION_BYTES) {
			return res.status(413).json({ error: 'Reflexia je príliš dlhá', code: 'REFLECTION_TOO_LARGE' });
		}

		try {
			let sess = await loadSession(code);
			if (!sess) return res.status(404).json({ error: 'Session nenájdená', code: 'NOT_FOUND' });
			sess = await advance(sess, actor);
			if (!['active', 'reflection'].includes(sess.status)) {
				return res.status(409).json({ error: 'Session nie je aktívna', code: 'WRONG_STATUS' });
			}
			const membership = await loadMembership(sess, actor);
			if (membership.role === 'host') {
				// The host reflects too (no reward row); 200 so Reflection.js calls onSubmitted.
				return res.json({ ok: true });
			}
			if (!membership.role) {
				return res.status(403).json({ error: 'Nie si v tejto session', code: 'NOT_PARTICIPANT' });
			}
			await queryCoinsDb(
				`UPDATE public.session_participants
				 SET reflection_data = $1, reflection_done = true
				 WHERE id = $2`,
				[payload, membership.participant.id]
			);
			res.json({ ok: true });
		} catch (err) {
			console.error('[Sessions] reflect failed:', err.message);
			res.status(500).json({ error: 'Nepodarilo sa uložiť reflexiu', code: 'REFLECT_ERROR' });
		}
	});

	// ─── complete (host) ─────────────────────────────────────────────

	router.post('/:code/complete', async (req, res) => {
		if (!coinApiReady()) return respondCoinApiDisabled(res);
		const user = await requireSupabaseUser(req, res);
		if (!user) return;

		const code = codeOf(req);
		try {
			let sess = await loadSession(code);
			if (!sess) return res.status(404).json({ error: 'Session nenájdená', code: 'NOT_FOUND' });
			if (sess.host_id !== user.id) {
				return res.status(403).json({ error: 'Len host môže ukončiť session', code: 'NOT_HOST' });
			}
			if (sess.status === 'completed') {
				return res.status(409).json({ error: 'Session je už dokončená', code: 'ALREADY_COMPLETED' });
			}
			// The host is back: record it first, so a host who returns after a
			// locked phone completes the game instead of expiring it.
			sess = await touchHost(sess);
			const expiry = State.expiryReason(sess);
			if (expiry) {
				await expireSession(sess.id, expiry);
				return respondGone(res);
			}
			if (sess.status === 'expired') return respondGone(res);
			// Explicit status guard — only active or reflection sessions can complete
			if (!State.canTransition(sess.status, 'completing')) {
				return res.status(409).json({ error: 'Session nie je aktívna', code: 'WRONG_STATUS' });
			}
			const prevStatus = sess.status;
			// H2: gates read the server-clamped game (floors: 2 players, 3 minutes).
			const gateGame = State.sanitizeSessionGame(sess.game_json).game || sess.game_json;

			// ─── VALIDATION GATE 1: Duration ───────────────────────────────
			const durResult = validateDurationGate(sess.started_at, gateGame);
			if (!durResult.pass) {
				await queryCoinsDb(
					'UPDATE public.sessions SET reward_validation = $1 WHERE id = $2',
					[JSON.stringify(durResult.validation), sess.id]
				);
				return res.status(422).json({
					error: `Session trvala príliš krátko (${Math.round(durResult.validation.duration_actual_min)}/${durResult.validation.duration_required_min} min)`,
					code: 'DURATION_TOO_SHORT',
					validation: durResult.validation
				});
			}

			// ─── VALIDATION GATE 2: Participant count ──────────────────────
			const { rows: paidParts } = await queryCoinsDb(
				'SELECT COUNT(*)::int AS cnt FROM public.session_participants WHERE session_id = $1 AND coins_paid > 0',
				[sess.id]
			);
			const actualPlayers = paidParts[0]?.cnt || 0;
			const partResult = validateParticipantGate(actualPlayers, gateGame);
			if (!partResult.pass) {
				await queryCoinsDb(
					'UPDATE public.sessions SET reward_validation = $1 WHERE id = $2',
					[JSON.stringify(partResult.validation), sess.id]
				);
				return res.status(422).json({
					error: `Nedostatok hráčov (${actualPlayers}/${partResult.validation.participants_required})`,
					code: 'NOT_ENOUGH_PLAYERS',
					validation: partResult.validation
				});
			}

			// ─── VALIDATION GATE 3: Host cooldown ──────────────────────────
			const { rows: cooldownRows } = await queryCoinsDb(
				`SELECT COUNT(*)::int AS cnt FROM public.sessions
				 WHERE host_id = $1 AND status = 'completed'
				   AND completed_at > NOW() - INTERVAL '1 hour'`,
				[user.id]
			);
			const hostSessionsLastHour = cooldownRows[0]?.cnt || 0;
			const coolResult = validateHostCooldownGate(hostSessionsLastHour);
			if (!coolResult.pass) {
				await queryCoinsDb(
					'UPDATE public.sessions SET reward_validation = $1 WHERE id = $2',
					[JSON.stringify(coolResult.validation), sess.id]
				);
				return res.status(429).json({
					error: `Príliš veľa sessions za hodinu (${hostSessionsLastHour}/${HOST_COOLDOWN_MAX}). Skús neskôr.`,
					code: 'HOST_COOLDOWN',
					validation: coolResult.validation
				});
			}

			// ─── Atomic status lock (CAS from the exact earlier state) ─────
			const { rowCount: lockCount } = await queryCoinsDb(
				`UPDATE public.sessions SET status = 'completing' WHERE id = $1 AND status = $2`,
				[sess.id, prevStatus]
			);
			if (lockCount === 0) {
				return res.status(409).json({ error: 'Session je už dokončená', code: 'ALREADY_COMPLETED' });
			}

			// ─── Filter and whitelist competency keys ──────────────────────
			const rawKompetence = sess.game_json?.rvp?.kompetence || [];
			const kompetence = rawKompetence.filter(k => VALID_COMPETENCY_KEYS.includes(k));
			const awardedMarker = { rpg: true, kompetence_keys: kompetence };

			// ─── Transactional reward loop ─────────────────────────────────
			const client = await deps.getPool().connect();
			let participantsRewarded = 0;
			let myRpgLevelUp = false;
			let myXpGained = 0;
			let hostXp = 0;
			try {
				await client.query('BEGIN');

				// M2: only participants who actually paid at /start are rewarded; a
				// join that raced the start (or a skipped, unpaid player) is not.
				// Guests can never pay (040 CHECK), so they are never rewarded.
				const { rows: parts } = await client.query(
					`SELECT user_id FROM public.session_participants
					 WHERE session_id = $1 AND reflection_done = true AND awarded_competencies IS NULL
					   AND coins_paid > 0`,
					[sess.id]
				);

				const participantXp = [];
				for (const p of parts) {
					// Per-participant daily cap: coins (their stake back) always, XP
					// only for the first SESSION_XP_REWARDS_PER_DAY sessions a day.
					const { rows: capRows } = await client.query(
						`SELECT COUNT(*)::int AS cnt FROM public.coin_transactions
						  WHERE user_id = $1 AND action = 'session_complete' AND created_at >= CURRENT_DATE`,
						[p.user_id]
					);
					const capped = (capRows[0]?.cnt || 0) >= State.SESSION_XP_REWARDS_PER_DAY;
					const xp = capped ? 0 : SESSION_XP_AWARD;

					const { rows: preXpRows } = await client.query(
						'SELECT COALESCE(rpg_xp, 0)::int AS rpg_xp FROM public.profiles WHERE id = $1 FOR UPDATE',
						[p.user_id]
					);
					const levelBefore = computeRpgLevel(preXpRows[0]?.rpg_xp || 0).level;

					await client.query(
						`UPDATE public.session_participants
						 SET awarded_competencies = $1 WHERE session_id = $2 AND user_id = $3`,
						[JSON.stringify({ ...awardedMarker, xp, capped }), sess.id, p.user_id]
					);

					const { rowCount: coinRows } = await client.query(
						'UPDATE public.profiles SET coins = COALESCE(coins,0) + $1 WHERE id = $2',
						[COMPLETION_BONUS, p.user_id]
					);
					if (coinRows === 0) {
						await client.query(
							'INSERT INTO public.profiles (id, coins) VALUES ($1, $2)',
							[p.user_id, COMPLETION_BONUS]
						);
					}
					await client.query(
						'INSERT INTO public.coin_transactions (user_id, amount, action, metadata) VALUES ($1, $2, $3, $4)',
						[p.user_id, COMPLETION_BONUS, 'session_complete', JSON.stringify({ session_code: code, kompetence_keys: kompetence, xp })]
					);

					if (xp > 0) {
						const { level: rpgLvlAfter } = await awardXpInTransaction(client, p.user_id, xp, 'session_complete');
						if (p.user_id === user.id) {
							myXpGained = xp;
							myRpgLevelUp = rpgLvlAfter > levelBefore;
						}
					}
					participantXp.push(xp);
				}
				participantsRewarded = parts.length;

				// ─── Host reward: 50 % of the average participant XP, no coins ──
				const proposedHostXp = State.computeHostXp(participantXp);
				if (proposedHostXp > 0) {
					const { rows: hostCap } = await client.query(
						`SELECT COUNT(*)::int AS cnt FROM public.sessions
						  WHERE host_id = $1 AND host_xp_awarded > 0 AND completed_at >= CURRENT_DATE`,
						[user.id]
					);
					if ((hostCap[0]?.cnt || 0) < State.HOST_XP_SESSIONS_PER_DAY) {
						await client.query('INSERT INTO public.profiles (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [user.id]);
						const { rows: hostPre } = await client.query(
							'SELECT COALESCE(rpg_xp, 0)::int AS rpg_xp FROM public.profiles WHERE id = $1 FOR UPDATE',
							[user.id]
						);
						const hostLevelBefore = computeRpgLevel(hostPre[0]?.rpg_xp || 0).level;
						const { level: hostLevelAfter } = await awardXpInTransaction(client, user.id, proposedHostXp, 'session_host');
						hostXp = proposedHostXp;
						myXpGained = hostXp;
						myRpgLevelUp = hostLevelAfter > hostLevelBefore;
					}
				}

				// Write audit trail + mark completed (inside transaction)
				// C1: required values come from the gate results.
				const validation = {
					...buildCompletionValidation({
						durationValidation: durResult.validation,
						participantValidation: partResult.validation,
						hostSessionsLastHour,
						competencies: kompetence,
						participantsRewarded: parts.length,
					}),
					host_xp_awarded: hostXp,
				};
				await client.query(
					`UPDATE public.sessions SET status = 'completed', completed_at = NOW(), reward_validation = $1, host_xp_awarded = $3 WHERE id = $2`,
					[JSON.stringify(validation), sess.id, hostXp]
				);

				await client.query('COMMIT');
				await logEvent(sess.id, user.id, 'host', 'completed', { rewarded: participantsRewarded, host_xp: hostXp });

				// Compute trained stats and effective stats for the host (cosmetic)
				const sessionTrainedStats = [...new Set(kompetence.map(k => GAME_KOMP_TO_STAT[k]).filter(Boolean))];
				let sessionStatsAfter = {};
				try {
					const { rows: hostProfile } = await queryCoinsDb(
						'SELECT rpg_avatar_id FROM public.profiles WHERE id = $1', [user.id]
					);
					const hClassId = hostProfile[0]?.rpg_avatar_id || null;
					if (hClassId) {
						const { rows: hTalRows } = await queryCoinsDb(
							'SELECT talent_id FROM public.rpg_user_talents WHERE user_id = $1', [user.id]
						);
						// M4: getEffectiveStats needs talent objects, not ids.
						sessionStatsAfter = getEffectiveStats(hClassId, talentIdsToTalents(hTalRows.map(r => r.talent_id))).effective;
					}
				} catch (_) { /* non-critical */ }

				res.json({
					ok: true,
					awarded: awardedMarker,
					participants_rewarded: participantsRewarded,
					validation,
					host_xp_awarded: hostXp,
					my_level_changes: {},
					my_rpg_level_up: myRpgLevelUp,
					rpg_xp_gained: myXpGained,
					trained_stats: sessionTrainedStats,
					stats_after: sessionStatsAfter,
				});
			} catch (txErr) {
				await client.query('ROLLBACK');
				// Revert the lock to the exact earlier state so the host can retry.
				await queryCoinsDb(
					`UPDATE public.sessions SET status = $2 WHERE id = $1 AND status = 'completing'`,
					[sess.id, prevStatus]
				);
				throw txErr;
			} finally {
				client.release();
			}
		} catch (err) {
			console.error('[Sessions] complete failed:', err.message);
			res.status(500).json({ error: 'Nepodarilo sa ukončiť session', code: 'COMPLETE_ERROR' });
		}
	});

	// ─── Session reward: participant fetches their own RPG reward status ───
	// Only returns data for the authenticated requesting user — never exposes others.
	router.get('/:code/my-reward', async (req, res) => {
		if (!coinApiReady()) return respondCoinApiDisabled(res);
		const user = await requireSupabaseUser(req, res);
		if (!user) return;

		const code = codeOf(req);
		try {
			const { rows: sessRows } = await queryCoinsDb(
				'SELECT id, status FROM public.sessions WHERE join_code = $1', [code]
			);
			if (!sessRows.length) return res.status(404).json({ error: 'Session nenájdená', code: 'NOT_FOUND' });
			const sess = sessRows[0];
			if (sess.status !== 'completed') {
				return res.status(400).json({ error: 'Session ešte nie je dokončená', code: 'NOT_COMPLETED' });
			}

			const { rows: partRows } = await queryCoinsDb(
				`SELECT awarded_competencies FROM public.session_participants
				 WHERE session_id = $1 AND user_id = $2`,
				[sess.id, user.id]
			);
			if (!partRows.length) return res.status(404).json({ error: 'Nie si účastníkom tejto session', code: 'NOT_PARTICIPANT' });

			const awarded = partRows[0].awarded_competencies || {};
			res.json({ awarded, rpg: true });
		} catch (err) {
			console.error('[Sessions] my-reward failed:', err.message);
			res.status(500).json({ error: 'Nepodarilo sa načítať odmenu', code: 'REWARD_ERROR' });
		}
	});

	router.sweepExpired = sweepExpired;
	return router;
}

module.exports = { createSessionsRouter };
