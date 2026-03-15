# Reward Validation System — Design Document

**Date:** 2026-03-14
**Status:** Draft — pending approval
**Approach:** Lightweight gates + Teacher authority (Approach 1 + 3 hybrid)
**Depends on:** Phase 4 session/progression system (already implemented)

---

## Design Principles

1. **Server-authoritative** — All reward logic runs on the server. The client never decides what to award.
2. **Game-driven thresholds** — The game's own `duration.min` and `playerCount.min` define minimum validation gates.
3. **Teacher trust** — The host (teacher) is a trusted actor. Gates protect against external exploits, not against deliberate teacher fraud.
4. **Idempotent** — Every reward operation is safe to retry. Double-awarding is structurally impossible.
5. **Audit trail** — Every reward event is recorded with enough metadata to reconstruct what happened.

---

## A. Reward Validation Rules

A session grants rewards **only when ALL of these conditions are true:**

### A1. State Machine Integrity

```
waiting → active → reflection → completed
```

The session must have passed through all states in order. The server records timestamps at each transition. Skipping a state (e.g., `waiting → completed`) is structurally impossible because each API endpoint checks the current state before allowing the transition.

| Transition | Endpoint | Guard |
|---|---|---|
| waiting → active | `POST /start` | `status = 'waiting'` |
| active → reflection | automatic (timer) or manual | `status = 'active'` |
| reflection → completed | `POST /complete` | `status IN ('active','reflection')` |

### A2. Minimum Duration Gate

The session must have been **active** for at least a minimum time derived from the game:

```
required_minutes = max(game.duration.min, 3)
actual_minutes   = (now - started_at) in minutes
```

**Rule:** `actual_minutes >= required_minutes`

If the game has no `duration.min`, the fallback is **5 minutes**.

The floor of 3 minutes prevents games with `duration.min: 1` from being trivially farmable. Three minutes is short enough for legitimate quick activities but long enough to prevent click-through exploits.

### A3. Minimum Participant Count

The session must have at least:

```
required_players = max(game.playerCount.min, 1)
actual_players   = COUNT(session_participants WHERE coins_paid > 0)
```

**Rule:** `actual_players >= required_players`

This uses `coins_paid > 0` (not just existence in the table) to count only players who were present at start time.

### A4. Reflection Requirement

Each individual player only receives rewards if they submitted a reflection:

```
session_participants.reflection_done = true
AND session_participants.awarded_competencies IS NULL
```

The `awarded_competencies IS NULL` guard prevents double-awarding.

### A5. Host Cooldown

A single host cannot complete more than **5 reward sessions per rolling hour**:

```sql
SELECT COUNT(*) FROM public.sessions
WHERE host_id = $1
  AND status = 'completed'
  AND completed_at > NOW() - INTERVAL '1 hour'
```

**Rule:** `count < 5`

This makes mass-farming sessions impractical without blocking legitimate classroom use (a teacher running 2-3 activities per hour is normal).

### A6. Solo Completion Gate

Solo completions (via `/api/profile/complete-solo`) follow a simpler path:

- Timer must have been running (verified client-side via `Timer.setOnComplete`)
- Reflection must be submitted (the callback only fires after form submission)
- **Cooldown:** max 10 solo completions per user per day (prevents grinding)

```sql
SELECT COUNT(*) FROM public.coin_transactions
WHERE user_id = $1
  AND action = 'solo_complete'
  AND created_at > NOW() - INTERVAL '24 hours'
```

---

## B. Competency Reward Calculation

### B1. Source: Game JSON

Every generated game contains an RVP mapping:

```json
{
  "rvp": {
    "kompetence": ["k-uceni", "komunikativni", "pracovni"],
    "stupen": "druhy",
    "oblast": ["jazyk"]
  }
}
```

The `kompetence` array lists which of the 7 RVP competencies the game develops. Typically 2-4 competencies per game.

### B2. Valid Competency Keys

Only these 7 keys are accepted (matching `public/data/rvp.json`):

| Key | Name |
|---|---|
| `k-uceni` | Kompetence k uceniu |
| `k-reseni-problemu` | Kompetence k rieseniu problemov |
| `komunikativni` | Komunikativna kompetence |
| `socialni-personalni` | Socialna a personalna kompetence |
| `obcanske` | Obcianska kompetence |
| `pracovni` | Pracovna kompetence |
| `digitalni` | Digitalna kompetence |

The server validates each key against this whitelist. Unknown keys are silently dropped.

### B3. Mapping: Game → Player

```
game.rvp.kompetence = ["k-uceni", "komunikativni"]
                           ↓
player.competency_points["k-uceni"]       += AWARD
player.competency_points["komunikativni"] += AWARD
```

Each competency listed in the game gives a flat reward to the player. The reward is the same regardless of which competency it is (no competency is "worth more" than another in V1).

---

## C. Reward Formula (V1)

### C1. Constants

```js
const COMPETENCY_AWARD  = 50;   // points per competency per session
const COMPLETION_BONUS  = 100;  // coins per player on session complete
const SESSION_JOIN_COST = 200;  // coins deducted per player on start
```

### C2. Formula per Player

```
competency_points_earned = game.rvp.kompetence.length * COMPETENCY_AWARD
coins_earned             = COMPLETION_BONUS
coins_spent              = SESSION_JOIN_COST (already deducted at start)
net_coins                = COMPLETION_BONUS - SESSION_JOIN_COST = -100
```

**Design intent:** Sessions are a **net coin drain** (-100 per session). Players spend coins to play but earn competency points. This creates two separate economies:
- **Coins** = consumable currency (earned via generation, challenges, daily rewards)
- **Competency points** = permanent progression (only earned via gameplay)

### C3. Example

A game with `kompetence: ["k-uceni", "komunikativni", "pracovni"]`:

```
Player receives:
  k-uceni:        +50 pts
  komunikativni:  +50 pts
  pracovni:       +50 pts
  coins:         +100 (completion bonus)
  coins:         -200 (already paid at join)
  ─────────────────────
  Net: +150 competency pts, -100 coins
```

### C4. Solo Formula

Solo completions use the same competency award but a smaller coin bonus:

```js
const SOLO_COMPLETION_BONUS = 100;  // same as session for V1
```

No join cost is deducted for solo play (the timer is free to use).

---

## D. Database Model Changes

### D1. Add `started_at` to sessions table

```sql
ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
```

Set when `POST /start` transitions the session to `active`. Used for duration validation.

### D2. Add `reward_validation` JSONB to sessions table

```sql
ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS reward_validation JSONB;
```

Populated at completion time with the validation result:

```json
{
  "duration_actual_min": 17.4,
  "duration_required_min": 15,
  "participants_actual": 8,
  "participants_required": 2,
  "host_sessions_last_hour": 1,
  "competencies_awarded": ["k-uceni", "komunikativni"],
  "passed": true,
  "validated_at": "2026-03-14T10:35:00Z"
}
```

This creates a permanent audit trail of why rewards were or were not granted.

### D3. Competency key whitelist (server constant)

No database table — stored as a server-side constant derived from `rvp.json`:

```js
const VALID_COMPETENCY_KEYS = [
  'k-uceni', 'k-reseni-problemu', 'komunikativni',
  'socialni-personalni', 'obcanske', 'pracovni', 'digitalni'
];
```

### D4. No schema changes to profiles or session_participants

The existing schema already supports:
- `profiles.competency_points` (JSONB) — stores accumulated points per key
- `session_participants.awarded_competencies` (JSONB) — idempotency guard
- `session_participants.reflection_done` (BOOLEAN) — reflection gate
- `coin_transactions` — audit trail for all coin movements

### D5. Migration SQL (012_reward_validation.sql)

```sql
-- Reward validation system support
ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reward_validation JSONB;

-- Index for host cooldown queries
CREATE INDEX IF NOT EXISTS idx_sessions_host_completed
  ON public.sessions (host_id, completed_at)
  WHERE status = 'completed';

-- Index for solo cooldown queries
CREATE INDEX IF NOT EXISTS idx_coin_tx_solo_cooldown
  ON public.coin_transactions (user_id, created_at)
  WHERE action = 'solo_complete';
```

---

## E. Backend Reward Flow

### E1. Session Completion Flow (updated `/api/sessions/:code/complete`)

```
Host calls POST /complete
    │
    ├─ 1. Auth check: is user the host?
    ├─ 2. Status check: is session in 'active' or 'reflection'?
    │
    ├─ 3. VALIDATION GATE (new)
    │     ├─ 3a. Duration: (now - started_at) >= max(game.duration.min, 3) min
    │     ├─ 3b. Participants: COUNT(coins_paid > 0) >= max(game.playerCount.min, 1)
    │     ├─ 3c. Host cooldown: completed sessions last hour < 5
    │     ├─ 3d. Log validation result to sessions.reward_validation
    │     │
    │     └─ IF ANY GATE FAILS → 422 with specific error code
    │        {
    │          "error": "Session trvala príliš krátko (3/15 minút)",
    │          "code": "DURATION_TOO_SHORT",
    │          "validation": { ... }
    │        }
    │
    ├─ 4. Filter eligible participants
    │     WHERE reflection_done = true
    │       AND awarded_competencies IS NULL
    │
    ├─ 5. For each eligible participant:
    │     ├─ Read current competency_points from profiles
    │     ├─ Merge: add COMPETENCY_AWARD per valid competency key
    │     ├─ Write updated competency_points to profiles
    │     ├─ Add COMPLETION_BONUS coins to profiles
    │     ├─ Record coin_transaction (action: 'session_complete')
    │     └─ Set awarded_competencies on session_participants (idempotency)
    │
    └─ 6. Mark session as completed (status, completed_at)
         Return { ok, participants_rewarded, validation }
```

### E2. Solo Completion Flow (updated `/api/profile/complete-solo`)

```
Player calls POST /complete-solo
    │
    ├─ 1. Auth check
    ├─ 2. Validate game_json.rvp.kompetence exists and is non-empty
    │
    ├─ 3. SOLO COOLDOWN CHECK (new)
    │     SELECT COUNT(*) FROM coin_transactions
    │     WHERE user_id = $1 AND action = 'solo_complete'
    │       AND created_at > NOW() - INTERVAL '24 hours'
    │     IF count >= 10 → 429 Too Many Requests
    │
    ├─ 4. Whitelist-filter competency keys
    │     kompetence.filter(k => VALID_COMPETENCY_KEYS.includes(k))
    │
    ├─ 5. Merge competency points + award coins (same as session flow)
    └─ 6. Return { ok, awarded, competency_points }
```

### E3. Where Logic Lives

| Component | Responsibility |
|---|---|
| **Server (server.js)** | ALL reward calculation, validation, and DB writes |
| **Client (script.js)** | Calls API, displays results, no reward logic |
| **Database** | Storage + idempotency guards (constraints, NOT NULL) |
| **NOT in DB functions** | Keeping logic in Node.js for debuggability and testability |

---

## F. Anti-Exploit Protection

### F1. Exploit Matrix

| Exploit | Protection | Gate |
|---|---|---|
| Start session → immediately complete | Duration gate: must be active for `game.duration.min` minutes | A2 |
| Host creates session alone, completes | Participant count gate: need `game.playerCount.min` players | A3 |
| Mass-farm sessions rapidly | Host cooldown: max 5/hour | A5 |
| Same user gets rewarded twice | `awarded_competencies IS NULL` idempotency guard | A4 |
| Inject fake competency keys | Server-side whitelist filter | B2 |
| Skip reflection, get rewards | `reflection_done = true` required | A4 |
| Solo grind: spam timer completions | Solo daily cap: max 10/day | A6 |
| Manipulate game_json to add more competencies | Server validates `kompetence` against whitelist, max length is naturally capped by `rvp.json` having only 7 keys | B2 |
| Create account just to farm | Coins are net-negative per session (-100). Competency points have no monetary value. | C2 |

### F2. What This System Does NOT Protect Against

- **Colluding teachers** — A teacher who deliberately creates fake sessions with fake students. Mitigation: not in scope for V1. Future: admin dashboard, anomaly detection.
- **Bot accounts** — Automated signups joining sessions. Mitigation: existing robot challenge on signup.
- **Reflection quality** — A player can submit "asdf" as reflection text. Mitigation: not in scope for V1. Future: minimum text length, keyword scoring.

### F3. Error Responses for Failed Validation

```
422 DURATION_TOO_SHORT    — "Session trvala príliš krátko ({actual}/{required} min)"
422 NOT_ENOUGH_PLAYERS    — "Nedostatok hráčov ({actual}/{required})"
429 HOST_COOLDOWN         — "Príliš veľa sessions za hodinu. Skús neskôr."
429 SOLO_DAILY_LIMIT      — "Dosiahnutý denný limit solo hier ({count}/{limit})"
```

---

## G. Future Expansion Path

### G1. Competency Levels (Phase 5)

Competency points accumulate per key. At thresholds, the competency "levels up":

```
Level 1:     0 –  249 pts   (Nováčik)
Level 2:   250 –  749 pts   (Skúsený)
Level 3:   750 – 1499 pts   (Expert)
Level 4:  1500 – 2999 pts   (Majster)
Level 5:  3000+  pts        (Legenda)
```

Display: colored badge + level number next to each competency bar.

No database change needed — levels are computed from `competency_points` values.

### G2. Total Player Level

A player's overall "level" can be computed as the average of all competency levels:

```
total_level = floor(average(all_competency_levels))
```

This is purely computed, never stored. If the player has 0 in all competencies, their level is 1. Displayed on the profile card.

### G3. Achievements (Phase 6+)

Triggered by milestones:
- "First Reflection" — complete your first reflection
- "Team Player" — participate in 10 sessions
- "Well-Rounded" — reach Level 2 in all 6 competencies
- "Century" — accumulate 100 competency points in any single key

Database: `achievements` table with `user_id`, `achievement_key`, `unlocked_at`.

### G4. Avatar Evolution

Tie avatar appearance to total competency level:
- Level 1: basic avatar
- Level 2: border glow
- Level 3: animated border
- Level 4: custom badge
- Level 5: legendary frame

### G5. Talent Trees (Phase 7+)

Each competency could have a skill tree with unlockable perks:
- `k-uceni` Level 3 → unlock "Speed Reader" perk (shorter timer for reading-heavy games)
- `komunikativni` Level 3 → unlock "Leader" badge in lobby

This requires a new `talent_unlocks` table and significant UI work. Not in V1 scope.

### G6. Adaptive Difficulty

Game generation can use the player's competency profile to adjust difficulty:
- Low competency → more scaffolding, simpler language
- High competency → more challenge, open-ended tasks

The player's `competency_points` are passed to the AI prompt as context.

---

## Summary

| Section | Core Decision |
|---|---|
| A. Validation | Time gate + player count + host cooldown + reflection |
| B. Calculation | Flat 50pts per competency listed in game.rvp.kompetence |
| C. Formula | Net -100 coins, +50pts per competency. Coins drain, skills accumulate. |
| D. Database | Add `started_at` + `reward_validation` to sessions. One migration. |
| E. Backend | All logic in server.js. Client is display-only. |
| F. Anti-exploit | 5 gates: duration, players, cooldown, reflection, idempotency |
| G. Future | Competency levels → achievements → talent trees → adaptive AI |
