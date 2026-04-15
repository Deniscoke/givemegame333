# Billing — čo skontrolovať keď nič nevidíš

## 1. Kde je billing v UI?

- Klikni na **ikonu telefónu** (v pravom hornom rohu) → otvorí sa Profil modal
- Teraz by sa mal automaticky zobraziť tab **Profil** s sekciou **Plán** (Free / Pro)
- Ak vidíš tab **gIVEME** — klikni na tab **Profil** v hornej časti modalu

## 2. Si prihlásený?

- Sekcia billing sa zobrazuje **len prihláseným používateľom**
- Ak vidíš "Prihlás sa cez Google" → prihlás sa najprv

## 3. Supabase migration — spustil si SQL?

"Upload" súboru nestačí. V Supabase treba **spustiť** SQL:

1. Supabase Dashboard → **SQL Editor**
2. **New query**
3. Skopíruj celý obsah z `supabase/RUN_BILLING_IN_SQL_EDITOR.sql`
4. Vlož do editora
5. Klikni **Run**

Ak si to neurobil, tabuľka `user_billing` alebo stĺpce `paid_access_enabled` / `billing_note` nemusia existovať a billing API spadne.

## 4. Vercel / produkcia

- Ak testuješ na **produkcii** (napr. [givemegame333.vercel.app](https://givemegame333.vercel.app)): po pushi na GitHub môže trvať 1–2 minúty, kým Vercel nasadí novú verziu
- Vercel Dashboard → Deployments — skontroluj, či posledný deploy zelený
- **Hard refresh**: Ctrl+Shift+R (Windows) alebo Cmd+Shift+R (Mac) — vymazanie cache
- Alebo otvor v anonymnom okne

## 5. Env premenné (Vercel)

Na Verceli musia byť nastavené:

- `STRIPE_PAYMENT_LINK_PRO_MONTHLY` — URL z Stripe Payment Link (napr. `https://buy.stripe.com/...`)
- `SUPABASE_DB_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY` — pre DB a auth

Bez `STRIPE_PAYMENT_LINK_PRO_MONTHLY` tlačidlo "Upgrade to Pro" vráti chybu.

## 6. Migrácia `plan_usage_daily` (Free vs Pro limity)

Pre denný limit AI hier (`/api/generate-game`) treba tabuľku z `supabase/migrations/018_plan_usage_daily.sql`. Spusti ju v **SQL Editor** (rovnako ako billing SQL vyššie). Ak chýba, server v konzole varuje pri inkrementácii; denný limit sa nemusí presne uplatniť.

## 7. Lokálne testovanie

```bash
npm start
```

Potom otvor `http://localhost:3000` a skontroluj konzolu prehlíadača (F12) — či nie sú chyby pri volaní `/api/billing/state`.

## 8. Limity plánov (prehľad)

Konfigurácia čísel je v `lib/plan-entitlements.js` (Free vs Pro). API `/api/billing/state` vracia `entitlements` a `usage` pre UI.
