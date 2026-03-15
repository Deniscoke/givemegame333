# gIVEMECOIN Hybrid — Implementačný plán a checklist

**Scenár C:** In-app coiny + voliteľný blockchain token

---

## Fáza 1: Vylepšenie in-app coinov (bez blockchainu)

**Cieľ:** Stabilný základ, história transakcií, coin menu.  
**Čas:** 2–4 dni

### 1.1 Databáza

- [ ] Vytvoriť migráciu `006_coin_transactions.sql`
- [ ] Spustiť v Supabase Dashboard
- [ ] Upraviť `App.Coins.award()` — pri každom pridání zapísať do `coin_transactions`

### 1.2 Backend API

- [ ] Endpoint `GET /api/coins/history?limit=50` — vracia históriu pre prihláseného usera
- [ ] Endpoint `GET /api/coins/balance` — vracia aktuálny balance (môže byť z profiles)

### 1.3 Frontend — Coin menu (iba in-app, bez blockchainu)

- [ ] Klik na coin ikonu v headeri → otvorí dropdown/modal
- [ ] Zobrazenie: balance, posledných 10–20 transakcií
- [ ] Formát transakcie: „+15 Robot Challenge“, „-5 Dar gIVEME“, atď.
- [ ] Sekcia „Ako zarábať“ — odkazy na Robot Challenge, Tamagochi, gIVEME
- [ ] **Žiadny** WalletConnect, Claim token ani crypto terminológia — to až Fáza 3

### 1.4 Logovanie existujúcich akcií

- [ ] Robot Challenge — pri úspechu zapísať `+15`, action `robot_challenge`
- [ ] Tamagochi — pri každom coine zapísať `+1`, action `tamagochi_coin`
- [ ] gIVEME darovanie — zapísať `-X` donor, `+X` recipient, action `giveme_donation_*`

---

## Fáza 2: Právne a dokumentácia

**Cieľ:** Pripraviť podklady pred blockchain vrstvou.  
**Čas:** 1–2 týždne (vrátane konzultácií)

### 2.1 Dokumenty

- [ ] Terms of Service (ToS) — šablóna alebo právnik
- [ ] Privacy Policy — GDPR compliant
- [ ] Token Disclaimer — text pre UI (viď `gIVEMECOIN_LEGAL_CONSIDERATIONS.md`)

### 2.2 Konzultácie

- [ ] Právnik — 1–2h review hybrid modelu
- [ ] Určiť jurisdikciu (SK / CZ / iná)

---

## Fáza 3: Blockchain vrstva (voliteľná)

**Cieľ:** Claim tokenov za in-app coiny.  
**Čas:** 2–4 týždne (podľa znalostí)

### 3.1 Výber technológie

- [ ] Vybrať sieť: Polygon / Base / Solana / iná
- [ ] Vybrať wallet: MetaMask + WalletConnect alebo Phantom

### 3.2 Smart contract / token

- [ ] Vytvoriť ERC-20 alebo SPL token
- [ ] Nasadit na testnet (najprv)
- [ ] Mintovací mechanizmus — kto môže mintovať (len backend)

### 3.3 Backend

- [ ] Migrácia `007_token_claims.sql`
- [ ] Endpoint `POST /api/coins/claim-request` — overí usera, balance, vráti tx alebo podpis
- [ ] Rate limiting, min. balance
- [ ] Veková brána (18+) — overenie pred claimom

### 3.4 Frontend — Crypto / Claim rozšírenie (samostatná sekcia v coin menu)

- [ ] Nová sekcia „Claim token“ — zobrazí sa len ak je blockchain vrstva aktívna
- [ ] Tlačidlo „Claim gIVEME token“ + WalletConnect modal
- [ ] Zobrazenie Token Disclaimer pred claimom
- [ ] Success / error stavy
- [ ] Oddeliť vizuálne od bežného in-app coin menu (Fáza 1)

### 3.5 Testovanie

- [ ] Testnet — celý flow
- [ ] Mainnet — len po právnom OK

---

## Fáza 4: Spustenie a monitoring

- [ ] Monitoring claimov, chýb
- [ ] Zber feedbacku od používateľov
- [ ] Príprava na právne audit (ak potrebný)

---

## Rýchly checklist — čo urobiť najskôr

1. **Tento týždeň:** Fáza 1.1 a 1.2 (databáza + API)
2. **Ďalší týždeň:** Fáza 1.3 a 1.4 (UI + logovanie)
3. **Paralelne:** Fáza 2.1 (ToS, Privacy Policy) — môžeš použiť generátory online
4. **Pred blockchainom:** Fáza 2.2 (právnik)

---

## Súvisiace dokumenty

- `docs/gIVEMECOIN_LEGAL_CONSIDERATIONS.md` — právne hľadiská
- `docs/gIVEMECOIN_HYBRID_SPEC.md` — technická špecifikácia
