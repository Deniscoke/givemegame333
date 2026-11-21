Scope covered: filters, prompts, schema, cost, and where to add the new features. Every claim cites file:line, relative to the repo root `C:\Users\Admin\Desktop\gIVEMEGAME.IO-OPENCLAW\.worktrees\hardening`.

## 1. Filter options and value ranges

**UI (`public/index.html`)**
- **Age (Od/Do):** min options are `""`, 3, 5, 6, 8, 10, 12 (131-139). Max options are `""`, 6, 8, 10, 12, 14, and "16+" with value `16` (141-149). There is no 18, and nothing checks that min ≤ max on the client or the server.
- **Players:** `""`, `solo`, `small` (2–5), `medium` (6–15), `large` (16–30) (155-161). The SK labels are "Squad" with "2–5 (mini squad)", "6–15 (squad)" and "16+ (full lobby)" (`public/data/i18n/sk.json:21-26`). "16+" does not match the server cap of 30.
- **Duration:** `""`, `quick` (5–15), `medium` (15–30), `long` (30–60) (166-171). The SK labels already say "Timer": "Speedrun (5–15 min)", "Classic (15–30 min)", "Marathon (30+ min)" (`sk.json:27-31`). "30+" does not match the server cap of 60.
- **Setting:** toggles for `any`, `indoor`, `outdoor` (176-186), read by `getActiveSetting` (`public/script.js:421-425`).
- **"Rozšírené možnosti"** is a `<details>` block (190-295) containing:
  - energy: low, medium, high
  - circus-only activity: solo, pair, group, mass
  - reflection-only depth: light, medium, deep
  - cooking-only cuisine
  - meditation-only focus
  - the RVP block: stupeň `prvni` or `druhy`, 7 kompetence, 9 oblasti
- **Popis** is outside the details block, maxlength 200 (300).
- Filters are collected in `public/script.js:394-419`. "Surprise" resets age, players, duration, RVP and setting, but not energy or description (504-512).

**Server-side ranges are duplicated in 4 places in `server.js`:**
- Players: `{solo:[1,1], small:[2,5], medium:[6,15], large:[16,30]}` at 585-590, 680, 702 and 1130 (labels).
- Duration: `{quick:[5,15], medium:[15,30], long:[30,60]}` at 610-614, 684, 703 and 1131.
- Age: a missing max defaults to `'99'`, a missing min to `'5'` (578-579, 689). `enforceConstraints` uses `parseInt` (713-718).
- Because the "16+" option sends 16, the game's `ageRange.max` is forced to 16.

**Sanitizer (`lib/ai-guard.js`)**
- `NUMERIC_OK_FIELDS = {ageMin, ageMax, players, duration}` (151). A finite number is turned into a string (197-199). Any other value must be a string, cleaned and clamped to 300 chars (140, 157-161, 192-195).
- No enum or range checks. `ageMin: "abc"` or `mode: "<anything>"` goes into the prompt as-is (`server.js:572` `THEME: ${filters.mode}`, and 580). That is bounded prompt injection, not a crash.
- Allowed keys are listed at 144-149. Unknown keys are dropped, so any new filter key must be added here.

## 2. How the prompt is built

**Structure.** The static system prompt is `buildSystemPrompt` (`server.js:885-937`), cached in `STATIC_SYSTEM_PROMPT` (940). The user message (1169-1208) contains, in order:
- language line
- `panelSummary` (1139-1156)
- `buildExactValuesBlock` (676-697)
- `buildFilterDescription` constraints (559-673)
- `buildDidacticGuidance` (851-882)
- optional RPG profile block, logged-in users with an avatar only (1089-1126)
- per-language task block (1159-1167)
- optional knowledge files (1188-1198)
- optional remix block (1199-1208)

**What each mode changes** (two maps, plus a few hard-coded rules):
- `modeThemes` (564-571), e.g. party = high-energy teambuilding, circus = circus mechanics are mandatory, meditation = no competition.
- `modeDidactics` (862-869):
  - party: Tuckman, ice-breakers
  - classroom: Bloom, scaffolding, formative assessment, RVP ZV, inquiry/PBL
  - reflection: Schön
  - circus: circus pedagogy
  - cooking: hands-on/sensory
  - meditation: MBSR
- The system prompt also has hard rules for classroom (RVP mapping), cooking and meditation (915-917).
- An unknown mode falls through to `THEME: ${mode}` (572) and party didactics (870).
- Mode-specific filters (activity, depth, cuisine, focus) add constraints at 598-647.

**Pedagogy actually named in the prompt:**
- A general line: "experiential learning (Kolb), active learning…, gamification that supports intrinsic motivation" (859).
- The system prompt identity mentions "Kolb, Bloom, experiential learning" (886).
- The mode lines add Tuckman, Bloom, Schön and MBSR.
- Not present anywhere: scouting/Junák, outdoor/adventure education (Hahn), drama in education, cooperative games, design thinking, flipped classroom, Comenius ("škola hrou"), debrief models.
- The tone directive is Gen Z slang and "AVOID… scaffolding" (899-907).

**Requested output fields.** `COMPACT_GAME_SCHEMA` (556) asks for:
- id, title, pitch, playerCount, ageRange, duration, setting, mode, energyLevel
- materials (shown as **Loot**), instructions (**Walkthrough**), learningGoals (**XP Ciele**), reflectionPrompts (**Debrief**)
- safetyNotes, adaptationTips, facilitatorNotes, verificationChallenge
- rvp: kompetence, oblasti, stupen, prurezova_temata, ocekavane_vystupy, doporucene_hodnoceni

The labels come from `sk.json:96-106`, the render targets from `index.html:387-477`, and the RVP render from `game-ui.js:143-210`.

**RVP rules.** A competence constraint is always added, even outside classroom mode (653-657). The stupeň logic is a hard-coded binary `prvni`/`druhy` (651, 1152). `public/data/rvp.json` `stupne` has only `prvni` (6–11) and `druhy` (11–15), so there is no secondary-school band for 15–18.

**Gap:** the "Game Pack" fields (playerBrief, lessonFlow, teacherGuide, adaptations, riskNotes) are normalised in `lib/game-schema.js:27-90` and `public/js/game-schema.js:4-47`, but they are not in `COMPACT_GAME_SCHEMA`. So AI-generated games always have them empty.

**Validation and post-processing:**
- `validateGame` checks required fields (729-777).
- One repair call to `gpt-4o-mini` at temperature 0.3 (823-848, 1286-1315).
- A regex safety check (783-819).
- `enforceConstraints` overwrites playerCount, duration, ageRange, setting and energy (700-725). It does not enforce `mode` or the circus `activity`.

## 3. Model, token cost and caching

- **Model:** `OPENAI_MODEL` or `gpt-4o` (1213). On a 404 it falls back to `gpt-4o-mini` (1210-1214, 1272-1276). Repair always uses `gpt-4o-mini` (1212).
- **Settings:** temperature defaults to 0.8 (1216). `response_format: json_object` is used (1242-1244). There is one 50 s time budget for all calls (1228-1229).
- **max_tokens:** the code default is **2000** (1215). `.env.example:28` sets 5000, and `AI_CONTEXT.md:378` says 5000. The docs don't match the code; which value applies depends on the deployed env.
- **System prompt size:** lines 886-936 are about 4,300 chars, including the ~770-char schema. That is roughly 1,100–1,250 tokens.
- **User message size:** about 2,500–3,500 chars, or roughly 700–1,000 tokens. The RPG block (~1,060 chars) and the always-on RVP constraint add to this.
- **Knowledge files:** up to 15,000 chars (~4k tokens) more (276-277). The `source of knowledge/` folder is currently empty in this worktree.
- **Typical total:** about 2k input tokens and up to 2k (or 5k) output tokens. A failed parse or validation adds a repair call of up to ~4k chars in and 3k tokens out (830, 842).
- **Caching:** there is no explicit caching. The comment at 939 relies on OpenAI's automatic prefix caching, which needs a prefix of at least 1,024 tokens. The system prompt is only just over that, so caching probably applies, but this is an estimate. `usage` / `cached_tokens` is never logged, so it can't be confirmed from the code.

## 4. Where to add the requested features

**First, put the ranges in one shared constant.** Create one shared `lib/filter-presets.js` with the duration, player and age-band tables. Use it everywhere the ranges are currently duplicated:
- `server.js` 585-590, 610-614, 680, 684, 702-703, 1130-1131
- `public/js/game-data.js:84-97` (the fallback scorer; it currently ignores `solo` and keeps old thresholds)

Then add enum validation in `lib/ai-guard.js:174-204`.

**Duration presets (Speedrun ~5-10, Classic ~15-25, Marathon 30+)**
- New values in `index.html:166-171`.
- i18n keys `duration_*` in all 6 `public/data/i18n/*.json` files (sk at 28-31).
- The server tables listed above.
- `public/js/timer.js:100` uses `duration.max`; check it still works.
- For Speedrun, add a "short, catchy, 1-sentence rules, zero setup" rule to `buildFilterDescription` near 617 and to `buildDidacticGuidance` near 873.

**Age 6-18 and grade bands**
- Options in `index.html:131-149`: add 6–18 steps, or add a grade-band select that sets ageMin and ageMax.
- Server: 577-581, 688-691, 713-718, 1143.
- Add a min ≤ max check and a 3–18 clamp in `ai-guard.js` near 197.
- For 15–18, add a third band (e.g. `stredni`) to `rvp.json` `stupne`, and replace the binary ternaries at `server.js:651` and 1152. Also update the `stupen` enum in `COMPACT_GAME_SCHEMA` (556) and the select at `index.html:257-261`.

**Squad presets (solo, pair, small group, class)**
- Options at `index.html:155-161`.
- Add `pair` [2,2] and `class` [20,30] to the server tables (585-590, 680, 702, 1130).
- The circus-only `activity` filter (599-606, `index.html:206-215`) overlaps with this; fold it in or drop it.
- Fix the "16+" label in `sk.json:26`.

**New "Online" mode**
- Mode button at `index.html:96-121`, plus i18n `mode_online` keys.
- `modeThemes` (564-571) and `modeDidactics` (862-869).
- `modeLabels` (1129) and the mode enum in `COMPACT_GAME_SCHEMA` (556).
- Mode-specific filter toggling in `App.setMode` in `public/script.js` (not read in this pass).
- Fallback library: `public/data/games.json` has 10 games covering only party, universal, classroom, circus and reflection (no cooking, meditation or online). Online requests would fall back to poorly matched games (−3 score, `game-data.js:59-60`).
- **Alternative:** make "online" a setting instead. That means changing `index.html:176-186`, `server.js` 622-624 (the binary "Do NOT suggest indoor/outdoor" logic would produce nonsense for "online"), 876-877, 1132, the setting enum in 556, and 719.

**Broad methodology grounding with short, catchy games**
- Add a `lib/methodologies.js` catalogue, for example:
  - Kolb cycle
  - scouting patrol method / Junák
  - Hahn outdoor/adventure education
  - cooperative games
  - drama in education
  - Bloom
  - PBL/inquiry
  - design thinking
  - Comenius "škola hrou"
  - a debrief model (e.g. What? / So what? / Now what?)
  - energizers
- Pick 1–2 entries per mode and duration in `buildDidacticGuidance` (851-882).
- Put the fixed catalogue text in `buildSystemPrompt` (886-936). It stays static, so it is cached, and it pushes the prefix safely past the 1,024-token threshold.
- Add a `"methodology": "string"` field to `COMPACT_GAME_SCHEMA` (556), the `validateGame` checks (733, 748) and the repair rules (834-836). Render it in `game-ui.js` near 57-68 with a new section in `index.html:385-477`.
- To make the Game Pack sections work, also add `playerBrief` and `lessonFlow` to 556.

## Live site: DB-down symptoms vs real bugs

With Supabase paused, a logged-in user's request fails the billing check (`server.js:1042-1046`) or the usage check (1062-1066) with **503 DB_UNAVAILABLE**. The frontend classifies that as "busy" (`game-api.js:51`) and shows a library game with "AI je teraz preťažená". That is a symptom of the paused DB, not a generation bug.

Guests skip those DB checks and still reach OpenAI.

An auth outage while a token is present returns 503 at 988-991. Whether a stored but expired session hits this path was not traced.

Real code bugs found in this pass, independent of the DB:
- Label and range mismatches: "16+" vs 30 players, "Marathon 30+" vs 60 minutes, the "16+" age option enforced as max 16.
- No range or enum validation on the filters.
- Game Pack fields are never requested, so they are always empty for AI games.
- The default max_tokens in code differs from the docs.