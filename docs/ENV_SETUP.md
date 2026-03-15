# ENV_SETUP.md — Bezpečné nastavenie prostredia

Tento projekt funguje len vtedy, ak sú všetky tajomstvá držané mimo repozitára. Postupuj podľa krokov:

## 1. Lokálne premenlivé prostredia
1. Skopíruj `.env.example` na `.env.local` (alebo `.env` len na svojom stroji).  
2. Vyplň reálne hodnoty:
   - `OPENAI_API_KEY` — nový kľúč vytvorený v [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
   - `OPENAI_MODEL`, `OPENAI_TTS_MODEL` ponechaj podľa odporúčaní
   - `SUPABASE_DB_URL` — Postgres connection string zo Supabase (potrebné pre migrácie aj server)
   - `SUPABASE_URL` — napr. `https://vhpkkbixshfyytohkruv.supabase.co`
   - `SUPABASE_ANON_KEY` — Supabase anon key (backend ho používa na verifikáciu tokenov)
3. Súbor `.env.local` nikdy necommituj (je v `.gitignore`).

## 2. Vercel / Deploy prostredie
1. `Project Settings → Environment Variables`
2. Pridaj/nahraď:
   - `OPENAI_API_KEY`
   - `OPENAI_MODEL`
   - `OPENAI_TTS_MODEL`
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `NARRATOR_STYLE` (ak používaš)
3. Nastav rovnaké hodnoty pre Production aj Preview.  
4. Spusť redeploy, aby server nabil nové hodnoty.

## 3. Supabase kľúče
1. V Supabase Dashboard → "Project Settings → API" klikni na **Regenerate API keys** (aspoň Anon Key).  
2. Novú hodnotu nepíš do frontendu — namiesto toho ju načítaj na serveri z env premenných a poskytuj klientovi len to, čo naozaj potrebuje (napr. sign-in linky alebo proxy endpointy).  
3. Kým nebude hotová serverová proxy, drž nový key len v `.env.local` a manuálne ho vkladaj do vývojových builds.

## 4. Kontrola repozitára
- `.env` bol odstránený; jediným zdrojom šablóny je `.env.example`.
- Pred pushom vždy over, že v gite nie sú žiadne súbory obsahujúce `sk-`, `supabase.co`, alebo iné tajomstvá (`git status`, `git grep 'sk-'`).

## 5. Rotácia v prípade úniku
1. **Revoke** úniknutý kľúč (OpenAI, Supabase).  
2. Vytvor nový kľúč, vlož do Vercel envs + `.env.local`.  
3. Deployni novú verziu.  
4. Skontroluj logy, či nikto nevolal starý endpoint.

---
Tento dokument nechávaj v `docs/`, aby každý ďalší prispievateľ vedel, ako s env premennými pracovať bez rizika úniku.
