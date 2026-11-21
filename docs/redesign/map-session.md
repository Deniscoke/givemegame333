The headline is a critical regression: `POST /api/sessions/:code/complete` cannot succeed. It returns 500 every time, so no participant has been able to get session rewards since commit 0f6a6ca. This is a code bug, not a symptom of the paused database.

Files covered: `server.js` (2427-2870, constants 82-114, 434-440), `public/js/session.js`, `public/js/reflection.js`, `lib/reward-validation.js`, `lib/rpg-progression.js`, migrations 011, 012, 015, 033 and 035.

## 1. Lifecycle

| Step | Triggered by | What the server checks / does |
|---|---|---|
| **Create** `POST /api/sessions` (server.js:2427) | Host, via the hidden 🎮 button `Session.create(window.currentGame)` (index.html:314) | Logged-in user (2429) and `game_json.title` (2433). Nothing else in `game_json` is checked: it comes from the client and is stored as-is (2455). The join code is 6 characters from `Math.random` (434-440), with 10 retries on collision (2439). Row starts as `waiting`. |
| **Lobby** | Client only | Polling every 1.5 s for the first 4 ticks, then every 4 s (session.js:829-845), plus realtime (344-363). Share link is `/?lobby=CODE` (597-600). |
| **Join** `POST /:code/join` (2498) | Player, via "Pripojiť sa do hry" → `openJoinDialog` (index.html:87-88, session.js:284), or the deep link `restoreFromUrlOrStorage` (485) | Status must be `waiting` (2510). Balance must be at least `SESSION_JOIN_COST`=100 (2519). Insert uses `ON CONFLICT DO NOTHING` (2527). **No coins are taken at join.** No `playerCount.max` cap, no way to leave, and nothing stops the host joining their own session. |
| **Start** `POST /:code/start` (2538) | Host, `btn-lobby-start` (session.js:205) | Caller must be the host (2550) and status `waiting` (2553). Takes 100 from each participant with `coins_paid=0` (2561-2578). Sets `active`, `timer_ends_at` (= `game_json.duration.max`, default 15 min) and `started_at` (2557, 2580). |
| **Active** | Clients | Each client counts down `timer_ends_at` on its own, then opens reflection itself (session.js:430-443, 438-441). |
| **Reflection** `POST /:code/reflect` (2592) | Each player (reflection.js:221) | Only checks that status is `active` or `reflection` (2609). The server **never sets `reflection`** (no writer in server.js), so `reflection` is a client-only phase. Unknown callers, including the host, get 200 with no effect (2620-2623). |
| **Complete** `POST /:code/complete` (2631) | Host, `btn-lobby-complete` (session.js:245) | Host-only (2643). Three gates: duration ≥ max(`game_json.duration.min`, 3) (reward-validation.js:16-21); count of payers ≥ `game_json.playerCount.min` (47-49); fewer than 5 completions by this host in the last hour (2689-2707). Then a compare-and-swap to `completing` (2711), and a transaction that rewards everyone with `reflection_done AND awarded_competencies IS NULL` (2734-2773) before setting `completed` (2788). |
| **My reward** `GET /:code/my-reward` (2841) | Defined on the server | session.js never calls it. `_fetchAndShowMyReward` only reloads the HUD (session.js:880-886). |

## 2. XP and coin awards

| Event | Host | Participant |
|---|---|---|
| Join | none | 0 (balance checked only) |
| Start | none | −100 coins plus a `session_join` transaction row (2567-2577) |
| Reflect | none | none |
| Complete | **nothing.** The host is not in `session_participants`, so the loop skips them; `my_level_changes` is hardcoded `{}` (2816) | +100 coins `COMPLETION_BONUS` (2754) and +75 XP `SESSION_XP_AWARD` (2768). XP is capped at 999999 total (rpg-progression.js:186). |

- **Server-side only:** yes. Amounts are server constants (server.js:82-95).
- **Idempotent:**
  - Complete is, through the `awarded_competencies IS NULL` marker plus the CAS (2711, 2736).
  - Start is only partly: a loop of separate queries with no transaction and no status CAS (2565-2583).
- **Capped:** only by the host cooldown of 5 per hour (server.js:114). Participants have no daily cap on session XP or coins.

## 3. Bugs, ranked by severity

**CRITICAL**
1. **`/complete` always returns 500.** `requiredMin` and `requiredPlayers` are referenced at server.js:2779 and 2781 but declared nowhere in server.js.
   - They were local variables before commit 0f6a6ca moved validation into `lib/reward-validation.js`. They now exist only inside that module (reward-validation.js:18, 49).
   - Inside the transaction this throws a `ReferenceError` → ROLLBACK (2823) → status goes back to `active` → generic `COMPLETE_ERROR` 500 (2835).
   - Scenario: any session that passes all three gates. The host sees "Nepodarilo sa ukončiť session", nobody is rewarded, and every participant has already paid 100.
   - Fix: use `durResult.validation.duration_required_min` and `partResult.validation.participants_required`.

**HIGH**

2. **Coins can be printed because the deduction is clamped at zero.** The join check (2519) reads the balance at join time, but the charge happens later and is clamped by `GREATEST(0, …)` (2567). `coins_paid` is still set to the full 100 (2571).
   - Scenario: a user with 100 coins joins 5 waiting lobbies. All 5 hosts start, and the user pays 100 in total.
   - Each session then counts them as a payer (2671) and pays out +100 coins and +75 XP, so they gain about 400 coins.

3. **XP farming through `game_json`, which the client controls.** `playerCount.min`, `duration.min/max` and `rvp.kompetence` all come from the request body (2432, 2455).
   - Scenario: the host posts `playerCount.min:1, duration.min:0`, so the effective floor is 3 minutes. One alt account joins and pays 100. Three minutes later it gets 100 back plus 75 XP.
   - The alt can rotate across many hosts because participants have no cap.
   - Reflection is accepted at any moment while active (2609), so nobody has to play.

4. **A host who leaves locks everyone's coins.** `_quitSession` clears local storage and leaves the session `active` (session.js:686-697).
   - If the host later opens `?lobby=CODE`, `_restoreOrJoin` probes the session and calls `join` (544-546). The server returns 409 `ALREADY_STARTED` (2510) because only `waiting` is allowed.
   - The host is not a participant, so they have no way back, and only the host can complete (2643).
   - There is no expiry, cleanup job or refund anywhere. Each participant loses 100 coins.
   - The same happens if the host clears storage, switches device, or the 6 h `STORAGE_TTL_MS` passes (session.js:20).

5. **Absent players get charged.** There is no leave endpoint. A player who joined and closed the tab is still charged at start (2561). The number charged is returned (2585), but the player is never told.

**MEDIUM**

6. **Double start charges twice.** `/start` has no compare-and-swap on status. Two concurrent requests (the button is disabled on the client at session.js:212, but retries and other tabs still happen) both read `coins_paid=0` (2562) and both deduct.
7. **Join racing start gives free rewards.** A join that passes the `waiting` check (2510) and inserts after start has read the participant list (2561) ends up with `coins_paid=0`. The reward loop only requires `reflection_done` (2736), not `coins_paid>0`, so that player is rewarded without paying.
8. **Start is not atomic.** If a query fails mid-loop, some players are charged and the status stays `waiting` (2565-2583). The 500 response also leaks `detail: err.message` (2588), which session.js:222 shows to the user.
9. **Participants on phones may never see completion.** `_onActive` stops polling (session.js:396) and `_closeLobby` stops it too (825). From then on participants depend entirely on realtime for the `completed` event.
   - Realtime only works if migration 035 has been applied: it fixes the RLS self-join bug from 011 and adds the tables to the realtime publication.
   - Mobile websockets drop, so a phone player can sit on a finished game. The `completing` status has no label either (session.js:746-752).
10. **Reflection never opens after a refresh once the timer has run out.** `_onActive` only starts the timer when `secLeft > 0` (session.js:433). The server never sets `reflection`, so `_rehydrate` (584-585) shows the game with no timer, and the player can never submit and never earn.
11. **Any logged-in user can read any session by code.** `GET /api/sessions/:code` (2464) runs on the service pool, bypassing RLS, and returns `game_json`, participant display names and `reflection_done` state.
    - Codes are 6 characters from a 32-character set (about 1.07e9 combinations).
    - None of the `/api/sessions` routes has its own rate limiter (only `express.json()` at server.js:143). Whether the general rate limit from commit 0f6a6ca covers them was not verified.
12. **Create hangs when the database is down.** The join-code loop (2439-2445) runs outside `try`. Express 4 (package.json:30) does not catch a rejected promise there, so the request hangs until the client gives up after 12 s and shows "AbortError" (session.js:865).
    - With Supabase paused, `coinApiReady()` is still true because the pool exists (server.js:438), so all session routes fail with 500s or timeouts. That part is a database-down symptom; the missing `try` is a real bug.
13. **A failed audit insert breaks the whole completion.** `awardXpInTransaction` wraps the audit INSERT in `try/catch` inside the transaction (rpg-progression.js:198-211). If that INSERT fails, Postgres aborts the transaction, every later query fails, and the whole completion rolls back. The catch does not help.

**LOW**
14. The host gets no XP or coins, yet `complete()` checks `rpg_xp_gained` (session.js:276), which is always 0 for the host. The success toast says "{count} hráčov dostalo odmeny" (269), and every participant sees "RPG odmeny udelené" (465) even if they never reflected and got nothing.
15. The host's complete button is shown inside the lobby modal, which is already closed (session.js:817-820, 415). The host has to find the 📋 badge to reach it.
16. If the host has generated a different game since creating the session, `_onActive` keeps the host on that local game while players see `session.game_json` (session.js:404-411).
17. Opening a link on a second device fails for a player who already joined: there is no saved state on that device, so it calls join and gets 409 (session.js:529-546).
18. Dead code: `isParticipant` at session.js:573 is always true and unused.
19. `restoreFromUrlOrStorage` runs twice when a user signs in (script.js:180-181 and 189-190), which can mean two joins and two subscriptions.
20. A failed `/complete` rollback always resets status to `active`, even if it was `reflection` (2825).
21. There is no client-side size limit on reflection payloads; only the 100 kb default from `express.json()` applies.

**Challenge pill:** this is `btn-robot-challenge` (index.html:40-42). It is not part of the session system. It pays through `/api/coins/award` with action `robot_challenge`, limited per 24 h by plan, plus 30 XP outside the coin transaction and best-effort (server.js:1447-1478, 96).

## 4. What an "Online" mode needs

The current lobby is built for one room: the host projects the game, players reflect on their own devices, and the database carries all the state.

1. **Realtime**
   - Apply migration 035 everywhere.
   - Move the player list to a Supabase Realtime presence or broadcast channel per session, with server-signed events. Right now `session_participants` events only reach the row's own user (035 header), so the host's list relies on the 4 s poll.
   - Keep low-frequency polling running through every phase as a fallback for phones (fixes item 9).
   - Show online, offline and last-seen per player.
2. **Join by link or QR**
   - `?lobby=` already exists (session.js:597).
   - Add: a QR code in the lobby; anonymous or guest join with a nickname for students without accounts; and the deep link carried through login (login.html:476 partly does this).
   - Rate-limit and restrict `GET /:code` to members (item 11).
3. **Server-side state machine**
   - Add a server `reflection` transition, either on a timer or triggered by the host.
   - Use compare-and-swap on every transition (items 6 and 7).
   - Add a heartbeat, an inactivity timeout, automatic expiry of `waiting` and `active` sessions, and refunds on abandonment (item 4).
   - Allow host transfer or co-hosts, and let the host rejoin from the server-side `host_id` rather than local storage.
   - Add a participant leave endpoint before start (item 5).
4. **Per-player turns**
   - New tables for game state, turns and moves (e.g. `session_state`, `session_turns`).
   - A server-assigned current turn with a deadline, and skip or auto-advance for disconnected players.
   - Only the server advances turns; clients only submit moves.
   - Today `game_json` is a static AI-generated description, so no per-step structure exists to sequence.
5. **Async activities**
   - Per-player deadlines instead of the single `timer_ends_at`.
   - Allow submissions across hours or days for remote homework.
   - Payment and rewards per completed activity rather than per session, so not everyone has to be online at once.
6. **Crossplay and devices**
   - The UI already has a mobile-first lobby, focus trapping and a badge. It still needs:
     - wake-lock or resume handling;
     - reconnect on `visibilitychange`;
     - an explicit "you are viewing the host's projector" mode versus a "play on your own device" mode.
7. **Economy**
   - Validate `game_json` on the server, or reference a saved game ID, so clients cannot set the gate limits (item 3).
   - Charge with a conditional update (deduct only if the balance covers it) instead of clamping (item 2).
   - Add a per-participant daily cap on session rewards.
   - Decide on a host reward.