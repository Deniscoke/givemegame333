# Prompt pre ChatGPT — Stav projektu gIVEMEGAME.IO

**Skopíruj celý text nižšie a vlož ho do nového chatu s ChatGPT.**

---

## Kontext pre AI asistenta (ChatGPT)

Ahoj! Potrebujem pomoc s projektom **gIVEMEGAME.IO**. Tu je kompletný prehľad, aby si vedel, o čo ide a v akom stave to je.

---

### Čo to je?

**gIVEMEGAME.IO** je webová aplikácia — **inteligentný generátor vzdelávacích hier**. Pomáha učiteľom, lektorom a facilitátorom vytvárať originálne, pedagogicky podložené hry a aktivity. Používa **OpenAI GPT** na generovanie hier podľa filtrov (režim, vek, počet hráčov, trvanie, prostredie atď.). Výstup je v Gen Z štýle — casual, s konkrétnymi príkladmi, nie akademický.

**Cieľová skupina:** české/slovenské školstvo (RVP ZV), podporuje SK, CS, EN, ES.

---

### Tech stack

- **Backend:** Node.js, Express, OpenAI SDK
- **Frontend:** Vanilla JS (žiadny framework), HTML5, CSS3
- **Auth:** Supabase (Google OAuth)
- **Deploy:** Vercel (serverless)
- **Fonty:** Press Start 2P, VT323 (retro gaming)
- **Ikony:** Bootstrap Icons

---

### Štruktúra projektu (čo máme v súboroch)

```
gIVEMEGAME.IO-OPENCLAW/
├── server.js              # Express backend, API routes, OpenAI volania
├── public/
│   ├── index.html         # Hlavná app (UI generátora hier)
│   ├── login.html         # Prihlásenie (Google OAuth)
│   ├── script.js          # Frontend logika (~2500 riadkov)
│   ├── style.css          # Štýly
│   ├── data/
│   │   ├── games.json     # Vzorové hry (fallback keď AI zlyhá)
│   │   ├── rvp.json       # RVP ZV kurikulum (kompetencie, oblasti)
│   │   ├── narrator-facts.json
│   │   └── i18n/          # sk, cs, en, es preklady
│   ├── gIVEME/            # Mini sociálna sieť (iframe)
│   └── tamagochi/         # Tamagotchi mini-hra (iframe)
├── data/                  # Duplikáty dát (games, rvp, i18n)
├── source of knowledge/   # Používateľ uploaduje .txt, .md, .json — AI ich používa
├── supabase/
│   └── migrations/        # 001–008 SQL migrácie (profiles, coins, giveme, quest_log...)
├── docs/
│   ├── gIVEMECOIN_IMPLEMENTATION_PLAN.md   # Plán coin systému
│   ├── gIVEMECOIN_LEGAL_CONSIDERATIONS.md
│   ├── gIVEMECOIN_HYBRID_SPEC.md
│   └── ENV_SETUP.md
├── no robot test/         # Robot Challenge (CAPTCHA) — React/Vite
├── zoom-pan-the-image-on-hover-mouse-move/  # Referenčný kód pre zoom
├── .env.example
├── vercel.json
├── package.json
└── PROJECT_OVERVIEW_FOR_AI.md   # Detailný prehľad pre AI
```

---

### Čo už funguje (implementované)

1. **Generovanie hier** — POST `/api/generate-game`, OpenAI GPT, fallback na `games.json`
2. **3-panelové UI** — Ľavý panel (filtre), stred (viewport hry), pravý panel (SMARTA, Tamagochi, história)
3. **Režimy:** Party, Classroom, Reflection, Circus, Cooking, Meditation
4. **RVP filtre** — Stupeň, Kompetencie, Oblasti (české kurikulum)
5. **SMARTA** — AI rozprávač s faktami, TTS (OpenAI alebo Web Speech)
6. **gIVEMECOIN** — in-app coiny (localStorage + Supabase sync), odmeny za timer, robot, narrator
7. **Robot Challenge** — CAPTCHA (matematika, sekvencia, emoji mriežka) — 250 coinov
8. **gIVEME** — mini sociálna sieť s pixel art postami, lajky, komentáre, darovanie coinov
9. **Tamagochi** — mini-hra v iframe
10. **i18n** — SK, CS, EN, ES
11. **Supabase** — profily, coiny, follows, giveme_posts, quest_log

---

### Čo je v pláne / rozpracované

**gIVEMECOIN Fáza 1** (podľa `docs/gIVEMECOIN_IMPLEMENTATION_PLAN.md`):
- Migrácia `006_coin_transactions.sql` — história transakcií
- API: `GET /api/coins/history`, `GET /api/coins/balance`
- **Coin menu** — dropdown pri kliknutí na coin ikonu: balance, posledné transakcie, „Ako zarábať“
- Logovanie existujúcich akcií (Robot Challenge, Tamagochi, gIVEME darovanie) do `coin_transactions`

**Fázy 2–4:** Právne dokumenty (ToS, Privacy Policy), blockchain vrstva (voliteľná) — claim tokenov za coiny.

---

### Kľúčové API endpointy

| Endpoint | Metóda | Účel |
|----------|--------|------|
| `/api/generate-game` | POST | Generuje hru cez OpenAI |
| `/api/random-fact` | GET | Náhodný vzdelávací fakt (SMARTA) |
| `/api/tts` | POST | OpenAI TTS |
| `/api/knowledge` | GET | Zoznam súborov v „source of knowledge“ |
| `/api/status` | GET | Stav, hasApiKey, model |

---

### Schéma hry (JSON)

```json
{
  "id": "ai-xxxxxx",
  "title": "string",
  "pitch": "string",
  "playerCount": { "min": 6, "max": 30 },
  "ageRange": { "min": 6, "max": 12 },
  "duration": { "min": 15, "max": 30 },
  "setting": "indoor|outdoor|any",
  "mode": "party|classroom|reflection|circus|cooking|meditation",
  "materials": ["string"],
  "instructions": ["string"],
  "learningGoals": ["string"],
  "rvp": { "kompetence", "oblasti", "stupen", ... }
}
```

---

### Termíny (CZ/SK)

- **Spawnuj hru** = Generuj hru
- **RVP** = Rámcový vzdělávací program (kurikulum)
- **Stupeň** = Ročník (1./2. stupeň)
- **SMARTA** = AI rozprávač

---

### Ako ma môžeš osloviť pri pomoci

- **Frontend:** „V script.js, modul GameUI…“, „V index.html, ľavý panel…“
- **Backend:** „V server.js, buildSystemPrompt…“, „V /api/generate-game…“
- **Dáta:** „Štruktúra games.json“, „Formát rvp.json“
- **gIVEMECOIN:** „Implementuj Fázu 1 z gIVEMECOIN_IMPLEMENTATION_PLAN“

---

*Toto je aktuálny stav projektu k marcu 2026. Použij tento kontext pri každej otázke o gIVEMEGAME.IO.*
