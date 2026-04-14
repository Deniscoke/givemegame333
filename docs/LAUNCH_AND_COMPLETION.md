# gIVEMEGAME.IO — čo je hotové, čo dokončiť, čo je voliteľné

Krátky prehľad pre spustenie predaja a ďalší rozvoj.

## Hotovo (funkčné v kóde)

| Oblast | Stav |
|--------|------|
| Hra, generovanie, filtre, módy | Áno |
| Prihlásenie (Supabase Auth) | Áno |
| Profil, coiny, časť analytiky | Áno |
| **Plán Free / Pro** — čítanie z DB `user_billing` | Áno |
| **Upgrade** — Stripe Payment Link (bez secret key v appke) | Áno |
| Stránky `/billing/success`, `/billing/cancel` | Áno |
| `GET /api/billing/public-config` — či je platba zapnutá + support email | Áno |
| Vyšší limit generovania pre Pro (30 vs 10/min) | Áno |
| Fallback DB ak chýba migrácia 017 (starší `user_billing`) | Áno |
| Varovanie v profile ak nie je nastavený `STRIPE_PAYMENT_LINK_PRO_MONTHLY` | Áno |

## Musíš nastaviť ty (nie je v kóde)

1. **Vercel (alebo hosting)** — env premenné: `OPENAI_API_KEY`, Supabase, `STRIPE_PAYMENT_LINK_PRO_MONTHLY`, voliteľne `BILLING_SUPPORT_EMAIL`.
2. **Stripe** — Payment Link (Live), success/cancel URL na tvoju doménu.
3. **Supabase** — spustiť SQL z `RUN_BILLING_IN_SQL_EDITOR.sql` (ak ešte nie je).
4. **Po každej platbe** — manuálne zapnúť Pro v `user_billing` (kým nie sú webhooks).

## Odporúčané dokončiť pred verejným predajom

| Úloha | Prečo |
|-------|--------|
| Obchodné podmienky + GDPR / OÚ | Právna istota (EÚ) |
| Kontaktný email v `BILLING_SUPPORT_EMAIL` | Zobrazí sa na success stránke a v toastoch pri chybe |
| Vlastná doména na Verceli | Dôvera, stabilné URL pre Stripe |
| Jedna testovacia platba end-to-end | Overenie celého flow |

## Voliteľné (Phase 2) — škálovanie bez manuálnej práce

| Úloha | Prínos |
|-------|--------|
| Stripe webhook + auto `paid_access_enabled` | Žiadne ručné zapínanie Pro |
| Customer Portal / zrušenie predplatného v Stripe | Menej emailov podpory |
| Ďalšie Pro výhody v UI (export, balíky) | Lepší predajný argument |

## Čo znamená „funkčná stránka“ teraz

- Po prihlásení → Profil → vidíš plán (Free/Pro), tlačidlo Upgrade ak si Free a Stripe link je nastavený.
- Ak link nie je nastavený, uvidíš varovanie a tlačidlo bude neaktívne (prevádzkovateľ musí doplniť env).
- Po platbe → Stripe presmeruje na success stránku s textom o manuálnej aktivácii a voliteľným emailom podpory.

---

*Posledná aktualizácia: súčasná vetva kódu (Payment Link MVP).*
