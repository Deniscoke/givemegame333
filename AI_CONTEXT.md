# AI_CONTEXT.md — gIVEMEGAME.IO

> **Účel tohto súboru:** Jediný zdroj pravdy o stave projektu pre AI asistentov.
> Skopíruj ho do nového chatu (ChatGPT / Claude / Cursor / iné), aby AI vedelo,
> s čím pracuje, **predtým** ako začne písať kód alebo navrhovať zmeny.
>
> **Aktualizované:** 2026-05-08 · **Vetva:** main · **Deploy:** Vercel (`givemegame333.vercel.app`)

---

## 0) Ako tento súbor používať (TL;DR pre AI)

Si AI asistent, ktorý dostal tento dokument ako kontext. Než odpovieš:

1. Prečítaj sekcie 1–4 (čo to je, stack, štruktúra, hlavné moduly).
2. Pri otázke o konkrétnej funkcii nájdi sekciu (5–13) — sú indexované podľa domény (Billing, RPG, Edu, Sessions…).
3. Pri písaní/úprave kódu **vždy** uveď konkrétny súbor a približný riadok, vrátane existujúcich konvencií (vid. sekcia 14).
4. Pri databáze pozri sekciu 6 — názvy tabuliek, stĺpce, migrácie.
5. Tento projekt je **v slovenčine + češtine**. UI texty sú primárne CZ (RVP), kódové komentáre miešané SK/CS/EN. Hovor po slovensky, ak používateľ neoznámi inak.

---

## 1) Čo to je?

**gIVEMEGAME.IO** je webová aplikácia — **inteligentný generátor vzdelávacích hier** pre učiteľov, lektorov a facilitátorov v česko-slovenskom školstve. Generuje pedagogicky podložené hry pomocou OpenAI GPT podľa filtrov (režim, vek, počet hráčov, trvanie, RVP kompetencie, prostredie). Výstup v Gen Z štýle.

Okrem generátora obsahuje:

- **Multiplayer sessions** (lobby, join code, reflexia, kompetenčné odmeny).
- **RPG vrstvu** (avatar, level, talenty, perky, XP zo sessions a sólo hier).
- **gIVEME** — mini sociálnu sieť s pixel-art postami (iframe).
- **Tamagochi / SMARTA / Robot Challenge** — vedľajšie minihry / odmeny.
- **gIVEMEEDU** — administračný modul škôl (triedy, gradebook, dochádzka, role admin/teacher/student).
- **Billing** — tier-based predplatné cez Stripe (free / teacher / school / admin) + legacy Payment Link MVP.

**Cieľová skupina:** ZŠ + SŠ (RVP ZV kurikulum). Jazyky: SK, CS, EN, ES.

---

## 2) Tech stack

| Vrstva       | Technológia                                                                |
|--------------|----------------------------------------------------------------------------|
| Backend      | Node.js + Express 4 (`server.js`, ~3700 riadkov, jeden file)               |
| Frontend     | Vanilla JS, IIFE moduly (žiadny framework, žiadny bundler)                 |
| Build        | Žiadny — Vercel servuje `server.js` priamo (`@vercel/node`, maxDuration 60)|
| AI           | OpenAI SDK (`openai` v4) — `gpt-4o` (chat) + `gpt-4o-mini-tts` (TTS)       |
| Auth         | Supabase Auth (Google OAuth, JWT v `Authorization: Bearer …`)              |
| DB           | Supabase PostgreSQL cez `pg` Pool (NIE supabase-js na backende)            |
| Platby       | Stripe (`stripe` v22) — webhook + Customer Portal + Checkout Session       |
| Fonty        | Press Start 2P, VT323                                                      |
| Testing      | `node --test` (vstavané) — `test/` + `test/integration/`                   |
| Deploy       | Vercel (primárny), Render (záloha — `render.yaml`)                         |

**Závislosti** (`package.json`): cors, dotenv, express, openai, pg, stripe.

---

## 3) Štruktúra repozitára (zhora nadol)

```
gIVEMEGAME.IO-OPENCLAW/
├── server.js                    # Express backend — VŠETKY route definície
├── package.json                 # node, scripts: start, dev, db:migrate, test
├── vercel.json                  # routing — všetko ide cez server.js
├── render.yaml                  # alternatívny deploy
├── .env.example                 # šablóna env premenných (kópia → .env)
│
├── lib/                         # backend moduly (require'd zo server.js)
│   ├── billing.js               # tier system, Stripe helpers, requireTier middleware
│   ├── plan-entitlements.js     # Free vs Pro limity (single source of numbers)
│   ├── plan-usage.js            # počítadlá AI generations, robot, solo / 24h
│   ├── reward-validation.js     # gates: duration, participants, host cooldown
│   ├── edu-routes.js            # /api/edu/* router (~1100 riadkov)
│   ├── rpg-avatars.js           # avatar manifest, switch cost, validácie
│   ├── rpg-progression.js       # level/XP, computeSoloXpFromDurationMax
│   ├── rpg-talents.js           # talent tree, prereq validácia
│   └── game-schema.js           # JSON schema generovaných hier
│
├── public/                      # statické súbory + frontend SPA
│   ├── index.html               # hlavná app (3-panelové UI)
│   ├── login.html               # Google OAuth (Supabase)
│   ├── home.html / home.css     # marketingová landing
│   ├── pricing.html             # Ceník + consent modal (§ 1837 OZ)
│   ├── account.html             # /Můj účet — tier, fakturácia, Customer Portal
│   ├── choose.html              # výber rola po prihlásení
│   ├── game.html / game.js      # /game/:id — embed/share view
│   ├── script.js                # hlavný frontend kontroler (~72 KB)
│   ├── style.css                # ~145 KB — všetky štýly v jednom
│   ├── billing/                 # success.html, cancel.html
│   ├── edu/                     # gIVEMEEDU UI — index/classes/gradebook/...
│   │   ├── css/  js/
│   │   ├── classes.html attendance.html gradebook.html members.html
│   │   └── perk-requests.html
│   └── js/                      # IIFE moduly (window.App.*)
│       ├── coins.js             # App.Coins — balance, award, history
│       ├── game-api.js          # App.GameAPI — /api/generate-game wrapper
│       ├── game-ui.js           # rendering hier, panely
│       ├── game-edit.js         # inline edit vygenerovaných hier
│       ├── library.js           # /knižnica — saved_games CRUD
│       ├── narrator.js          # SMARTA UI + TTS prehrávanie
│       ├── reflection.js        # 7+2 otázky po hre
│       ├── session.js           # multiplayer lobby/start/complete
│       ├── timer.js             # countdown + +500 coinov
│       ├── rpg-avatar.js / rpg-screen.js / rpg-talents.js / rpg-xp-fx.js
│       └── sfx.js
│
├── supabase/migrations/         # 001–027 SQL (spúšťané manuálne v Supabase SQL editori)
│
├── source of knowledge/         # .txt/.md/.json — injectované do AI promptu pri generovaní hier
│
├── docs/                        # dizajnové a operačné dokumenty
│   ├── BILLING_MVP.md  BILLING_PAYMENT_LINK_MVP.md  TROUBLESHOOTING_BILLING.md
│   ├── ENV_SETUP.md  MIGRATION_012_READINESS.md  SMOKE_TEST_PLAN.md
│   ├── LAUNCH_AND_COMPLETION.md  gIVEMECOIN_*.md
│   └── plans/
│
├── gIVEME/                      # mini sociálna sieť (samostatný iframe)
├── tamagochi/                   # mini-hra (iframe)
├── no robot test/               # Robot Challenge (React) — CAPTCHA, +250 coinov
├── Avatars/                     # avatar PNG-ká (1.png … 8.png)
├── scripts/run-supabase-migrations.js  # `npm run db:migrate`
└── test/                        # node --test
    ├── reward-validation.test.js
    └── integration/  (billing, sessions, edu)
```

**Kľúčový princíp:** `server.js` je monolit. Reward logika, generation orchestration, sessions, billing, RPG, edu — všetko tu. Iba `edu-routes.js` je vyextrahovaný router.

---

## 4) Hlavné domény / moduly (mapa)

| Doména              | Backend (server.js riadky)               | Frontend                                    | DB tabuľky                                                  |
|---------------------|------------------------------------------|---------------------------------------------|-------------------------------------------------------------|
| Game generation     | `/api/generate-game` (~827)              | `public/js/game-api.js`, `game-ui.js`       | —                                                           |
| Saved games         | `/api/games/*` (~2484–2724)              | `public/js/library.js`                      | `saved_games`                                               |
| Sessions            | `/api/sessions/*` (~2038–2484)           | `public/js/session.js`                      | `sessions`, `session_participants`                          |
| Coins               | `/api/coins/*` (~1199–1300)              | `public/js/coins.js`                        | `profiles.coins`, `coin_transactions`                       |
| Reward validation   | `/api/sessions/:code/complete` (~2242)   | `session.js` (volá `/complete`)             | `sessions.reward_validation`, `mode_clicks_daily`           |
| RPG (avatar/level)  | `/api/rpg/*` (~2816–3284)                | `rpg-screen.js`, `rpg-avatar.js`, `rpg-talents.js` | `profiles` (rpg_*), `rpg_talents`, `rpg_perks`        |
| EDU (school admin)  | `/api/edu/*` (router v `lib/edu-routes.js`) | `public/edu/*`                           | `edu_schools`, `edu_school_memberships`, `edu_classes`, `edu_class_enrollments`, `edu_subjects`, `edu_teaching_assignments`, `edu_gradebook_*`, `edu_attendance` |
| Billing (tiered)    | `/api/billing/*` (~1299–1620)            | `pricing.html`, `account.html`              | `billing_subscriptions`, `billing_events`, `profiles.tier`  |
| Billing (legacy MVP)| webhook + manual flag                    | (nepoužíva sa pri novom flow)               | `user_billing`                                              |
| SMARTA narrator     | `/api/random-fact`, `/api/tts` (~3500–3736) | `narrator.js`                            | `narrator_preferences`, denný cap počítadlo                 |
| gIVEME social       | (priamo cez Supabase z frontendu)        | `gIVEME/` iframe                            | `giveme_posts`, `giveme_likes`, `giveme_comments`, `giveme_coin_donations` |

---

## 5) API endpointy (kompletný zoznam podľa domény)

### Game generation & library
- `POST /api/generate-game` — OpenAI generation, fallback na `public/data/games.json`. Rate limit: 8/min Free, 30/min Pro.
- `POST /api/games/save` · `GET /api/games/library` · `GET /api/games/:id`
- `GET /api/games/public/:id` (sharable)
- `PATCH /api/games/:id` · `…/favorite` · `…/publish` · `…/rate` · `DELETE /api/games/:id`

### Sessions (multiplayer)
- `POST /api/sessions` — vytvor lobby (host)
- `GET /api/sessions/:code` — stav
- `POST /api/sessions/:code/join` — pripoj sa, **−100 coinov** (pôvodný dizajn 200, kód má 100)
- `POST /api/sessions/:code/start` · `…/reflect` · `…/complete` (atomic CAS, 5 reward gates)
- `GET /api/sessions/:code/my-reward` — výsledok pre konkrétneho hráča

### Coins
- `GET /api/coins/balance` · `GET /api/coins/history`
- `POST /api/coins/log` — server-side log z FE
- `POST /api/coins/award-mode-click` — denný cap (`mode_clicks_daily`)
- `POST /api/shop/purchase` — minutie coinov za item

### Profile & analytics
- `POST /api/profile/complete-solo` — sólo timer + reflexia
- `POST /api/verify-completion` — AI overenie fotky (bonus +100 XP / +75 coinov)
- `GET /api/profile/competencies` · `GET /api/profile/analytics`
- `GET/PATCH /api/user/preferences`

### RPG
- `GET/PATCH /api/rpg/avatar` (switch cost = `RPG_AVATAR_SWITCH_COST`)
- `GET /api/rpg/talents` · `POST /api/rpg/talents/unlock` (+25 XP idempotentne)
- `GET /api/rpg/perks` · `POST /api/rpg/perks/:key/use`

### EDU (`lib/edu-routes.js` mounted on `/api/edu`)
- `GET /me` — moja škola/role/membership
- `POST /schools` (admin len) · `GET /classes` · `POST /classes`
- `GET/POST /students` · `GET/POST /subjects` · `POST /teaching-assignments`
- `GET/POST /members` · `PATCH /members/:id` · `DELETE /members/:id`
- `GET/POST /gradebook` · `…/items` · `…/entries`
- `GET/POST /attendance`
- `GET /users/by-email` (lookup, rate-limited)
- (server.js): `GET /api/edu/perk-requests` · `POST …/:id/decide` · `GET /api/edu/students/:userId/rpg`

### Billing
- `GET /api/billing/public-config` · `GET /api/billing/state` · `GET /api/billing/tier`
- `GET /api/billing/upgrade-url` · `POST /api/billing/checkout` (vytvorí Stripe Checkout Session + uloží consent)
- `GET /api/billing/legal-versions` · `POST /api/billing/portal` (Customer Portal)
- `POST /api/billing/stripe-webhook` — RAW body (parser scoped iba na túto cestu)

### SMARTA / TTS
- `GET /api/random-fact` (denný cap 10) · `GET /api/narrator-areas`
- `POST /api/tts` (OpenAI TTS, Pro only)

### Misc
- `GET /api/status` · `GET /api/knowledge` · `POST /api/knowledge/reload`
- HTML routes: `/`, `/login`, `/billing/success`, `/billing/cancel`, `/choose.html`, `/edu`, `/edu/<page>.html`, `/game/:id`

---

## 6) Databáza (Supabase Postgres) — migrácie

Migrácie sa spúšťajú **manuálne v Supabase SQL Editori** (alebo `npm run db:migrate`). Idempotentné — používajú `IF NOT EXISTS` / `DO $$`.

| #     | Súbor                                      | Obsah                                                                  |
|-------|--------------------------------------------|------------------------------------------------------------------------|
| 001   | `001_profiles_and_follows.sql`             | `profiles` (auto-trigger pri Google login), `follows`                  |
| 002   | `002_add_coins_to_profiles.sql`            | `profiles.coins INT DEFAULT 150`                                       |
| 003   | `003_giveme_social.sql`                    | `giveme_posts`, `giveme_likes`, `giveme_comments`, `giveme_coin_donations` |
| 004   | `004_add_prompt_to_posts.sql`              | `giveme_posts.prompt`                                                  |
| 005   | `005_quest_log.sql`                        | denné questy                                                           |
| 006   | `006_coin_transactions.sql`                | `coin_transactions` (audit)                                            |
| 007   | `007_add_scoreboard_to_profiles.sql`       | scoreboard polia                                                       |
| 008   | `008_smarta_styles.sql`                    | SMARTA štýly                                                            |
| 009   | `009_saved_games.sql`                      | `saved_games`                                                          |
| 010   | `010_narrator_preferences.sql`             | `narrator_preferences`                                                 |
| 011   | `011_sessions_and_progression.sql`         | `sessions`, `session_participants`, `competency_points` JSONB          |
| 012   | `012_reward_validation.sql`                | `sessions.started_at`, `reward_validation` JSONB, `status='completing'`|
| 013   | `013_game_feedback.sql`                    | feedback                                                               |
| 014   | `014_public_token.sql`                     | sharable token                                                         |
| 015   | `015_mode_click_daily_cap.sql`             | `mode_clicks_daily`                                                    |
| 016   | `016_billing.sql`                          | **Legacy** `user_billing`, `billing_events` (Payment Link MVP)         |
| 017   | `017_payment_link_manual_billing.sql`      | `paid_access_enabled`, `billing_note`                                  |
| 018   | `018_edu_core.sql`                         | `edu_schools`, `edu_school_memberships`, `edu_classes`, `edu_class_enrollments`, `edu_subjects`, `edu_teaching_assignments`, `edu_gradebook_*`, `edu_attendance`, `edu_audit_log` |
| 018b  | `018_plan_usage_daily.sql`                 | `plan_usage_daily` — počítadlá AI generations / 24h                    |
| 019\* | `019_edu_add_parent_role.sql.DISABLED`     | (disabled — Sprint 2)                                                  |
| 020   | `020_profiles_add_email.sql`               | `profiles.email` + sync trigger                                        |
| 021   | `021_audit_append_only.sql`                | append-only audit log enforcement                                      |
| 022   | `022_rpg_avatar.sql`                       | `profiles.rpg_avatar_id`, switch ledger                                |
| 024   | `024_rpg_progression.sql`                  | `profiles.rpg_level`, `rpg_xp`, talent unlock log                      |
| 025   | `025_level_perks.sql`                      | `rpg_perks` katalóg + `rpg_perk_uses`                                  |
| 026   | `026_billing.sql`                          | **Tier system**: `profiles.tier`, `billing_subscriptions`, `billing_events`, `effective_tier(uuid)` SQL fn, `daily_games_count` |
| 027   | `027_billing_consent.sql`                  | `withdrawal_consent_at/_ip/_text`, `tos_version`, `privacy_version`, `v_billing_consent_audit` view |

### Kľúčové tabuľky (zhrnutie)

- **profiles** — `id, email, coins INT, competency_points JSONB, games_generated, games_exported, tier ('free'|'teacher'|'school'|'admin'), rpg_avatar_id, rpg_level, rpg_xp, daily_games_count, daily_games_day, withdrawal_consent_at, tos_version, privacy_version`
- **sessions** — `id, host_id, game_json JSONB, join_code, status ('waiting'→'active'→'reflection'→'completing'→'completed'), started_at, completed_at, reward_validation JSONB`
- **session_participants** — `session_id, user_id, coins_paid, reflection_done, awarded_competencies JSONB`
- **coin_transactions** — `user_id, amount, action, metadata JSONB, created_at`
- **billing_subscriptions** — `user_id, school_id, tier, stripe_customer_id, stripe_subscription_id (UNIQUE), stripe_price_id, status, current_period_*, cancel_at_period_end, trial_end`
- **billing_events** — `stripe_event_id UNIQUE, type, user_id, subscription_id, payload JSONB, processed_at` (idempotency)
- **edu_*** — pozri migráciu 018 (multi-tenant, RLS, audit log)

### `effective_tier(p_user UUID)` SQL funkcia
Vracia `MAX(profiles.tier, inherited_tier_from_teacher)` — žiak v triede platiaceho učiteľa získa `teacher` tier (level cap zrušený, perky 6+), ale **nemôže sám vytvárať triedy**.

---

## 7) Tier system & monetizácia (aktuálny model)

| Tier      | Kto                                       | Cap dennej generácie | Level cap | Perk lvl cap | Súbežné lobby |
|-----------|-------------------------------------------|----------------------|-----------|--------------|----------------|
| `free`    | default (sólo žiak)                       | 3                    | 5         | 5            | 1              |
| `teacher` | platiaci učiteľ (Stripe `teacher_monthly` alebo `teacher_yearly`) | unlimited | unlimited | unlimited | unlimited |
| `school`  | celá škola (Stripe `school_yearly`)       | unlimited            | unlimited | unlimited    | unlimited      |
| `admin`   | interný (my)                              | bypass všetkých gates | —         | —            | —              |

**Pozn.:** `lib/plan-entitlements.js` definuje aj `pro` plán (legacy `pro_teacher_monthly`) so semi-limity (25 solo/24h, 30/min). Tento systém ostáva pre backward compat — nový kód volá `getEffectiveTier()` z `lib/billing.js`.

### Stripe konfigurácia (env)

```
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_TEACHER_MONTHLY=price_...
STRIPE_PRICE_TEACHER_YEARLY=price_...
STRIPE_PRICE_SCHOOL_YEARLY=price_...
STRIPE_CHECKOUT_SUCCESS_URL=    # voliteľné, default = host/billing/success
STRIPE_CHECKOUT_CANCEL_URL=
STRIPE_PORTAL_RETURN_URL=
```

### Webhook events handlované
`checkout.session.completed`, `customer.subscription.created/updated/deleted`, `invoice.payment_failed`. Idempotency cez `billing_events.stripe_event_id UNIQUE`.

### Consent (§ 1837 OZ — okamžité plnenie digitálnej služby)
Pri checkoute musí používateľ zaškrtnúť:
1. Súhlas s okamžitým plnením (vzdanie sa 14-dňového odstúpenia).
2. Súhlas s ToS/Privacy.

Server uloží `withdrawal_consent_at/_ip/_text + tos_version + privacy_version` do `profiles`. UI: `pricing.html` consent modal.

---

## 8) Reward & validation system (sessions a sólo)

**5 brán** v `/api/sessions/:code/complete` (musia prejsť všetky):

1. **Trvanie:** `(now − started_at) >= max(game.duration.min, 3)` min → `DURATION_TOO_SHORT`
2. **Počet hráčov:** `COUNT(coins_paid > 0) >= max(game.playerCount.min, 1)` → `NOT_ENOUGH_PLAYERS`
3. **Cooldown hosta:** `< 5 sessions / rolling hour` → `HOST_COOLDOWN`
4. **Reflexia:** `reflection_done = true AND awarded_competencies IS NULL` (nie je double-award)
5. **Solo daily limit (pre `/profile/complete-solo`):** `< 5 (free) / 25 (pro) / 24h`

Atomic CAS na status `'reflection' → 'completing' → 'completed'` zabraňuje double-awardingu.

### Konštanty (v `server.js`)

```js
SESSION_JOIN_COST = 100         // -100 coinov za join (kódový stav; design docs hovoria 200)
COMPLETION_BONUS  = 100         // +100 coinov za session/solo complete
COMPETENCY_AWARD  = 50          // +50 bodov na kompetenciu (per kompetencia hry)
TALENT_XP_AWARD   = 25          // za odomknutie talentu
SESSION_XP_AWARD  = 75          // za session complete
ROBOT_XP_AWARD    = 30          // za robot challenge
VERIFICATION_XP_BONUS   = 100   // za úspešné AI overenie fotky
VERIFICATION_COIN_BONUS = 75
MIN_SESSION_DURATION_FLOOR = 3  // min
HOST_COOLDOWN_MAX = 5
JOIN_CODE_LENGTH = 6            // chars from JOIN_CODE_CHARS (bez 0/O/I/1)
```

### 7 RVP kompetencií (whitelist)
`k-uceni`, `k-reseni-problemu`, `komunikativni`, `socialni-personalni`, `obcanske`, `pracovni`, `digitalni`

Každá hra má `game.rvp.kompetence: string[]` — za session/solo complete sa pripočíta `+50` bodov za každú kompetenciu (permanent, len rastú).

---

## 9) RPG vrstva

- **Avatar:** 8 možných (`Avatars/1.png` … `8.png`), switch stojí coiny (konštanta v `lib/rpg-avatars.js`).
- **Level:** `computeRpgLevel(xp)` — krivka v `lib/rpg-progression.js`. **Free tier capnutý na 5** (`applyLevelCap` v `server.js`).
- **Talenty:** strom s prereq validáciou, `rpg_talents` tabuľka, +25 XP per unlock (idempotentné cez UNIQUE constraint).
- **Perky:** levelové odmeny v `rpg_perks` (migrácia 025), použitie loguje `rpg_perk_uses`.
- **Solo XP scaling:** `computeSoloXpFromDurationMax(game.duration.max)` — dlhšie hry = viac XP.
- **Mapping kompetencia → RPG stat** (`GAME_KOMP_TO_STAT` v `server.js`):
  - `k-uceni → focus`, `k-reseni-problemu → insight`, `komunikativni / socialni-personalni → communication`, `obcanske → resilience`, `pracovni → strategy`, `digitalni → insight`.

---

## 10) gIVEMEEDU (school admin modul)

**Sprint 1 hardened** (Sprint 2 = parent role, deferred). Kľúče v `lib/edu-routes.js`:

- **Tenancy:** každý query má `school_id` filter; RLS je defense-in-depth (service role bypasses).
- **Audit:** všetky writes logované do `edu_audit_log` (actor, school, entity, old/new state).
- **Rate limit:** in-memory per-instance (Vercel cold start = reset; akceptovateľné).
- **Soft-delete only:** `archived_at` na core records (grades/attendance) — žiadny hard delete.
- **Roles:** `admin`, `teacher`, `student` (parent **deferred** — nie je access path).
- **Tier gate:** EDU funkcie vyžadujú minimálne `teacher` tier (cez `requireTier` middleware).

UI: `public/edu/index.html` (rozcestník), `classes.html`, `gradebook.html`, `attendance.html`, `members.html`, `perk-requests.html`.

---

## 11) Coins economy (gIVEMECOIN)

| Akcia                       | Suma  |
|-----------------------------|-------|
| Nový používateľ (starter)   | +150  |
| Generate game               | −125  |
| Surprise game               | −50   |
| Join session                | −100 (kód) / −200 (design docs) |
| Session complete            | +100  |
| Solo complete               | +100  |
| Timer complete              | +500  |
| Robot Challenge             | +250  |
| SMARTA fakt (max 10/deň)    | +50   |
| AI photo verify             | +75 (+ 100 XP) |

**Netto za session:** −100 (zámerný drain — anti-farm).

---

## 12) AI generation pipeline

1. **Vstup** (`POST /api/generate-game`): filtre (mode, age, players, duration, setting, RVP), `language`, voliteľne `customPrompt`.
2. **Knowledge injection:** server načíta súbory zo `source of knowledge/` (.txt/.md/.json) a vsunie ich ako system context.
3. **OpenAI call:** `gpt-4o`, `temperature` z env (default 0.8), `max_tokens` 5000.
4. **Validation & sanitization:** výstup musí matchovať schemu z `lib/game-schema.js`. Pri zlyhaní → `games.json` fallback.
5. **Counters:** `incrementAiGenerationsSuccess()` zapíše do `plan_usage_daily` (pre denný cap).
6. **Rate limit:** 8/min Free, 30/min Pro (per IP+user).

### Schéma generovanej hry (JSON)

```json
{
  "id": "ai-xxxxxx",
  "title": "string",
  "pitch": "string",
  "playerCount": { "min": 2, "max": 15 },
  "ageRange":    { "min": 8, "max": 15 },
  "duration":    { "min": 15, "max": 30 },
  "setting": "indoor|outdoor|any",
  "mode":    "party|classroom|reflection|circus|cooking|meditation",
  "materials":     ["string"],
  "instructions":  ["string"],
  "learningGoals": ["string"],
  "rvp": { "kompetence": ["k-uceni"], "oblasti": [], "stupen": "prvni|druhy" }
}
```

---

## 13) Bezpečnosť & compliance

- **CORS:** allowlist cez `ALLOWED_ORIGINS` (comma-separated). Bez env = wildcard (iba dev).
- **CSP:** `default-src 'self'`, povolené iba `cdn.jsdelivr.net` + `fonts.googleapis.com/gstatic.com` + `*.supabase.co`. `frame-src 'self'` (iframe gIVEME), `frame-ancestors 'self'`.
- **Headers:** `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin`, `HSTS: 2 years; includeSubDomains`, `Permissions-Policy` (camera/mic/geo off).
- **Stripe webhook:** RAW body parser **scoped iba** na `/api/billing/stripe-webhook` (musí ísť pred `express.json()`).
- **Auth:** každý chránený endpoint volá `requireSupabaseUser(req, res)` → vráti user objekt z JWT (alebo už odpovedal 401).
- **Audit:** `edu_audit_log` (append-only enforcement v migrácii 021), `coin_transactions`, `billing_events`, `sessions.reward_validation` JSONB stopa.
- **Trust proxy:** `app.set('trust proxy', 1)` pre správne `req.ip` za Vercel/nginx.
- **Privacy:** žiaden hard-delete na grades/attendance, GDPR consent pri checkoute uložený s IP a textom.

---

## 14) Konvencie kódu (riaď sa nimi pri zmenách)

- **Backend:** `'use strict'`, CommonJS (`require`/`module.exports`). Tabby na indent (server.js používa tabs aj spaces — drž štýl daného súboru).
- **Frontend:** žiadne moduly cez `import` — IIFE pattern (`(function(){ ... window.App = window.App || {}; window.App.X = ...; })();`).
- **i18n:** `window.givemegame_t(key, fallback)` — kľúče v `public/data/i18n/{sk,cs,en,es}.json`.
- **DB queries:** parametrizované (`$1, $2, …`), nikdy string concat. Vždy preferuj `pg` Pool nad supabase-js na backende.
- **Error handling:** chyby z DB obal v try/catch, fallback (napr. `getUserBillingState` má fallback ak migrácia nebežala — kontroluje `e.code === '42703'` / `42883'`).
- **Komentáre:** miešané SK/CS/EN; pri nových sekciách použi banner `// ═══════…`.
- **Žiadne placeholder funkcie** — keď niečo pridávaš, musí to fungovať.
- **Idempotentné migrácie:** vždy `IF NOT EXISTS`, `DO $$ BEGIN ... END $$;` pre ALTER.

---

## 15) Lokálne spustenie

```bash
npm install
copy .env.example .env
# vlož OPENAI_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_DB_URL, STRIPE_*

npm run db:migrate     # spustí migrácie (alebo manuálne v Supabase SQL Editori)
npm start              # http://localhost:3000

npm test               # všetky testy (node --test)
npm run test:unit      # iba reward-validation
npm run test:integration
```

**Tunnel** pre testy s reálnym Supabase callbackom: `npm run tunnel` (localtunnel).

---

## 16) Vercel / produkcia

- URL: `https://givemegame333.vercel.app`
- `vercel.json`: jeden serverless function (`server.js`), maxDuration 60s.
- Env vars sa nastavujú v Vercel Dashboard → Settings → Environment Variables.
- Stripe webhook URL musí byť produkčná (`https://givemegame333.vercel.app/api/billing/stripe-webhook`).

---

## 17) Známe TODO / nedoriešené

1. **`SESSION_JOIN_COST`** — kód má 100, design docs hovoria 200. **Treba rozhodnúť** a unifikovať.
2. **`019_edu_add_parent_role.sql.DISABLED`** — Sprint 2, vyžaduje `edu_parent_student_links` a UI flow.
3. **Migration 012 (reward validation)** — overiť že je nasadená na produkčnom Supabase.
4. **CSP `unsafe-inline'`** — frontend má inline `<script>` blocky. Sprint 2: vytiahnuť do `.js` a prejsť na nonce-based CSP.
5. **Žiadne unit testy pre RPG progression / talents.**
6. **Rate limit** v `edu-routes.js` je in-memory — pri škálovaní (viac Vercel inštancií) treba Redis/Upstash.

---

## 18) Ako mi (AI) odpovedať

- **Frontend:** „V `public/js/session.js`, funkcia `complete()`…", „v `public/index.html`, panel `.competencies`…"
- **Backend:** „V `server.js` na riadku ~2242 (`/api/sessions/:code/complete`)…", „v `lib/billing.js`, `getEffectiveTier()`…"
- **DB:** „Tabuľka `sessions` so stĺpcami `started_at, reward_validation JSONB`…", „migrácia 026 pridáva…"
- **Konštanty:** vždy uveď konkrétne číslo zo sekcie 8 alebo 11.
- **Pri novej featúre:** najprv navrhni **(a) DB migráciu**, **(b) backend endpoint**, **(c) frontend modul**, **(d) test**. V tomto poradí.

---

## 19) Glosár

| Skratka  | Význam                                                              |
|----------|---------------------------------------------------------------------|
| RVP      | Rámcový vzdělávací program (CZ kurikulum pre ZŠ)                    |
| ZŠ / SŠ  | Základná / Stredná škola                                            |
| Stupeň   | `prvni` (1. stupeň, 1.–5. ročník) / `druhy` (2. stupeň, 6.–9.)      |
| SMARTA   | AI rozprávač/storyteller v app                                      |
| gIVEME   | Mini sociálna sieť (pixel-art posty)                                |
| gIVEMECOIN | In-app mena (coins)                                               |
| OZ       | Občanský zákoník (CZ právo) — § 1837 = digitálna služba consent     |
| RLS      | Row Level Security (Supabase/Postgres)                              |
| CAS      | Compare-And-Swap (atomic update v `/complete`)                      |

---

*Stav projektu k 2026-05-08. Pri väčšej zmene aktualizuj tento súbor — je to jediný zdroj pravdy pre AI.*
