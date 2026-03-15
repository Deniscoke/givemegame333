# Prompt pre ChatGPT — Stav projektu gIVEMEGAME.IO
**Aktualizovaný:** 2026-03-15

**Skopíruj celý text nižšie a vlož ho do nového chatu s ChatGPT.**

---

Ahoj! Potrebujem pomoc s projektom **gIVEMEGAME.IO**. Tu je kompletný prehľad aktuálneho stavu.

---

## Čo to je?

**gIVEMEGAME.IO** je webová app — **inteligentný generátor vzdelávacích hier**. Pomáha učiteľom, lektorom a facilitátorom vytvárať pedagogicky podložené hry. Používa **OpenAI GPT** na generovanie hier podľa filtrov. Výstup je Gen Z štýl, casual, s konkrétnymi príkladmi.

**Cieľová skupina:** česko-slovenské školstvo (RVP ZV kurikulum), podporuje SK/CS/EN/ES.

---

## Tech stack

- **Backend:** Node.js, Express, OpenAI SDK, PostgreSQL (`pg` Pool)
- **Frontend:** Vanilla JS (IIFE moduly, žiadny framework), HTML5, CSS3
- **Auth:** Supabase (Google OAuth, JWT)
- **Deploy:** Vercel (serverless)
- **DB:** Supabase PostgreSQL

---

## Štruktúra projektu

```
gIVEMEGAME.IO-OPENCLAW/
├── server.js              # Express backend — VŠETKA reward logika je TU
├── public/
│   ├── index.html, script.js, style.css
│   ├── js/
│   │   ├── coins.js, game-api.js, game-data.js, game-ui.js
│   │   ├── game-edit.js, library.js, narrator.js
│   │   ├── reflection.js, session.js, timer.js
│   └── data/
│       ├── games.json, rvp.json
│       └── i18n/  (sk, cs, en, es)
├── supabase/migrations/   (001–012 SQL)
├── source of knowledge/   (.txt/.md/.json — vkladá sa do AI promptu)
└── docs/plans/            (dizajnové dokumenty)
```

---

## Čo už funguje

1. **Generovanie hier** — OpenAI GPT, fallback na `games.json`
2. **3-panelové UI** — Filtre / Game viewport / SMARTA + história
3. **Režimy:** Party, Classroom, Reflection, Circus, Cooking, Meditation
4. **RVP filtre** — Stupeň, Kompetencie, Oblast
5. **gIVEMECOIN** — in-app coiny (localStorage + Supabase sync)
6. **SMARTA** — AI rozprávač, TTS, denný limit 10 faktov, +50 coinov odmena
7. **Robot Challenge** — CAPTCHA mini-hra, odmena +250 coinov
8. **gIVEME** — mini sociálna sieť (pixel art posty, lajky, darovanie coinov)
9. **gIVEMEGOCHI** — Tamagotchi mini-hra (iframe)
10. **i18n** — SK/CS/EN/ES, `window.givemegame_t(key, fallback)`
11. **Sessions (Phase 4)** — multiplayerové session (create/join/start/reflect/complete)
12. **Systém kompetencií (Phase 4)** — 7 RVP kompetencií, body za dokončenie hier
13. **Reward Validation System** — anti-exploit ochrana s 5 bránami + audit trail

---

## Ekonomika coinov

| Akcia | Suma |
|---|---|
| Nový používateľ | +150 |
| Generovanie hry | -125 |
| Pripojenie do session | -200 |
| Dokončenie session | +100 |
| Solo dokončenie | +100 |
| Timer dokončený | +500 |
| Robot Challenge | +250 |
| SMARTA | +50 |

**Netto za session: -100 coinov** (zámerný drain — zabraňuje farmeniu)

---

## Systém kompetencií

7 kľúčov z `rvp.json`:
`k-uceni`, `k-reseni-problemu`, `komunikativni`, `socialni-personalni`, `obcanske`, `pracovni`, `digitalni`

- Za každú kompetenciu v `game.rvp.kompetence` → **+50 bodov**
- Body sú **permanentné** — len rastú
- Vek hráčov rastie biologicky, nie cez levelovanie

### Reward Validation brány (musí prejsť všetky):
1. **Trvanie:** `(teraz - started_at) >= max(game.duration.min, 3)` min → `DURATION_TOO_SHORT`
2. **Počet hráčov:** `COUNT(coins_paid > 0) >= max(game.playerCount.min, 1)` → `NOT_ENOUGH_PLAYERS`
3. **Cooldown hosta:** `< 5 sessions za hodinu` → `HOST_COOLDOWN`
4. **Reflexia:** `reflection_done = true AND awarded_competencies IS NULL`
5. **Denný limit solo:** `< 10/deň` → `SOLO_DAILY_LIMIT`

---

## Databázová schéma (kľúčové tabuľky)

**profiles:** `id, coins, competency_points JSONB, games_generated, games_exported`

**sessions:** `id, host_id, game_json JSONB, join_code, status (waiting/active/reflection/completing/completed), started_at, completed_at, reward_validation JSONB`

**session_participants:** `session_id, user_id, coins_paid, reflection_done, awarded_competencies JSONB`

**coin_transactions:** `user_id, amount, action, metadata JSONB, created_at`

---

## Čo čaká na vykonanie

1. **Spustiť Migration 012 v Supabase Dashboard** (`supabase/migrations/012_reward_validation.sql`)
2. Integračné testovanie validation brán

---

## Budúce plány

- **Phase 5:** Úrovne kompetencií (Level 1–5 podľa bodov)
- **Phase 6:** Achievementy, evolúcia avatara
- **Phase 7:** Adaptívna ťažkosť AI, talent trees

---

## Ako referencovať kód

- **Frontend:** `V public/js/session.js, funkcia complete()...`
- **Backend:** `V server.js, endpoint /complete...`
- **Konštanty odmien:** `COMPETENCY_AWARD=50, COMPLETION_BONUS=100, SESSION_JOIN_COST=200`
- **i18n:** `public/data/i18n/sk.json, kľúče pre chyby: err_duration_short, err_not_enough_players...`

---

*Aktuálny stav projektu k 2026-03-15. Použi tento kontext pri každej otázke.*
