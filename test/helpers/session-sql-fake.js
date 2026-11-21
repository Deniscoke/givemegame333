'use strict';

/**
 * FakeDb extension for the Phase 6 session routes (lib/routes/sessions.js).
 * Checked before the core handlers in economy-harness.js, so it also
 * overrides the session statements Phase 6 changed. Unknown SQL still falls
 * through to the core handlers and finally throws.
 *
 * Participants get a lazy `id` (older seeds have none); timestamps are ISO
 * strings; NOW() is the real clock.
 */

let seq = 0;
const nowIso = () => new Date().toISOString();
const ms = (v) => (v ? new Date(v).getTime() : NaN);
const OPEN = ['waiting', 'active', 'reflection'];

function partsOf(db, sessionId) {
	return db.state.participants.filter((p) => {
		if (!p.id) p.id = `sp-${++seq}`;
		return p.session_id === sessionId;
	});
}

function byId(db, id) {
	return db.state.participants.find((p) => p.id === id);
}

function pick(p, cols) {
	return Object.fromEntries(cols.map((c) => [c, p[c] === undefined ? null : p[c]]));
}

const PART_COLS = ['id', 'user_id', 'is_guest', 'nickname', 'coins_paid', 'reflection_done', 'left_at', 'awarded_competencies'];

/**
 * @param {import('./economy-harness').FakeDb} db
 * @param {string} sql normalised SQL
 * @param {unknown[]} params
 * @returns {{ rows: any[], rowCount: number } | null}
 */
function sessionSql(db, sql, params) {
	const s = db.state;
	s.events = s.events || [];
	const ok = (rows = [], rowCount = rows.length) => ({ rows, rowCount });

	// ── sessions ──
	if (sql.startsWith('INSERT INTO public.sessions (host_id, game_json, join_code, play_style, max_players, allow_guests, expires_at, last_host_seen_at)')) {
		const [hostId, gameJson, code, playStyle, maxPlayers, allowGuests, expiresAt] = params;
		const id = `sess-new-${++seq}`;
		s.sessions[id] = {
			id, host_id: hostId, game_json: JSON.parse(gameJson), join_code: code, status: 'waiting',
			play_style: playStyle, max_players: maxPlayers, allow_guests: allowGuests, expires_at: expiresAt,
			last_host_seen_at: nowIso(), created_at: nowIso(), started_at: null, completed_at: null,
			reward_validation: null, host_xp_awarded: 0,
		};
		const r = s.sessions[id];
		return ok([pick(r, ['id', 'join_code', 'status', 'created_at', 'play_style', 'max_players', 'allow_guests', 'expires_at'])]);
	}
	if (sql.startsWith("UPDATE public.sessions SET status = 'expired', expired_at = NOW(), expire_reason = $2 WHERE id = $1 AND status IN ('waiting', 'active', 'reflection') RETURNING id, join_code")) {
		const r = s.sessions[params[0]];
		if (!r || !OPEN.includes(r.status)) return ok([]);
		Object.assign(r, { status: 'expired', expired_at: nowIso(), expire_reason: params[1] });
		return ok([{ id: r.id, join_code: r.join_code }]);
	}
	if (sql.startsWith("UPDATE public.sessions SET status = 'reflection', reflection_ends_at = $2, expires_at = $3 WHERE id = $1 AND status = 'active' RETURNING")) {
		const r = s.sessions[params[0]];
		if (!r || r.status !== 'active') return ok([]);
		Object.assign(r, { status: 'reflection', reflection_ends_at: params[1], expires_at: params[2] });
		return ok([{ status: r.status, reflection_ends_at: r.reflection_ends_at, expires_at: r.expires_at }]);
	}
	if (sql.startsWith("SELECT id, status, expires_at, last_host_seen_at FROM public.sessions WHERE status IN ('waiting', 'active', 'reflection') AND (expires_at <= NOW() OR last_host_seen_at <= NOW() - make_interval(mins => $1))")) {
		const t = Date.now();
		return ok(Object.values(s.sessions).filter((r) => OPEN.includes(r.status)
			&& (ms(r.expires_at) <= t || t - ms(r.last_host_seen_at) >= params[0] * 60000))
			.map((r) => pick(r, ['id', 'status', 'expires_at', 'last_host_seen_at'])));
	}
	if (sql === 'UPDATE public.sessions SET last_host_seen_at = NOW() WHERE id = $1') {
		const r = s.sessions[params[0]];
		if (r) r.last_host_seen_at = nowIso();
		return ok([], r ? 1 : 0);
	}
	if (sql.startsWith("UPDATE public.sessions SET status = 'active', timer_ends_at = $1, started_at = NOW(), expires_at = $4 WHERE id = $2 AND host_id = $3 AND status = 'waiting' RETURNING id")) {
		const r = s.sessions[params[1]];
		if (!r || r.host_id !== params[2] || r.status !== 'waiting') return ok([]);
		Object.assign(r, { status: 'active', timer_ends_at: params[0], started_at: nowIso(), expires_at: params[3] });
		return ok([{ id: r.id }]);
	}
	if (sql === "UPDATE public.sessions SET status = 'completing' WHERE id = $1 AND status = $2") {
		const r = s.sessions[params[0]];
		if (!r || r.status !== params[1]) return ok([], 0);
		r.status = 'completing';
		return ok([], 1);
	}
	if (sql === "UPDATE public.sessions SET status = $2 WHERE id = $1 AND status = 'completing'") {
		const r = s.sessions[params[0]];
		if (!r || r.status !== 'completing') return ok([], 0);
		r.status = params[1];
		return ok([], 1);
	}
	if (sql === "UPDATE public.sessions SET status = 'completed', completed_at = NOW(), reward_validation = $1, host_xp_awarded = $3 WHERE id = $2") {
		const r = s.sessions[params[1]];
		Object.assign(r, { status: 'completed', completed_at: nowIso(), reward_validation: JSON.parse(params[0]), host_xp_awarded: params[2] });
		return ok([], 1);
	}
	if (sql.startsWith('SELECT COUNT(*)::int AS cnt FROM public.sessions WHERE host_id = $1 AND host_xp_awarded > 0 AND completed_at >= CURRENT_DATE')) {
		const since = new Date(); since.setUTCHours(0, 0, 0, 0);
		return ok([{ cnt: Object.values(s.sessions).filter((r) => r.host_id === params[0] && r.host_xp_awarded > 0
			&& ms(r.completed_at) >= since.getTime()).length }]);
	}

	// ── session_participants ──
	let m;
	if ((m = sql.match(/^SELECT id, user_id, is_guest, nickname, coins_paid, reflection_done, left_at, awarded_competencies FROM public\.session_participants WHERE session_id = \$1 AND (user_id|guest_token_hash) = \$2$/))) {
		const p = partsOf(db, params[0]).find((x) => x[m[1]] === params[1]);
		return ok(p ? [pick(p, PART_COLS)] : []);
	}
	if (sql.startsWith('SELECT sp.id, sp.user_id, sp.is_guest, sp.nickname, sp.coins_paid, sp.reflection_done, sp.joined_at, sp.left_at, sp.last_seen_at, p.display_name FROM public.session_participants sp LEFT JOIN public.profiles p')) {
		return ok(partsOf(db, params[0]).map((p) => ({
			...pick(p, ['id', 'user_id', 'is_guest', 'nickname', 'coins_paid', 'reflection_done', 'joined_at', 'left_at', 'last_seen_at']),
			display_name: (p.user_id && s.profiles[p.user_id]?.display_name) || null,
		})));
	}
	if (sql === 'SELECT COUNT(*)::int AS cnt FROM public.session_participants WHERE session_id = $1 AND left_at IS NULL') {
		return ok([{ cnt: partsOf(db, params[0]).filter((p) => !p.left_at).length }]);
	}
	if (sql.startsWith('INSERT INTO public.session_participants (session_id, user_id, last_seen_at) VALUES ($1, $2, NOW()) ON CONFLICT (session_id, user_id) DO NOTHING')) {
		if (partsOf(db, params[0]).some((p) => p.user_id === params[1])) return ok([], 0);
		s.participants.push({
			id: `sp-${++seq}`, session_id: params[0], user_id: params[1], is_guest: false, nickname: null,
			coins_paid: 0, reflection_done: false, awarded_competencies: null, joined_at: nowIso(), last_seen_at: nowIso(), left_at: null,
		});
		return ok([], 1);
	}
	if (sql.startsWith('INSERT INTO public.session_participants (session_id, is_guest, nickname, guest_token_hash, last_seen_at) VALUES ($1, true, $2, $3, NOW()) RETURNING id')) {
		const id = `sp-${++seq}`;
		s.participants.push({
			id, session_id: params[0], user_id: null, is_guest: true, nickname: params[1], guest_token_hash: params[2],
			coins_paid: 0, reflection_done: false, awarded_competencies: null, joined_at: nowIso(), last_seen_at: nowIso(), left_at: null,
		});
		return ok([{ id }]);
	}
	if (sql === 'UPDATE public.session_participants SET left_at = NULL, last_seen_at = NOW() WHERE id = $1') {
		const p = byId(db, params[0]);
		if (p) Object.assign(p, { left_at: null, last_seen_at: nowIso() });
		return ok([], p ? 1 : 0);
	}
	if (sql === 'UPDATE public.session_participants SET last_seen_at = NOW() WHERE id = $1') {
		const p = byId(db, params[0]);
		if (p) p.last_seen_at = nowIso();
		return ok([], p ? 1 : 0);
	}
	if (sql === 'UPDATE public.session_participants SET left_at = NOW() WHERE id = $1 AND left_at IS NULL') {
		const p = byId(db, params[0]);
		if (!p || p.left_at) return ok([], 0);
		p.left_at = nowIso();
		return ok([], 1);
	}
	if (sql === 'UPDATE public.session_participants SET refunded_at = NOW() WHERE id = $1') {
		const p = byId(db, params[0]);
		if (p) p.refunded_at = nowIso();
		return ok([], p ? 1 : 0);
	}
	if (sql.startsWith('SELECT id, user_id, coins_paid FROM public.session_participants WHERE session_id = $1 AND coins_paid > 0 AND refunded_at IS NULL AND awarded_competencies IS NULL')) {
		return ok(partsOf(db, params[0]).filter((p) => p.coins_paid > 0 && !p.refunded_at && p.awarded_competencies == null)
			.map((p) => pick(p, ['id', 'user_id', 'coins_paid'])));
	}
	if (sql.startsWith('UPDATE public.session_participants SET left_at = NOW() WHERE session_id = $1 AND left_at IS NULL AND coins_paid = 0 AND last_seen_at < NOW() - make_interval(secs => $2) RETURNING id')) {
		const t = Date.now();
		const stale = partsOf(db, params[0]).filter((p) => !p.left_at && p.coins_paid === 0
			&& p.last_seen_at && t - ms(p.last_seen_at) > params[1] * 1000);
		stale.forEach((p) => { p.left_at = nowIso(); });
		return ok(stale.map((p) => ({ id: p.id })));
	}
	if (sql.startsWith('SELECT user_id FROM public.session_participants WHERE session_id = $1 AND coins_paid = 0 AND left_at IS NULL AND is_guest = false')) {
		return ok(partsOf(db, params[0]).filter((p) => p.coins_paid === 0 && !p.left_at && !p.is_guest)
			.map((p) => ({ user_id: p.user_id })));
	}
	if (sql === 'UPDATE public.session_participants SET reflection_data = $1, reflection_done = true WHERE id = $2') {
		const p = byId(db, params[1]);
		if (p) Object.assign(p, { reflection_data: JSON.parse(params[0]), reflection_done: true });
		return ok([], p ? 1 : 0);
	}

	// ── profiles / ledger / events ──
	if (sql === 'SELECT coins FROM public.profiles WHERE id = $1') {
		const p = s.profiles[params[0]];
		return ok(p ? [{ coins: p.coins }] : []);
	}
	if (sql.startsWith("SELECT COUNT(*)::int AS cnt FROM public.coin_transactions WHERE user_id = $1 AND action = 'session_complete' AND created_at >= CURRENT_DATE")) {
		const since = new Date(); since.setUTCHours(0, 0, 0, 0);
		return ok([{ cnt: s.tx.filter((t) => t.user_id === params[0] && t.action === 'session_complete'
			&& new Date(t.created_at).getTime() >= since.getTime()).length }]);
	}
	if (sql.startsWith('INSERT INTO public.session_events (session_id, actor_id, actor_kind, event, detail)')) {
		s.events.push({ session_id: params[0], actor_id: params[1], actor_kind: params[2], event: params[3],
			detail: params[4] == null ? null : JSON.parse(params[4]) });
		return ok([], 1);
	}
	return null;
}

module.exports = { sessionSql };
