'use strict';

/**
 * Phase 9: POST /api/pets/interact — login required, fixed server-side
 * amount, daily limit under the profile lock, 503 without a database.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { startEconomyServer } = require('./helpers/economy-harness');
const { createPetsRouter } = require('../lib/routes/pets');
const { PET_REWARD, validateCoinLog } = require('../lib/coin-log-policy');

const U = 'user-pet';
const en = require('../public/data/pet-tips.en.json');
const sk = require('../public/data/pet-tips.sk.json');
const C = en.challenges[0];
let h;

before(async () => { h = await startEconomyServer(); });
after(async () => { await h.stop(); });
beforeEach(() => {
	h.db.state = { profiles: { [U]: { coins: 10, rpg_xp: 0, rpg_avatar_id: null } }, sessions: {}, participants: [], tx: [], talents: [] };
});

const interact = (opts) => h.call('POST', '/api/pets/interact', opts);

describe('pets reward route', () => {
	it('rejects anonymous callers with 401 and pays nothing', async () => {
		const res = await interact({ body: { challenge_id: C.id, answer: C.correct } });
		assert.equal(res.status, 401);
		assert.equal(h.db.state.tx.length, 0);
	});

	it('pays the fixed amount for a correct answer, never a client amount', async () => {
		const res = await interact({ user: U, body: { challenge_id: C.id, answer: C.correct, amount: 9999, coins: 9999 } });
		assert.equal(res.status, 200, JSON.stringify(res.body));
		assert.equal(res.body.credited, PET_REWARD.coins);
		assert.equal(h.db.state.profiles[U].coins, 10 + PET_REWARD.coins);
		assert.equal(h.db.state.tx.at(-1).action, 'pet_challenge');
		assert.equal(h.db.state.tx.at(-1).amount, PET_REWARD.coins);
	});

	it('pays nothing for a wrong answer and keeps the daily slot', async () => {
		const wrong = (C.correct + 1) % C.options.length;
		const res = await interact({ user: U, body: { challenge_id: C.id, answer: wrong } });
		assert.equal(res.status, 200);
		assert.equal(res.body.rewarded, false);
		assert.equal(h.db.state.tx.length, 0);
	});

	it('refuses unknown challenges and bad input with 400', async () => {
		assert.equal((await interact({ user: U, body: { challenge_id: 'nope', answer: 0 } })).status, 400);
		assert.equal((await interact({ user: U, body: { challenge_id: C.id, answer: 'x' } })).status, 400);
		assert.equal((await interact({ user: U, body: {} })).status, 400);
	});

	it('stops at the daily limit with 429 and no extra coins', async () => {
		for (let i = 0; i < PET_REWARD.dailyLimit; i++) {
			assert.equal((await interact({ user: U, body: { challenge_id: C.id, answer: C.correct } })).status, 200);
		}
		const coins = h.db.state.profiles[U].coins;
		const res = await interact({ user: U, body: { challenge_id: C.id, answer: C.correct } });
		assert.equal(res.status, 429);
		assert.equal(res.body.code, 'PET_DAILY_LIMIT');
		assert.equal(h.db.state.profiles[U].coins, coins);
		assert.equal(h.db.state.tx.filter((t) => t.action === 'pet_challenge').length, PET_REWARD.dailyLimit);
	});

	it('cannot be claimed through /api/coins/log', () => {
		assert.equal(validateCoinLog({ action: 'pet_challenge', amount: 5 }).ok, false);
	});
});

describe('pets route without a database', () => {
	it('answers 503 so the pet keeps working locally', async () => {
		const app = express();
		app.use(express.json());
		app.use('/api/pets', createPetsRouter({
			coinApiReady: () => false,
			respondCoinApiDisabled: (res) => res.status(503).json({ code: 'COIN_API_DISABLED' }),
			requireSupabaseUser: async () => { throw new Error('must not be called'); },
			getPool: () => null,
		}));
		const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
		try {
			const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/pets/interact`, {
				method: 'POST', headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ challenge_id: C.id, answer: C.correct }),
			});
			assert.equal(res.status, 503);
		} finally {
			await new Promise((resolve) => srv.close(resolve));
		}
	});
});

describe('pet challenge data', () => {
	it('has identical ids and answer indexes in every language', () => {
		const key = (d) => d.challenges.map((c) => `${c.id}:${c.correct}:${c.options.length}`).join('|');
		assert.equal(key(sk), key(en));
		for (const c of en.challenges) assert.ok(c.correct >= 0 && c.correct < c.options.length);
	});
});
