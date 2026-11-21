# gIVEMEGAME.IO: phased implementation plan (lead architect)

Repo root: `C:\Users\Admin\Desktop\gIVEMEGAME.IO-OPENCLAW\.worktrees\hardening`. Paths below are relative to it. I re-checked four bugs in the code during this pass. All other file:line references come from the subsystem maps.

The four re-checked bugs:
- `requiredMin` and `requiredPlayers` are used at `server.js:2779` and `:2781`, but they only exist inside `lib/reward-validation.js:18` and `:49`.
- The coin charge is clamped with `GREATEST(0, …)` at `server.js:2567`.
- `public/script.js:1899` looks up `#tamagochi-iframe`, and no such element exists in `public/index.html`.
- `index.html:42` puts a "🤖" in front of the `robot_challenge` label, and "Talenты" at `index.html:791` contains Cyrillic letters.

---

## 1. Bugs found (real code bugs, not caused by the paused DB)

### CRITICAL
| # | Bug | Where | Fix |
|---|---|---|---|
| C1 | Session completion always returns 500. It throws a ReferenceError on `requiredMin` / `requiredPlayers`, then rolls back, so nobody is ever rewarded and every participant has already paid 100. | `server.js:2779`, `:2781` | Use `durResult.validation.duration_required_min` and `partResult.validation.participants_required`. Add a route-level test. |
| C2 | The browser can write `profiles.coins` and `rpg_avatar_id` directly. `coins.js` keeps whichever is higher, the localStorage value or the server value, and writes it back. This mints coins, which buy XP potions and skip the 5000-coin avatar charge. | `supabase/migrations/030_billing_security.sql:115-118`, `033_security_lockdown.sql:24-27`, `public/js/coins.js:52`, `:72-77` | New migration revoking column UPDATE/INSERT. Credits happen only on the server. `coins.js` stops writing and only reads the server balance. |

### HIGH
| # | Bug | Where | Fix |
|---|---|---|---|
| H1 | The session charge is clamped at 0 while `coins_paid` is still set to 100. One user with 100 coins can be a payer in N sessions and collect N×100 coins plus 75 XP each. | `server.js:2567`, `:2571`, `:2519` | Use a conditional `UPDATE … SET coins = coins - $1 WHERE id=$2 AND coins >= $1 RETURNING`. If no row comes back, skip the participant and mark them unpaid. |
| H2 | Session `game_json` comes from the client, and the gates trust it. With `playerCount.min:1` and `duration.min:0`, an alt account can farm rewards. | `server.js:2432`, `:2455` | Store the game on the server (game id or play ticket) and validate `game_json` with the shared presets (Phase 4). |
| H3 | Solo completion trusts `game_json` and `xp_multiplier` from the client, giving up to 750 XP per call. | `server.js:2237`, `:2295-2298`, `public/script.js:223-225` | Short term: clamp the multiplier to 1 unless a purchased boost exists in the ledger. Long term: play tickets (Phase 5). |
| H4 | Photo verification has no cap and no link to a game, and every call is a gpt-4o request (+100 XP, +75 coins, AI cost). | `server.js:2125-2157` | Daily cap per user plus a server-side challenge text. Later, one per ticket. |
| H5 | When the host leaves, the session stays `active` forever. There is no rejoin, expiry or refund, so participants' coins are locked. | `public/js/session.js:686-697`, `server.js:2510`, `:2643` | Let the host rejoin based on `host_id`, add expiry plus refund (Phase 6). |
| H6 | Players who joined and then closed the tab are still charged at start. There is no leave endpoint. | `server.js:2561` | Add `POST /:code/leave` and a presence check before start. |
| H7 | The global Space/Enter handler calls `preventDefault()` and `generate()` on any focused button, link or summary, so keyboard users cannot use the UI. | `public/script.js:686-704` | Only run when `document.activeElement === document.body`. Add a modifier to the S/T/M shortcuts (WCAG 2.1.4). |
| H8 | Translations are applied only after a chain of DB awaits. The Czech HTML defaults stay on screen for 10-25 s, or forever if `loadStats` hangs, because it has no timeout. | `public/script.js:171-337`, `:1055` | Call `setLang(currentLang)` first in `init()`, add a timeout to `loadStats`, and re-render the badge afterwards (`:754-760`). |
| H9 | Mode clicks earn coins through the uncapped `/api/coins/log`. The capped route is never called. | `public/script.js:767`, `server.js:2004` | Call `/api/coins/award-mode-click`. |

### MEDIUM
| # | Bug | Where | Fix |
|---|---|---|---|
| M1 | Double `/start` charges twice. There is no compare-and-swap (CAS) and the start is not atomic. The error response leaks `err.message`. | `server.js:2561-2588` | One transaction plus `UPDATE … WHERE status='waiting' RETURNING`. Return a generic error. |
| M2 | A join racing the start is rewarded without paying, because the reward loop doesn't require `coins_paid>0`. | `server.js:2736` | Add `AND coins_paid > 0`. |
| M3 | A failed audit INSERT inside the transaction aborts the whole transaction; the try/catch does not help. | `lib/rpg-progression.js:198-211` | Wrap the INSERT in `SAVEPOINT` / `ROLLBACK TO SAVEPOINT`. |
| M4 | `stats_after` receives talent ids where talent objects are expected, so every talent bonus is 0 and the game card shows lower stats than the panel. | `server.js:2317`, `:2807` (around `:2330`, `:2820`) | Map the ids to talent objects first. |
| M5 | Robot-challenge XP is awarded outside the ledger transaction, and Pro users have no cap. | `server.js:1467-1482`, `lib/plan-entitlements.js:23` | Use a single transaction and give Pro a cap. |
| M6 | Perk claims are not atomic (check, then insert). | `server.js:3620-3658` | Partial unique index on `(user_id, perk_key) WHERE status='pending'`. |
| M7 | The free-tier level cap is applied inconsistently. | `server.js:2360`, `:3775`, `:1105` | Use one helper everywhere. |
| M8 | The SMARTA daily limit and the `narrator_fact` +50 reward exist only on the client. | `public/js/narrator.js:16-79`, `lib/coin-log-policy.js:20,53` | Server-side daily cap for each reward source. |
| M9 | Session create hangs while the DB is down: the join-code loop runs outside `try`, and Express 4 does not catch the rejection. | `server.js:2439-2445` | Move it inside the try. |
| M10 | Session participants on phones can miss the completion: polling stops, and they rely on realtime only. Reflection also never opens after a refresh once the timer has run out. | `session.js:396`, `:825`, `:433`, `:584-585` | Keep a slow poll running in every phase. Open reflection when `secLeft<=0`. |
| M11 | `GET /api/sessions/:code` lets any logged-in user read any session. There is no rate limit specific to session routes. | `server.js:2464` | Restrict to members and add a rate limit. |
| M12 | The RPG UI shows a load failure as "Prihlás sa" or "Nie si členom školy", and the stats "Načítavam…" never resolves. `_token()` and the perks fetch have no timeout. | `rpg-avatar.js:129-143`, `rpg-screen.js:150-157`, `:242-251`, `:338-343`, `:367-369`, `rpg-talents.js:44-63` | `load()` returns `{ok, status}`. Show distinct error, retry and login states. Add timeouts. |
| M13 | A non-member who bought an avatar sees "Bez triedy" and zero stats, because `class_id` is nulled. | `server.js:3353` vs `:3239` | Use the same gate for both, or stop nulling `class_id`. |
| M14 | The gIVEMEGOCHI coin and postMessage flow is dead at both ends. If it worked, every tap would award a coin. | `public/index.html:588`, `public/script.js:1898-1903`, `tamagochi/index.html:1589-1621` | Phase 9. |
| M15 | XSS: unescaped `innerHTML`. | `public/js/game-ui.js:290` (`game.title`), `public/js/reflection.js:98`, `:121` | Escape, or use `textContent`. |
| M16 | Filters have no enum or range validation. The age max is forced to 16 by the "16+" option. Labels don't match the server caps ("16+" players vs 30, "Marathon 30+" vs 60). | `lib/ai-guard.js:144-204`, `server.js:572-614`, `index.html:131-171`, `sk.json:26`, `:31` | Phase 4. |
| M17 | `data-i18n-placeholder` is never applied. | `script.js:1168-1199`, `index.html:300` | Handle it in `applyTranslations`. |
| M18 | German SMARTA facts come back in Czech. | `server.js:3953` | Add `de` to the language map. |
| M19 | Modals have no focus management, Escape handling or dialog role. | `game-ui.js:335-340`, `index.html:686`, `:815`, `:855`, `:995` | Shared modal shell (Phase 2/3). |

### LOW
- Double 🤖 on the Challenge pill (`index.html:42` plus every language file's `robot_challenge`). Cyrillic "Talenты" (`index.html:791`).
- NÁSTROJE button overflows its box (`generator-shell.css:140-146` does not reset `width:40px` from `style.css:885-893`).
- `--font-display` is never defined (`generator-shell.css:167`). Press Start 2P is loaded twice (`index.html:8`, `tokens.css:1`).
- `cursor-effect.js` creates top-level globals (`:62-90`) and has no reduced-motion check.
- Czech strings hardcoded in JS: `game-ui.js:22-46`, `:292`, and the export labels at `script.js:583-665`.
- Free users send a doomed `/api/tts` request on every click (`narrator.js:269-311`: a 401/403 does not disable it).
- Host messaging after session completion is misleading (`session.js:269`, `:276`, `:465`). `restoreFromUrlOrStorage` runs twice on sign-in (`script.js:180-181`, `:189-190`).
- The `player` role is missing from `ROLE_LABELS` (`rpg-screen.js:32`).
- Talent descriptions promise effects that are not implemented (`lib/rpg-talents.js:25-151`).
- Game Pack fields are never requested from the AI (`server.js:556` vs `lib/game-schema.js:27-90`).
- Default `max_tokens` is 2000 in code but 5000 in the docs (`server.js:1215` vs `.env.example:28`).

## 2. Symptoms caused only by the paused Supabase

These show up on the live site because the database is paused. They are not separate code bugs:
- "RPG Avatar: Prihlás sa a vyber si svojho hrdinu" while logged in: `/api/rpg/avatar` returns 401/500/503, so `load()` returns null (`rpg-avatar.js:47-65`). M12 is the UX bug that hides the real cause.
- RPG screen: "Nie si členom školy", "Bez triedy", "Načítavam odmeny…" stuck, "Prihlás sa pre zobrazenie odmien", stats "Načítavam…" (`rpg-screen.js:129-157`, `:242-251`, `:367-369`). Same note.
- Profile modal: the login CTA shows and coins are stuck at 0. Coin dropdown: "Otváram históriu..." (`index.html:923`). Library: "Načítavam..." (`:965`).
- Student portal: "Načítavam tvoje aktivity/pokrok…" (`student/index.html:62`, `:67`).
- Logged-in generation returns 503 `DB_UNAVAILABLE` (`server.js:1042-1046`, `:1062-1066`), and the UI falls back to a library game with "AI je teraz preťažená" (`game-api.js:51`). Guests still reach OpenAI.
- Every session route returns 500 or times out (the create hang itself is bug M9).
- Czech text on screen for a long time. The cause is H8, a code bug; the paused DB only makes it last longer.

---

## 3. Phases

Each phase can ship on its own. They are ordered by value and risk.

### Phase 0: Economy and session hotfixes (½-1 day, ship first)
- **Goals:** stop coin and XP minting; make session completion work again.
- **Files:**
  - `server.js`: 2779/2781 (C1), 2561-2588 (H1, M1), 2736 (M2), 2439-2445 (M9), 2298 (clamp `xp_multiplier`; H3 short term), 2125 (daily cap on photo verification; H4), 2317/2807 (M4)
  - `lib/rpg-progression.js:198-211` (savepoint; M3)
  - `public/script.js:767` (H9)
  - `public/js/coins.js:52`, `:72-77` (stop writing coins from the browser)
  - `public/js/game-ui.js:290`, `public/js/reflection.js:98`, `:121` (M15)
- **Migration:** `036_revoke_client_economy_writes.sql`. Revoke UPDATE/INSERT on `profiles.coins` and `profiles.rpg_avatar_id` for `authenticated`. Add a partial unique index for perks (M6).
- **Tests:**
  - `test/session-complete.route.test.js` (supertest plus pg-mem or a test DB): passing gates means rewards are paid and status becomes `completed`.
  - Charge tests: insufficient balance means no charge and no payer flag; a double start charges once.
  - Multiplier clamp test.
  - RLS test: the client UPDATE on `coins` is denied.
- **Acceptance:** a 2-player session completes and both reflecting players get +100 coins and +75 XP. Five parallel lobbies with 100 coins give at most one payer. Editing coins from the DevTools Supabase client fails.
- **Risk:** medium. Guests who rely on localStorage-only coins lose the server sync, which needs decision §5.3. Apply migration 035 everywhere at the same time.

### Phase 1: i18n order and keyboard fixes (1-2 days)
- **Goals:** Slovak text on first paint; keyboard users can use the app.
- **Files:**
  - `public/script.js`: move `setLang` to the start of `init()` (163-171); add a timeout to `loadStats` (1055); re-render the badge (754-760); handle `data-i18n-placeholder` (1168-1199); fix the key handler (686-704)
  - `public/index.html`: switch all `data-i18n` fallback text to Slovak (95-845); add `data-i18n` to 51, 63, 191, 523-532, 650, 689-736, 917-961, 998-1027; remove the 🤖 at 42; fix "Talenты" at 791; translate the help modal at 825-837
  - `public/js/game-ui.js:22-46`, `:292`, and `public/script.js:583-665`: move strings to `t()`
  - all six `public/data/i18n/*.json`: add the new keys and fill the roughly 50 missing in DE/ES/TR; review the English slang in `sk.json:17`, `:37`, `:86`, `:122`, `:162`
  - `server.js:3953`: add `de`
- **New file:** `scripts/check-i18n.js`. A CI script that fails when a key is missing in any language file or a `t('…')` key has no entry in any file.
- **Tests:** an i18n key-parity test. A jsdom test that `init()` applies SK translations before any network promise settles.
- **Acceptance:** with the network to Supabase blocked, the first paint shows "Varenie", "Trieda" and the SK placeholder. Enter on the Help button opens help, not generation.
- **Risk:** low.

### Phase 2: Pixel design-system foundation (3-4 days; Phases 3, 7, 8 and 9 build on it)
- **Goals:**
  - One token set for colour, corners, shadows and fonts, aware of mode and of light/dark.
  - One square pixel icon set.
  - Component classes: button, icon button, pill, panel, card, modal shell, tabs, toast.
  - A type scale.
  - A global reduced-motion guard.
- **New files:**
  - `public/ui/px-tokens.css`. Merges `style.css:8-175`, `ui/tokens.css:3-24` and `style.css:4943-4968`:
    - `--px-radius:0`
    - `--px-shadow:4px 4px 0 #000`
    - `--font-display` (Press Start), `--font-body` (Atkinson), `--font-data`
    - per-mode `--mode-accent`, `--surface`, `--surface-raised`, `--on-surface` with contrast of at least 4.5:1 (darkened Party/Circus/Cooking panels from `style.css:61`, `:124`, `:145`)
    - a light variant under `[data-theme=light]`
  - `public/ui/px-components.css`:
    - `.px-btn` and `.px-iconbtn` (40×40 hit area, 44 on touch)
    - `.px-pill`, `.px-panel`, `.px-card`, `.px-tabs`
    - `.px-modal` (header, ✕ icon button, body, footer)
    - `.px-toast`, `.px-badge`
  - `public/ui/px-motion.css`:
    - `@media (prefers-reduced-motion: reduce)` disables the animations at `style.css:345`, `348`, `903`, `1169`, `1610`, `1908`, `2149`, `2573`, `3653`
    - the coin spin and generate glow become hover-only even when motion is allowed
  - `public/ui/icons/px-icons.svg`. One SVG sprite on a 16×16 grid with `shape-rendering:crispEdges`, using `<use href="#i-fullscreen">`. Icons: fullscreen, help, tools, settings, library, coin, robot, school, share, close, filter, sound, user, pet, chat, play.
  - `public/js/px-modal.js`. Shared open/close with focus trap, Escape, focus restore, `role=dialog`, `aria-modal` and `aria-labelledby` (fixes M19). Replaces `game-ui.js:335-340`.
  - `docs/design-system.md`. The token and component reference.
- **Changes:**
  - `index.html:8-13`: load order is tokens, components, motion; drop the duplicate font import (`tokens.css:1`); drop Bootstrap Icons only after Phase 3.
  - `cursor-effect.js`: wrap in an IIFE, add a `matchMedia` check (`:180-199`), and reduce the burst size.
  - Mode switching (`script.js:722-728`) also sets `data-mode` on `<body>`, so decoration can follow the mode (Phase 3).
  - Persist the theme choice (`game-ui.js:324-332`).
- **Tests:**
  - A contrast checker script over the token pairs (`scripts/check-contrast.js`, run in CI).
  - A visual smoke test with Playwright screenshots per mode, light and dark.
  - Unit tests for the focus trap in `px-modal.js` (jsdom).
- **Acceptance:** tokens and components exist, are documented, and are used by at least the header (proof of concept). There are no undefined CSS variables. Reduced motion stops every endless animation.
- **Risk:** low by itself, because it only adds files. Migrating screens onto it happens in Phase 3.

### Phase 3: Apply the design system (4-6 days)
- **Goals:** a consistent header, panels, "Rozšírené možnosti", tool shell, modals and RPG overlay. Mode-specific decoration. Clear RPG error states.
- **Header** (`index.html:27-79`, `style.css:213-280`, `1886-1909`, `2213-2257`, `generator-shell.css:26-74`, `140-146`):
  - one 40px height with the 44px touch override, `.px-iconbtn`, sprite icons
  - Coin, Challenge and Share move into `.header-actions` as `.px-pill`
  - NÁSTROJE gets `width:auto` and no uppercase, and is hidden at ≥1200px
- **Type scale:**
  - minimum 12px for Press Start display text, minimum 14px for body text
  - selectors: `.mode-name` (`style.css:329-334`, `1745`), `.panel-label` and `.filter-label` (`836-848`, `982-989`), `.badge` and `.meta-value` (`1234`, `1276`), `.btn-lang`, `.btn-toggle`, `.btn-action`, narrator (`619-678`), footer (`801-818`), profile tabs (`394`), toast (`1584`)
- **Left panel:**
  - `#advanced-options` becomes a square `.px-panel` (`generator-shell.css:114-138`)
  - un-nest the RVP `.panel-section` (`index.html:252-293`) and clean up the indentation at 188-295
  - replace the 0.6 dimming (`script.js:747-751`) with an "len v režime Trieda" badge
  - remove the dead 🎮 button and the IndieWeb engine panel (`index.html:314-328`) after Phase 6 adds a proper "Vytvoriť lobby" entry point
- **Right panel:**
  - the tool shell and inner cards share one style (`generator-shell.css:148-253` vs `style.css:629-700`)
  - square tabs that follow `--mode-accent`
  - the RPG HUD loses its inline styles (`index.html:658-664`)
- **Modals:**
  - `.modal-box`, `.library-modal` (`style.css:2725`), coin dropdown (`:1929`), settings menu, profile modal (`387-509`) and RPG header (`4016-4048`) all move to `.px-modal`
  - the avatar becomes square (`:422`); remove the inline `#888` close buttons (`index.html:849`, `865`)
- **Mode decoration:** a new `public/ui/px-mode-decor.css` plus `public/js/mode-decor.js`. Each mode gets 2-3 decorative sprites positioned in the margins (balloons, chalkboard, tent, pot, lotus), using CSS `steps()` animation at ≤4fps and disabled under reduced motion. No canvas loop.
- **RPG states:**
  - `rpg-talents.js:44-63` and `rpg-avatar.js:47-65` return `{ok, status, data}`
  - `rpg-screen.js:129-157`, `:242-251`, `:338-343`, `:367-369` render three distinct states: "Server nedostupný, skúsiť znova" (503/500/timeout), "Prihlás sa" (401), and "Nie si členom školy" (a real membership flag)
  - add a timeout to `_token()` and an AbortController for the perks fetch
  - add `player` to `ROLE_LABELS`; resolve M13
  - server: return a real `eligible` / `membership` flag instead of the constant at `server.js:3380-3382`
- **Tests:** Playwright screenshots per mode. RPG panel tests with stubbed 401/503/200 responses. An axe-core accessibility run.
- **Acceptance:** one corner radius, one shadow style and one icon source app-wide. No text below 12px. axe shows no contrast or name violations on the main screen. With the DB down, the RPG panel says "server nedostupný", not "prihlás sa".
- **Risk:** medium (wide CSS surface). Mitigation: migrate screen by screen behind `body.px-v2` and delete legacy rules at the end.

### Phase 4: Generation presets, age bands, squads, methodologies (3-4 days)
- **New files:**
  - `lib/filter-presets.js`, shared and exposed to the client through `GET /api/filter-presets` or a build copy to `public/js/filter-presets.js`:
    - duration: `speedrun` 5-10, `classic` 15-25, `marathon` 30-60
    - squad: `solo` 1, `pair` 2, `group` 3-6, `class` 15-30
    - age bands: 6-8, 8-11, 11-15, 15-19, plus a free min/max range from 6 to 19
  - `lib/methodologies.js`: a catalogue (Kolb, Junák patrol method, Hahn outdoor ed., cooperative games, drama in education, Bloom, PBL, design thinking, Comenius "škola hrou", What?/So what?/Now what? debrief, energizers) mapped to modes, durations and age bands.
- **Changes:**
  - `server.js`: replace the duplicated tables at 585-590, 610-614, 680, 684, 702-703, 1130-1131; age logic at 577-581, 688-691, 713-718, 1143; RVP stupeň at 651 and 1152 gets a third `stredni` band
  - `COMPACT_GAME_SCHEMA` (556): add `methodology`, `playerBrief`, `lessonFlow`, and `stupen` with `stredni`
  - `validateGame` (733, 748) and repair rules (834-836)
  - `buildDidacticGuidance` (851-882): pick 1-2 methodologies per mode/duration/age; Speedrun rule "≤5 krokov, pravidlá v 1 vete, nulová príprava"; rewrite the tone directive at 899-907 so it stops contradicting scaffolding
  - `buildSystemPrompt` (886-936): the static catalogue goes here, which keeps it cacheable
  - `lib/ai-guard.js:144-204`: enum checks, min ≤ max, clamp 6-19, unknown modes rejected
  - `public/index.html:131-171`: age band select plus range, squad and duration options
  - `public/data/rvp.json` (`stupne` adds `stredni`), `index.html:257-261`
  - `public/js/game-data.js:84-97` (fallback scorer)
  - `public/js/game-ui.js:57-68`: render the methodology badge
  - i18n keys in all six JSON files; `public/js/timer.js:100` checked against the new durations
  - log `usage.prompt_tokens_details.cached_tokens` next to the call at 1242
- **Tests:**
  - `test/filter-presets.test.js`: ranges, label parity, `enforceConstraints` with every preset
  - `test/ai-guard.test.js`: rejects bad enums, swaps min > max
  - a prompt snapshot test for each mode×duration
  - schema validation with fixture games
- **Acceptance:** choosing Speedrun with ages 15-19 and Pair produces a game with `duration.max ≤ 10`, `ageRange` 15-19, `playerCount` 2-2, a non-empty `methodology` and `stupen: stredni`. Cached tokens appear in the logs.
- **Risk:** low to medium. Prompt drift is covered by the snapshot tests and a manual review of 20 sample games per mode by the pedagogy reviewer.

### Phase 5: Verifiable play, reflection bonus, mode-based attributes (4-6 days)
- **Migration `037_play_tickets_and_stat_xp.sql`:**
  - `play_tickets(id uuid, user_id, game_hash, game_json jsonb, mode, duration_min, duration_max, kompetence text[], started_at, completed_at, reflection_id)`
  - `reflections(id, user_id, ticket_id, session_id null, ratings jsonb, texts jsonb, created_at)`
  - `user_stat_xp(user_id, stat, xp, primary key(user_id, stat))`
- **New file `lib/attribute-map.js`:**
  - one unified competency map merging the CZ keys (`server.js:99-111`) and the SK talent keys (`rpg-progression.js:168-178`), with creativity reachable
  - mode priors:
    - cooking → focus + strategy, plus sub-tags `motorika` and `vyziva`
    - circus → resilience + motor
    - meditation → focus + resilience
    - party → communication + creativity
    - classroom → insight + strategy
    - reflection → communication + focus
    - online → communication + digital
  - each mapping carries a short pedagogical rationale string (shown in the UI tooltip)
- **Server routes:**
  - `POST /api/play/start`: returns a ticket. It is issued at generation, or from a library game id.
  - `POST /api/play/:ticket/reflect`: validation is all ratings present, open answers of at least 20 characters, and not a duplicate of the user's last 5.
  - `POST /api/profile/complete-solo` takes only `ticket_id`:
    - duration gate from `lib/reward-validation.js`, single use
    - participation XP from the existing 30-120 curve, plus +25% with a valid reflection
    - stat XP split from `kompetence` and the mode prior
  - drop the client `xp_multiplier` (boost read from the ledger)
- **Client:**
  - `public/script.js:209-259`: start a ticket when the game starts; send solo reflections to the server (`reflection.js:236-243`)
  - fix the HUD reload race (`rpg-talents.js:45`)
  - `game-ui.js` `updateGameCardStats`: show "+X participation / +Y reflection" and the stat XP gained
  - the RPG panel shows `user_stat_xp` bars plus per-competency counts and average self-rating
- **Talents:** either implement 201/403/603 or rewrite the descriptions as stat-only (`lib/rpg-talents.js`). Default is to rewrite.
- **Tests:**
  - ticket single use
  - duration gate
  - reflection quality gate
  - stat split determinism
  - repeated-reflection rejection
  - level-cap helper used in all 3 places (M7)
- **Acceptance:** completing a cooking game with a valid reflection gives participation XP plus a 25% bonus, and focus/strategy XP rows increase. Replaying the same ticket returns 409. A forged `game_json` has no effect.
- **Risk:** medium to high (economy). Ship behind a `PLAY_TICKETS_ENABLED` flag and keep the old route behind a 2-week deprecation.

### Phase 6: Session state machine and "Online" mode (6-10 days)
- **Migration `038_session_state_machine.sql`:**
  - `sessions`: add `last_host_seen_at`, `expires_at`, `play_style ('room'|'online'|'async')`, `reflection_ends_at`
  - `session_participants`: add `left_at`, `last_seen_at`, `is_guest`, `nickname`
  - `session_events` for an audit trail
  - pg_cron, or a server interval job, expires sessions and refunds `coins_paid`
- **Server** (extract to `lib/routes/sessions.js` first to cut `server.js` conflicts):
  - CAS on every transition: `waiting → active → reflection → completing → completed/expired`
  - server-set reflection on timer or host action
  - `POST /:code/leave`, `POST /:code/heartbeat`
  - host rejoin based on `host_id`
  - host reward (decision §5.4)
  - per-participant daily cap
  - `GET /:code` restricted to members and rate-limited (M11)
  - store `game_id` or a ticket instead of raw `game_json` (H2)
- **Online mode:**
  - mode button (`index.html:96-121`), `modeThemes` / `modeDidactics` / `modeLabels` (`server.js:564-571`, `862-869`, `1129`), schema enum (556)
  - the prompt asks for remote-safe mechanics (chat, camera-optional, screen share, per-player tasks)
  - games carry `onlineFlow` steps the server can sequence; per-player deadlines for async play
  - client `public/js/session.js`:
    - Supabase Realtime presence/broadcast channel per session, plus a slow poll running in every phase (M10)
    - reconnect on `visibilitychange`, wake-lock
    - "projektor" vs "hrám na svojom zariadení" views
    - fix the second-device join (`:529-546`), the double restore (`script.js:180-190`), honest toasts (`:269-276`, `:465`)
  - QR code in the lobby (vendored `qrcode-generator`, MIT, inline)
  - guest join with a nickname for students without accounts, no coins
- **Tests:**
  - state machine transitions, including illegal ones
  - expiry and refund job
  - leave before start means not charged
  - guest join, rate limit
  - Playwright two-context test: host plus 2 players, one disconnects and reconnects
- **Acceptance:**
  - a host who closes the tab can resume from another device
  - abandoned sessions refund within the TTL
  - a phone player sees completion within 10 s without realtime
  - an Online game with 4 remote players finishes end to end with per-player rewards
- **Risk:** high (realtime, many states). Mitigation: put the state machine on the server first (6a), then add Online UI (6b).

### Phase 7: Accessibility features (3-4 days, after Phases 1-2)
- **Read-aloud:**
  - new `public/js/read-aloud.js`, extracted from `narrator.js:108-135`, `204-208`, `315-327`; add `tr-TR` to `getLangBcp47`
  - capture-phase Ctrl/⌘+click reads `closest('[data-i18n],p,li,h1,h2,h3,.game-pitch,.toast')`, avoiding the Ctrl+C handler at `script.js:699`
  - an "Čítať nahlas" toggle in the preferences menu (`index.html:64-77`), with a speaker sprite icon
- **Readable font:**
  - `body.readable-font` defined in `px-tokens.css` (swaps `--font-display` to `--font-body` for non-heading elements, minimum 16px)
  - set before first paint from an inline `<head>` script reading localStorage
  - pixel borders, icons and shadows stay, so the pixel look is kept
- **Tour:**
  - new `public/js/tour.js` and `public/ui/px-tour.css`
  - backdrop at z-index 30000 with a spotlight hole (box-shadow cutout) and 200ms fades (none under reduced motion)
  - Ďalej / Späť / Preskočiť buttons, `role=dialog`, focus trap reusing `px-modal.js`
  - steps: `#mode-grid`, `#creation-basics`, `#advanced-options`, `#btn-generate`, `.btn-surprise`, `#btn-game-tools`, help (add an id), `#btn-library`, `#coin-display`, `#btn-join-session`
  - opens the mobile drawers before spotlighting inside them (`index.html:47`, `game-ui.js:371`)
  - gated on `givemegame_tour_done`; started after `setLang`; suspends shortcuts
  - "Spustiť tutoriál znova" in the help footer (`index.html:848-850`)
  - other a11y: `aria-live` on `#toast` and `#status-text`; `for=` on labels (`index.html:129-300`); keyboard roles for the clickable divs (`index.html:27`, `404-467`, `game-ui.js:286-295`, `library.js:341`, `367`, `rpg-talents.js:174`, `204`); restore focus outlines (`style.css:616`, `1082`, `2950`, `3344`, `3369`, `3383`); add the skip link
- **Tests:** axe-core in Playwright; tour keyboard walk-through; read-aloud unit test with a stubbed `speechSynthesis`.
- **Acceptance:** the tour can be completed with the keyboard only. Ctrl+click reads in the current UI language. axe shows 0 serious issues.
- **Risk:** low.

### Phase 8: SMARTA dock, chat and free voice (3-5 days)
- **Client:**
  - new `public/js/smarta-dock.js` and `public/ui/px-smarta.css`
  - a pixel-anime portrait sprite (static sprite sheet, 2-3 frames for idle/talk at ≤6fps) docked `position:absolute` bottom-right inside `main#game-viewport` (`index.html:332`)
  - collapsible chat window (`.px-modal` variant, non-blocking)
  - settings: position, size, mute, voice, style (reuses the styles from `narrator.js:183-201`)
  - refactor `narrator.js` to export `speak()` and `fetchFact()` (`:232-245`, `:334-443`) and drop the `#narrator-bot` coupling; the right-panel tab becomes settings-only
  - stop the doomed TTS call for Free users (`:269-311`: cache 401/403)
- **Server:**
  - `POST /api/smarta/chat`: the plan gate copied from `server.js:3895-3921`, gpt-4o-mini, `max_tokens` 150, the last 6 turns, per-user rate limit (`rpgRateLimit` at `:3176-3188`), daily cap
  - Free tier: an intent matcher over static JSON (`data/smarta-replies.{lang}.json`: help topics, tips) at zero token cost
  - move the narrator daily limit and the reward cap to the server (M8)
  - fix the stale "GPT-5.4" comments (`:3886`, `:3923`)
- **Voice:** a pluggable `lib/tts-providers.js` with `openai` (existing) and an optional `elevenlabs` (`ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, server-side only, cached by text hash in a `tts_cache` table or storage). Web Speech stays the free default (§5.1).
- **Tests:** chat route gate, rate limit and cap tests; provider fallback order; a docking layout test at 375/768/1440px.
- **Acceptance:** SMARTA sits bottom-right without covering the generate button and can be configured and hidden. Free users get local replies and Web Speech with no 401 noise. Pro chat costs ≤150 output tokens per turn.
- **Risk:** low to medium (cost is controlled by caps).

### Phase 9: gIVEMEGOCHI connection and roaming pets (4-6 days)
- **gIVEMEGOCHI:**
  - embed `<iframe id="tamagochi-iframe" src="tamagochi/index.html?embed=1">` in place of the link at `index.html:588`, keeping a "full screen" button
  - the child posts to `window.opener || window.parent` with the exact origin; the parent checks `event.origin` (`script.js:1898-1903`)
  - coins only on level-up or minigame finish, never per tap (`tamagochi/index.html:964-974`, `1589-1621`)
  - the parent sends `pet_syncUser {user, rpgLevel, avatarId}` (pattern from `script.js:1715-1722`)
  - persistence: localStorage keyed by uid first; server sync via migration `039_pet_state.sql` (`profiles.pet_state jsonb`, or a `user_pets` table) plus `GET/PATCH /api/pet` modelled on `/api/user/preferences` (`server.js:3113-3160`)
  - remove the Tailwind CDN (`tamagochi/index.html:7`) and add i18n
  - the gIVEME fake XP bar (`gIVEME/script.js:218`, `542-549`) and the hard-coded 42 coins (`:186`) read real RPG data
- **Roaming pets:**
  - new `public/js/pets.js`, `public/ui/px-pets.css`, `public/data/pets.json` (species, unlock level, sprites) and `public/data/pet-tips.{lang}.json`
  - DOM sprite in a fixed overlay with a z-index below the side panels, so pets "hide behind" them
  - simple state machine: walk / idle / sleep / peek, driven by a `setTimeout` scheduler at ≤5 updates per second (no rAF loop when idle); paused on `document.hidden` and under reduced motion (static pet)
  - unlocks from `progression.level` (`rpg-talents.js:44`, `273`); new unlocks shown on the level-up toast (`coins.js:350-355`)
  - tips from static JSON at zero tokens
  - random challenges and rewards through a new server route `POST /api/pets/interact`: daily cap, coins via the ledger, XP via `awardXpInTransaction`, new sources registered in `lib/coin-log-policy.js` `REWARD_BASE`
  - user settings: turn off, one pet only, "nerušiť"
- **Tests:** postMessage origin rejection; pet reward caps; unlock thresholds; a performance budget test in Playwright (idle CPU, rAF count when pets are sleeping).
- **Acceptance:** caring for the pet in the embed raises the main wallet only on milestones (≤N per day). The pet survives a reload. Pets appear at their unlock levels, sleep after inactivity, and work with the DB down using local state only.
- **Risk:** medium (performance on low-end school laptops; economy). Mitigated by the caps and the budget test.

### Phase 10: Test account with everything unlocked (½-1 day; can ship any time after Phase 0)
- **New files:**
  - `scripts/seed-test-account.js`: idempotent, uses the service role; sets Pro plan, rpg_xp 55000, every talent row, avatar, perks, coins, pets unlocked, a school membership as teacher and student
  - an `is_test_account boolean` column (migration `040_test_accounts.sql`)
- **Guard rails:**
  - the script refuses to run unless `NODE_ENV!=='production'` or `ALLOW_TEST_SEED=1` plus an explicit email allowlist env var
  - test accounts are excluded from leaderboards and analytics
  - the password is never committed; it is entered on the CLI or the account uses magic-link login
- **Tests:** dry-run mode; the idempotency test passes when run twice.
- **Acceptance:** one command produces an account where every screen (RPG tree, perks, SMARTA Pro, gIVEME, pets) is reachable.
- **Risk:** low if the guards hold.

---

## 4. What can run in parallel

The main conflict surface is `server.js` (monolith), `public/index.html`, `public/script.js` and the i18n JSON files. Before parallel work starts, a ½-day refactor should move session routes to `lib/routes/sessions.js`, RPG routes to `lib/routes/rpg.js` and SMARTA routes to `lib/routes/smarta.js`. That turns most `server.js` conflicts into separate files.

| Track | Phases | Main files | Can run alongside |
|---|---|---|---|
| A: Backend economy | 0, then 5 | `server.js` (rewards), `lib/rpg-progression.js`, `lib/reward-validation.js`, migrations 036/037 | B and C |
| B: Frontend foundation | 1, then 2, then 3 | `index.html`, `script.js` (init/i18n), `ui/*.css`, `style.css`, i18n JSON | A and D (D must not touch i18n until 1 merges) |
| C: Generation | 4 | `server.js` 556-940 (prompt section), `lib/ai-guard.js`, `lib/filter-presets.js`, `lib/methodologies.js`, `rvp.json`, `game-data.js` | A and B. Its `index.html` filter block (131-171) and i18n keys conflict with B only lightly; merge B's Phase 1 first. |
| D: Sessions / Online | 6 | `lib/routes/sessions.js`, `public/js/session.js`, migration 038 | After Phase 0 (shares `server.js:2427-2870`). Parallel with C and B-Phase 2. The Online mode button touches `index.html:96-121` and server mode maps, so coordinate with C. |
| E: Companions | 8, 9 | `narrator.js`, new `smarta-dock.js`, `pets.js`, `tamagochi/index.html`, `lib/routes/smarta.js` | Needs Phase 2's components. Phases 8 and 9 can run in parallel with each other. Phase 9 pet rewards depend on Phase 0's economy lockdown. |
| F: Accessibility | 7 | `read-aloud.js`, `tour.js`, `px-tour.css`, label and aria edits in `index.html` | After Phases 1 and 2. Conflicts with Phase 3 on `index.html`, so run after Phase 3 or split by region. |
| G: Test account | 10 | `scripts/`, migration 040 | Any time after Phase 0 |

**Safe concurrent sets:**
- {0, 1, 4}
- {2, 5, 6a}
- {3, 8, 9}
- 7 and 10 last, or whenever free.

## 5. Open decisions for the product owner

1. **Free voice provider.**
   - ElevenLabs' free tier has a small monthly character quota, and its terms restrict commercial use and require attribution, which is a problem for a paid school product.
   - **Recommended default:** browser Web Speech for everyone, OpenAI TTS for Pro (already built), and an ElevenLabs adapter behind an env var with server-side caching, switched on only after the licence has been checked.
2. **Is "Online" a mode or a setting?**
   - As a mode it gets its own theme, didactics and decoration, but it can't combine with Cooking or Circus.
   - **Recommended default:** a play style (`room` / `online` / `async`) that combines with any mode, plus remote-safe prompt rules. A visible "Online" mode button can be a shortcut that sets play style online with the Party theme.
3. **Guest and offline coins once browser writes are revoked.**
   - **Recommended default:** guests get a local "practice wallet" that is never synced. On sign-up, a one-time server-validated starter grant of 500 replaces the local balance (no merge).
4. **Reward model.**
   - **Recommended default:**
     - participation XP 30-120 based on validated time, +25% for a quality reflection
     - the host earns 50% of participant XP when ≥2 reflecting players finish
     - keep the 6 existing stats, with `motorika` and `vyziva` as visible sub-tags under focus/strategy for Cooking and Circus instead of new top-level stats
     - talent descriptions rewritten as stat-only
5. **Pixel icon and portrait art source.**
   - **Recommended default:** start from an MIT-licensed 16×16 pixel icon set (e.g. Pixelarticons) built into our own sprite and recoloured to tokens. Commission or hand-make only the SMARTA portrait and pet sprites, keeping each pet within 4 frames to protect the low-CPU target.