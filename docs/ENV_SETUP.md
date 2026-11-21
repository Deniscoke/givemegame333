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
k dispozícii samostatný reconcile flow. Ten aplikuje `026` až `032`, pričom
`026` zachová staré `billing_events` riadky a doplní novú schému:

```powershell
npm run db:migrate -- --upgrade-legacy-016 --from 026 --confirm-legacy-upgrade legacy-016-to-033
```

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
