# ENV_SETUP.md — Bezpečné nastavenie prostredia

Všetky reálne tajomstvá patria mimo repozitára. Šablóna
[`../.env.example`](../.env.example) obsahuje výhradne zástupné hodnoty.

## Lokálne prostredie

1. Skopíruj `.env.example` do `.env`. Server pri lokálnom štarte načítava práve
   `.env` cez `dotenv.config()`; `.env.local` nie je bez ďalšej runtime zmeny
   automaticky načítaný.
2. Doplň reálne hodnoty pre OpenAI, Supabase a podľa
   [billing handoffu](./BILLING_MVP.md) aj všetky Stripe a právne billing premenné.
3. Súbory `.env`, `.env.local` a ďalšie `.env.*` sú ignorované. Nepridávaj ich
   ručne do indexu; `.env.example` je jediná verzovaná šablóna.

### Testovací účet s odomknutým všetkým

Jeden účet, cez ktorý sa dá otvoriť každá obrazovka: Pro plán učiteľa
(SMARTA Pro), level 10 (všetky pet-y aj perky), všetky talenty, avatar,
50 000 coinov, členstvo v škole ako učiteľ aj ako žiak. Účet má v databáze
`profiles.is_test_account = true`, takže sa nepočíta do rebríčkov, analytiky
ani školských reportov.

Lokálne (po `npm run db:local:start` a `npm run db:local:migrate`):

```powershell
npm run db:local:seed-test -- --dry-run   # len vypíše plán, nič nezapíše
npm run db:local:seed-test                # vytvorí / obnoví účet
```

- Predvolený e-mail je `tester@givemegame.local`; zmeníš ho cez `TEST_ACCOUNT_EMAIL`.
- Heslo je rovnaké ako pri ostatných lokálnych účtoch: `LOCAL_TEST_PASSWORD`
  v súbore `.env.local` (vytvorí sa samo, nikdy sa nevypisuje ani necommituje).
- Prihlásiš sa na `http://localhost:3100`.
- Skript môžeš spustiť opakovane, nič sa nezdvojí.

Mimo lokálneho počítača skript odmietne bežať, kým nenastavíš všetky tri veci:
`ALLOW_TEST_SEED=1`, e-mail v zozname `TEST_ACCOUNT_EMAILS` (oddelené čiarkou)
a heslo v `TEST_ACCOUNT_PASSWORD` (aspoň 12 znakov). Cieľ sa berie z
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` a `SUPABASE_DB_URL`. Heslo
nikdy nedávaj do repozitára.


## Deploy prostredie

1. V nastavení deployment projektu otvor **Environment Variables**.
2. Pre každý cieľový environment vlož serverové hodnoty z `.env.example`.
   Stripe secret key a webhook signing secret nikdy nevkladaj do frontendu.
3. Billing aktivuj až po kompletnej konfigurácii: nastav
   `BILLING_SUBSCRIPTIONS_ENABLED=true` až keď sú prítomné všetky premenné
   popísané v [BILLING_MVP.md](./BILLING_MVP.md), obe povinné Teacher ceny sú
   rozdielne a webhook je otestovaný v test mode. School cena je voliteľné
   mapovanie pre contact-led provisioning, nie self-service Checkout.
4. Po zmene environment variables spusti redeploy a over bezpečný Checkout aj
   podpis webhooku.
5. Nastav `CRON_SECRET` (dlhý náhodný reťazec). Vercel ním raz denne volá
   `/api/cron/session-sweep` (pozri `crons` vo `vercel.json`), ktorý ukončí
   opustené sessions a vráti hráčom mince. Bez tejto premennej je endpoint
   zatvorený; sessions sa potom upratujú len pri bežných požiadavkách na
   `/api/sessions` (najviac raz za minútu na inštanciu).

## SMARTA: chat a hlas

SMARTA (pomocníčka v rohu hry) funguje bez akejkoľvek konfigurácie: Free a
neprihlásení používatelia dostanú lokálne odpovede z `public/data/smarta-replies.*.json`
(nulové tokeny) a hlas z prehliadača (Web Speech). Pro používatelia dostanú AI chat
a voliteľne prémiový hlas, ak sú nastavené tieto serverové premenné (nikdy ich
nevkladaj do frontendu):

| Premenná | Význam |
|---|---|
| `OPENAI_API_KEY` | Chat SMARTY (gpt-4o-mini, max 150 tokenov, posledných 6 správ) a hlas OpenAI. Bez neho SMARTA odpovedá lokálne. |
| `SMARTA_CHAT_MODEL` | Voliteľné. Predvolene `gpt-4o-mini`. |
| `SMARTA_CHAT_DAILY_CAP` | Voliteľné. Denný limit AI správ na používateľa (predvolene 40). Počíta sa v pamäti inštancie. |
| `ELEVENLABS_API_KEY` | Voliteľné. Prémiový hlas ElevenLabs. Potrebuje aj `ELEVENLABS_VOICE_ID`. |
| `ELEVENLABS_VOICE_ID` | Voliteľné. ID hlasu (len písmená a čísla). |
| `TTS_DAILY_CHAR_CAP` | Voliteľné. Koľko znakov prémiového hlasu môže jeden používateľ prečítať za deň (predvolené 20000). Potom sa použije hlas prehliadača. |
| `ELEVENLABS_MODEL_ID` | Voliteľné. Predvolene `eleven_multilingual_v2`. |
| `OPENAI_TTS_MODEL` | Voliteľné. Predvolene `gpt-4o-mini-tts`. |

Poradie hlasu: ElevenLabs (ak je nastavený), potom OpenAI, inak Web Speech v
prehliadači. Prémiový hlas je len pre plán Pro; audio sa cachuje v pamäti
(LRU, bez databázy).

## Databázové migrácie (staging ako prvý)

Runner podporuje všetky aktívne `.sql` súbory po `032` v explicitnom poradí a
zámerne ignoruje `019_edu_add_parent_role.sql.DISABLED`. Pred pripojením k DB
skontroluj katalóg a release plán; tieto dva príkazy databázu neotvoria:

```powershell
npm run db:migrate:list
npm run db:migrate:release:dry-run
```

Na úplne novej prázdnej databáze runner bezpečne aplikuje celý katalóg:

```powershell
npm run db:migrate
```

Ak `public.givemegame_schema_migrations` už obsahuje záznamy z predchádzajúceho
behu, aplikuj iba aktuálnu release sekvenciu na **staging**:

```powershell
npm run db:migrate -- --from 026
```

Runner odmietne defaultný replay, keď je tracking tabuľka prázdna, ale známe
aplikačné objekty už existujú. Pre takúto non-legacy databázu runner neposkytuje
automatickú adopciu ani baseline a nikdy nezapíše checksum za migráciu, ktorú
sám úspešne nevykonal. Repository owner a DBA musia mimo runnera vykonať
kontrolovaný baseline alebo manuálnu reconciliáciu: inventarizovať skutočnú
históriu a schému, porovnať ju s presnými publikovanými súbormi, vyriešiť každý
drift a až po review a staging zálohe zaznamenať overený stav. Tento postup je
projektovo špecifická owner-operated zmena DB; dokumentácia zámerne neposkytuje
univerzálny SQL alebo executable shortcut.

Pre existujúcu databázu overenú presne na legacy schéme migrácie `016` je
k dispozícii samostatný reconcile flow. Ten aplikuje `026` až `041`, pričom
`026` zachová staré `billing_events` riadky a doplní novú schému:

```powershell
npm run db:migrate -- --upgrade-legacy-016 --from 026 --confirm-legacy-upgrade legacy-016-to-041
```

`023_rpg_talents.sql` dopĺňa tabuľku talentov, ktorá bola v produkcii vytvorená
ručne. Na produkcii je no-op (`CREATE TABLE IF NOT EXISTS`); `--from 026` ju
preskočí, čo je v poriadku, lebo tabuľka tam už existuje.

Po kontrolovanom DBA baseline alebo legacy upgrade používaj release selector
`--from 026` (alebo presné vzostupné `--files`). Celý defaultný katalóg správne
odmietne historický replay nezaznamenaných migrácií pred už trackovaným release.

Po staging smoke teste zopakuj rovnaký dry-run a apply proti produkčnému
prostrediu. Runner eviduje iba úspešne commitnuté migrácie v
`public.givemegame_schema_migrations` podľa plného názvu a SHA-256 checksumu.
Pri zmene checksumu alebo čiastočnom SQL zlyhaní sa zastaví; všeobecná chyba
„already exists“ migráciu nikdy potichu neoznačí ako aplikovanú. Výstup
nevypisuje connection string.

Historicky existujú oba aktívne súbory `018_edu_core.sql` a
`018_plan_usage_daily.sql`, `019` je vypnutý a číslo `023` chýba. Už vydané
názvy sa nepremenúvajú. Publikovaná migrácia `029_assessment_security.sql`
zabezpečuje assessment tabuľky a nesmie sa meniť po vydaní; additive
`031_assessment_scope_security.sql` sprísňuje scope funkciu a policies a
`032_assessment_scope_evidence.sql` pridáva nemenný, databázou potvrdený dôkaz
scope assessment pokusu pre bezpečný reporting. Žiadna migrácia `029` pre
institutions neexistuje.

### Coiny: server je jediný zdroj zostatku (036–038) — poznámka k vydaniu

Od `036` prehliadač nezapisuje `profiles.coins` a zostatok prihláseného
používateľa sa číta len zo servera; hodnota v `localStorage` sa ignoruje.
`037` zakazuje prehliadaču vkladať gIVEME dary (darca platí cez
`POST /api/giveme/donate`). `038` žiadny zostatok nemení: používateľov, ktorých súčet v `coin_transactions`
(mínus odoslané a plus prijaté dary) je vyšší ako `profiles.coins`, iba zapíše
do `public.coin_reconcile_candidates` na ručnú kontrolu. Staré riadky ledgeru
posielal prehliadač, preto sa automaticky nepripisujú. Po kontrole oprav
zostatok ručne a zapíš riadok `balance_reconcile` s pôvodnou hodnotou v `metadata`. V poznámkach k vydaniu
používateľom oznám, že zostatok coinov sa odteraz počíta na serveri a coiny
nazbierané len v prehliadači (alebo ako hosť) sa môžu líšiť od zobrazeného
čísla.

### Overiteľná hra a reflexia (039, Fáza 5) — prepínač a prechodné obdobie

`039_play_tickets_and_stat_xp.sql` pridáva tabuľky `play_tickets`, `reflections`
a `user_stat_xp`. Zapisuje do nich len server; prehliadač nemá žiadne granty.

- `PLAY_TICKETS_ENABLED` — predvolene **zapnuté**. Hodnota `0`, `false`, `off`
  alebo `no` funkciu vypne: `/api/play/*` vráti 404 `PLAY_TICKETS_DISABLED`,
  generovanie nevydáva lístky a `/api/profile/complete-solo` beží len po starom
  (podľa `game_json` z prehliadača, s obmedzením násobiča XP z H3).
- Keď je zapnuté, prihlásený používateľ dostane pri generovaní lístok hry
  (`_play_ticket`), tlačidlo READY ho spustí (`POST /api/play/start`; hra
  z knižnice dostane nový lístok) a `complete-solo` prijme `ticket_id`. Dĺžku,
  režim a kompetencie berie server zo svojho lístka; lístok platí raz.
  XP: 30–120 za účasť podľa overených minút, +25 % za reflexiu, ktorá prešla
  kontrolou (`POST /api/play/:ticket/reflect`: všetky hodnotenia, odpovede aspoň
  20 znakov, nie opakovanie posledných 5 reflexií).
  Hra z knižnice je obsah z prehliadača: dĺžku, režim a kompetencie prevezme
  len vtedy, keď sa jej obsah (bez kľúčov začínajúcich `_`) zhoduje s hrou,
  ktorú server sám vygeneroval. Inak dostane lístok 5–45 min bez režimu a
  kompetencií (bez stat XP). Hra bez kópie na serveri (lokálna záložná hra,
  hra vytvorená bez prihlásenia) sa spustí cez `{ local: true }` a dostane
  lístok 5–15 min bez bonusov; ráta sa do denného limitu lístkov z knižnice.
- `PLAY_TICKETS_LEGACY_UNTIL` — koniec dvojtýždňového prechodného obdobia pre
  starších klientov, ktorí ešte neposielajú `ticket_id`. Predvolene
  `2026-12-05T00:00:00Z`. Dovtedy `complete-solo` bez lístka beží po starom
  a odpoveď nesie hlavičky `Deprecation: true` a `Sunset`. Potom vráti 400
  `TICKET_REQUIRED`. Po uplynutí obdobia (a keď v logoch nie sú volania bez
  lístka) sa dá stará cesta `completeSoloLegacy` v `server.js` odstrániť.

Poradie nasadenia: najprv migrácia `039`, potom server. Ak migrácia ešte nie je
aplikovaná, nastav `PLAY_TICKETS_ENABLED=false`, inak vydanie lístka pri
generovaní iba zaloguje chybu a dokončenie bez lístka pôjde starou cestou.

## Kontrola pred deployom

- Spusť `npm ls stripe`; runtime závislosť `stripe` musí byť vyriešená.
- Spusť testy pre billing a skontroluj, že webhook používa raw body pred JSON parserom.
- Spusť `npm run db:migrate:list`, release dry-run a staging apply podľa sekcie
  vyššie; produkciu aplikuj až po úspešnom staging smoke teste.
- Ak má existujúca non-legacy schéma prázdny tracker, zastav automatický release
  a eskaluj kontrolovaný baseline/manuálnu reconciliáciu repository ownerovi a DBA.
- Pri secret-marker kontrole vypisuj len názov súboru a typ markera, nikdy jeho hodnotu.
- Skontroluj `git status` a `.gitignore`, vrátane `VERCEL_KEYS.md` a lokálnych key dumpov.

## Ak existuje alebo vznikne únik

1. Zastav používanie dotknutého prístupu a spusti interný incident proces.
2. **Repository owner** musí externým poskytovateľom zrotovať/revoke-núť dotknuté
   prístupové údaje, aktualizovať deployment environment variables a nasadiť novú verziu.
3. **Repository owner** musí odstrániť citlivý materiál z Git histórie schváleným
   postupom a koordinovať dopad na klony/forky.
4. Over, že nové hodnoty nie sú v súboroch, build artefaktoch ani logoch.

Tento handoff nevykonáva žiadnu rotáciu, nasadenie, externú konfiguráciu ani
prepis Git histórie. Ignore pravidlá chránia iba budúce neúmyselné pridania.
