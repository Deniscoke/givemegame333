# API kľúče a nastavenia pre Vercel

## 1. Čo pridať do Vercel Environment Variables

V projekte na Vercel: **Settings** → **Environment Variables**

| Názov | Hodnota | Povinné |
|------|---------|---------|
| `OPENAI_API_KEY` | tvoj OpenAI kľúč (začína sk-) | ✅ Áno |
| `OPENAI_MODEL` | `gpt-4o` | ❌ Voliteľné (predvolené) |

---

## 2. Kde získať OPENAI_API_KEY

1. Choď na **[platform.openai.com/api-keys](https://platform.openai.com/api-keys)**
2. Prihlás sa (alebo vytvor účet)
3. **Create new secret key** → skopíruj kľúč (začína `sk-...`)
4. Vlož do Vercel ako `OPENAI_API_KEY`

> ⚠️ Kľúč sa zobrazí len raz. Ak ho stratíš, vytvor nový.

---

## 3. Supabase — netreba do Vercel

Supabase URL a Anon Key sú už v kóde. **Nič nemusíš pridávať do Vercel.**

Ale ak chceš, aby **Google prihlásenie** fungovalo na produkčnej URL, musíš pridať Vercel adresu do Supabase a Google Cloud.

---

## 4. Supabase Dashboard (pre Google login)

**Produkčná Vercel URL:** `https://givemegame333.vercel.app`

1. Choď na **[supabase.com/dashboard](https://supabase.com/dashboard)** → tvoj projekt
2. **Authentication** → **URL Configuration**
3. Do **Redirect URLs** pridaj:
   ```
   https://givemegame333.vercel.app/login.html
   ```
4. **Site URL** môžeš nastaviť na: `https://givemegame333.vercel.app`

*(Pre iný projekt / preview nahraď doménu za svoju `*.vercel.app` adresu.)*

---

## 5. Google Cloud Console (pre Google login)

1. Choď na **[console.cloud.google.com](https://console.cloud.google.com/)** → **APIs & Services** → **Credentials**
2. Otvor svoj **OAuth 2.0 Client ID** (Web application)
3. Do **Authorized JavaScript origins** pridaj:
   ```
   https://givemegame333.vercel.app
   ```
4. **Authorized redirect URIs** — `https://vhpkkbixshfyytohkruv.supabase.co/auth/v1/callback` tam už má byť (ak nie, pridaj)

---

## 6. Stripe — Upgrade to Pro (Payment Link, bez API kľúča)

Aplikácia **nepoužíva** `STRIPE_SECRET_KEY` na tlačidlo Upgrade. Stačí **odkaz na Payment Link** (verejná URL typu `https://buy.stripe.com/...`).

### 6.1 Čo urobíš v Stripe Dashboard

1. **[dashboard.stripe.com](https://dashboard.stripe.com)** — prihlásenie / účet (najprv **Test mode** vľavo hore).
2. **Product catalog** → **Add product** (voliteľné — Payment Link vie vytvoriť produkt aj priamo v kroku nižšie).
3. **Payment Links** → **New payment link**.
4. Vyber **Products** → tvoj produkt (napr. „Pro Teacher Monthly“) s **recurring** cenou (mesačne), alebo vytvor cenu v sprievodcovi.
5. Sekcia **After payment**:
   - **Success URL:** `https://givemegame333.vercel.app/billing/success`
   - **Cancel URL:** `https://givemegame333.vercel.app/billing/cancel`
6. Ulož link → skopíruj **celú URL** odkazu (začína zvyčajne `https://buy.stripe.com/...`).

### 6.2 Čo pridáš do Vercel

**Settings** → **Environment Variables** → pridaj:

| Názov | Hodnota |
|------|---------|
| `STRIPE_PAYMENT_LINK_PRO_MONTHLY` | celá URL z kroku 6.1 (bez medzier) |
| `BILLING_SUPPORT_EMAIL` | voliteľné, napr. `tvoj@email.sk` |

Potom **Redeploy** projektu (Deployments → … → Redeploy), aby sa env načítal.

### 6.2a Pridal som premennú, ale v aplikácii stále červený text

Over v prehliadači (Production):

`https://givemegame333.vercel.app/api/billing/public-config`

Ak je `"upgradeAvailable": false`, server **stále nevidí** odkaz. Skontroluj:

1. **Správny projekt na Verceli** — ten, ktorý má doménu `givemegame333.vercel.app` (Settings → Domains).
2. **Názov premennej** — presne `STRIPE_PAYMENT_LINK_PRO_MONTHLY` (žiadna medzera, iný názov typu `STRIPE_PAYMENT_LINK` nefunguje).
3. **Prostredie (Environment)** — pri ukladaní premennej musí byť zaškrtnuté **Production**. Ak je len Preview/Development, Production ostane prázdny.
4. **Hodnota** — celá URL `https://buy.stripe.com/...` bez úvodzoviek; nie prázdny riadok.
5. **Nový deployment** po uložení env — **Deployments** → tri bodky pri poslednom deployi → **Redeploy** (alebo prázdny commit / push z GitHubu).

### 6.3 API kľúče (kedy áno / nie)

| Kľúč | Potrebný teraz? |
|------|-----------------|
| **Payment Link URL** (`STRIPE_PAYMENT_LINK_PRO_MONTHLY`) | **Áno** — bez neho červené varovanie v profile |
| **Publishable key** (`pk_test_...` / `pk_live_...`) | **Nie** — Payment Link beží na stránke Stripe |
| **Secret key** (`sk_test_...` / `sk_live_...`) | **Nie** — pre tento MVP sa v kóde nepoužíva na upgrade |

Secret key budeš potrebovať **až neskôr**, ak pridáme Checkout Session, Customer Portal alebo **webhook** na automatické zapnutie Pro po platbe.

### 6.4 Po úspešnej platbe (dôležité)

V tomto MVP sa **Pro nezapína sám**. Po platbe v Stripe nájdeš zákazníka (email), v Supabase nájdeš `user_id` a v tabuľke `user_billing` nastavíš `paid_access_enabled = true` (návod: `docs/BILLING_PAYMENT_LINK_MVP.md`).

---

## Zhrnutie

**Minimálne pre Vercel:** Stačí `OPENAI_API_KEY` — hra bude fungovať, AI generovanie tiež.

**Pre Google login na produkcii:** Pridaj Vercel URL do Supabase Redirect URLs a Google Authorized origins (kroky 4 a 5).

**Pre Stripe Upgrade v profile:** `STRIPE_PAYMENT_LINK_PRO_MONTHLY` + redeploy (krok 6). Secret key zatiaľ netreba.
