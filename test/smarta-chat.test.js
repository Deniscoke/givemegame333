'use strict';

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { createSmartaRouter, matchLocalReply, sanitizeHistory, scrubSecrets, MAX_TOKENS, MAX_TURNS } = require('../lib/routes/smarta');

function makeOpenAi(content = 'Ahoj z AI') {
	const calls = [];
	return {
		calls,
		chat: { completions: { create: async (opts) => { calls.push(opts); return { choices: [{ message: { content } }] }; } } }
	};
}

/** Boots the router; the bearer token is the user id, "free-*" users are unpaid. */
async function boot({ openai, env = { OPENAI_API_KEY: 'sk-test-key-1234567890' }, rateLimit, dailyCap } = {}) {
	const app = express();
	app.use('/api/smarta', createSmartaRouter({
		optionalUser: async (req) => {
			const h = req.headers.authorization || '';
			return h.startsWith('Bearer ') ? { id: h.slice(7) } : null;
		},
		isPaidUser: async (u) => !u.id.startsWith('free-'),
		getOpenAI: () => openai,
		env,
		rateLimit,
		dailyCap
	}));
	const server = await new Promise((resolve) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s)); });
	const base = `http://127.0.0.1:${server.address().port}`;
	async function chat(body, token) {
		const res = await fetch(`${base}/api/smarta/chat`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
			body: JSON.stringify(body)
		});
		return { status: res.status, headers: res.headers, json: await res.json() };
	}
	return { chat, close: () => new Promise((r) => server.close(r)) };
}

const servers = [];
async function start(opts) {
	const s = await boot(opts);
	servers.push(s);
	return s;
}
after(async () => { await Promise.all(servers.map((s) => s.close())); });

describe('SMARTA chat plan gate', () => {
	it('answers anonymous users from local replies without calling OpenAI', async () => {
		const openai = makeOpenAi();
		const { chat } = await start({ openai });
		const r = await chat({ message: 'Ako získam mince?', lang: 'sk' });
		assert.equal(r.status, 200);
		assert.equal(r.json.source, 'local');
		assert.match(r.json.reply, /Mince/);
		assert.equal(openai.calls.length, 0);
	});

	it('answers free users locally with the plan hint and no OpenAI call', async () => {
		const openai = makeOpenAi();
		const { chat } = await start({ openai });
		const r = await chat({ message: 'How do I join my friends?', lang: 'en' }, 'free-1');
		assert.equal(r.json.source, 'local');
		assert.equal(r.json.planGate, 'smarta_pro_only');
		assert.match(r.json.reply, /code/i);
		assert.equal(openai.calls.length, 0);
	});

	it('calls OpenAI for paid users with max_tokens 150 and at most 6 turns', async () => {
		const openai = makeOpenAi('Odpoveď od AI');
		const { chat } = await start({ openai });
		const history = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `t${i}` }));
		const r = await chat({ message: 'Povedz mi vtip', history, lang: 'sk' }, 'pro-1');
		assert.equal(r.json.source, 'openai');
		assert.equal(r.json.reply, 'Odpoveď od AI');
		assert.equal(openai.calls.length, 1);
		const call = openai.calls[0];
		assert.equal(call.max_tokens, 150);
		assert.equal(MAX_TOKENS, 150);
		assert.equal(call.model, 'gpt-4o-mini');
		const turns = call.messages.filter((m) => m.role !== 'system');
		assert.ok(turns.length <= 6, `got ${turns.length} turns`);
		assert.equal(turns.length, MAX_TURNS);
		assert.equal(turns[turns.length - 1].content, 'Povedz mi vtip');
		assert.equal(turns[0].content, 't15');
		assert.equal(call.messages[0].role, 'system');
		assert.match(call.messages[0].content, /children/);
		assert.match(call.messages[0].content, /Slovak/);
	});

	it('falls back to local replies when OPENAI_API_KEY is missing', async () => {
		const openai = makeOpenAi();
		const { chat } = await start({ openai, env: {} });
		const r = await chat({ message: 'ahoj', lang: 'sk' }, 'pro-1');
		assert.equal(r.json.source, 'local');
		assert.equal(openai.calls.length, 0);
	});

	it('falls back to a local reply when OpenAI throws, without leaking the error', async () => {
		const openai = { chat: { completions: { create: async () => { throw Object.assign(new Error('Incorrect API key sk-abcdefghijklmnopqrstuv'), { status: 401 }); } } } };
		const { chat } = await start({ openai });
		const r = await chat({ message: 'ahoj', lang: 'sk' }, 'pro-1');
		assert.equal(r.status, 200);
		assert.equal(r.json.source, 'local');
		assert.ok(!JSON.stringify(r.json).includes('sk-abc'));
	});

	it('scrubs key-looking strings from model output', async () => {
		const openai = makeOpenAi('Kľúč je sk-abcdefghijklmnopqrstuvwxyz1234');
		const { chat } = await start({ openai });
		const r = await chat({ message: 'kluc', lang: 'sk' }, 'pro-1');
		assert.ok(!r.json.reply.includes('sk-abcdef'));
	});
});

describe('SMARTA chat validation', () => {
	it('rejects empty and over-long messages', async () => {
		const { chat } = await start({ openai: makeOpenAi() });
		assert.equal((await chat({ message: '   ' })).status, 400);
		assert.equal((await chat({})).status, 400);
		const long = await chat({ message: 'a'.repeat(301) });
		assert.equal(long.status, 400);
		assert.equal(long.json.code, 'MESSAGE_TOO_LONG');
		assert.equal((await chat({ message: 'a'.repeat(300) })).status, 200);
	});

	it('ignores malformed history entries', () => {
		const h = sanitizeHistory([null, { role: 'system', content: 'x' }, { role: 'user', content: 5 }, { role: 'user', content: ' ok ' }]);
		assert.deepEqual(h, [{ role: 'user', content: 'ok' }]);
		assert.equal(scrubSecrets('sk-aaaaaaaaaaaaaaaaaaaa'), '[…]');
	});
});

describe('SMARTA chat limits', () => {
	it('rate limits per user and IP with Retry-After', async () => {
		const { chat } = await start({ openai: makeOpenAi(), rateLimit: { limit: 3, windowMs: 60000 } });
		for (let i = 0; i < 3; i++) assert.equal((await chat({ message: 'ahoj' }, 'pro-r')).status, 200);
		const blocked = await chat({ message: 'ahoj' }, 'pro-r');
		assert.equal(blocked.status, 429);
		assert.equal(blocked.json.code, 'RATE_LIMITED');
		assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
		// another user is not affected
		assert.equal((await chat({ message: 'ahoj' }, 'pro-other')).status, 200);
	});

	it('stops calling OpenAI after the daily cap and answers locally', async () => {
		const openai = makeOpenAi();
		const { chat } = await start({ openai, dailyCap: 2 });
		assert.equal((await chat({ message: 'a' }, 'pro-cap')).json.source, 'openai');
		assert.equal((await chat({ message: 'b' }, 'pro-cap')).json.source, 'openai');
		const third = await chat({ message: 'ahoj' }, 'pro-cap');
		assert.equal(third.status, 200);
		assert.equal(third.json.source, 'local');
		assert.equal(third.json.limit, 'daily');
		assert.equal(openai.calls.length, 2);
		// the cap is per user
		assert.equal((await chat({ message: 'a' }, 'pro-cap2')).json.source, 'openai');
	});

	it('reads the daily cap from SMARTA_CHAT_DAILY_CAP', async () => {
		const openai = makeOpenAi();
		const { chat } = await start({ openai, env: { OPENAI_API_KEY: 'sk-test-key-1234567890', SMARTA_CHAT_DAILY_CAP: '1' } });
		assert.equal((await chat({ message: 'a' }, 'pro-env')).json.source, 'openai');
		assert.equal((await chat({ message: 'b' }, 'pro-env')).json.limit, 'daily');
	});
});

describe('SMARTA local intent matcher', () => {
	it('matches Slovak and English intents, ignoring diacritics', () => {
		assert.equal(matchLocalReply('Ako sa pripojím ku kamarátom?', 'sk').intent, 'join');
		assert.equal(matchLocalReply('kde nájdem knižnicu', 'sk').intent, 'library');
		assert.equal(matchLocalReply('how do I earn coins', 'en').intent, 'coins');
	});
	it('does not match short keywords inside other words', () => {
		assert.equal(matchLocalReply('chipmunk', 'en').intent, null);
	});
	it('falls back to a helpful reply with a tip', () => {
		const r = matchLocalReply('xyzzy', 'en');
		assert.equal(r.intent, null);
		assert.match(r.reply, /Tip:/);
	});
	it('uses Slovak for Czech and English for German', () => {
		assert.equal(matchLocalReply('ahoj', 'cs').intent, 'hello');
		assert.match(matchLocalReply('hello', 'de').reply, /Hi!/);
	});
});
