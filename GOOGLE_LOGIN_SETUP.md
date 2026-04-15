# Nastavenie Google prihlásenia (gIVEMEGAME.IO)

Google login používa **Supabase Auth** s OAuth 2.0. Ak prihlásenie nefunguje (hlavne Safari na iPhone), skontrolujte:

## 1. Supabase Dashboard

1. Otvorte [Supabase Dashboard](https://supabase.com/dashboard) → váš projekt **vhpkkbixshfyytohkruv**
2. **Authentication** → **Providers** → **Google** — zapnite a vložte **Client ID** a **Client Secret** z Google Cloud
3. **Authentication** → **URL Configuration**:
   - **Site URL**: produkčná URL **`https://givemegame333.vercel.app`** — ak je localhost, po OAuth sa vrátiš na localhost!
   - **Redirect URLs** — **KRITICKÉ** — ak tu nie je vaša URL, Supabase presmeruje na Site URL (localhost):
     - `http://localhost:3000/login.html`
     - `https://givemegame333.vercel.app/login.html`
     - Ak používate ngrok: `https://xxx.ngrok-free.app/login.html` (URL sa mení pri reštarte)

   **Tip:** Na login stránke v prehliadači otvorte "🔧 Safari/iPhone nefunguje?" — zobrazí sa presná URL, ktorú treba pridať.

## 2. Google Cloud Console

1. [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services** → **Credentials**
2. OAuth 2.0 Client ID (Web application)
3. **Authorized JavaScript origins** — pridajte:
   - `http://localhost:3000`
   - `https://givemegame333.vercel.app` (bez /login.html)
4. **Authorized redirect URIs** — musí byť presne:
   - `https://vhpkkbixshfyytohkruv.supabase.co/auth/v1/callback`

## 3. Spustenie

```bash
npm start
```

Otvor: `http://localhost:3000` → presmeruje na login → **Sign in with Google**

## Riešenie problémov

- **Safari na iPhone nefunguje** (najčastejší problém):
  1. Otvor login stránku na telefóne
  2. Klikni na "🔧 Safari/iPhone nefunguje? Pridaj túto URL:"
  3. Skopíruj zobrazenú URL (alebo napíš ju ručne)
  4. Supabase Dashboard → Authentication → URL Configuration → Redirect URLs → **Add URL** → vlož presne túto URL
  5. Ulož a skús znova
  6. Ak stále nefunguje: skús **Chrome** na iPhone namiesto Safari

- **Chyba pri redirecte**: URL v Supabase musí byť **presne** rovnaká (vrátane https, bez lomítka na konci)
- **Chyba pri autorizácii**: Google Cloud → Authorized redirect URIs musí obsahovať `https://vhpkkbixshfyytohkruv.supabase.co/auth/v1/callback`
- **Session sa nestaví**: DevTools (F12) → Console — hľadaj chyby
