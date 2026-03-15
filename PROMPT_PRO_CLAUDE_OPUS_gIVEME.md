# Prompt pre Claude Opus: gIVEME sociálna sieť

**Účel:** Vygeneruj kompletnú, funkčnú gIVEME sociálnu sieť podľa špecifikácie. Výstup musí byť pripravený na okamžitú integráciu do existujúceho projektu gIVEMEGAME.IO — keď ho používateľ stiahne a nahraje, Cursor/Composer na to hneď nadviaže a dokončí integráciu.

---

## KONTEXT PROJEKTU

**gIVEMEGAME.IO** je generátor vzdelávacích hier s pixel-art estetikou. Má:
- Hlavnú aplikáciu (index.html, script.js, style.css)
- **Profilový modal** s tlačidlom v headeri — otvára modal s tabmi Profil a gIVEME
- **gIVEME iframe** — načítava gIVEME/index.html v tabu gIVEME
- **Supabase** — auth (Google), profiles, follows, giveme_posts, giveme_likes, giveme_comments, giveme_coin_donations
- **Coins systém** — App.Coins v hlavnej app, gIVEME môže posielať postMessage pre pridanie coinov
- **Login** — login.html s Google Sign in, po prihlásení uloží do sessionStorage.givemegame_user objekt { uid, name, email, photo }

**Existujúca integrácia** (čo už funguje):
- postMessage z parent do gIVEME: { type: giveme_syncUser, user } a { type: giveme_syncCoins }
- gIVEME môže poslať { type: giveme_requestSync } a parent odpovie sync
- gIVEME môže poslať { type: giveme_coin, amount } a parent volá App.Coins.award
- Link Prihlásit sa v profile modale smeruje na login.html

---

## ČO MÁŠ VYTVORIŤ

### 1. Štruktúra súborov (presne takto)

gIVEME/
  index.html      # Hlavná stránka sociálnej siete
  styles.css      # CSS
  script.js       # Všetka logika
  (žiadne ďalšie súbory — všetko v týchto troch)

### 2. Funkčnosti

- **Feed** — posty z giveme_posts (Supabase), s autorom z profiles, lajky, komentáre, darovanie coinov
- **Vytvorenie postu** — pixel art editor (16x16 alebo podobné), caption, voliteľné zadanie/prompt
- **Google autentifikácia** — cez Supabase Auth; pri prvom prihlásení sa vytvorí profil automaticky (trigger handle_new_user)
- **Session sync** — gIVEME číta sessionStorage.givemegame_user ALEBO supabase.auth.getSession(); ak je v iframe, prijíma postMessage od parenta pre sync usera
- **Coins** — ak je v iframe: sync s parent App.Coins cez postMessage; ak standalone: lokálny localStorage fallback
- **Stories** — môžu byť mock/demo alebo pripravené na budúce rozšírenie
- **Lajky, komentáre, darovanie coinov** — plne funkčné (Supabase)
- **i18n** — pripravené na SK, CS, EN, ES (podľa hlavnej app)

### 3. Technické požiadavky

- **Supabase** — použij @supabase/supabase-js z CDN
- **Konfigurácia** — na začiatku script.js: SUPABASE_URL a SUPABASE_ANON_KEY (používateľ doplní)
- **Auth flow** — ak nie je prihlásený a chce vytvoriť post/lajkovať: zobraziť CTA Prihlás sa s odkazom na ../login.html
- **Ak je v iframe** — detekcia window.parent !== window; vtedy používať postMessage pre coins a sync
- **Pixel art** — canvas alebo grid, paleta farieb, export do base64 data URL pre uloženie do image_data

### 4. Štruktúra tabuliek (pre referenciu)

- profiles — id, display_name, avatar_url, bio, coins
- giveme_posts — id, author_id, image_data, caption, prompt, created_at
- giveme_likes — post_id, user_id
- giveme_comments — post_id, user_id, content, created_at
- giveme_coin_donations — post_id, donor_id, recipient_id, amount

### 5. Integračný kontrakt (pre Cursor)

**Výstup musí obsahovať:**

1. **README_INTEGRATION.md** v hlavnom priečinku projektu s:
   - Zoznam súborov, ktoré treba nahradiť/pridať
   - Presné kroky: Nahraď obsah gIVEME/ týmto výstupom
   - Čo už má byť v hlavnej app: profile-modal s iframe giveme-iframe, postMessage listenery
   - Checklist: Ak X nie je v index.html, pridaj Y

2. **Komentáre v kóde** označujúce integračné body:
   - // INTEGRATION: parent postMessage tam kde sa čaká sync
   - // INTEGRATION: login link tam kde je odkaz na login

3. **Žiadne breaking changes** — súbory v hlavnej app sa nemajú meniť. gIVEME je samostatný modul v priečinku gIVEME/.

---

## FORMAT VÝSTUPU

1. **Súbory** — vypíš každý súbor v plnom znení (code block s filename)
2. **README_INTEGRATION.md** — ako prvý
3. **Na konci** — zhrnutie: Čo treba ešte urobiť v Cursor/Composer po nahratí: …

---

## DÔLEŽITÉ PRE OPUS

- Buď **exhaustívny** — žiadne placeholder funkcie, všetko musí fungovať
- **Escape HTML** všade kde sa vkladá user content (XSS)
- **Error handling** — Supabase môže vrátiť chybu, zobraz správne hlásenie
- **UTF-8** — všetky súbory v UTF-8, diakritika SK/CS/EN/ES
- **Pixel art** — zachovaj estetiku projektu (Press Start 2P, VT323, retro)
- **Responsive** — funguje na mobile aj desktop

---

## PRÍKLAD POUŽITIA (pre overenie)

Po integrácii:
1. Používateľ klikne v headeri — otvorí sa modal
2. Tab gIVEME — načíta sa iframe s gIVEME/index.html
3. Ak je prihlásený (Google) — vidí feed, môže lajkovať, komentovať, darovať coiny, vytvoriť post
4. Ak nie je prihlásený — vidí feed, CTA Prihlás sa pre akcie vyžadujúce auth
5. Coiny z gIVEME (darovanie, odmeny) sa syncujú do hlavnej app

---

Začni výstupom: README_INTEGRATION.md a potom všetky súbory v gIVEME/.

---

## RÝCHLY ŠTART (čo skopírovať do Claude Opus)

Skopíruj celý tento súbor do chatu s Claude Opus a napíš:

> Vygeneruj gIVEME sociálnu sieť podľa špecifikácie v tomto dokumente. Výstup musí byť kompletný a pripravený na integráciu — keď ho stiahnem a nahrať do projektu, Cursor Composer na to musí vedieť nadviazať. Začni README_INTEGRATION.md, potom gIVEME/index.html, gIVEME/styles.css, gIVEME/script.js. Všetko v plnom znení, žiadne placeholdery.

---

## POSTMESSAGE PROTOKOL (presná špecifikácia)

**Parent → gIVEME (iframe):**
```javascript
{ type: "giveme_syncUser", user: { uid, name, email, photo } | null }
{ type: "giveme_syncCoins" }  // gIVEME si vyžiada aktuálny balance cez request
```

**gIVEME → Parent:**
```javascript
{ type: "giveme_requestSync" }  // parent odpovie syncUser + syncCoins
{ type: "giveme_coin", amount: number }  // parent volá App.Coins.award("giveme_xxx")
```

**sessionStorage.givemegame_user** formát:
```json
{ "uid": "uuid", "name": "Meno", "email": "a@b.com", "photo": "https://..." }
```

---

## SUPABASE MIGRÁCIE (už existujú v projekte)

Súbory v `supabase/migrations/`:
- 001_profiles_and_follows.sql
- 002_add_coins_to_profiles.sql
- 003_giveme_social.sql
- 004_add_prompt_to_posts.sql

Opus nemusí generovať migrácie — len kód, ktorý s nimi pracuje.
