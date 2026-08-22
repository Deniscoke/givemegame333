# PROJECT_STATE.md

> Single source of truth pre gIVEMEGAME.IO → INVOK transformáciu.
> Posledná aktualizácia: 2026-08-22
> Verzia: 1.2

---

## 1. Misia (TL;DR)

Pripraviť **gIVEMEGAME.IO** (existujúca AI-powered vzdelávacia platforma) na predaj poskytovateľovi slovenskej výzvy **INVOK** (PSK-MPSVR-060-2025-DV-ESF+, sociálna inovácia vo vzdelávaní) do **90 dní**. Hotová platforma musí spĺňať atribúty sociálnej inovácie podľa Prílohy č. 9 výzvy.

---

## 2. Tech stack

| Vrstva | Technológia |
|---|---|
| Frontend | Vanilla JS, HTML, CSS (žiadny React, žiadny build step) |
| Backend | Node.js + Express monolit (`server.js`) + moduly v `lib/` |
| Databáza | Supabase Postgres cez raw `pg.Pool` (service role) |
| Auth | Supabase JWT, helper `requireSupabaseUser(req, res)` |
| Platby | Stripe Checkout + podpisovo verifikovaný webhook (legacy Payment Link vyradený) |
| Hosting | Vercel |
| AI | OpenAI API (game generation) |
| Realtime | Supabase Realtime + polling fallback |
| Tests | Node built-in `node --test` runner |
| i18n | JSON súbory v `public/data/i18n/{sk,cs,en,de,es,tr}.json` |

---

## 3. Štruktúra repozitára (high-level)

```
gIVEMEGAME.IO-OPENCLAW/
├─ server.js                   # Hlavný backend (Express monolit, ~3000+ riadkov)
├─ lib/                        # Business logika moduly
│  ├─ rpg-progression.js       # XP, levely, talenty
│  ├─ rpg-avatars.js
│  ├─ rpg-talents.js
│  ├─ billing.js               # Stripe + plan entitlements
│  ├─ plan-entitlements.js
│  └─ edu-routes.js            # EDU portal endpoints
├─ public/
│  ├─ index.html               # Hlavné UI
│  ├─ script.js                # Frontend logika
│  ├─ style.css                # Pixel-art + retro dizajn
│  ├─ login.html
│  ├─ account.html
│  ├─ pricing.html
│  ├─ js/
│  │  ├─ session.js            # Multiplayer sessions (host/join/lobby)
│  │  ├─ reflection.js         # 9-otázkový reflexný modul
│  │  ├─ coins.js              # Coin economy
│  │  ├─ rpg-screen.js
│  │  ├─ rpg-talents.js
│  │  ├─ rpg-xp-fx.js          # Pixel-art XP celebration
│  │  └─ narrator.js           # AI vypravec
│  ├─ data/i18n/               # SK, CS, EN, DE, ES, TR
│  └─ edu/                     # EDU portal scaffold (members, classes, ...)
├─ supabase/migrations/        # SQL migrácie po 032 (historicky duplicitné 018, chýba 023)
├─ test/rpg/                   # Unit testy (137 passing)
└─ Avatars/                    # Static avatar assets (1–8)
```

---

## 4. Aktuálne features (čo už beží)

- ✅ 6 herných módov: Party, Classroom, Reflection, Circus, Cooking, Meditation
- ✅ AI generátor hier s RVP mapovaním
- ✅ Multiplayer sessions (host + join code + lobby + realtime + reflexia)
- ✅ Reflexný modul s 9 otázkami mapovanými na kompetencie
- ✅ RPG progresia: XP, level (1–10), 6 statov, talenty
- ✅ Coin economy (gIVEMECOIN) + daily caps + server-authoritative
- ✅ Robot challenge (mini cognitive tasks)
- ✅ Multi-language: SK, CS, EN, DE, ES, TR
- ✅ Stripe subscription billing hardening (Checkout, consent, ownership validation, canonical Stripe reconciliation a advisory serialization)
- ✅ Security baseline (HSTS, CORS allowlist, parameterized SQL, JWT auth)
- ✅ XSS escape v session participant rendering
- ✅ Mobile host UX fixes (badge, backdrop dismiss, fast polling)
- ✅ EDU portal scaffold (`/edu/`) — members, classes, attendance, gradebook
- ✅ Čitateľný role-aware shell: join-first `/student/`, zjednotená EDU/Assessment/INVOK navigácia, zameraný generátor a live-session režim
- ✅ Verejné, prihlasovacie, účtové a billing plochy používajú čitateľnú typografiu a viditeľný keyboard focus
- ✅ Stabilizovaný testovací baseline: plný suite green (578 testov pri verifikácii 2026-08-22)

---

## 5. INVOK kontext

### 5.1 Hlavné požiadavky výzvy
1. **Online vzdelávací systém (LMS)** — kurzy, registrácia, testovanie, úlohy, dáta, reporting
2. **4 moduly** — Podnikavosť, Kritické myslenie, Tímovka, Prezentačné zručnosti
3. **10 workshopov + 6 projektových výziev**
4. **Pre/post testy** (najdôležitejšie — merateľnosť dopadu)
5. **Metodiky pre učiteľov** (scenáre hodín, mikro-kurzy)
6. **WCAG 2.1 AA** + ŠVVP podpora + titulky + screen reader + klávesnica
7. **Minimálne 10 škôl** v pilote
8. **Sustainability** po skončení financovania

### 5.2 7 atribútov sociálnej inovácie
1. Multisektorovosť a sieťovanie
2. Otvorený proces spolutvorby
3. Novátorstvo
4. **Merateľnosť pozitívneho spoločenského dopadu** (kritické)
5. Multidisciplinarita
6. Schopnosť redefinovať vzťahy
7. Schopnosť škálovania

---

## 6. Gap analýza

| INVOK požiadavka | Stav | Akcia |
|---|---|---|
| LMS | 🟡 čiastočne (EDU scaffold) | Rozšíriť |
| 4 moduly obsahovo | 🟢 AI vie generovať | Kurátorovať |
| Pre/post testy | 🟢 MVP hotové | Pilotný obsah + smoke test (P0) |
| Inštitucionálny dashboard | 🟢 API + UI hotové | Pilotný reporting smoke test (P0) |
| WCAG 2.1 AA | 🔴 audit potrebný | **Audit + opraviť** (P0) |
| Video lekcie | 🔴 chýba | Postaviť (P1) |
| Asynchrónne submissions | 🟡 perk-requests | Rozšíriť (P1) |
| Učiteľské metodiky | 🟡 AI generuje | Knižnica + export (P1) |
| Reflexie | 🟢 hotové | – |
| Multi-language | 🟢 6 jazykov | – |
| Stripe sustainability | 🟢 hotové | Teacher self-service + School contact-led |

---

## 7. 90-dňová roadmapa

### FÁZA 1 (deň 1–30): INVOK-Ready MVP
- **T1**: Pre/post test modul (`lib/assessment.js`, migrácia `028_assessments.sql`)
- **T2**: Inštitucionálny dashboard (`/public/institution/`; bez novej institutions migrácie)
- **T3**: WCAG 2.1 AA audit + opravy (vrátane "Classroom mode" neutrálneho dizajnu)
- **T4**: Knižnica oficiálnych modulov (`lib/official-curricula.js`; číslo budúcej migrácie TBD, pretože `030` je billing security)

### FÁZA 2 (deň 31–60): Diferenciátory
- **T5**: Peer feedback v sessions
- **T6**: Adaptívne obťažnosti (`lib/adaptive.js`, budúca migrácia `033_adaptive_state.sql` alebo vyššia)
- **T7**: Učiteľská metodika builder s PDF/DOCX exportom
- **T8**: Open data export API

### FÁZA 3 (deň 61–90): Pilot
- **T9–10**: Onboarding 1. školy + učiteľské zaškolenie
- **T11**: Onboarding 2.–3. školy + zber pre-testov
- **T12**: Mid-point report s reálnymi dátami

---

## 8. Active work (čo sa robí TERAZ)

> Aktualizuj túto sekciu po každej dokončenej úlohe.

- [x] **Fáza 1 / Týždeň 1**: Pre/post test modul (HOTOVO — MVP)
  - migrácia `028_assessments.sql` (4 tabuľky)
  - `lib/assessment.js` (pure scoring)
  - `lib/assessment-routes.js` (Express router)
  - frontend `public/edu/assessments.html` + `js/assessments.js`
  - i18n kľúče (SK + EN)
  - 44 unit testov passing
- [x] **T1.1 — Assessment security hardening** (HOTOVO)
  - publikovaná migrácia `029_assessment_security.sql` (RLS + helper `fn_is_educator`), additive `031_assessment_scope_security.sql` (scope helper/policies) a `032_assessment_scope_evidence.sql` (nemenný DB-stamped dôkaz scope pokusu)
  - access-control helpery v `lib/assessment.js` (canCreateAssessment, canSeeCorrectAnswer, canSubmitAttempt, canStartAttempt, canViewAttempt)
  - role guard na `POST /api/assessments` (iba teacher/admin v `edu_school_memberships`)
  - rate limit: 20 create/h, 60 start/h, 60 submit/h (per user)
  - `is_active` guard na start
  - 29 nových testov (73 v assess súbore, 218 celkom)
  - i18n `assess_*` doplnené do CS
- [x] **T2a — Inštitucionálne API** (HOTOVO)
  - `lib/institution.js` (pure helpery: access rules + filters + delta summary + export sanitizer)
  - `lib/institution-routes.js` (Express router, 7 endpointov)
  - wiring v `server.js` (mounted na `/api/institution/*`)
  - 54 unit testov passing
- [x] **Task 1 — Billing security hardening** (HOTOVO, runtime stabilizovaný cez `cb64736`)
  - Stripe Checkout je explicitne feature-flagged a vyžaduje dve oddelené Teacher ceny a právne consent údaje; School mapping je voliteľný a contact-led bez self-service School Checkoutu.
  - Webhook overuje Stripe podpis a vlastníctvo, načíta canonical subscription a serializuje reconciliation per subscription advisory lockom; legacy Payment Link upgrade route je vyradená.
  - Migrácia `030_billing_security.sql` chráni billing profilové polia a obmedzuje prístup k billing dátam na service role.
- [x] **Task 2 — Stabilný testovací baseline** (HOTOVO)
  - Plný suite green: 543 testov pri verifikácii 2026-08-21 po oprave spoľahlivého životného cyklu procesu.
- [x] **Fáza 1 / Týždeň 2 / T2b**: Inštitucionálny Dashboard UI (HOTOVO — Task 4)
  - `/institution/` dashboard, školské/triedne filtre, Impact Trail, summary/module pre-post pohľady a CSV export.
  - Konzumuje existujúcich sedem `/api/institution/*` endpointov; nepridáva `029_institutions.sql`.
- [x] **Readable role-based product shell — Tasks 1–7 + Task 8 lokálne QA** (IMPLEMENTOVANÉ, ČAKÁ NA REVIEW/PREVIEW)
  - Dokončené trasy: `/`, `/login.html`, `/student/`, `/index.html`, `/edu/`, `/edu/assessments.html` a `/institution/`.
  - Typografia: Atkinson Hyperlegible pre body a controls (min. 16 px), IBM Plex Mono pre kódy/timery/dáta, Press Start 2P iba pre krátke brand/badge/celebration akcenty.
  - Accessibility/responsive: 44 px touch targets, spoločné `:focus-visible`, reduced-motion režim a nulový document overflow v 21 kombináciách trás pri 1440×900, 768×1024 a 375×812.
  - Lokálny testovací baseline po opravách nezávislého review: 583/583 testov; všetkých 29 pôvodne požadovaných JavaScript súborov a všetky následne zmenené skripty prešli syntax kontrolou.
  - Task 8 review opravy: pending lobby prežije neprihlásený reload a login redirect je single-flight; učiteľská knižnica má samostatný existujúci stav `/index.html?view=library`; session modály majú focus trap/inert/Escape/restore lifecycle; `.edu-btn-sm` má min. 44 × 44 px.
  - Release stav: iba lokálne overená feature branch; GitHub push a Vercel Preview sú zámerne pozastavené do nezávislého review. Produkcia nebola zmenená.
- [ ] **Fáza 1 / Týždeň 3**: WCAG audit
- [ ] **Fáza 1 / Týždeň 4**: Knižnica oficiálnych modulov

---

## 9. Tech debt (známe problémy)

- ⚠️ CSP header nie je nastavený (inline `<script>` bloky)
- ⚠️ Žiadny rate limit na `/api/coins/log` (možnosť spamovať robot_challenge XP)
- ⚠️ Pixel-art dizajn nie je WCAG-friendly (kontrast)
- ⚠️ Žiadne video lekcie / media player
- ⚠️ GDPR pre maloletých žiakov (súhlas zákonných zástupcov UI flow)
- ⚠️ Assessment i18n: kľúče `assess_*` chýbajú v DE/ES/TR (SK/CS/EN hotové; fallback na key/EN funguje)
- ⚠️ Assessment rate limiter je in-memory — na Vercel Fluid Compute multi-instance je to soft cap (každá inštancia má svoj counter). Pre hard caps presunúť na Redis/Vercel KV
- ⚠️ Institution export pseudonymizácia: `user_id` (UUID) je v CSV — dostatočné pre INVOK reporting, ale pri požiadavke na úplnú anonymizáciu treba sequence number (Student 1, 2...) namiesto UUID
- ⚠️ Deployment credential exposure: ignore pravidlá nezbavia už trackovaných súborov ani Git histórie. Repository owner musí zrotovať existujúce credentials a vyčistiť históriu podľa incident procesu.
- ⚠️ Externé DB migrácie zostávajú owner-operated: podporovaný runner aplikuje billing/assessment release ako `026_billing.sql` → `027_billing_consent.sql` → `028_assessments.sql` → `029_assessment_security.sql` → `030_billing_security.sql` → `031_assessment_scope_security.sql` → `032_assessment_scope_evidence.sql`, najprv na staging. Eviduje plný názov + SHA-256 iba za migrácie, ktoré sám úspešne vykonal. Jeho bootstrap preflight najprv iba číta stav trackeru a schémy; prázdny tracker nad existujúcou non-legacy schémou fail-closed bez DB zápisu vyžaduje kontrolovaný DBA baseline/manuálnu reconciliáciu mimo runnera. Jedinou automatickou výnimkou je explicitne overený legacy-016 upgrade. Obe `018` ostávajú aktívne, `019` je disabled a `023` chýba.
- ⚠️ Lokálne UI QA prebehlo bez `SUPABASE_DB_URL`, OpenAI API kľúča, staging účtov a seedovaných školských dát. Overené boli bezpečné no-auth/error stavy; reálne student/teacher dáta a platený checkout sa nesmú deklarovať ako overené pred staging smoke testom.
- ⚠️ GitHub/Vercel sú externé release závislosti Task 8. Push, Vercel Preview `Ready` kontrola a Preview API smoke ostávajú po nezávislom schválení vetvy; produkčný alias sa nesmie meniť.

---

## 10. Konvencie pre code-execution AI

### Bezpečnosť
- DB queries vždy parameterizované (`$1, $2, ...`)
- Auth: `requireSupabaseUser(req, res)` na chránených endpointoch
- Coin/XP operácie atómicky cez `coinsDbPool.connect()` + `BEGIN/COMMIT`
- XSS escape: `esc(s)` helper pri innerHTML s user-controlled obsahom
- Žiadne secrets v `public/` (anon key OK, service role NIKDY)

### Kódový štýl
- JS bez TypeScript build kroku
- Komentáre po SK/CZ alebo EN, kód po EN
- Žiadny console.log v produkcii (varovanie cez hooks)
- i18n strings cez `window.givemegame_t(key, fallback)`
- Test files v `test/rpg/*.test.js`, run cez `node --test test/rpg/file.test.js`

### Git workflow
- Commit messages: `feat:` / `fix:` / `refactor:` / `docs:` / `test:` / `chore:` / `perf:` / `ci:`
- Nikdy `--no-verify`, `--amend` len so súhlasom používateľa
- Hlavná vetva: `main`

### Frontend
- Žiadny React, žiadny Vue, žiadny build step — vanilla JS
- CSS premenné cez `:root { --accent: ... }`
- Mobile-first, touch targety ≥ 40px
- Backdrop click + ESC vždy zatvoria modal

---

## 11. Business model (pre INVOK sustainability)

| Vrstva | Cieľová skupina | Cena | Účel |
|---|---|---|---|
| Free Educator | Individuálny učiteľ | 0 € | Onboarding, growth |
| School License | Škola | 50–150 €/mes | Dashboard, reporting, podpora |
| Network License | INVOK partner, kraj | 500–2000 €/mes | Multi-škola, customizácia |

INVOK pokryje 1. rok pre 10 škôl. Potom prechádzajú na School License.

---

## 12. Externé prostriedia

- **Production URL**: givemegame.io (Vercel)
- **Supabase project**: `vhpkkbixshfyytohkruv`
- **Repo**: gIVEMEGAME.IO-OPENCLAW
- **Branch**: `main`
- **Aktuálna QA branch**: `codex/readable-student-shell-impl` (lokálna; ešte bez pushu/Preview)

---

## 13. Decision log (rozhodnutia, ktoré sa nemenia)

> Aktualizuj túto sekciu pri každej strategickej zmene.

- **2026-06-01**: Hlavný cieľ = INVOK readiness do 90 dní
- **2026-06-01**: Tech stack zostáva vanilla JS / Express / Supabase (žiadny rewrite na Next.js / TypeScript)
- **2026-06-01**: 4 INVOK moduly budú hybridné — kurátorovaný obsah + AI bonus generátor
- **2026-06-01**: Pixel-art dizajn zostáva ako default, "Classroom mode" pridá neutrálnu alternatívu
- **2026-06-01**: Assessment scoring je deterministický súčet bodov (žiadne IRT v MVP) — IRT v Fáze 2
- **2026-06-01**: Text otázky → 0 bodov + `needs_manual_review` flag — žiadny AI autoscoring v MVP
- **2026-06-01**: Assessment router je samostatný `lib/assessment-routes.js` (nie integrovaný do `edu-routes.js`) — izolovaný surface area pre INVOK certifikáciu
- **2026-06-01**: T1.1 — Assessment access model = **creator-scoped** v MVP. Class/institution scope ide do T2. Teacher v škole nevidí cudzie assessmenty ani ich výsledky, ak ich sám nevytvoril.
- **2026-06-01**: T1.1 — RLS na 4 assessment tabuľkách je **defense-in-depth** (backend používa service-role pool ktorý RLS obchádza). Aktivuje sa keď/ak pridáme direct supabase-js client access.
- **2026-06-01**: T1.1 — Rate limit je **in-memory per-process** (mirror pattern z `lib/edu-routes.js`). Soft cap na Vercel multi-instance — vedome akceptovaný kompromis pre MVP.
- **2026-06-01**: T1.1 — Role guard `canCreateAssessment` vyžaduje **non-archived membership** s rolou `teacher` alebo `admin`. Žiaci nemôžu vytvárať assessmenty.
- **2026-06-01**: T2a — **API-first dashboard approach**: institution reporting API je kompletné pred UI. T2b (dashboard UI) bude len konzumovať tieto endpointy.
- **2026-06-01**: T2a — **Pre/post delta pairing rule**: najskorší submitted `pre` + najnovší submitted `post` (per user_id + module_key). DISTINCT ON v Postgres bez subquery.
- **2026-06-01**: T2a — **Export minimalizuje osobné údaje**: CSV obsahuje len `user_id` (UUID = pseudonymizovaný identifikátor). Žiadne mená, emaily, telefóny. `sanitizeDeltaForExport()` vynucuje whitelist polí.
- **2026-08-21**: **Task 1 billing hardening** — produkčný billing flow je Stripe Checkout + podpisovo verifikovaný webhook; Payment Link/manual-provisioning upgrade flow ostáva vyradený. Paid access neudeľuje success redirect.
- **2026-08-21**: **Billing product scope** — self-service predaj vyžaduje iba dve Teacher ceny (monthly/yearly). School mapping je voliteľný pre externe provisionovaný contact-led produkt; School tier nemá self-service Checkout.
- **2026-08-21**: **Billing reconciliation** — subscription mutation načíta canonical Stripe subscription a pred lokálnou mutáciou sa serializuje per subscription PostgreSQL advisory lockom; timestamp ostáva audit/monotonic defense, nie jediný zdroj pravdy.
- **2026-08-21**: **Billing/assessment release order** — migrácie `026_billing.sql`, `027_billing_consent.sql`, `028_assessments.sql`, publikovaná nemenná `029_assessment_security.sql`, `030_billing_security.sql`, additive `031_assessment_scope_security.sql` a immutable-evidence `032_assessment_scope_evidence.sql` sa aplikujú v tomto poradí. `032` databázou potvrdzuje historický membership/enrollment scope assessment pokusu a chráni ho pred neskoršou zmenou. Historické duplicitné `018` a chýbajúce `023` sú ponechané bez premenovania už vydaných súborov; budúce roadmap migrácie začnú najskôr číslom `033`.
- **2026-08-21**: **Task 2 baseline** — plný testovací suite je green: 543 testov pri finálnej verifikácii; presný počet sa môže zvyšovať s ďalšími regresnými testami.
- **2026-08-21**: **Task 4 dashboard** — INVOK institution dashboard UI je hotové nad existujúcim reporting API. Migrácia `029_assessment_security.sql` patrí assessment RLS hardeningu; žiadna `029_institutions.sql` neexistuje ani nie je potrebná.
- **2026-08-21**: **Migration runner** — poradie je explicitné podľa plných názvov (vrátane oboch `018`), disabled `019` sa neaplikuje a chýbajúce `023` sa nedopĺňa premenovaním. Úspešné transakcie sa evidujú plným názvom + SHA-256. Fresh DB môže použiť celý katalóg a tracked DB release selector; existujúca non-legacy schéma s prázdnym trackerom sa odmietne bez zapisovania checksumov a vyžaduje owner/DBA baseline alebo manuálnu reconciliáciu mimo runnera. Explicitný overený legacy-016 upgrade ostáva podporovaný. Release sa vždy skúša najprv na staging.
- **2026-08-22**: **Readable role shell rollout** — role-aware/readable Tasks 1–7 sú lokálne implementované; Task 8 review našlo štyri Important chyby, všetky sú lokálne opravené s regresiami a whole-product QA prešlo 583/583 testami. Vetva ostáva Preview-only kandidátom; push, Vercel Preview a produkčné rozhodnutie nasledujú až po nezávislom re-review.

---

**Koniec dokumentu. Tento súbor je živá referencia — aktualizuj sekcie 8, 9 a 13 priebežne.**
