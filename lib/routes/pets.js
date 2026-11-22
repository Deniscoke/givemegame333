'use strict';

/**
 * gIVEMEGAME.IO — roaming pets (POST /api/pets/interact), Phase 9.
 *
 * A pet asks a pre-written mini-challenge (public/data/pet-tips.*.json,
 * zero AI tokens). A correct answer pays a small fixed reward through the
 * coin ledger; at most PET_REWARD.dailyLimit per day, counted on the server
 * under the profile row lock (lib/coin-ledger.js applyPetReward).
 *
 * The client sends only { challenge_id, answer }. The amount, the limit and
 * the right answer are never taken from the client. A wrong answer pays
 * nothing and does not use up a daily slot. If the database is not
 * configured the route answers 503 and the pet keeps working locally.
 */

const express = require('express');
const { applyPetReward } = require('../coin-ledger');
const { PET_REWARD } = require('../coin-log-policy');
const { createRateLimiter } = require('../simple-rate-limit');

// Static require so the serverless bundler ships the file. Answer indexes
// are identical in every language file (a test checks it).
const CHALLENGES = (() => {
	try { return require('../../public/data/pet-tips.en.json').challenges || []; } catch { return []; }
})();

/** @returns {{ id: string, correct: number } | undefined} */
function findChallenge(id) {
	return CHALLENGES.find((c) => c.id === id);
}

/**
 * @param {{
 *   coinApiReady: () => boolean,
 *   respondCoinApiDisabled: (res: import('express').Response) => unknown,
 *   requireSupabaseUser: (req: import('express').Request, res: import('express').Response) => Promise<{id: string}|null>,
 *   getPool: () => import('pg').Pool | null,
 *   rateLimit?: { limit: number, windowMs: number }
 * }} deps
 */
function createPetsRouter(deps) {
	const router = express.Router();
	const limiter = createRateLimiter({ limit: deps.rateLimit?.limit ?? 20, windowMs: deps.rateLimit?.windowMs ?? 60 * 1000 });

	router.post('/interact', async (req, res) => {
		if (!deps.coinApiReady()) return deps.respondCoinApiDisabled(res);
		const user = await deps.requireSupabaseUser(req, res);
		if (!user) return;

		const rl = limiter.check(user.id);
		if (!rl.ok) {
			res.set('Retry-After', String(rl.retryAfterSec));
			return res.status(429).json({ error: 'Príliš veľa pokusov', code: 'RATE_LIMITED' });
		}

		const { challenge_id: challengeId, answer } = req.body || {};
		const challenge = typeof challengeId === 'string' ? findChallenge(challengeId) : null;
		if (!challenge || !Number.isInteger(answer)) {
			return res.status(400).json({ error: 'challenge_id a answer sú povinné', code: 'INVALID_INPUT' });
		}
		if (answer !== challenge.correct) {
			return res.json({ correct: false, rewarded: false, credited: 0 });
		}

		const pool = deps.getPool();
		const client = await pool.connect();
		try {
			await client.query('BEGIN');
			const r = await applyPetReward(client, { userId: user.id, metadata: { challenge_id: challenge.id } });
			if (r.status === 'no_profile') {
				await client.query('ROLLBACK');
				return res.status(404).json({ error: 'Profil neexistuje', code: 'NO_PROFILE' });
			}
			if (r.status === 'limit') {
				await client.query('ROLLBACK');
				return res.status(429).json({
					error: 'Denný limit odmien od zvieratiek je vyčerpaný',
					code: 'PET_DAILY_LIMIT', limit: r.limit, balance: r.balance, correct: true, rewarded: false, credited: 0
				});
			}
			await client.query('COMMIT');
			return res.json({
				correct: true, rewarded: true, credited: r.credited, balance: r.balance,
				remaining_today: r.remaining, daily_limit: PET_REWARD.dailyLimit
			});
		} catch (err) {
			try { await client.query('ROLLBACK'); } catch { /* ignore */ }
			console.error('[Pets] interact failed:', err.message);
			return res.status(500).json({ error: 'Odmenu sa nepodarilo uložiť', code: 'PET_ERROR' });
		} finally {
			client.release();
		}
	});

	router.resetForTests = () => limiter.reset();
	return router;
}

module.exports = { createPetsRouter, findChallenge };
