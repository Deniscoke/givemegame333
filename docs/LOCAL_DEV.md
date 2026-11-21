# gIVEMEGAME na vlastnom počítači (lokálne testovanie)

Tento návod ti ukáže, ako spustiť gIVEMEGAME u seba na počítači aj s
prihlasovaním, školou, triedou a testami — bez živej (produkčnej) databázy.
Všetko beží iba u teba. Nič sa neposiela na živý web.

> Na počítači môže bežať aj iný projekt (napríklad INVOK) so svojou vlastnou
> databázou. gIVEMEGAME má **vlastnú, oddelenú** databázu na iných portoch
> (55321–55329), takže si navzájom neprekážajú.

## Čo potrebuješ

- **Docker Desktop** (program s veľrybou).
- **Node.js** (už ho máš, ak ti funguje `npm`).
- Otvorený priečinok projektu v termináli.

## 1. Zapni Docker Desktop

Spusti aplikáciu **Docker Desktop** a počkaj, kým dole vľavo nesvieti zelené
„Engine running". Bez toho nič ďalšie nepôjde.

## 2. Spusti lokálnu databázu

```
npm run db:local:start
```

Prvýkrát to trvá dlhšie (sťahuje sa niekoľko sto MB). Nabudúce je to rýchle.

## 3. Priprav nastavenia (iba prvýkrát)

```
npm run db:local:env
```

Vytvorí súbor `.env.local` s adresou lokálnej databázy. Súbor sa nikdy
nenahráva na GitHub. OpenAI kľúč si skopíruje z tvojho `.env` sám.

## 4. Vytvor tabuľky v databáze

```
npm run db:local:migrate
```

Keď uvidíš `Migration run complete`, je to hotové. Môžeš to spustiť
kedykoľvek znova — nič sa nepokazí (napíše `0 applied`).

## 5. Naplň databázu testovacími údajmi

```
npm run db:local:seed
```

Vytvorí testovacie účty, jednu školu, triedu 7.A, žiakov v triede, mince a
ukážkový vstupný a výstupný test (INVOK, podnikavosť). Aj toto môžeš spustiť
viackrát.

## 6. Spusti aplikáciu

```
npm run dev:local
```

Potom otvor v prehliadači: **http://localhost:3100**

Na prihlasovacej stránke (http://localhost:3100/login.html) uvidíš navyše
rámček **„Lokálne testovacie prihlásenie"** s e-mailom a heslom. Ten sa
zobrazí iba lokálne — na živom webe ho nikto neuvidí.

## Testovacie účty

| Rola | E-mail |
|------|--------|
| Správca školy | admin@givemegame.local |
| Učiteľ | teacher@givemegame.local |
| Žiak | student@givemegame.local |
| Žiak 2 | student2@givemegame.local |

**Heslo** je pre všetky účty rovnaké. Vytvorí sa náhodne pri prvom
`npm run db:local:seed` a uloží sa do súboru `.env.local` na riadok
`LOCAL_TEST_PASSWORD` (ten súbor sa nikdy nedostane na GitHub). Je to iba
testovacie heslo pre tvoj počítač — nikde inde ho nepoužívaj.

## Prezeranie databázy (Supabase Studio)

Otvor **http://localhost:55323** — uvidíš všetky tabuľky a údaje ako v
Supabase na webe.

Maily (napríklad reset hesla) sa nikam neposielajú, zachytí ich
**http://localhost:55324**.

## Vypnutie

- Aplikáciu zastavíš v termináli klávesmi **Ctrl + C**.
- Databázu vypneš:

```
npm run db:local:stop
```

Údaje ostanú uložené a pri ďalšom `npm run db:local:start` budú späť.
Tento príkaz vypne **iba** gIVEMEGAME databázu, iné projekty nechá bežať.

## Keď niečo nejde

- **„Cannot connect to the Docker daemon"** → Docker Desktop nie je zapnutý.
- **„.env.local is missing"** → spusti `npm run db:local:env`.
- **Prihlásenie hlási nesprávne heslo** → spusti znova `npm run db:local:seed`
  (heslá sa nastavia nanovo).
- **Chceš úplne čistú databázu** → v termináli:
  `npx --yes supabase@3.2.0 db reset --workdir .`
  a potom znova kroky 4 a 5. (Zmaže iba gIVEMEGAME údaje.)

## Neskôr: nahratie skutočných údajov zo zálohy

Keď bude produkčný Supabase projekt znova zapnutý alebo si stiahneš zálohu
(Supabase → Project Settings → Database → Backups), môžeš skutočné údaje
nahrať do lokálnej databázy:

1. Spusti lokálnu databázu (`npm run db:local:start`).
2. Ak máš zálohu ako `.sql` súbor:

   ```
   psql "postgresql://postgres:postgres@127.0.0.1:55322/postgres" -f zaloha.sql
   ```

3. Ak máš zálohu ako `.dump` / `.backup` súbor:

   ```
   pg_restore --no-owner --no-acl -d "postgresql://postgres:postgres@127.0.0.1:55322/postgres" zaloha.dump
   ```

4. Ak záloha obsahuje celú databázu, začni z prázdnej databázy (pozri
   „čistá databáza" vyššie) a **nespúšťaj** predtým migrácie ani seed —
   tabuľky prídu zo zálohy. Potom spusti `npm run db:local:migrate`, ktorý
   doplní iba to, čo v zálohe chýba (ak hlási „Tracking is empty but known
   application schema exists", požiadaj vývojára o pomoc).

Číslo portu **55322** je dôležité — to je gIVEMEGAME databáza. Port 54322
patrí inému projektu (INVOK), tam nič nenahrávaj.
