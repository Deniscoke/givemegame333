# Zdieľanie s kamarátom (tunely)

## Čo sa zmenilo

Keď kamarát otvorí **tunelový link**, dostane **hra priamo** — nie login. Nemusí sa prihlasovať.

Keď ty otvoríš **localhost:3000**, stále vidíš login (ak chceš).

---

## Možnosť A: LocalTunnel (najjednoduchšie — len npm)

**Výhoda:** Žiadna inštalácia, funguje na Windows. Pri prvom otvorení môže byť „Click to Continue“ — kamarát klikne.

1. Spusti server:
   ```bash
   npm start
   ```

2. V **druhom termináli** (v priečinku projektu):
   ```bash
   npm run tunnel
   ```
   alebo
   ```bash
   npx localtunnel --port 3000
   ```

3. Skopíruj URL (napr. `https://xxx.loca.lt`) a pošli kamarátovi. Ak vidíš „Click to Continue“, klikni — potom skopíruj URL z adresného riadka a pošli ju.

---

## Možnosť B: Ngrok

1. **Spusti server:**
   ```bash
   npm start
   ```
   alebo
   ```bash
   node server.js
   ```

2. **Spusti ngrok** (v druhom termináli):
   ```bash
   ngrok http 3000
   ```

3. **Skopíruj URL** z ngrok (napr. `https://abc123.ngrok-free.dev`) a pošli kamarátovi.

4. **Dôležité:** Pri prvom otvorení ngrok zobrazí stránku „Visit Site“ — kamarát musí na ňu **kliknúť**, aby videl hru.

---

## Možnosť C: Cloudflare Tunnel

**Poznámka:** Na Windows môže mať problémy (certifikáty). Ak nefunguje, skús LocalTunnel (A) alebo Ngrok (B).

1. Nainštaluj [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/)
2. Spusti server, potom v druhom termináli: `cloudflared tunnel --url http://localhost:3000`
3. Skopíruj URL (`https://xxx.trycloudflare.com`)

---

## Ak kamarát chce prihlásenie (Google)

Potrebuješ pridať ngrok URL do:

### Supabase
1. [Supabase Dashboard](https://supabase.com/dashboard) → tvoj projekt
2. **Authentication** → **URL Configuration**
3. Do **Redirect URLs** pridaj: `https://TVOJ-NGROK-URL.ngrok-free.dev/login.html`

### Google Cloud
1. [Google Cloud Console](https://console.cloud.google.com/) → Credentials
2. OAuth 2.0 Client ID → **Authorized JavaScript origins** → pridaj `https://TVOJ-NGROK-URL.ngrok-free.dev`
3. **Authorized redirect URIs** → pridaj `https://vhpkkbixshfyytohkruv.supabase.co/auth/v1/callback` (ak tam ešte nie je)

---

## Ak odkaz nefunguje ani tebe ani kamarátovi

1. **Over, že server beží:** Otvor `http://localhost:3000` vo svojom prehliadači — musíš vidieť login/hru. Ak nie, spusti `npm start`.
2. **Skús LocalTunnel:** `npm run tunnel` v druhom termináli — často funguje lepšie ako Cloudflare na Windows.
3. **Skús Ngrok:** `ngrok http 3000` — pri prvom otvorení klikni na „Visit Site“.

---

## Ak kamarát vidí „connection refused“ / „localhost odmítl připojení“

**Príčina:** Kamarát otvára `http://localhost:3000` namiesto tunelovej URL. Localhost funguje len na tvojom počítači.

**Riešenie:**
1. Skopíruj presne tunelovú URL (ngrok alebo Cloudflare) a pošli kamarátovi
2. Keď si sám na tunelovej URL, v hlavičke sa zobrazí tlačidlo **🔗 Zdieľať** — klikni a skopíruj odkaz

---

## Ak kamarátovi sa nič nezobrazuje (ngrok)

**Príčina:** Ngrok free zobrazuje intersticiálnu stránku „Visit Site“. Kamarát musí na ňu **kliknúť**.

**Riešenie:** Použi **LocalTunnel** (Možnosť A) — jednoduchšie. Alebo skús **Ngrok** a daj kamarátovi vedieť, že musí kliknúť na „Visit Site“.

---

## Poznámka

Ngrok URL sa mení pri každom spustení (vo free verzii). Po každom novom `ngrok http 3000` musíš aktualizovať URL v Supabase/Google, ak chceš Google login cez ngrok.
