# QA Report — gIVEMEGAME.IO

**Dátum:** 2026-03-15  
**Účel:** Kontrola kvality, checklist pre manuálne testovanie, zistené riziká

---

## 1. Prehľad projektu

- **Typ:** Webová aplikácia — generátor vzdelávacích hier
- **Tech:** Node.js + Express, Vanilla JS, Supabase, OpenAI, Vercel
- **Stav:** Funkčný MVP s Phase 4 (sessions, competency points, reward validation)

---

## 2. QA Checklist — Čo otestovať

### 2.1 Backend & API

| # | Test | Status | Poznámka |
|---|------|--------|----------|
| 1 | `GET /api/status` vracia JSON | ⬜ | Overiť `hasApiKey`, `model` |
| 2 | `POST /api/generate-game` s platnými filtrami | ⬜ | Vyžaduje OPENAI_API_KEY |
| 3 | `POST /api/generate-game` bez kľúča → fallback na games.json | ⬜ | |
| 4 | `GET /api/random-fact` (SMARTA) | ⬜ | Query: lang, area, style |
| 5 | `POST /api/tts` s textom | ⬜ | Vyžaduje OpenAI TTS |
| 6 | `GET /api/knowledge` vracia zoznam súborov | ⬜ | Z `source of knowledge/` |
| 7 | `GET /api/coins/balance` pre prihláseného | ⬜ | Vyžaduje JWT |
| 8 | `GET /api/coins/history` pre prihláseného | ⬜ | Limit 50 |
| 9 | `POST /api/sessions` — vytvorenie session | ⬜ | Host vytvorí lobby |
| 10 | `POST /api/sessions/:code/join` — join za coiny | ⬜ | 100 coins (SESSION_JOIN_COST v server.js) |
| 11 | `POST /api/sessions/:code/start` — started_at | ⬜ | Transition waiting → active |
| 12 | `POST /api/sessions/:code/complete` — reward gates | ⬜ | Duration, participants, cooldown |
| 13 | `POST /api/profile/complete-solo` — solo flow | ⬜ | Solo daily limit 10 |

### 2.2 Reward Validation Gates (Phase 4)

| # | Test | Očakávaný výsledok |
|---|------|---------------------|
| 1 | Session complete pred uplynutím `duration.min` | Chyba `DURATION_TOO_SHORT` |
| 2 | Session complete s menej hráčmi ako `playerCount.min` | Chyba `NOT_ENOUGH_PLAYERS` |
| 3 | Host dokončí >5 sessions za hodinu | Chyba `HOST_COOLDOWN` |
| 4 | Solo complete >10x za 24h | Chyba `SOLO_DAILY_LIMIT` |
| 5 | Dvojité volanie `/complete` na rovnakú session | Jedno udeľenie, druhé fail (atomic CAS) |

### 2.3 Frontend (manuálne)

| # | Test | Status |
|---|------|--------|
| 1 | Login cez Google OAuth | ⬜ |
| 2 | Zmena jazyka SK/CZ/EN/ES | ⬜ |
| 3 | Výber režimu (Party, Classroom, ...) | ⬜ |
| 4 | Nastavenie filtrov (vek, hráči, trvanie) | ⬜ |
| 5 | Klik SPAWNUJ HRU → generovanie | ⬜ |
| 6 | Klik Surprise → náhodná hra | ⬜ |
| 7 | Timer countdown + READY | ⬜ |
| 8 | Competency panel — zobrazenie po complete | ⬜ |
| 9 | SMARTA — fakt, TTS, daily limit | ⬜ |
| 10 | Coin menu (balance + história) | ⬜ |
| 11 | Robot Challenge (no robot test) | ⬜ |
| 12 | gIVEME iframe — posty, lajky | ⬜ |
| 13 | Tamagochi iframe | ⬜ |
| 14 | Mobile responsive (filtre, overlays) | ⬜ |
| 15 | Dark/Light theme | ⬜ |

### 2.4 Database & Migrácie

| # | Migrácia | Overiť v Supabase |
|---|----------|-------------------|
| 1 | 001–011 | Tabuľky existujú |
| 2 | **012** | `sessions.started_at`, `reward_validation`, status `completing` | **SPUSTIŤ MANUÁLNE** |
| 3 | 013–015 | game_feedback, public_token, mode_click_daily_cap |

---

## 3. Zistenia z kódu (code review)

### ✅ Silné stránky

- **Server-authoritative rewards** — všetka logika odmen v `server.js`, klient len zobrazuje
- **Atomic CAS** na `/complete` — `status = 'completing'` bráni double-awardingu
- **Competency whitelist** — `VALID_COMPETENCY_KEYS` filtruje neplatné kľúče
- **Transaction wrapper** — award loop v `BEGIN/COMMIT` — rollback pri chybe
- **i18n** — všetky 4 jazyky pokryté

### ⚠️ Riziká / obmedzenia

| Riziko | Popis | Odporúčanie |
|--------|-------|-------------|
| V1 solo deduplication | Per-game solo môže byť teoreticky zneužitý (10/day je globálne) | Phase 5: per-game hash v metadata |
| Source of Knowledge | Súbory >100KB sa preskakujú, celkový limit ~15K znakov | Dokumentovať limit pre používateľov |
| OpenAI rate limits | Žiadny explicit rate limiting na `/generate-game` | Pridať rate limit (napr. 10/min per IP) |
| Robot Challenge | Samostatná React app v `no robot test/` | Integrácia cez iframe — overiť CORS |

### 🔍 Nájdene v kóde

- **server.js:** `SESSION_JOIN_COST = 100` (design docs hovoria 200 — aktuálne je 100)
- **Žiadne TODO/FIXME** v hlavných súboroch (čistý kód)
- **Linter:** Žiadne chyby v `server.js`, `script.js`

---

## 4. Chýbajúce / nedokončené

1. **Unit testy** — projekt nemá `*.test.js` ani `*.spec.js`
2. **E2E testy** — žiadny Playwright/Cypress
3. **Migration 012** — musí sa spustiť manuálne v Supabase SQL Editori
4. **Integračné testy** reward gates — odporúčané pred production

---

## 5. Odporúčania pred nasadením

1. Spustiť migráciu 012 v Supabase (ak ešte nebeží)
2. Overiť `.env` na Vercel: `OPENAI_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
3. Manuálny smoke test: login → generate → timer → complete (solo i session)
4. Overiť coin flow: generate -125, join -100, complete +100

---

## 6. Stručný sumár

| Oblasť | Stav |
|--------|------|
| Backend API | ✅ Implementované |
| Reward validation | ✅ Implementované (012 treba spustiť) |
| Frontend | ✅ Funkčné |
| Testy | ❌ Chýbajú |
| Dokumentácia | ✅ PROJECT_OVERVIEW, reward-system, plány |

---

*Tento report používaj ako checklist pri QA fáze a pri predávaní projektu.*
