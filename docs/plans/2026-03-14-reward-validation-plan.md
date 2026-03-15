# Reward Validation System — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add anti-exploit validation gates to the session reward system — time gate, player count gate, host cooldown, solo daily cap, competency whitelist, and audit trail.

**Architecture:** All validation logic lives in `server.js`. Two existing endpoints are modified (`/complete` and `/complete-solo`), one endpoint is modified (`/start` to record `started_at`). One new SQL migration adds columns and indexes. No client-side changes are required — all gates are transparent to the frontend (it only sees success/error responses).

**Tech Stack:** Node.js/Express, PostgreSQL via `pg` Pool, Supabase auth (JWT verification via `requireSupabaseUser`)

**Design doc:** `docs/plans/reward-system.md`

---

## Task 1: Database Migration — Add `started_at` and `reward_validation` columns

**Files:**
- Create: `supabase/migrations/012_reward_validation.sql`

**Step 1: Create the migration file**

Write the SQL migration at `supabase/migrations/012_reward_validation.sql`:

```sql
-- ═══════════════════════════════════════════════════════════════════
-- gIVEMEGAME.IO — Reward Validation System
-- Migration 012
-- ═══════════════════════════════════════════════════════════════════

-- 1. Add started_at to sessions (set when /start transitions to 'active')
ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;

-- 2. Add reward_validation audit trail
ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS reward_validation JSONB;

-- 3. Index for host cooldown: "completed sessions in last hour by host"
CREATE INDEX IF NOT EXISTS idx_sessions_host_completed
  ON public.sessions (host_id, completed_at)
  WHERE status = 'completed';

-- 4. Index for solo cooldown: "solo completions in last 24h by user"
CREATE INDEX IF NOT EXISTS idx_coin_tx_solo_cooldown
  ON public.coin_transactions (user_id, created_at)
  WHERE action = 'solo_complete';
```

**Step 2: Run the migration in Supabase**

Open the Supabase Dashboard → SQL Editor → paste the content of `012_reward_validation.sql` → Run.

Expected: "Success. No rows returned" (DDL statements produce no rows).

Verify by checking the `sessions` table schema in Supabase → Table Editor → sessions → should now show `started_at` and `reward_validation` columns.

**Step 3: Commit**

```bash
git add supabase/migrations/012_reward_validation.sql
git commit -m "feat: migration 012 — started_at + reward_validation columns for anti-exploit"
```

---

## Task 2: Add server-side constants and validation helper

**Files:**
- Modify: `server.js` (lines 17–21, the constants block)

**Step 1: Add new constants after existing ones**

In `server.js`, find lines 17–21 (the existing constants block):

```js
const SESSION_JOIN_COST = 200;
const COMPETENCY_AWARD  = 50;
const COMPLETION_BONUS  = 100;
const JOIN_CODE_CHARS   = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const JOIN_CODE_LENGTH  = 6;
```

Add immediately after line 21 (`const JOIN_CODE_LENGTH = 6;`):

```js
// ─── Reward validation constants ───
const VALID_COMPETENCY_KEYS = [
	'k-uceni', 'k-reseni-problemu', 'komunikativni',
	'socialni-personalni', 'obcanske', 'pracovni', 'digitalni'
];
const MIN_SESSION_DURATION_FLOOR = 3;    // minutes — absolute minimum even if game.duration.min is lower
const MIN_SESSION_DURATION_FALLBACK = 5; // minutes — used when game has no duration.min
const HOST_COOLDOWN_MAX  = 5;            // max completed sessions per host per rolling hour
const SOLO_DAILY_LIMIT   = 10;           // max solo completions per user per 24h
```

**Step 2: Commit**

```bash
git add server.js
git commit -m "feat: add reward validation constants — whitelist, cooldowns, duration floor"
```

---

## Task 3: Record `started_at` in `/start` endpoint

**Files:**
- Modify: `server.js` (the `POST /api/sessions/:code/start` handler, around line 1121)

**Step 1: Update the session status UPDATE query**

Find this line in the `/start` endpoint (around line 1121–1123):

```js
await queryCoinsDb(
    `UPDATE public.sessions SET status = 'active', timer_ends_at = $1 WHERE id = $2`,
    [timerEndsAt, sess.id]
);
```

Replace it with:

```js
await queryCoinsDb(
    `UPDATE public.sessions SET status = 'active', timer_ends_at = $1, started_at = NOW() WHERE id = $2`,
    [timerEndsAt, sess.id]
);
```

The only change is adding `, started_at = NOW()` to the SET clause.

**Step 2: Verify**

Restart the server. Create a test session, start it. Check in Supabase Table Editor that the `started_at` column is populated with a timestamp matching the current time.

**Step 3: Commit**

```bash
git add server.js
git commit -m "feat: record started_at timestamp when session transitions to active"
```

---

## Task 4: Add validation gates to `/complete` endpoint

**Files:**
- Modify: `server.js` (the `POST /api/sessions/:code/complete` handler, lines 1167–1236)

This is the largest task. The existing endpoint is restructured to add 3 validation gates between the auth/status checks and the reward loop.

**Step 1: Update the SELECT query to include `started_at`**

Find (around line 1174–1175):

```js
const { rows } = await queryCoinsDb(
    'SELECT id, host_id, game_json, status FROM public.sessions WHERE join_code = $1', [code]
);
```

Replace with:

```js
const { rows } = await queryCoinsDb(
    'SELECT id, host_id, game_json, status, started_at FROM public.sessions WHERE join_code = $1', [code]
);
```

**Step 2: Add validation gates after the `ALREADY_COMPLETED` check**

Find the block (around lines 1182–1185):

```js
if (sess.status === 'completed') {
    return res.status(409).json({ error: 'Session je už dokončená', code: 'ALREADY_COMPLETED' });
}

const kompetence = sess.game_json?.rvp?.kompetence || [];
```

Replace with this entire block (everything between the status check and the reward loop):

```js
if (sess.status === 'completed') {
    return res.status(409).json({ error: 'Session je už dokončená', code: 'ALREADY_COMPLETED' });
}

// ─── VALIDATION GATE 1: Duration ───────────────────────────────
const gameDurMin = sess.game_json?.duration?.min;
const requiredMin = Math.max(
    gameDurMin != null ? gameDurMin : MIN_SESSION_DURATION_FALLBACK,
    MIN_SESSION_DURATION_FLOOR
);
const startedAt = sess.started_at ? new Date(sess.started_at) : null;
const actualMin = startedAt ? (Date.now() - startedAt.getTime()) / 60000 : 0;

if (actualMin < requiredMin) {
    const validation = {
        duration_actual_min: Math.round(actualMin * 10) / 10,
        duration_required_min: requiredMin,
        passed: false,
        failed_gate: 'DURATION_TOO_SHORT',
        validated_at: new Date().toISOString()
    };
    await queryCoinsDb(
        'UPDATE public.sessions SET reward_validation = $1 WHERE id = $2',
        [JSON.stringify(validation), sess.id]
    );
    return res.status(422).json({
        error: `Session trvala príliš krátko (${Math.round(actualMin)}/${requiredMin} min)`,
        code: 'DURATION_TOO_SHORT',
        validation
    });
}

// ─── VALIDATION GATE 2: Participant count ──────────────────────
const gamePlayerMin = sess.game_json?.playerCount?.min || 1;
const requiredPlayers = Math.max(gamePlayerMin, 1);
const { rows: paidParts } = await queryCoinsDb(
    'SELECT COUNT(*)::int AS cnt FROM public.session_participants WHERE session_id = $1 AND coins_paid > 0',
    [sess.id]
);
const actualPlayers = paidParts[0]?.cnt || 0;

if (actualPlayers < requiredPlayers) {
    const validation = {
        participants_actual: actualPlayers,
        participants_required: requiredPlayers,
        passed: false,
        failed_gate: 'NOT_ENOUGH_PLAYERS',
        validated_at: new Date().toISOString()
    };
    await queryCoinsDb(
        'UPDATE public.sessions SET reward_validation = $1 WHERE id = $2',
        [JSON.stringify(validation), sess.id]
    );
    return res.status(422).json({
        error: `Nedostatok hráčov (${actualPlayers}/${requiredPlayers})`,
        code: 'NOT_ENOUGH_PLAYERS',
        validation
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

if (hostSessionsLastHour >= HOST_COOLDOWN_MAX) {
    return res.status(429).json({
        error: `Príliš veľa sessions za hodinu (${hostSessionsLastHour}/${HOST_COOLDOWN_MAX}). Skús neskôr.`,
        code: 'HOST_COOLDOWN'
    });
}

// ─── Filter and whitelist competency keys ──────────────────────
const rawKompetence = sess.game_json?.rvp?.kompetence || [];
const kompetence = rawKompetence.filter(k => VALID_COMPETENCY_KEYS.includes(k));
const awarded = {};
kompetence.forEach(k => { awarded[k] = COMPETENCY_AWARD; });
```

**Step 3: Add the audit trail AFTER the reward loop**

Find the line that marks the session as completed (around the old line 1226–1228):

```js
await queryCoinsDb(
    `UPDATE public.sessions SET status = 'completed', completed_at = now() WHERE id = $1`,
    [sess.id]
);
```

Replace with:

```js
// Write audit trail + mark completed
const validation = {
    duration_actual_min: Math.round(actualMin * 10) / 10,
    duration_required_min: requiredMin,
    participants_actual: actualPlayers,
    participants_required: requiredPlayers,
    host_sessions_last_hour: hostSessionsLastHour,
    competencies_awarded: kompetence,
    participants_rewarded: parts.length,
    passed: true,
    validated_at: new Date().toISOString()
};
await queryCoinsDb(
    `UPDATE public.sessions SET status = 'completed', completed_at = NOW(), reward_validation = $1 WHERE id = $2`,
    [JSON.stringify(validation), sess.id]
);
```

**Step 4: Update the return value to include validation**

Find the return line (old line ~1231):

```js
res.json({ ok: true, awarded, participants_rewarded: parts.length });
```

Replace with:

```js
res.json({ ok: true, awarded, participants_rewarded: parts.length, validation });
```

**Step 5: Commit**

```bash
git add server.js
git commit -m "feat: add 3 validation gates to /complete — duration, players, host cooldown"
```

---

## Task 5: Add solo daily limit to `/complete-solo` endpoint

**Files:**
- Modify: `server.js` (the `POST /api/profile/complete-solo` handler, lines 898–947)

**Step 1: Add cooldown check after the `kompetence` validation**

Find (around lines 906–908):

```js
if (!Array.isArray(kompetence) || kompetence.length === 0) {
    return res.status(400).json({ error: 'game_json.rvp.kompetence je povinné', code: 'MISSING_COMPETENCIES' });
}
```

Add immediately AFTER this block (before the `try {`):

```js
// ─── Solo cooldown: max SOLO_DAILY_LIMIT per 24h ──────────────
try {
    const { rows: soloRows } = await queryCoinsDb(
        `SELECT COUNT(*)::int AS cnt FROM public.coin_transactions
         WHERE user_id = $1 AND action = 'solo_complete'
           AND created_at > NOW() - INTERVAL '24 hours'`,
        [user.id]
    );
    if ((soloRows[0]?.cnt || 0) >= SOLO_DAILY_LIMIT) {
        return res.status(429).json({
            error: `Denný limit solo hier dosiahnutý (${soloRows[0].cnt}/${SOLO_DAILY_LIMIT})`,
            code: 'SOLO_DAILY_LIMIT'
        });
    }
} catch (e) {
    console.error('[Completion] solo cooldown check failed:', e.message);
    // Non-blocking: if cooldown check fails, allow the completion to proceed
}
```

**Step 2: Add competency whitelist filter**

Find (around lines 920–923, inside the `try` block):

```js
kompetence.forEach(k => {
    updated[k] = (parseInt(updated[k], 10) || 0) + COMPETENCY_AWARD;
    awarded[k] = COMPETENCY_AWARD;
});
```

Replace with:

```js
const validKomps = kompetence.filter(k => VALID_COMPETENCY_KEYS.includes(k));
validKomps.forEach(k => {
    updated[k] = (parseInt(updated[k], 10) || 0) + COMPETENCY_AWARD;
    awarded[k] = COMPETENCY_AWARD;
});
```

**Step 3: Commit**

```bash
git add server.js
git commit -m "feat: add solo daily limit (10/day) + competency whitelist filter"
```

---

## Task 6: Add i18n keys for validation error messages

**Files:**
- Modify: `public/data/i18n/sk.json`
- Modify: `public/data/i18n/cs.json`
- Modify: `public/data/i18n/en.json`
- Modify: `public/data/i18n/es.json`

**Step 1: Add 4 new keys to each locale file**

Append these keys before the closing `}` in each file.

**sk.json** — add after the last existing key:
```json
  "err_duration_short":    "Session trvala príliš krátko ({actual}/{required} min)",
  "err_not_enough_players":"Nedostatok hráčov ({actual}/{required})",
  "err_host_cooldown":     "Príliš veľa sessions za hodinu. Skús neskôr.",
  "err_solo_daily_limit":  "Denný limit solo hier dosiahnutý ({count}/{limit})"
```

**cs.json:**
```json
  "err_duration_short":    "Session trvala příliš krátce ({actual}/{required} min)",
  "err_not_enough_players":"Nedostatek hráčů ({actual}/{required})",
  "err_host_cooldown":     "Příliš mnoho sessions za hodinu. Zkus později.",
  "err_solo_daily_limit":  "Denní limit sólo her dosažen ({count}/{limit})"
```

**en.json:**
```json
  "err_duration_short":    "Session was too short ({actual}/{required} min)",
  "err_not_enough_players":"Not enough players ({actual}/{required})",
  "err_host_cooldown":     "Too many sessions per hour. Try again later.",
  "err_solo_daily_limit":  "Daily solo limit reached ({count}/{limit})"
```

**es.json:**
```json
  "err_duration_short":    "Sesión demasiado corta ({actual}/{required} min)",
  "err_not_enough_players":"Jugadores insuficientes ({actual}/{required})",
  "err_host_cooldown":     "Demasiadas sesiones por hora. Intenta más tarde.",
  "err_solo_daily_limit":  "Límite diario de solo alcanzado ({count}/{limit})"
```

**Step 2: Commit**

```bash
git add public/data/i18n/sk.json public/data/i18n/cs.json public/data/i18n/en.json public/data/i18n/es.json
git commit -m "feat: add i18n keys for reward validation error messages (4 languages)"
```

---

## Task 7: Handle validation errors in client

**Files:**
- Modify: `public/js/session.js` (the `complete()` function, around line 103–121)

The server now returns `422` and `429` status codes for validation failures. The client already handles `!res.ok` with `GameUI.toast(❌ ${data.error})`, which will display the Slovak server error message. However, to use the i18n keys we just added, we should map the error codes.

**Step 1: Update the error handling in `complete()`**

Find the `complete()` function's error handling (around line 110–113):

```js
const data = await res.json();
if (!res.ok) { GameUI.toast(`❌ ${data.error}`); return; }
```

Replace with:

```js
const data = await res.json();
if (!res.ok) {
    let msg = data.error;
    const v = data.validation;
    if (data.code === 'DURATION_TOO_SHORT' && v) {
        msg = _t('err_duration_short', msg).replace('{actual}', Math.round(v.duration_actual_min)).replace('{required}', v.duration_required_min);
    } else if (data.code === 'NOT_ENOUGH_PLAYERS' && v) {
        msg = _t('err_not_enough_players', msg).replace('{actual}', v.participants_actual).replace('{required}', v.participants_required);
    } else if (data.code === 'HOST_COOLDOWN') {
        msg = _t('err_host_cooldown', msg);
    }
    GameUI.toast(`❌ ${msg}`);
    return;
}
```

**Step 2: Handle solo daily limit error in `script.js`**

Find the solo completion error handler in `public/script.js` (around lines 212–213):

```js
const data = await res.json();
if (!res.ok) throw new Error(data.error || 'Chyba servera');
```

Replace with:

```js
const data = await res.json();
if (!res.ok) {
    if (data.code === 'SOLO_DAILY_LIMIT') {
        throw new Error(t('err_solo_daily_limit', data.error || 'Denný limit').replace('{count}', '').replace('{limit}', ''));
    }
    throw new Error(data.error || 'Chyba servera');
}
```

**Step 3: Commit**

```bash
git add public/js/session.js public/script.js
git commit -m "feat: map validation error codes to i18n messages in client"
```

---

## Task 8: Manual Integration Test

This task has no code changes — it is a verification checklist.

**Step 1: Restart the server**

```bash
node server.js
```

**Step 2: Test duration gate**

1. Generate a game (any mode — note the `duration.min` value)
2. Create a session → join as a second account → Start
3. Wait only 30 seconds → try to Complete
4. Expected: `422 DURATION_TOO_SHORT` toast with actual/required minutes
5. Check Supabase `sessions` table → `reward_validation` should contain `{ "passed": false, "failed_gate": "DURATION_TOO_SHORT", ... }`

**Step 3: Test participant count gate**

1. Generate a game with `playerCount.min: 2`
2. Create a session (only host, no other players join) → Start
3. Wait for the duration to pass → try to Complete
4. Expected: `422 NOT_ENOUGH_PLAYERS` toast

**Step 4: Test successful completion**

1. Generate a game → create session → have enough players join → Start
2. Wait for the minimum duration to pass
3. Each player submits reflection
4. Host clicks Complete
5. Expected: `200 OK`, competency points awarded, `reward_validation` shows `{ "passed": true, ... }`

**Step 5: Test solo daily limit**

1. Complete 10 solo games (timer → reflection → submit) in quick succession
2. On the 11th attempt, Expected: `429 SOLO_DAILY_LIMIT` toast

**Step 6: Test host cooldown**

1. Complete 5 sessions rapidly as the same host (may need to adjust `MIN_SESSION_DURATION_FLOOR` to `0` temporarily for testing)
2. On the 6th attempt, Expected: `429 HOST_COOLDOWN` toast

**Step 7: Final commit**

If any fixes were needed during testing, commit them:

```bash
git add -A
git commit -m "fix: reward validation integration test fixes"
```

---

## Summary

| Task | What | Lines Changed | Difficulty |
|------|------|---------------|------------|
| 1 | DB migration (started_at, reward_validation) | ~15 SQL | Easy |
| 2 | Server constants (whitelist, limits) | ~8 JS | Easy |
| 3 | Record started_at in /start | ~1 line change | Easy |
| 4 | Validation gates in /complete | ~80 JS (restructure) | Medium |
| 5 | Solo daily limit + whitelist | ~20 JS | Easy |
| 6 | i18n error keys (4 languages) | ~16 JSON | Easy |
| 7 | Client error mapping | ~20 JS | Easy |
| 8 | Manual integration test | 0 code | Verification |

**Total estimated: ~160 lines of new/changed code across 8 tasks.**
