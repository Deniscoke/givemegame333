'use strict';

/**
 * Route-level harness for the economy routes in server.js.
 *
 * Boots the real Express app with:
 *   - `pg` replaced by an in-memory fake that understands exactly the SQL the
 *     economy routes issue (unknown SQL throws, so a route change that adds a
 *     query fails loudly instead of silently passing);
 *   - Supabase auth answered locally (the bearer token is the user id);
 *   - OpenAI replaced by a scripted vision stub;
 *   - every other network call refused.
 *
 * Transactions are serialised with a mutex and rolled back from a snapshot,
 * which is enough to model the compare-and-swap / conditional UPDATE logic.
 */

const path = require('node:path');

const SERVER_PATH = path.join(__dirname, '..', '..', 'server.js');
const SUPABASE_URL = 'http://supabase.test.invalid';
const ENV_KEYS = ['VERCEL', 'NODE_ENV', 'OPENAI_API_KEY', 'SUPABASE_DB_URL', 'SUPABASE_URL',
	'SUPABASE_ANON_KEY', 'ALLOWED_ORIGINS'];

function norm(sql) {
	return String(sql).replace(/\s+/g, ' ').trim();
}

function clone(v) {
	return JSON.parse(JSON.stringify(v));
}

function createState() {
	return {
		profiles: {},          // id → { coins, rpg_xp, rpg_avatar_id }
		sessions: {},          // id → { id, host_id, game_json, join_code, status, started_at, completed_at, reward_validation, timer_ends_at }
		participants: [],      // { session_id, user_id, coins_paid, reflection_done, awarded_competencies, joined_at }
		tx: [],                // coin_transactions { user_id, amount, action, metadata, created_at }
		talents: [],           // { user_id, talent_id }
	};
}

function today() {
	const d = new Date();
	return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

class FakeDb {
	constructor() {
		this.state = createState();
		this.locked = null;      // client currently inside BEGIN
		this.waiters = [];
		this.log = [];
		this.openAiCalls = 0;
	}

	async acquire(owner) {
		while (this.locked && this.locked !== owner) {
			await new Promise((resolve) => this.waiters.push(resolve));
		}
		this.locked = owner;
	}

	release(owner) {
		if (this.locked !== owner) return;
		this.locked = null;
		const w = this.waiters.splice(0);
		w.forEach((fn) => fn());
	}

	ensureProfile(id) {
		if (!this.state.profiles[id]) this.state.profiles[id] = { coins: 0, rpg_xp: 0, rpg_avatar_id: null };
		return this.state.profiles[id];
	}

	insertTx(userId, amount, action, metadata) {
		const meta = typeof metadata === 'string' ? JSON.parse(metadata) : (metadata ?? null);
		this.state.tx.push({ user_id: userId, amount: Number(amount), action, metadata: meta, created_at: new Date() });
	}

	session(id) { return this.state.sessions[id]; }

	part(sessionId, userId) {
		return this.state.participants.find((p) => p.session_id === sessionId && p.user_id === userId);
	}

	/** Execute one statement. Returns { rows, rowCount }. */
	exec(rawSql, params = []) {
		const sql = norm(rawSql);
		this.log.push(sql);
		const s = this.state;
		const ok = (rows = [], rowCount = rows.length) => ({ rows, rowCount });
		let m;

		if (/^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT) \w+$/.test(sql)) return ok();

		// ── sessions ──
		if (/^SELECT [\w, ]+ FROM public\.sessions WHERE join_code = \$1$/.test(sql)) {
			const row = Object.values(s.sessions).find((x) => x.join_code === params[0]);
			return ok(row ? [clone(row)] : []);
		}
		if (sql.startsWith("UPDATE public.sessions SET status = 'active', timer_ends_at = $1, started_at = NOW() WHERE id = $2 AND host_id = $3 AND status = 'waiting' RETURNING id")) {
			const row = s.sessions[params[1]];
			if (!row || row.host_id !== params[2] || row.status !== 'waiting') return ok([]);
			Object.assign(row, { status: 'active', timer_ends_at: params[0], started_at: new Date().toISOString() });
			return ok([{ id: row.id }]);
		}
		if (sql === 'UPDATE public.sessions SET reward_validation = $1 WHERE id = $2') {
			const row = s.sessions[params[1]];
			if (row) row.reward_validation = JSON.parse(params[0]);
			return ok([], row ? 1 : 0);
		}
		if (sql === "UPDATE public.sessions SET status = 'completing' WHERE id = $1 AND status IN ('active', 'reflection')") {
			const row = s.sessions[params[0]];
			if (!row || !['active', 'reflection'].includes(row.status)) return ok([], 0);
			row.status = 'completing';
			return ok([], 1);
		}
		if (sql === "UPDATE public.sessions SET status = 'completed', completed_at = NOW(), reward_validation = $1 WHERE id = $2") {
			const row = s.sessions[params[1]];
			Object.assign(row, { status: 'completed', completed_at: new Date().toISOString(), reward_validation: JSON.parse(params[0]) });
			return ok([], 1);
		}
		if (sql === "UPDATE public.sessions SET status = 'active' WHERE id = $1 AND status = 'completing'") {
			const row = s.sessions[params[0]];
			if (row && row.status === 'completing') { row.status = 'active'; return ok([], 1); }
			return ok([], 0);
		}
		if (sql.startsWith("SELECT COUNT(*)::int AS cnt FROM public.sessions WHERE host_id = $1 AND status = 'completed'")) {
			const cnt = Object.values(s.sessions).filter((x) => x.host_id === params[0] && x.status === 'completed'
				&& Date.now() - new Date(x.completed_at).getTime() < 3600000).length;
			return ok([{ cnt }]);
		}

		// ── session_participants ──
		if (sql.startsWith('SELECT user_id FROM public.session_participants WHERE session_id = $1 AND coins_paid = 0')) {
			return ok(s.participants.filter((p) => p.session_id === params[0] && p.coins_paid === 0)
				.map((p) => ({ user_id: p.user_id })));
		}
		if (sql === 'UPDATE public.session_participants SET coins_paid = $1 WHERE session_id = $2 AND user_id = $3') {
			const p = this.part(params[1], params[2]);
			if (p) p.coins_paid = params[0];
			return ok([], p ? 1 : 0);
		}
		if (sql === 'SELECT COUNT(*)::int AS cnt FROM public.session_participants WHERE session_id = $1 AND coins_paid > 0') {
			return ok([{ cnt: s.participants.filter((p) => p.session_id === params[0] && p.coins_paid > 0).length }]);
		}
		if (sql.startsWith('SELECT user_id FROM public.session_participants WHERE session_id = $1 AND reflection_done = true AND awarded_competencies IS NULL')) {
			const requirePaid = sql.includes('AND coins_paid > 0');
			return ok(s.participants.filter((p) => p.session_id === params[0] && p.reflection_done
				&& p.awarded_competencies == null && (!requirePaid || p.coins_paid > 0)).map((p) => ({ user_id: p.user_id })));
		}
		if (sql === 'UPDATE public.session_participants SET awarded_competencies = $1 WHERE session_id = $2 AND user_id = $3') {
			const p = this.part(params[1], params[2]);
			if (p) p.awarded_competencies = JSON.parse(params[0]);
			return ok([], p ? 1 : 0);
		}

		// ── profiles ──
		if ((m = sql.match(/^SELECT COALESCE\(rpg_xp, ?0\)::int AS rpg_xp FROM public\.profiles WHERE id = \$1( FOR UPDATE)?$/))) {
			const p = s.profiles[params[0]];
			return ok(p ? [{ rpg_xp: p.rpg_xp }] : []);
		}
		if (/^SELECT COALESCE\(coins, ?0\)::int AS coins FROM public\.profiles WHERE id = \$1( FOR UPDATE)?$/.test(sql)) {
			const p = s.profiles[params[0]];
			return ok(p ? [{ coins: p.coins }] : []);
		}
		if (sql === 'SELECT COALESCE(coins, 0)::int AS coins, COALESCE(rpg_xp, 0)::int AS rpg_xp FROM public.profiles WHERE id = $1 FOR UPDATE') {
			const p = s.profiles[params[0]];
			return ok(p ? [{ coins: p.coins, rpg_xp: p.rpg_xp }] : []);
		}
		if (sql === 'UPDATE public.profiles SET coins = COALESCE(coins, 0) - $1 WHERE id = $2 AND COALESCE(coins, 0) >= $1 RETURNING coins') {
			const p = s.profiles[params[1]];
			if (!p || p.coins < params[0]) return ok([]);
			p.coins -= params[0];
			return ok([{ coins: p.coins }]);
		}
		if ((m = sql.match(/^UPDATE public\.profiles SET coins = (?:COALESCE\(coins, ?0\)|coins) \+ \$1 WHERE id = \$2( RETURNING coins)?$/))) {
			const p = s.profiles[params[1]];
			if (!p) return ok([], 0);
			p.coins += params[0];
			return m[1] ? ok([{ coins: p.coins }]) : ok([], 1);
		}
		if (sql === 'UPDATE public.profiles SET coins = coins - $1 WHERE id = $2') {
			const p = s.profiles[params[1]];
			p.coins -= params[0];
			return ok([], 1);
		}
		if (sql.startsWith('UPDATE public.profiles SET rpg_xp = LEAST(COALESCE(rpg_xp, 0) + $1, 999999) WHERE id = $2 RETURNING rpg_xp')) {
			const p = s.profiles[params[1]];
			if (!p) return ok([]);
			p.rpg_xp = Math.min(p.rpg_xp + params[0], 999999);
			return ok([{ rpg_xp: p.rpg_xp }]);
		}
		if (sql === 'INSERT INTO public.profiles (id, coins) VALUES ($1, $2)') {
			this.ensureProfile(params[0]).coins = params[1];
			return ok([], 1);
		}
		if (sql === 'INSERT INTO public.profiles (id) VALUES ($1) ON CONFLICT (id) DO NOTHING') {
			const existed = !!s.profiles[params[0]];
			this.ensureProfile(params[0]);
			return ok([], existed ? 0 : 1);
		}
		if (sql === 'SELECT rpg_avatar_id FROM public.profiles WHERE id = $1') {
			const p = s.profiles[params[0]];
			return ok(p ? [{ rpg_avatar_id: p.rpg_avatar_id }] : []);
		}
		if (sql === 'SELECT talent_id FROM public.rpg_user_talents WHERE user_id = $1') {
			return ok(s.talents.filter((t) => t.user_id === params[0]).map((t) => ({ talent_id: t.talent_id })));
		}

		// ── coin_transactions ──
		if ((m = sql.match(/^INSERT INTO public\.coin_transactions \(([^)]*)\) VALUES \(([^)]*)\)$/))) {
			const cols = m[1].split(',').map((c) => c.trim());
			const vals = m[2].split(',').map((v) => v.trim()).map((v) => {
				if (/^\$\d+$/.test(v)) return params[Number(v.slice(1)) - 1];
				if (/^'.*'$/.test(v)) return v.slice(1, -1);
				return Number(v);
			});
			const row = Object.fromEntries(cols.map((c, i) => [c, vals[i]]));
			this.insertTx(row.user_id, row.amount, row.action, row.metadata ?? null);
			return ok([], 1);
		}
		const since = today();
		const todays = (uid) => s.tx.filter((t) => t.user_id === uid && t.created_at >= since);
		if (sql.startsWith("SELECT COUNT(*)::int AS cnt FROM public.coin_transactions WHERE user_id = $1 AND action = 'photo_verify_attempt' AND created_at >= CURRENT_DATE")) {
			return ok([{ cnt: todays(params[0]).filter((t) => t.action === 'photo_verify_attempt').length }]);
		}
		if (sql.startsWith("SELECT COUNT(*)::int AS cnt FROM public.coin_transactions WHERE user_id = $1 AND action = 'photo_verify_bonus' AND created_at >= CURRENT_DATE")) {
			return ok([{ cnt: todays(params[0]).filter((t) => t.action === 'photo_verify_bonus').length }]);
		}
		if (sql.startsWith("SELECT COALESCE(SUM(amount), 0)::int AS used FROM public.coin_transactions WHERE user_id = $1 AND action LIKE 'giveme\\_%'")) {
			return ok([{ used: todays(params[0]).filter((t) => t.action.startsWith('giveme_') && t.amount > 0).reduce((a, t) => a + t.amount, 0) }]);
		}
		if (sql.startsWith('SELECT COALESCE(SUM(amount), 0)::int AS used FROM public.coin_transactions WHERE user_id = $1 AND action = $2 AND amount > 0')) {
			return ok([{ used: todays(params[0]).filter((t) => t.action === params[1] && t.amount > 0).reduce((a, t) => a + t.amount, 0) }]);
		}
		if (sql.startsWith("SELECT COALESCE(SUM(amount), 0)::int AS daily_total FROM public.coin_transactions WHERE user_id = $1 AND action = 'mode_click'")) {
			return ok([{ daily_total: todays(params[0]).filter((t) => t.action === 'mode_click').reduce((a, t) => a + t.amount, 0) }]);
		}
		if (sql.startsWith("SELECT COUNT(*)::int AS cnt FROM public.coin_transactions WHERE user_id = $1 AND action = 'solo_complete'")) {
			return ok([{ cnt: s.tx.filter((t) => t.user_id === params[0] && t.action === 'solo_complete'
				&& Date.now() - t.created_at.getTime() < 86400000).length }]);
		}
		if (sql.startsWith("SELECT COALESCE((SELECT SUM((metadata->>'boost_uses')::int)")) {
			const mine = s.tx.filter((t) => t.user_id === params[0]);
			const granted = mine.filter((t) => t.action === params[1] && t.metadata && 'boost_uses' in t.metadata)
				.reduce((a, t) => a + Number(t.metadata.boost_uses), 0);
			const used = mine.filter((t) => t.action === 'solo_complete' && Number(t.metadata?.xp_multiplier ?? 1) > 1).length;
			return ok([{ remaining: granted - used }]);
		}
		if (sql === 'SELECT 1 FROM public.coin_transactions WHERE user_id = $1 LIMIT 1') {
			return ok(s.tx.some((t) => t.user_id === params[0]) ? [{ '?column?': 1 }] : []);
		}

		// ── billing (free plan for every harness user) ──
		if (sql.startsWith('SELECT user_id, plan_code') && sql.includes('FROM public.user_billing WHERE user_id = $1')) return ok([]);
		if (sql === 'SELECT public.effective_tier($1) AS tier') return ok([{ tier: 'free' }]);

		throw new Error(`FakeDb: unhandled SQL: ${sql}`);
	}
}

function createPgModule(db) {
	let clientSeq = 0;
	class FakeClient {
		constructor() { this.id = ++clientSeq; this.snapshot = null; }
		async query(sql, params) {
			const s = norm(sql);
			if (s === 'BEGIN') {
				await db.acquire(this);
				this.snapshot = clone(db.state);
				return { rows: [], rowCount: 0 };
			}
			if (s === 'COMMIT') { this.snapshot = null; db.release(this); return { rows: [], rowCount: 0 }; }
			if (s === 'ROLLBACK') {
				if (this.snapshot) {
					// Dates do not survive JSON cloning; restore them.
					db.state = this.snapshot;
					db.state.tx.forEach((t) => { t.created_at = new Date(t.created_at); });
				}
				this.snapshot = null;
				db.release(this);
				return { rows: [], rowCount: 0 };
			}
			if (db.locked && db.locked !== this) await db.acquire(this).then(() => db.release(this));
			return db.exec(sql, params);
		}
		release() { if (db.locked === this) { db.release(this); } }
	}
	class Pool {
		constructor() { this.handlers = {}; }
		on() { return this; }
		async connect() { return new FakeClient(); }
		async query(sql, params) {
			if (db.locked) { await db.acquire('pool'); db.release('pool'); }
			return db.exec(sql, params);
		}
		async end() {}
	}
	return { Pool };
}

/**
 * @param {{ vision?: (call: number) => object }} [opts] — vision stub result per call
 */
async function startEconomyServer(opts = {}) {
	const envSnapshot = new Map(ENV_KEYS.map((k) => [k, { present: k in process.env, value: process.env[k] }]));
	Object.assign(process.env, {
		VERCEL: '1', NODE_ENV: 'test', OPENAI_API_KEY: 'sk-test-harness',
		SUPABASE_DB_URL: 'postgres://harness.invalid/db', SUPABASE_URL,
		SUPABASE_ANON_KEY: 'anon-test-key', ALLOWED_ORIGINS: '',
	});

	const db = new FakeDb();
	const pgPath = require.resolve('pg');
	require(pgPath);
	const pgOriginal = require.cache[pgPath].exports;
	require.cache[pgPath].exports = createPgModule(db);

	const openAiPath = require.resolve('openai');
	require(openAiPath);
	const openAiOriginal = require.cache[openAiPath].exports;
	const vision = opts.vision || (() => ({ verified: true, confidence: 90, feedback: 'ok' }));
	require.cache[openAiPath].exports = class StubOpenAI {
		constructor() {
			this.chat = {
				completions: {
					create: async () => {
						db.openAiCalls += 1;
						return { choices: [{ message: { content: JSON.stringify(vision(db.openAiCalls)) } }] };
					},
				},
			};
		}
	};

	const originalFetch = global.fetch;
	global.fetch = async (input, init) => {
		const url = String(input);
		if (url.startsWith(`${SUPABASE_URL}/auth/v1/user`)) {
			const auth = (init?.headers?.Authorization || '').replace(/^Bearer /, '');
			if (!auth.startsWith('user-')) return new Response('{}', { status: 401 });
			return new Response(JSON.stringify({ id: auth, email: `${auth}@test.invalid` }), {
				status: 200, headers: { 'content-type': 'application/json' },
			});
		}
		if (url.startsWith('http://127.0.0.1:')) return originalFetch(input, init);
		throw new Error(`External network disabled in economy harness: ${new URL(url).origin}`);
	};

	delete require.cache[SERVER_PATH];
	const app = require(SERVER_PATH);
	const server = await new Promise((resolve) => {
		const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
	});
	const baseUrl = `http://127.0.0.1:${server.address().port}`;

	async function call(method, urlPath, { user, body } = {}) {
		const headers = { 'content-type': 'application/json' };
		if (user) headers.Authorization = `Bearer ${user}`;
		const res = await fetch(`${baseUrl}${urlPath}`, {
			method, headers, body: body === undefined ? undefined : JSON.stringify(body),
		});
		let json = null;
		try { json = await res.json(); } catch { /* empty */ }
		return { status: res.status, body: json };
	}

	async function stop() {
		await new Promise((resolve) => server.close(resolve));
		global.fetch = originalFetch;
		require.cache[pgPath].exports = pgOriginal;
		require.cache[openAiPath].exports = openAiOriginal;
		delete require.cache[SERVER_PATH];
		for (const [k, snap] of envSnapshot) {
			if (snap.present) process.env[k] = snap.value; else delete process.env[k];
		}
	}

	return { db, call, stop, baseUrl };
}

module.exports = { startEconomyServer, FakeDb };
