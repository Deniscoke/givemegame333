# SMARTA, TTS, gIVEMEGOCHI and gIVEME: how they work and how they connect to the main app

Base path: `C:\Users\Admin\Desktop\gIVEMEGAME.IO-OPENCLAW\.worktrees\hardening`. All findings come from reading the code; nothing was run.

**Headline findings:**
- **gIVEMEGOCHI coins never reach the main wallet.** It opens in a new tab, but the code only posts to a parent frame, and the main app listens for an iframe that does not exist.
- **The "RPG Avatar: Prihlás sa…" text appears even when logged in.** The same text is shown for every failure, including the database being down.
- **SMARTA's daily limit and its 50-coin reward are enforced only in the browser.** Clearing localStorage resets them.
- **German SMARTA facts come back in Czech.**

## 1. SMARTA (narrator)

**Where it sits**
- It is the first tab ("SMARTA") of the right-hand panel, `aside#game-tools-panel` (`public/index.html:521-583`).
- The header button opens it with `App.UI.openTool('smarta')` (`public/index.html:50`). Tab switching is in `public/js/game-ui.js:352-397`.
- The panel is always visible on screens 1200px and wider, and is a drawer below that (`game-ui.js:370-372`).
- Panel contents:
  - topic dropdown `#narrator-area` (`index.html:539`)
  - five style checkboxes: genz, sangvinik, flegmatik, cholerik, melancholik (`index.html:543-564`)
  - the `#narrator-bot` button: an 8x8 pixel portrait built from CSS spans, plus the hint "Klikni a počúvaj" (key `narrator_click`) (`index.html:565-577`)
  - the fact output `#narrator-fact` (`index.html:578`)
- Code is in `public/js/narrator.js`, loaded at `index.html:975`.

**Click flow** (`narrator.js:334-443`)
1. `canUseSmarta()` checks the daily limit.
2. It calls `GET /api/random-fact?lang=&area=&style=`.
3. It shows the fact with a "🤖 AI" or "📋 Lokál" badge (`narrator.js:396-408`).
4. `speakAndAward()` reads it aloud, and when playback ends it calls `Coins.award('narrator_fact')`, which gives +50 (`narrator.js:232-245`, `coins.js:23`).

**The "1/10 dnes" limit**
- `SMARTA_DAILY_LIMIT = 10`, stored in localStorage key `givemegame_smarta_usage_<uid>` (`narrator.js:16-79`).
- The hint text is set at `narrator.js:180`.
- It is browser-only, so clearing localStorage resets it.
- It counts local (non-AI) facts too, including the error fallback (`narrator.js:391`, `417`).
- The server does not limit how often `narrator_fact` can be logged. `lib/coin-log-policy.js:20,53` only bounds each amount to 1..100, so the reward can be farmed.

**Styles**
- The checkboxes are saved to localStorage `givemegame_smarta_styles_<uid>` (`narrator.js:183-201`).
- They are also synced to the server through `GET/PATCH /api/user/preferences` (`server.js:3113-3160`, `public/script.js:91-142`), using DB columns `narrator_styles` and `narrator_lang` (migration `supabase/migrations/008_smarta_styles.sql`).
- Each style has three effects:
  - a text prompt hint (`server.js:3955-3961`)
  - an OpenAI voice preset (`server.js:4013-4019`)
  - Web Speech rate/pitch values (`narrator.js:124-135`)

**`GET /api/random-fact`** (`server.js:3887-4009`)
- Free or logged-out users, or a missing API key, always get a local fact from `data/narrator-facts.json` (`server.js:3819-3823`, `3906-3921`), with `planGate:'smarta_pro_only'`.
- Pro users get OpenAI, trying models in order: gpt-4o-mini, gpt-4o, gpt-4-turbo, gpt-3.5-turbo (`server.js:3949`), with `max_tokens:150` and `temperature 0.9`. This costs very little per fact.
- **Bug:** the language map at `server.js:3953` has no `de`, so German requests fall back to Czech.
- The comments at `server.js:3886` and `3923` say "GPT-5.4", which does not match the code.
- The client never shows the server's `_debug` error text on screen; it goes to the console only (`server.js:4008` vs `narrator.js:384-387`).

**`POST /api/tts`** (`server.js:4011-4100`)
- Requires login (401 otherwise) and a Pro plan (403 otherwise).
- Calls OpenAI `/v1/audio/speech` with model `OPENAI_TTS_MODEL` (default `gpt-4o-mini-tts`), mp3 output, and a 4096-character cap.
- Default voice is `marin`; the first selected style overrides it with coral, sage, onyx, cedar or nova.
- **Client fallback quirk** (`narrator.js:269-311`):
  - The client tries `/api/tts` first, with an 8-second timeout.
  - A network error, a timeout or a 502/503 sets `usePremiumTts=false` for the rest of the page session.
  - A 401 or 403 does not set it, so Free users send a failing TTS request on every click before falling back to Web Speech.

**Other routes**
- `GET /api/narrator-areas` (`server.js:3866`) lists curriculum (RVP) areas. The client falls back to `data/rvp.json` (`narrator.js:137-171`).

**Plan flag**
- `smartaOpenAiAndTts` is true for Pro and false for Free (`lib/plan-entitlements.js:19,31`), and is returned at `server.js:1559`.

## 2. TTS options and env vars

**Implemented**
- OpenAI `gpt-4o-mini-tts`: Pro only, paid per character (`server.js:4080`).
- Browser `speechSynthesis` (Web Speech API): free, used by everyone else. It picks a voice matching the language code (`narrator.js:112-121`) and works offline. Slovak and Czech voice quality depends on the operating system.

**Not implemented**
- ElevenLabs is mentioned only in `AGENTS.md:136`, as an agent tool. There is no ElevenLabs code and no env var for it.

**Env var names** (from `.env.example` and `process.env` usage in `server.js` and `lib/`):
- OpenAI: `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_TTS_MODEL`, `OPENAI_MAX_TOKENS`, `OPENAI_TEMPERATURE`
- Narrator: `NARRATOR_STYLE` (commented out in `.env.example:25`; the server-side default style)
- Supabase: `SUPABASE_DB_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`
- Server and limits: `PORT`, `NODE_ENV`, `ALLOWED_ORIGINS`, `AI_GLOBAL_DAILY_LIMIT`, `GUEST_AI_DAILY_LIMIT`, `VERCEL`
- Billing and Stripe: `BILLING_SUBSCRIPTIONS_ENABLED`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_TEACHER_MONTHLY`, `STRIPE_PRICE_TEACHER_YEARLY`, `STRIPE_PRICE_SCHOOL_YEARLY`, `APP_ORIGIN`, `BILLING_TERMS_URL`, `BILLING_PRIVACY_URL`, `BILLING_CONTACT_URL`, `BILLING_TOS_VERSION`, `BILLING_PRIVACY_VERSION`, `BILLING_WITHDRAWAL_CONSENT_TEXT`, `BILLING_SUPPORT_EMAIL`

## 3. gIVEMEGOCHI (`public/tamagochi/index.html`, a single file)

**State model**
- `createPet()` (`tamagochi/index.html:919-937`) holds: hunger, happy, energy, clean (each 0-100), age, xp, level, coins, alive, sick, poop, sleeping, x, y, accessory.
- Leveling: level up when xp ≥ level×30, which also gives +4 coins; accessory becomes a hat at level 3 and a bow at level 5 (`964-974`).
- `gameTick` runs every second (`1245-1290`, `1626`): stats decay, age goes up every 20 ticks, +1 coin every 12 ticks, the pet can get sick, and it dies at 0.
- Actions: feed, pet, clean, heal, sleep, snack (costs 3 coins), train, and a star-clicking minigame (`1049-1218`).
- The UI text is mostly Slovak written without diacritics, with a few English button labels (e.g. "WASH").

**Persistence: none**
- The file has no localStorage, server or database calls.
- Reloading the page resets the pet.
- The "STIAHNUT" (download) link saves the page's current HTML as a blob (`1580-1587`). The running pet state is not included.
- It also loads Tailwind from a CDN (`tamagochi/index.html:7`).

**Coin flow: broken**
- Every button and arrow key calls `notifyParentCoin()` (`1589-1621`). It posts `{type:'tamagochi_coin'}` only when `window.parent !== window`.
- The main app does not embed gIVEMEGOCHI. It links to it with `<a href="tamagochi/index.html" target="_blank">` (`public/index.html:588`), so in the new tab `window.parent === window` and nothing is sent.
- The listener at `public/script.js:1898-1903` requires `document.getElementById('tamagochi-iframe')`. No element with that id exists in `public/index.html`; it only appears in the old root-level `script.js:2284`.
- Result: the flow is dead at both ends.
- If it did work, every tap (including arrow-key movement) would award +1 coin (`coins.js:21`), which is farmable. The pet's own coin count is separate and never synced.
- An `?embed=1` compact mode already exists (`tamagochi/index.html:668-720`, `855`) but nothing uses it.

**User and RPG awareness: none.** The file never reads `givemegame_user`, Supabase, or `/api/rpg/*`.

**Gaps to "complete the connection"**
1. Embed it: replace the link with `<iframe id="tamagochi-iframe" src="tamagochi/index.html?embed=1">`, or have the tab also post to `window.opener`.
2. Award coins from pet events (level up, finished minigame) rather than from every tap, and add a server-side cap.
3. Save the pet:
   - Simplest: localStorage keyed by uid, the same pattern as `narrator.js:34-50`.
   - Proper: add a `pet_state` JSONB column on `profiles` plus `GET/PATCH /api/pet`, modelled on `/api/user/preferences` (`server.js:3113`).
4. Have the parent send `{type:'pet_syncUser', user, rpgLevel, avatarId}`, the same pattern as `giveme_syncUser` (`script.js:1715-1722`). The RPG level is available from `RpgTalents.load()` → `progression.level` (`public/js/rpg-screen.js:373`, `lib/rpg-progression.js:103-118`).
5. Check message origins: the child currently posts with `'*'`. Only gIVEME checks the origin (`gIVEME/script.js:1463`).
6. Optionally show the pet on gIVEME profiles, and award RPG XP for pet care through `awardXpInTransaction` (`lib/rpg-progression.js:180`), which today only robot_challenge uses (`server.js:1473-1476`).

## 4. gIVEME social network (`public/gIVEME/`)

**Features**
- Pixel-art post feed (`loadFeed`, `script.js:330`)
- Likes and double-tap like (`584`, `722`)
- Follow/unfollow (`126-183`)
- Comments (`873-1001`)
- Coin donations to posts (`761-835`)
- Share (`1034`) and stories (`1079-1145`)
- Pixel-canvas post creation with prompt suggestions, published to `giveme_posts` (`1190-1349`)
- User search (`1373`) and a user-profile modal showing posts, followers and following (`641-715`)

**How it gets the user**
1. Its own Supabase client calls `syncAuthFromSupabase()` (`script.js:8-58`). It also upserts the `profiles` row.
2. Otherwise it reads `sessionStorage` or `localStorage` `givemegame_user` (`17-26`).
3. The parent posts `giveme_syncUser`, either from `onGivemeLoad` (`public/script.js:1724-1729`) or in answer to the child's `giveme_requestSync`, which the child sends 3 times (`gIVEME/script.js:1547-1551`; handler at `public/script.js:1886-1891`).

**Access and coins**
- The tab is gated on the parent side: login is required, then Pro (`public/script.js:1605-1627`). The iframe still loads eagerly when the page loads (`index.html:754`).
- Coins call `window.parent.App.Coins` directly (same origin) (`gIVEME/script.js:191-217`, `775-808`).
- Display oddities:
  - The starting balance is hard-coded to 42 (`gIVEME/script.js:186`) when the parent is not reachable.
  - The XP bar is fake: it starts at 35% and is never linked to RPG XP (`218`, `542-549`).

**Why "RPG Avatar: Prihlás sa a vyber si svojho hrdinu" shows while logged in**
- This block is in the main app's Profile tab, `#rpg-avatar-container` (`index.html:710`), not inside gIVEME.
- `Profile.open()` decides "logged in" from the cached `getCurrentUser()` session value (`public/script.js:1534`). It then runs `RpgAvatar.load().then(renderProfileAvatar)` (`script.js:1567-1569`).
- `renderProfileAvatar` prints the login message whenever `_data` is null or not eligible (`public/js/rpg-avatar.js:129-143`).
- `load()` returns null in all of these cases (`rpg-avatar.js:47-65`):
  1. The Supabase `getSession()` call fails or takes longer than 8 seconds (`28-36`).
  2. `/api/rpg/avatar` returns anything other than OK:
     - 503 when the coin API is not configured (`server.js:3206`, `442-451`)
     - 401 when `requireSupabaseUser` fails, for example because Supabase auth is down
     - 500 when the database query fails (`server.js:3228-3231`)
  3. A network error or a 12-second timeout (`rpg-avatar.js:41`).
  4. The `_loading` guard returns the cached null when two calls overlap (`rpg-avatar.js:48`).
- The server itself marks every logged-in user as eligible (`server.js:3210`, `3220`). So on a working database, a logged-in user would see the hero picker.
- **Current symptom:** with production Supabase paused, case 2 applies, so this is a DB-down symptom.
- **Real code bug:** the UI shows the same login text for every failure. It should show "couldn't load, try again" when `getCurrentUser()` is set but the load failed. The comment at `rpg-avatar.js:130` admits the cases are combined.

## 5. Where to hook in the SMARTA portrait and roaming pets

**SMARTA portrait docked at the bottom-right of the game area**
- Mount point: `main#game-viewport` (`public/index.html:332`). Add an `position:absolute` child, or a fixed element anchored to that area.
- Reuse the existing pixel portrait markup and `.narrator-avatar-pixel.smarta` CSS (`index.html:566-575`, `public/style.css`), or swap in a sprite.
- Make `Narrator` reusable for chat. Today `onNarratorClick` and `speakAndAward` are private and depend on `#narrator-bot` (`narrator.js:334-336`); only `init`, `refreshHint` and `loadSmartaStyles` are exported (`445`).
- A chat window needs a new server route, for example `POST /api/smarta/chat`. Copy the plan gate from `random-fact` (`server.js:3895-3921`) and the 150-token cap (`3973`), plus a per-user rate limit (see `rpgRateLimit`, `server.js:3176-3188`).
- Keep the free tier free: canned or local replies plus Web Speech.

**Roaming pets (Clippy-style)**
- **Unlock source:** RPG level from `RpgTalents.load()` (`public/js/rpg-talents.js:44`, exposed at `273`), using `progression.level` 1-10 (`lib/rpg-progression.js:21-24`). Level-up events already show a toast (`coins.js:350-355`, `session.js:273-274`), so pets can be unlocked there.
- **Layering:** pets should be a fixed overlay. "Hiding behind panels" means a z-index between the left filters aside (ends at `index.html:329`), the main area and the right `#game-tools-panel` (`521`), so the panels draw on top of the pets.
- **Rewards:** use `Coins.award(source)` (`coins.js:101`). Any new reward names must also be added to `lib/coin-log-policy.js` `REWARD_BASE`, otherwise `/api/coins/log` rejects them (`server.js:1442-1445`); a test re-reads `coins.js` (`coin-log-policy.js:9`). XP needs a server route that calls `awardXpInTransaction`.
- **Low AI cost:** serve tips and challenges from static JSON, the same way `data/narrator-facts.json` is used by both server and client (`narrator.js:94-106`).
- **Messaging:** reuse the `giveme_*` postMessage pattern for any pet iframes, and add origin checks.
- **Graceful degradation:** pet state should live in localStorage first, with the server as an optional sync, so pets keep working while Supabase is paused.