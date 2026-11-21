'use strict';

/**
 * gIVEMEGAME.IO — multiplayer session routes (/api/sessions/*).
 *
 * Extracted from server.js (Phase 6) to cut merge conflicts. Every server
 * dependency is injected, so tests still boot it through server.js
 * (test/helpers/economy-harness.js).
 */

const express = require('express');
const { validateDurationGate, validateParticipantGate, validateHostCooldownGate } = require('../reward-validation');
const { computeRpgLevel, getEffectiveStats, awardXpInTransaction } = require('../rpg-progression');
const { talentIdsToTalents } = require('../rpg-talents');
const { buildCompletionValidation, startSessionAndCharge } = require('../session-economy');

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
 *   }
 * }} deps
 * @returns {import('express').Router}
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
	const router = express.Router();

	router.post('/', async (req, res) => {
		if (!coinApiReady()) return respondCoinApiDisabled(res);
		const user = await requireSupabaseUser(req, res);
		if (!user) return;
	
		const { game_json } = req.body || {};
		if (!game_json?.title) {
			return res.status(400).json({ error: 'game_json je povinné', code: 'MISSING_GAME' });
		}
	
		// M9: the join-code lookup hits the DB too, so it must sit inside the try —
		// Express 4 does not catch a rejected async handler and the request hangs.
		try {
			// Generate unique join code (retry on collision)
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
				`INSERT INTO public.sessions (host_id, game_json, join_code)
				 VALUES ($1, $2, $3)
				 RETURNING id, join_code, status, created_at`,
				[user.id, JSON.stringify(game_json), join_code]
			);
			res.json(rows[0]);
		} catch (err) {
			console.error('[Sessions] create failed:', err.message);
			res.status(500).json({ error: 'Nepodarilo sa vytvoriť session', code: 'CREATE_ERROR' });
		}
	});
	
	router.get('/:code', async (req, res) => {
		if (!coinApiReady()) return respondCoinApiDisabled(res);
		const user = await requireSupabaseUser(req, res);
		if (!user) return;
	
		const code = (req.params.code || '').toUpperCase().trim();
		if (!code) return res.status(400).json({ error: 'Kód je povinný', code: 'MISSING_CODE' });
	
		try {
			const { rows: sRows } = await queryCoinsDb(
				`SELECT id, host_id, game_json, join_code, status, timer_ends_at, created_at
				 FROM public.sessions WHERE join_code = $1`,
				[code]
			);
			if (!sRows.length) return res.status(404).json({ error: 'Session nenájdená', code: 'NOT_FOUND' });
			const session = sRows[0];
	
			const { rows: pRows } = await queryCoinsDb(
				`SELECT sp.user_id, sp.coins_paid, sp.reflection_done, sp.joined_at,
				        p.display_name
				 FROM public.session_participants sp
				 LEFT JOIN public.profiles p ON p.id = sp.user_id
				 WHERE sp.session_id = $1
				 ORDER BY sp.joined_at ASC`,
				[session.id]
			);
	
			res.json({ ...session, participants: pRows });
		} catch (err) {
			console.error('[Sessions] get failed:', err.message);
			res.status(500).json({ error: 'Nepodarilo sa načítať session', code: 'FETCH_ERROR' });
		}
	});
	
	router.post('/:code/join', async (req, res) => {
		if (!coinApiReady()) return respondCoinApiDisabled(res);
		const user = await requireSupabaseUser(req, res);
		if (!user) return;
	
		const code = (req.params.code || '').toUpperCase().trim();
		try {
			const { rows } = await queryCoinsDb(
				'SELECT id, status FROM public.sessions WHERE join_code = $1', [code]
			);
			if (!rows.length) return res.status(404).json({ error: 'Session nenájdená', code: 'NOT_FOUND' });
			const sess = rows[0];
			if (sess.status !== 'waiting') {
				return res.status(409).json({ error: 'Session už beží alebo skončila', code: 'ALREADY_STARTED' });
			}
	
			// Check coin balance
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
				`INSERT INTO public.session_participants (session_id, user_id)
				 VALUES ($1, $2) ON CONFLICT (session_id, user_id) DO NOTHING`,
				[sess.id, user.id]
			);
			res.json({ ok: true, session_id: sess.id });
		} catch (err) {
			console.error('[Sessions] join failed:', err.message);
			res.status(500).json({ error: 'Nepodarilo sa pripojiť', code: 'JOIN_ERROR' });
		}
	});
	
	router.post('/:code/start', async (req, res) => {
		if (!coinApiReady()) return respondCoinApiDisabled(res);
		const user = await requireSupabaseUser(req, res);
		if (!user) return;
	
		const code = (req.params.code || '').toUpperCase().trim();
		let client;
		try {
			const { rows } = await queryCoinsDb(
				'SELECT id, host_id, game_json, status FROM public.sessions WHERE join_code = $1', [code]
			);
			if (!rows.length) return res.status(404).json({ error: 'Session nenájdená', code: 'NOT_FOUND' });
			const sess = rows[0];
			if (sess.host_id !== user.id) {
				return res.status(403).json({ error: 'Len host môže štartovať session', code: 'NOT_HOST' });
			}
			if (sess.status !== 'waiting') {
				return res.status(409).json({ error: 'Session už beží', code: 'ALREADY_STARTED' });
			}
	
			const durationMin = sess.game_json?.duration?.max || 15;
			const timerEndsAt = new Date(Date.now() + durationMin * 60 * 1000).toISOString();
	
			// M1 + H1: status compare-and-swap and conditional charges in one
			// transaction. A second /start charges nobody; a participant without
			// enough coins is skipped and stays unpaid (never rewarded).
			client = await deps.getPool().connect();
			await client.query('BEGIN');
			const result = await startSessionAndCharge(client, {
				sessionId: sess.id,
				hostId: user.id,
				code,
				cost: SESSION_JOIN_COST,
				timerEndsAt,
			});
			if (!result.started) {
				await client.query('ROLLBACK');
				return res.status(409).json({ error: 'Session už beží', code: 'ALREADY_STARTED' });
			}
			await client.query('COMMIT');
	
			res.json({
				ok: true,
				timer_ends_at: timerEndsAt,
				participants_charged: result.charged.length,
				participants_unpaid: result.unpaid.length,
			});
		} catch (err) {
			if (client) { try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ } }
			console.error('[Sessions] start failed:', err.message);
			res.status(500).json({ error: 'Nepodarilo sa štartovať session', code: 'START_ERROR' });
		} finally {
			if (client) client.release();
		}
	});
	
	router.post('/:code/reflect', async (req, res) => {
		if (!coinApiReady()) return respondCoinApiDisabled(res);
		const user = await requireSupabaseUser(req, res);
		if (!user) return;
	
		const code = (req.params.code || '').toUpperCase().trim();
		const { reflection_data } = req.body || {};
		if (!reflection_data || typeof reflection_data !== 'object' || Array.isArray(reflection_data)) {
			return res.status(400).json({ error: 'reflection_data (object) je povinné', code: 'MISSING_DATA' });
		}
	
		try {
			const { rows } = await queryCoinsDb(
				'SELECT id, status FROM public.sessions WHERE join_code = $1', [code]
			);
			if (!rows.length) return res.status(404).json({ error: 'Session nenájdená', code: 'NOT_FOUND' });
			const sess = rows[0];
			if (!['active', 'reflection'].includes(sess.status)) {
				return res.status(409).json({ error: 'Session nie je aktívna', code: 'WRONG_STATUS' });
			}
	
			const { rowCount } = await queryCoinsDb(
				`UPDATE public.session_participants
				 SET reflection_data = $1, reflection_done = true
				 WHERE session_id = $2 AND user_id = $3`,
				[JSON.stringify(reflection_data), sess.id, user.id]
			);
			// rowCount === 0 means host (not in session_participants) — silently ok so onSubmitted fires
			if (rowCount === 0) {
				console.warn(`[Sessions] reflect: user ${user.id} is not a participant in session ${sess.id} (likely host)`);
				// Return 200 so Reflection.js calls onSubmitted and host can complete the session
			}
			res.json({ ok: true });
		} catch (err) {
			console.error('[Sessions] reflect failed:', err.message);
			res.status(500).json({ error: 'Nepodarilo sa uložiť reflexiu', code: 'REFLECT_ERROR' });
		}
	});
	
	router.post('/:code/complete', async (req, res) => {
		if (!coinApiReady()) return respondCoinApiDisabled(res);
		const user = await requireSupabaseUser(req, res);
		if (!user) return;
	
		const code = (req.params.code || '').toUpperCase().trim();
		try {
			const { rows } = await queryCoinsDb(
				'SELECT id, host_id, game_json, status, started_at FROM public.sessions WHERE join_code = $1', [code]
			);
			if (!rows.length) return res.status(404).json({ error: 'Session nenájdená', code: 'NOT_FOUND' });
			const sess = rows[0];
			if (sess.host_id !== user.id) {
				return res.status(403).json({ error: 'Len host môže ukončiť session', code: 'NOT_HOST' });
			}
			if (sess.status === 'completed') {
				return res.status(409).json({ error: 'Session je už dokončená', code: 'ALREADY_COMPLETED' });
			}
			// Explicit status guard — only active or reflection sessions can complete
			if (!['active', 'reflection'].includes(sess.status)) {
				return res.status(409).json({ error: 'Session nie je aktívna', code: 'WRONG_STATUS' });
			}
	
			// ─── VALIDATION GATE 1: Duration ───────────────────────────────
			const durResult = validateDurationGate(sess.started_at, sess.game_json);
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
			const partResult = validateParticipantGate(actualPlayers, sess.game_json);
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
	
			// ─── Atomic status lock: prevent concurrent /complete race ─────
			// Compare-and-swap: only one request can transition away from active/reflection
			const { rowCount: lockCount } = await queryCoinsDb(
				`UPDATE public.sessions SET status = 'completing' WHERE id = $1 AND status IN ('active', 'reflection')`,
				[sess.id]
			);
			if (lockCount === 0) {
				return res.status(409).json({ error: 'Session je už dokončená', code: 'ALREADY_COMPLETED' });
			}
	
			// ─── Filter and whitelist competency keys ──────────────────────
			const rawKompetence = sess.game_json?.rvp?.kompetence || [];
			const kompetence = rawKompetence.filter(k => VALID_COMPETENCY_KEYS.includes(k));
			const awardedMarker = { rpg: true, kompetence_keys: kompetence };
	
			// ─── Transactional reward loop ─────────────────────────────────
			// All awards are wrapped in a single DB transaction to prevent
			// partial awarding on crash/error (atomicity guarantee).
			const client = await deps.getPool().connect();
			let participantsRewarded = 0;
			let myRpgLevelUp = false;
			let myXpGained = 0;
			try {
				await client.query('BEGIN');
	
				// M2: only participants who actually paid at /start are rewarded; a
				// join that raced the start (or a skipped, unpaid player) is not.
				const { rows: parts } = await client.query(
					`SELECT user_id FROM public.session_participants
					 WHERE session_id = $1 AND reflection_done = true AND awarded_competencies IS NULL
					   AND coins_paid > 0`,
					[sess.id]
				);
	
				for (const p of parts) {
					const { rows: preXpRows } = await client.query(
						'SELECT COALESCE(rpg_xp, 0)::int AS rpg_xp FROM public.profiles WHERE id = $1 FOR UPDATE',
						[p.user_id]
					);
					const levelBefore = computeRpgLevel(preXpRows[0]?.rpg_xp || 0).level;
	
					await client.query(
						`UPDATE public.session_participants
						 SET awarded_competencies = $1 WHERE session_id = $2 AND user_id = $3`,
						[JSON.stringify(awardedMarker), sess.id, p.user_id]
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
						[p.user_id, COMPLETION_BONUS, 'session_complete', JSON.stringify({ session_code: code, kompetence_keys: kompetence })]
					);
	
					const { level: rpgLvlAfter } = await awardXpInTransaction(client, p.user_id, SESSION_XP_AWARD, 'session_complete');
					if (p.user_id === user.id) {
						myXpGained = SESSION_XP_AWARD;
						myRpgLevelUp = rpgLvlAfter > levelBefore;
					}
				}
				participantsRewarded = parts.length;
	
				// Write audit trail + mark completed (inside transaction)
				// C1: required values come from the gate results (requiredMin /
				// requiredPlayers only exist inside lib/reward-validation.js).
				const validation = buildCompletionValidation({
					durationValidation: durResult.validation,
					participantValidation: partResult.validation,
					hostSessionsLastHour,
					competencies: kompetence,
					participantsRewarded: parts.length,
				});
				await client.query(
					`UPDATE public.sessions SET status = 'completed', completed_at = NOW(), reward_validation = $1 WHERE id = $2`,
					[JSON.stringify(validation), sess.id]
				);
	
				await client.query('COMMIT');
	
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
						// M4: getEffectiveStats needs talent objects, not ids; the card
						// reads flat stat values.
						sessionStatsAfter = getEffectiveStats(hClassId, talentIdsToTalents(hTalRows.map(r => r.talent_id))).effective;
					}
				} catch (_) { /* non-critical */ }
	
				res.json({
					ok: true,
					awarded: awardedMarker,
					participants_rewarded: participantsRewarded,
					validation,
					my_level_changes: {},
					my_rpg_level_up: myRpgLevelUp,
					rpg_xp_gained: myXpGained,
					trained_stats: sessionTrainedStats,
					stats_after: sessionStatsAfter,
				});
			} catch (txErr) {
				await client.query('ROLLBACK');
				// Revert status lock so host can retry
				await queryCoinsDb(
					`UPDATE public.sessions SET status = 'active' WHERE id = $1 AND status = 'completing'`,
					[sess.id]
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
	
		const code = (req.params.code || '').toUpperCase().trim();
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

	return router;
}

module.exports = { createSessionsRouter };
