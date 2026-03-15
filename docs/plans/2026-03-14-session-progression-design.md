# Session & Progression System — Design Document
**Date:** 2026-03-14
**Status:** Approved
**Scope:** Session lobby, realtime multiplayer, reflection flow, competency progression

---

## 1. Product Goal

Evolve gIVEMEGAME.IO from a solo teacher tool into a session-based platform where:
- A host creates a game session with a join code
- Players join on their own devices and pay 200 coins to participate
- After playing, each player fills a reflection form (RVP-based)
- On completion, all participants receive competency points matching the game's RVP mapping

---

## 2. Session Flow

```
Host generates game
    ↓
Host creates session → receives join_code (e.g. "WOLF42")
    ↓
Players join with account + join_code
    ↓
[WAITING] Host sees lobby list → presses Start
    ↓ 200 coins deducted from every participant
[ACTIVE] Timer runs — players read game on own device, can share a note
    ↓ Timer ends automatically
[REFLECTION] Every player fills 5-question form (from game.rvp.doporucene_hodnoceni)
    ↓ Host confirms completion
[COMPLETED] All participants with reflection_done = true receive competency points
```

---

## 3. DB Schema — Migration 011

### 3A. Competency points on profiles
```sql
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS competency_points JSONB NOT NULL DEFAULT '{}';
-- Example value: {"k-uceni": 120, "k-reseni-problemu": 85, "komunikativni": 40}
-- Keys match rvp.json kompetence keys exactly
```

**Why JSONB:** RVP competencies are a fixed set of 6. JSONB allows atomic per-key updates
via `jsonb_set()` without schema changes if sub-competencies are added later.

### 3B. Sessions table
```sql
CREATE TABLE public.sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  game_json     JSONB NOT NULL,
  join_code     TEXT NOT NULL UNIQUE,       -- 6-char code e.g. "WOLF42"
  status        TEXT NOT NULL DEFAULT 'waiting',
                  -- 'waiting' | 'active' | 'reflection' | 'completed'
  timer_ends_at TIMESTAMPTZ,               -- set on Start
  created_at    TIMESTAMPTZ DEFAULT now(),
  completed_at  TIMESTAMPTZ
);
```

### 3C. Session participants table
```sql
CREATE TABLE public.session_participants (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id           UUID NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  user_id              UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  coins_paid           INTEGER NOT NULL DEFAULT 0,
  reflection_data      JSONB,              -- {question_id: answer}
  reflection_done      BOOLEAN DEFAULT false,
  awarded_competencies JSONB,              -- snapshot of points awarded
  joined_at            TIMESTAMPTZ DEFAULT now(),
  UNIQUE(session_id, user_id)
);
```

---

## 4. API Endpoints (server.js)

| Method | Path | Who | Action |
|--------|------|-----|--------|
| POST | `/api/sessions` | Host | Create session, generate join_code, return it |
| GET | `/api/sessions/:code` | All | Get session state + participant list |
| POST | `/api/sessions/:code/join` | Player | Join session (check coins ≥ 200) |
| POST | `/api/sessions/:code/start` | Host | Set status=active, deduct 200 coins from all, set timer_ends_at |
| POST | `/api/sessions/:code/reflect` | Player | Save reflection_data, set reflection_done=true |
| POST | `/api/sessions/:code/complete` | Host | Set status=completed, award competency points to all reflection_done participants |

### Competency reward logic (in /complete)
```
game_json.rvp.kompetence → e.g. ["k-uceni", "komunikativni", "socialni-personalni"]
for each participant WHERE reflection_done = true:
  for each competency key in game.rvp.kompetence:
    profiles.competency_points[key] += COMPETENCY_AWARD_PER_KEY  (default: 50)
  awarded_competencies = snapshot of what was awarded
  INSERT coin_transactions (action='session_complete', amount=100)
```

`COMPETENCY_AWARD_PER_KEY = 50` is a named constant — easy to tune.

---

## 5. Realtime (Supabase)

Single channel per session. Vanilla JS subscription:

```js
supabaseClient
  .channel(`session:${code}`)
  .on('postgres_changes',
      { event: '*', schema: 'public', table: 'sessions', filter: `join_code=eq.${code}` },
      handleStatusChange)
  .on('postgres_changes',
      { event: '*', schema: 'public', table: 'session_participants', filter: `session_id=eq.${sessionId}` },
      handleParticipantChange)
  .subscribe()
```

Status changes drive screen transitions on every connected client:
- `waiting → active` → show game card + timer
- `active → reflection` → show reflection form (timer end triggers status update via server)
- `reflection → completed` → show competency reward animation

---

## 6. UI Changes

### New elements (no redesign of existing layout)
- Welcome screen: add `[🎮 Vytvoriť session]` button next to Generate
- Session modal (host): shows join_code, waiting lobby list, Start button
- Join screen (player): enter join_code field, shows coin cost warning if balance < 200
- Active view: read-only game card + timer + simple textarea (notes/share)
- Reflection form: 5 questions generated from `game.rvp.doporucene_hodnoceni`
- Completed screen: competency point bars with RPG-style award animation
- Profile panel: competency stats bars, colored by `rvp.json[key].barva`

### Competency colors
Colors come directly from `rvp.json` — each competency already has `"barva": "#hex"`.
No new color definitions needed.

---

## 7. Implementation Order

| Phase | What | Complexity |
|-------|------|------------|
| 1 | DB migration 011 (sessions + participants + competency_points) | Low |
| 2 | Reflection form UI (timer end → form → submit) | Medium |
| 3 | Solo completion API (awards points, no session needed) | Low |
| 4 | Profile competency display panel | Low |
| 5 | Session create/join API + waiting lobby UI | Medium |
| 6 | Realtime channel subscription + status-driven screen transitions | Medium |
| 7 | Multiplayer start (coin deduction) + completion flow | Medium |
| 8 | Sharing/notes during active phase | Low |

---

## 8. What Is NOT Built Yet (deliberate deferrals)
- Chat (social layer, adds moderation complexity, no core loop value yet)
- Talent tree (comes after competency points are established)
- Student-initiated sessions (only host can create for now)
- Session history / replay
- Public sessions (all sessions are code-gated)

---

## 9. Key Constants
```js
SESSION_JOIN_COST   = 200   // coins deducted per player on Start
COMPETENCY_AWARD    = 50    // points per competency key per completed session
COMPLETION_BONUS    = 100   // extra coins awarded on session completion
JOIN_CODE_LENGTH    = 6     // alphanumeric, uppercase
SESSION_CODE_CHARS  = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'  // no confusable chars
```
