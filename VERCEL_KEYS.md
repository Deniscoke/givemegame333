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

## Zhrnutie

**Minimálne pre Vercel:** Stačí `OPENAI_API_KEY` — hra bude fungovať, AI generovanie tiež.

**Pre Google login na produkcii:** Pridaj Vercel URL do Supabase Redirect URLs a Google Authorized origins (kroky 4 a 5).
