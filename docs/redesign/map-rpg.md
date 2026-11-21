# RPG progression, rewards and gamification: read-only audit

Repo root: `C:\Users\Admin\Desktop\gIVEMEGAME.IO-OPENCLAW\.worktrees\hardening`. All paths below are relative to it.

**Headline findings:**
- **Session rewards never pay out.** `/api/sessions/:code/complete` crashes on every call that passes the validation gates, because it uses two variables that are never declared (`server.js:2779` and `:2781`). The transaction rolls back and the host gets a 500.
- **Coins, and through them XP and avatars, can be set from the browser.** The browser is allowed to write `profiles.coins` and `rpg_avatar_id` directly (`030_billing_security.sql:115-118`, kept on purpose per `033_security_lockdown.sql:24-27`). `public/js/coins.js` keeps whichever balance is higher, localStorage or server (`:52`), and writes it back (`:72-77`).
- **Several XP sources can be farmed.** Photo verification has no limit. The XP multiplier comes from the client and is never checked. The solo game data comes from the client and is never checked.
- **Playing never changes attributes.** Attributes are the class's base values plus talents bought with coins. "Trains" / "+XP ✓" on the game card is cosmetic only.
- **Reflection is collected but not rewarded.** Solo reflection never reaches the server.
- **The RPG profile panel shows two states that are really load errors.** "Nie si členom školy" and the permanent stats "Načítavam…" appear when the request fails, not because of the user's actual membership or loading.

---

## 1. Data model

**Avatar classes**
- 7 classes, ids 2–8: Scholar, Builder, Healer, Shadow, Alchemist, Sage, Knight (`lib/rpg-avatars.js:22-72`).
- Stored in `profiles.rpg_avatar_id`, constrained to 2–8 (`supabase/migrations/022_rpg_avatar.sql:7-9`).
- Picking or switching costs 5000 coins (`lib/rpg-avatars.js:20`, `server.js:3292-3312`). Deselecting is free (`server.js:3267`).
- Eligible roles are admin, teacher and student (`rpg-avatars.js:106`). But `GET` and `PATCH /api/rpg/avatar` let any logged-in user pick (`server.js:3210`, `:3239`).
- **Bypass:** the browser can update `rpg_avatar_id` directly (`030_billing_security.sql:115-118`), skipping the 5000-coin charge.

**Attributes ("stats")**
- 6 stats: insight, focus, creativity, resilience, communication, strategy. Each class has base values on a 1–20 scale totalling 40 (`lib/rpg-progression.js:153-161`).
- Effective stat = base + talent bonus. Talent bonus is +3 / +5 / +10 for tier 1 / 2 / 3 (`:182`, `:272-280`).
- Talent competency to stat mapping: `rpg-progression.js:168-178`.
- No attribute is stored in the DB; they are always computed.

**XP and levels**
- `profiles.rpg_xp` is an int from 0 to 999999 (`024_rpg_progression.sql:7-9`).
- 10 levels at 0 / 500 / 1200 / 2500 / 5000 / 9000 / 15000 / 24000 / 37000 / 55000 XP (`rpg-progression.js:139`). Level is computed, never stored (`:219-235`).
- Free tier is capped at level 5 (`lib/billing.js:90`, `server.js:72-80`). The cap is applied in talents and perks (`server.js:3372`, `:3543`, `:3611`). It is **not** applied in `/api/profile/competencies` (`:2360`), the teacher student view (`:3775`), or the generation prompt (`:1105`), so the level shown differs by screen.

**XP award helper**
- `awardXpInTransaction` (`rpg-progression.js:296-328`) adds the XP clamped to 999999. It writes a best-effort `coin_transactions` audit row with amount 0 and action `rpg_xp_award`.

**Talents**
- 42 talents: 7 classes × 2 branches × 3 tiers (`lib/rpg-talents.js:25-151`).
- Id = class×100 + branch×10 + tier. Costs are 300 / 600 / 1000 coins by tier, so a full class tree costs 5,700 coins per branch and 11,400 for both.
- A tier above 1 requires the previous tier (`:192-202`). The talent must belong to the user's current class (`server.js:3434`).
- **Unlocking requires school membership** with an eligible role (`server.js:3405-3408`, returns 403 "Musíš byť členom školy."; membership lookup at `:3191-3203`).
- Each unlock gives +25 XP (`server.js:94`, `:3488`).
- Unlocks are stored in `rpg_user_talents` (`023_rpg_talents.sql:30-35`).
- **None of the described effects are implemented.** Examples: "+5 % XP" (201), "+50 coinov za každé denné prihlásenie" (403), "Premení 500 XP → 250 coinov" (603). Nothing reads unlocked talents apart from the stat bonuses. "+10 bodov K učeniu" refers to competency points, which were removed (`server.js:2267`).

**Perks (real-world classroom rewards)**
- 9 perks, one per level 2–10, with cooldowns from 48 to 720 hours (`025_level_perks.sql:139-148`).
- When claimed (`server.js:3591-3671`): a user with a student membership gets `pending` and needs teacher approval. Everyone else, including teachers and non-members, gets `auto_approved` (`:3648-3650`).
- The cooldown/pending check and the insert are not atomic (`:3620-3658`), so two fast clicks could both succeed.
- Direct client inserts into `rpg_perk_uses` were removed in `033_security_lockdown.sql:203-207`.

**Coins**
- Stored in `profiles.coins`, which the client can write (see headline). New users get 500 starter coins from localStorage (`coins.js:33-42`).

## 2. Every way a user earns XP, coins or attributes

| Source | Route | XP | Coins | Limits / validation |
|---|---|---|---|---|
| Solo completion (after timer + reflection on the client) | `POST /api/profile/complete-solo` `server.js:2232` | 30–120 based on `duration.max` (`rpg-progression.js:210-217`), +15% per extra competency, capped at 150 (`server.js:2295-2297`), × `xp_multiplier` 1–5 (`:2298`) → **max 750** | +100 (`:84`, `:2281-2284`) | 5 per 24h free, 25 Pro (`lib/plan-entitlements.js:24`, `:34`). **`game_json` comes from the client** (`:2237`) and there is no proof the game was generated, the timer ran, or a reflection was written. **`xp_multiplier` is never checked against a purchase** (client sends it at `public/script.js:223-225`). |
| Multiplayer session completion | `POST /api/sessions/:code/complete` `server.js:2631` | 75 for each participant with `reflection_done` (`:95`, `:2734-2768`) | +100 each | Gates: minimum duration, paid participants, host max 5 per hour (`lib/reward-validation.js`). **Always fails with a ReferenceError** on `requiredMin` / `requiredPlayers` (`server.js:2779`, `:2781`; not declared anywhere, confirmed by grep). The transaction rolls back (`:2823-2828`) and the host gets 500. The host is not a participant, so it never earns. Tests only cover the pure gate functions (`test/reward-validation.test.js`). |
| Session reflection | `POST /api/sessions/:code/reflect` `server.js:2592` | 0 directly; it is only the gate for the session reward | 0 | Any non-array object passes, including `{}` (`:2599`). The content is never read. |
| Solo reflection | none | 0 | 0 | Stored only in localStorage (`public/js/reflection.js:236-243`). |
| Photo verification | `POST /api/verify-completion` `server.js:2125` | +100 (`:85`) | +75 (`:86`) | **No daily cap and no link to a game or completion.** The client supplies `challenge_description`, which goes into a prompt that already says "Be generous" (`:2154-2157`). Every call is a gpt-4o request, so it is also a cost risk. |
| Robot challenge | `POST /api/coins/log` with action `robot_challenge` `server.js:1438` | +30 (`:96`, `:1473-1482`) | logged only, up to 500 (`lib/coin-log-policy.js:12-19`) | 1 per 24h free, **unlimited for Pro** (`plan-entitlements.js:23`). Not proven server-side. The XP award runs outside the ledger transaction. |
| Talent unlock | `POST /api/rpg/talents/unlock` | +25 | −300 / −600 / −1000 | Unique per talent |
| XP potion | `POST /api/shop/purchase` `server.js:2061-2063` | +500 | −5000 | Turns (client-forgeable) coins into XP |
| Mode clicks | Frontend calls `Coins.award('mode_click')` (`public/script.js:767`), which goes to `/api/coins/log`, plus a direct client write of `profiles.coins` | 0 | +1 | The capped route `/api/coins/award-mode-click` (`server.js:2004`, cap 200/day at `:2001-2002`) **is never called by the frontend**, so the cap is not enforced. |
| Timer, narrator, tamagochi, phone-buzz, gIVEME social | `/api/coins/log` allowlist (`coin-log-policy.js:12-27`) | 0 | Ledger row only; the real balance comes from the client `save()` | Bounded amounts only, no rate limit |

**Is reflection rewarded separately?** No. It is only a yes/no gate for sessions (`server.js:2736`), and that route is broken. In the solo flow the client opens the reflection first (`public/script.js:209`), but the server does not require it.

**Are attributes tied to the game's mode or learning goals?** No.
- Attributes never change from playing; there is no stat column.
- `trained_stats` is computed from `rvp.kompetence` (`server.js:2306`, `:2796`) and is cosmetic only.
- `mode` (party, classroom, reflection, circus, cooking, meditation) appears only as prompt labels (`server.js:1128`) and is never used in rewards. Cooking has no link to motor skills or nutrition.
- **Separate bug:** `stats_after` passes talent ids where talent objects are expected (`server.js:2317`, `:2807`). Every talent bonus therefore comes out as 0, and the game card (`public/js/game-ui.js` `updateGameCardStats`) overwrites the stat bars with base-only values that are lower than the RPG panel's.

## 3. RPG profile panel states

The panel gets its data from `RpgTalents.load()` (`public/js/rpg-talents.js:44-63`). That function returns `null` when there is no token (`:49`), on any non-OK status (`:53`), on an exception or the 12s timeout (`:57`), **and** when a load is already in progress — it then returns the stale `_data`, which may be null (`:45`).

When the DB or Supabase is paused, the server answers 503 if auth verification is unavailable (`server.js:390-393`), 401/403 for an invalid token (`:395-396`), or 500 after the 5s pool connection timeout (`:308`). The client treats all of these as `null`.

| State shown | Exact condition | Expected when DB is down? | Verdict |
|---|---|---|---|
| "— Bez triedy —" (`rpg-screen.js:129-132`) | `!avatar_meta.label && !class_id`. `class_id` is null when: no avatar; **or the user has an avatar but no school membership** (`server.js:3353`); or the load failed / overlapped | Yes, as a load-failure symptom | **Bug:** a non-member who paid 5000 coins for an avatar (allowed at `:3239`) still sees "Bez triedy", an empty talent tree and zero stats. Avatar access and talent access are gated differently. |
| "Nie si členom školy" (`rpg-screen.js:150-157`) | `!data?.eligible \|\| !data.role`. The server always sends `eligible: true` and `role: 'player'` (`server.js:3380-3382`), so **this text only appears when the load failed** | Yes, it is what users see when the DB is down | **Bug (wrong label):** a load error is presented as a membership state. Real non-members instead see a raw "player" badge (`ROLE_LABELS` at `:32` has no `player` entry) and an empty school name. |
| Talent tree empty "Vyber si RPG avatara (musíš byť členom školy)…" (`rpg-talents.js:140-147`) | `!_data \|\| !_data.class_id` | Yes | Same mixing of error and real state as "Bez triedy" |
| "🎁 Načítavam odmeny…" (`rpg-screen.js:242`) | Shown before the token and fetch | Can last forever | **Bug:** `_token()` (`:338-343`) has no timeout, unlike `rpg-talents.js:22-25`, and the `fetch` at `:250` has no `AbortController`. If the session refresh against a paused Supabase hangs, the spinner never resolves. |
| "Prihlás sa pre zobrazenie odmien." (`rpg-screen.js:246-247`) | `getSession()` returned no `access_token`, or threw (including `window.supabaseClient` being undefined) | Yes, when the token expired and refresh fails against paused auth | Misleading: it shows "log in" while the rest of the UI still looks logged in. It should say "server unavailable" |
| "⚠️ Odmeny sa nepodarilo načítať." (`:251`) / "Chyba pri načítaní odmien." (`:308`) | `!res.ok` / exception | Yes | Correct, but there is no retry button |
| "📊 Načítavam…" in stats (`rpg-screen.js:367-369`) | `_lastData` is null, which `_loadAndRender` sets on any failed load (`:105`) | It is what you see when the DB is down | **Bug:** a permanent fake loading state with no error, timeout or retry |
| Level badge hidden (`:165-171`) | `!data.progression` | Yes | OK |
| Profile avatar block "Prihlás sa a vyber si svojho hrdinu." (`rpg-avatar.js:129-139`) | `!_data \|\| !_data.eligible`; `load()` returns null on any non-OK status (`:56`) | Yes | **Bug:** "log in" while logged in, on any 500 or 503 |
| HUD panel hidden (`game-ui.js` `renderRpgHudFromTalents`, `!data.progression`) / profile block "Načítaj RPG údaje…" | Load returned null | Yes | The `rpg_hud_need_school` hint can never show, because `eligible` is always true |

**Race:** `RpgScreen.refresh()` runs after the solo award (`public/script.js:259`) while the HUD reload is still in flight (`:248-250`). The second `load()` returns the old `_data` early (`rpg-talents.js:45`), so the screen can show stale XP or a null state.

## 4. Pedagogical grounding

**Mappings that exist:**
- Talent competencies use Slovak-style keys, 9 in total: ucenie, matematika, komunikacia, socialna, obcianska, pracovna, digitalna, kulturna, problemy (`rpg-talents.js:11-20`). They map to stats at `rpg-progression.js:168-178`.
- Game competencies use 7 Czech RVP keys (`VALID_COMPETENCY_KEYS`, `server.js:99-102`): k-uceni, k-reseni-problemu, komunikativni, socialni-personalni, obcanske, pracovni, digitalni. They map to stats at `server.js:103-111`, duplicated in `public/js/game-ui.js` (`GAME_KOMP_TO_STAT`).

**Gaps in those mappings:**
- **Two different vocabularies.** No game key maps to creativity, so creativity cannot be reached from games. `kulturna` and `matematika` have no game equivalent. Strategy comes only from `pracovni`.
- Soft skills and RVP key competencies are named, but nothing measures them. A stat is never a function of observed performance.

**What generation produces:**
- The schema includes `learningGoals` (free strings, at most 3 after `lib/ai-guard.js:223`), `reflectionPrompts`, `verificationChallenge`, and `rvp.{kompetence, oblasti, stupen, prurezova_temata, ocekavane_vystupy, doporucene_hodnoceni}` (`server.js:556`).
- The prompt asks for 1–3 competencies that the activity "GENUINELY trains" (`server.js:653-656`). This is AI self-assessment with no validation.
- The player's RPG profile is fed back into the prompt (`server.js:1088-1124`), regardless of school membership.

**What the UI labels mean:**
- "XP Ciele" is just the i18n label for `learningGoals` (`public/data/i18n/sk.json:98`). It has no XP logic.
- "RPG Atribúty" is the label for `rvp.kompetence` (`sk.json:100`). It renders stat chips marked "Trénuje" (`game-ui.js:155-171`).
- "Vzdelávacie ciele" (`public/game.html:108`, `index.html:1010`) is the same field.

**How it flows into rewards:**
- `learningGoals`, `ocekavane_vystupy` and `reflectionPrompts` do not affect rewards at all.
- `kompetence` only changes the XP multiplier (+15% per extra key, `server.js:2296`). This rewards the AI or the client for listing more keys, not the learner.
- Reflection ratings (1–5 for each of up to 3 competencies, `reflection.js:34-61`) are never used. `digitalni` has no question, so its raw key is shown as the label (`reflection.js:23-30`).

**Side finding (XSS):** `reflection.js:98` puts the AI or game-supplied `vc.description` into `innerHTML` without escaping; the labels at `:121` are handled the same way.

## 5. Gaps and concrete proposals

1. **Fix the blockers first:**
   - Use `durResult.validation.duration_required_min` and `partResult.validation.participants_required` in place of `requiredMin` / `requiredPlayers` at `server.js:2779` and `:2781`.
   - Pass talent objects instead of ids at `:2317` and `:2807`.
   - Revoke browser `UPDATE` / `INSERT` on `profiles.coins` and `rpg_avatar_id`, and move `coins.js` `save()` to server-side credits.
   - Route mode clicks through `/api/coins/award-mode-click`.
2. **Make solo completion verifiable:**
   - Issue a server-side "play ticket" at generation or start: `{game_id, user_id, started_at, duration.min/max, kompetence}`, stored server-side.
   - `complete-solo` accepts only the ticket id. It reads duration and competencies from the server copy, uses the reward-validation duration gate, and is single-use.
   - Drop client `xp_multiplier`. Look up an active, purchased `xp_boost` from the ledger instead.
3. **Participation XP plus a separate reflection bonus:**
   - Base participation XP comes from validated play time (e.g. the current 30–120 curve).
   - Add a reflection bonus (e.g. +25%) only for a server-received reflection that has all ratings, open answers of at least N characters, and is not a duplicate of the user's last K answers.
   - Send solo reflections to the server (new table `reflections(user_id, ticket_id, ratings jsonb, texts, created_at)`).
   - Let the host earn in sessions too (the host is not a participant, `server.js:2619-2623`).
4. **Map each mode to attributes, with growth stored in the DB:**
   - Add a `rpg_stat_xp` jsonb (or a table `user_stat_progress(user_id, stat, xp)`).
   - Each validated completion splits XP across stats from (a) `rvp.kompetence` through one unified key map, merging the CZ and SK vocabularies, and (b) a mode prior. Examples: cooking → strategy (planning) + focus, plus new "practical/motor" and "health" sub-tags; circus → resilience + motor; meditation → focus + resilience; party → communication; classroom → insight / strategy; reflection → communication + focus.
   - Make creativity reachable (kulturna, circus, party).
   - Optionally weight by the learner's self-rating (1–5), and in EDU by teacher confirmation.
5. **Measurable competencies:**
   - Keep `rvp.ocekavane_vystupy` per ticket and ask 1 rating per outcome in the reflection.
   - Optionally let the teacher tick "achieved" (an EDU assessments link, migrations 028–034).
   - Report per-competency counts and average self-ratings over time instead of opaque stats.
6. **Anti-abuse:**
   - Photo verification: require a valid ticket, allow one per ticket, use the server-side challenge text (not the client's), and add a daily cap.
   - Robot challenge: give Pro a cap too, or make it server-validated.
   - Run XP and ledger writes in one transaction (`server.js:1467-1482`).
   - Lock perk claims with `SELECT … FOR UPDATE` or a partial unique index on `(user_id, perk_key) WHERE status='pending'`.
   - Apply the level cap the same way everywhere (`:2360`, `:3775`, `:1105`).
   - Either implement the talent effects or rewrite their descriptions as stat-only.
7. **Panel UX:**
   - Have `load()` return `{ok:false, status}` so the UI can tell "not logged in" (401), "service unavailable" (503/500/timeout) and "not a member" apart.
   - Add a timeout to `rpg-screen.js` `_token()` and the perks fetch.
   - Replace the permanent stats "Načítavam…" with an error message and a retry button.
   - Gate avatar purchase and talent access the same way, or stop nulling `class_id` for non-members (`server.js:3353`).
   - Add "player" to `ROLE_LABELS`.