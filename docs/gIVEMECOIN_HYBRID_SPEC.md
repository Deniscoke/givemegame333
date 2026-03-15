# gIVEMECOIN Hybrid — Technická špecifikácia

**Scenár C:** In-app coiny + voliteľný blockchain token  
**Verzia:** 1.0

---

## 1. Architektúra

```
┌─────────────────────────────────────────────────────────────────┐
│                     gIVEMEGAME.IO                                │
├─────────────────────────────────────────────────────────────────┤
│  IN-APP COINS (existujúce)                                       │
│  • profiles.coins v Supabase                                     │
│  • Zarábanie: Robot Challenge, Tamagochi, gIVEME dary           │
│  • Žiadny blockchain                                              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ "Claim" (voliteľné)
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  BLOCKCHAIN LAYER (nové)                                         │
│  • WalletConnect / MetaMask                                      │
│  • Smart contract alebo CEX API                                  │
│  • Token: gIVEME (utility)                                       │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. Databázové rozšírenia

### 2.1 Nová tabuľka: `coin_transactions`

Pre históriu in-app coinov (aj bez blockchainu užitočné).

```sql
CREATE TABLE IF NOT EXISTS public.coin_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  action TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_coin_transactions_user ON public.coin_transactions(user_id);
CREATE INDEX idx_coin_transactions_created ON public.coin_transactions(created_at DESC);

-- RLS
ALTER TABLE public.coin_transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own transactions"
  ON public.coin_transactions FOR SELECT USING (auth.uid() = user_id);
```

**Hodnoty `action`:** `robot_challenge`, `tamagochi_coin`, `giveme_donation_sent`, `giveme_donation_received`, `claim_token`, `bonus`, atď.

### 2.2 Nová tabuľka: `token_claims` (pre blockchain)

Pre sledovanie, kto už claimol tokeny.

```sql
CREATE TABLE IF NOT EXISTS public.token_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  wallet_address TEXT NOT NULL,
  in_app_coins_spent INTEGER NOT NULL,
  tokens_claimed INTEGER NOT NULL,
  tx_hash TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_token_claims_user ON public.token_claims(user_id);
```

---

## 3. Konverzný pomer (príklad)

| In-app coiny | Tokeny (príklad) |
|--------------|-------------------|
| 100          | 1 gIVEME          |
| 1000         | 10 gIVEME         |
| 10000        | 100 gIVEME        |

**Poznámka:** Pomer určíš ty. Môže byť fixný alebo dynamický.

---

## 4. Technológie pre blockchain vrstvu

### Možnosť A: Ethereum / Polygon / Base (ERC-20)

- **WalletConnect** alebo **MetaMask** pre pripojenie peňaženky
- **ethers.js** alebo **viem** pre interakciu so smart contractom
- Smart contract: mintovanie tokenov na základe overeného claimu z backendu

### Možnosť B: Solana (SPL Token)

- **Phantom** / **WalletConnect**
- **@solana/web3.js**
- Rýchlejšie a lacnejšie transakcie

### Možnosť C: CEX / custodial (najjednoduchšie)

- Použiť API existujúcej platformy (napr. Circle, Fireblocks)
- Menej decentralizácie, ale jednoduchšia implementácia

---

## 5. Flow „Claim token“

```
1. User má 500 in-app coinov
2. Klikne "Claim gIVEME token"
3. Veková brána 18+ (ak nie, stop)
4. WalletConnect — pripojí MetaMask/Phantom
5. Backend overí: user_id, balance >= 100, ešte neclaimol dnes
6. Backend vytvorí "claim request"
7. Smart contract alebo API mintne/pošle tokeny na wallet
8. Backend: odpočíta 100 coinov, zapíše do token_claims
9. UI: "Success! 1 gIVEME poslané na tvoju peňaženku"
```

---

## 6. Bezpečnostné požiadavky

- **Backend overuje** každý claim — nikdy len frontend
- **Rate limiting** — max X claimov za deň / používateľa
- **Min. balance** — napr. 100 coinov na 1 claim
- **Wallet ownership** — overiť, že wallet patrí prihlásenému userovi (napr. podpis)

---

## 7. API endpointy (navrhované)

| Endpoint | Metóda | Popis |
|----------|--------|-------|
| `GET /api/coins/history` | GET | História transakcií pre usera |
| `POST /api/coins/claim-request` | POST | Zažiadať claim tokenov (vracia podpis alebo tx) |
| `GET /api/coins/claim-status` | GET | Stav posledného claimu |

---

## 8. Závislosti (npm)

Pre blockchain vrstvu (ak ERC-20):

```
npm install viem @walletconnect/modal
```

alebo

```
npm install ethers @walletconnect/web3-provider
```

---

## 9. Súbory na vytvorenie / úpravu

| Súbor | Zmena |
|-------|-------|
| `supabase/migrations/006_coin_transactions.sql` | Nová tabuľka |
| `supabase/migrations/007_token_claims.sql` | Nová tabuľka |
| `server.js` | Endpointy `/api/coins/*` |
| `script.js` | Rozšírenie `App.Coins` o históriu, UI menu |
| `index.html` | Coin menu dropdown/modal |
| `docs/` | Právne dokumenty |
