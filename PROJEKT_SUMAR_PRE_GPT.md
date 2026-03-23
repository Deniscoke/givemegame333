# gIVEMEGAME.IO — Súhrn projektu pre GPT

**Použitie:** Skopíruj celý obsah tohto súboru a vlož do nového chatu s ChatGPT. Poskytne to AI kompletný kontext pred tým, ako s ním budeš pracovať.

---

## Kontext pre AI asistenta

Ahoj! Potrebujem pomoc s projektom **gIVEMEGAME.IO**. Tu je súhrn čo to je, ako to funguje, čo je hotové a čo ešte treba.

---

## Čo to je?

**gIVEMEGAME.IO** je webová aplikácia — **inteligentný generátor vzdelávacích hier** pre učiteľov, lektorov a facilitátorov. Používa **OpenAI GPT** na generovanie hier podľa filtrov (režim, vek, počet hráčov, trvanie, prostredie atď.). Výstup je v Gen Z štýle — casual, s konkrétnymi príkladmi.

- **Cieľová skupina:** české/slovenské školstvo (RVP ZV kurikulum)
- **Jazyky:** SK, CS, EN, ES
- **Dvoj-mena:** `coins` (spotrebiteľné, zarábaš/míniš) + `competency points` (trvalá progresia, len rastú)

---

## Tech stack

| Vrstva | Technológia |
|--------|-------------|
| Backend | Node.js + Express |
| Frontend | Vanilla JS (modulárne, bez frameworku) |
| AI | OpenAI GPT (generovanie hier, TTS, fakty pre rozprávača) |
| Auth | Supabase (Google OAuth) |
| DB | Supabase PostgreSQL (pg Pool) |
| Deploy | Vercel (serverless) |
| Fonty | Press Start 2P, VT323 |

---

## Štruktúra súborov

```
├── server.js              # Backend — všetka reward logika tu
├── public/
│   ├── index.html         # Hlavná app
│   ├── login.html         # Google OAuth
│   ├── script.js          # Hlavný frontend controller
│   ├── js/                # Moduly (coins, game-api, game-ui, session, narrator, ...)
│   └── data/
│       ├── games.json     # Fallback keď AI zlyhá
│       ├── rvp.json       # RVP kurikulum (7 kompetencií)
│       └── i18n/          # sk, cs, en, es
├── supabase/migrations/   # 001–015 SQL migrácie
├── source of knowledge/   # .txt/.md/.json — AI ich injectuje do promptu
├── docs/plans/            # Design docs (reward-system, session-progression)
├── gIVEME/                # Mini sociálna sieť (iframe)
├── tamagochi/             # Tamagotchi mini-hra (iframe)
└── no robot test/         # Robot Challenge (React) — CAPTCHA, +250 coinov
```

---

## Čo je implementované (hotové)

### Jadro
- Generovanie hier cez `/api/generate-game` (OpenAI alebo fallback na games.json)
- 6 režimov: Party, Classroom, Reflection, Circus, Cooking, Meditation
- RVP filtre (stupeň, kompetencie, oblasti)
- 3-panelové UI: filtre vľavo, viewport hry v strede, kompetencie + SMARTA + história vpravo

### Coiny (gIVEMECOIN)
- Starter: 150 pre nových
- Mínus: Generate 125, Surprise 50, Join session 100
- Plus: Timer complete 500, Robot Challenge 250, SMARTA 50, Solo complete 100

### Phase 4 — Sessions a progresia
- Multiplayer sessions: host vytvorí lobby → join code → hráči vstupujú (100 coinov) → štart → reflection → complete
- **7 kompetencií** (k-uceni, k-reseni-problemu, komunikativni, socialni-personalni, obcanske, pracovni, digitalni)
- Odmena: +50 bodov na kompetenciu za session/solo complete
- **Reward validation gates:** duration (min 3 min), participant count, host cooldown (5/hod), solo daily limit (10/24h)
- Atomic CAS na `/complete` — bráni double-awardingu

### Ostatné
- **SMARTA** — AI rozprávač s faktami, TTS, 10 faktov/deň, +50 coinov
- **gIVEME** — pixel art posty, lajky, komentáre, darovanie coinov
- **Tamagochi** — mini-hra v iframe
- **Robot Challenge** — CAPTCHA (matika, sekvencia, emoji mriežka), +250 coinov
- **Knižnica** — ukladanie hier do Supabase `saved_games`
- **Inline edit** — úprava vygenerovaných hier v UI
- **Reflection** — 7 otázok na kompetencie + 2 otvorené po hre

---

## API endpointy (hlavné)

| Endpoint | Metóda | Účel |
|----------|--------|------|
| `/api/generate-game` | POST | Generuje hru |
| `/api/random-fact` | GET | SMARTA fakt |
| `/api/tts` | POST | OpenAI TTS |
| `/api/sessions` | POST | Vytvor session |
| `/api/sessions/:code/join` | POST | Pridaj sa (100 coinov) |
| `/api/sessions/:code/start` | POST | Štart hry |
| `/api/sessions/:code/complete` | POST | Dokončenie + odmeny |
| `/api/profile/complete-solo` | POST | Solo timer + reflection |
| `/api/coins/balance` | GET | Balance |
| `/api/coins/history` | GET | História transakcií |

---

## Databáza (Supabase)

- **profiles** — coins, competency_points (JSONB), games_generated, games_exported
- **sessions** — host_id, game_json, join_code, status (waiting→active→reflection→completing→completed), started_at, reward_validation
- **session_participants** — user_id, coins_paid, reflection_data, awarded_competencies
- **coin_transactions** — user_id, amount, action, metadata

---

## Čo treba ešte / QA

1. **Migrácia 012** — `started_at`, `reward_validation`, status `completing` — spustiť manuálne v Supabase SQL Editori
2. **Unit/E2E testy** — projekt ich nemá
3. **Integračné testy** reward gates — duration, participants, cooldown, solo limit
4. **SESSION_JOIN_COST** — v server.js je 100, design docs hovoria 200 (rozhodnúť ktorý)

---

## Schéma hry (JSON)

```json
{
  "id": "ai-xxxxxx",
  "title": "string",
  "pitch": "string",
  "playerCount": { "min": 2, "max": 15 },
  "ageRange": { "min": 8, "max": 15 },
  "duration": { "min": 15, "max": 30 },
  "setting": "indoor|outdoor|any",
  "mode": "party|classroom|reflection|circus|cooking|meditation",
  "materials": ["string"],
  "instructions": ["string"],
  "learningGoals": ["string"],
  "rvp": { "kompetence": ["k-uceni"], "oblasti": [], "stupen": "prvni|druhy" }
}
```

---

## Kľúčové konštanty (server.js)

- `SESSION_JOIN_COST = 100`
- `COMPETENCY_AWARD = 50`
- `COMPLETION_BONUS = 100`
- `VALID_COMPETENCY_KEYS` — whitelist 7 kompetencií
- `MIN_SESSION_DURATION_FLOOR = 3` (minúty)
- `HOST_COOLDOWN_MAX = 5` (sessions/hodinu)
- `SOLO_DAILY_LIMIT = 10`

---

## Termíny (CZ/SK)

- **Spawnuj hru** = Generuj hru
- **RVP** = Rámcový vzdělávací program
- **Stupeň** = prvni/druhy (1./2. stupeň ZŠ)
- **SMARTA** = AI rozprávač

---

## Ako ma osloviť pri pomoci

- **Frontend:** „V public/js/session.js, funkcia complete()…“, „V index.html, competency panel…“
- **Backend:** „V server.js, /complete endpoint…“, „Reward validation gates…“
- **DB:** „Tabuľka sessions“, „competency_points JSONB“
- **QA:** „Pomôž mi s testovaním reward gates“

---

*Stav projektu k marcu 2026. Pre detailný technický prehľad pozri PROJECT_OVERVIEW_FOR_AI.md. Pre QA checklist pozri QA_REPORT.md.*
