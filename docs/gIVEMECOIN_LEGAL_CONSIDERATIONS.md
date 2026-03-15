# gIVEMECOIN — Právne hľadiská a odporúčania

**Scenár C (Hybrid):** In-app coiny + voliteľný blockchain token  
**Dátum:** 2026  
**Poznámka:** Tento dokument nie je právna rada. Pre definitívne rozhodnutia konzultujte právnika v danej jurisdikcii.

---

## 1. Čo je gIVEMECOIN v hybrid modeli

| Vrstva | Popis | Právna kvalifikácia |
|--------|-------|---------------------|
| **In-app coiny** | Virtuálna mena v rámci aplikácie, zarábaná za aktivity | Herná mena / loyalty body — typicky nízke riziko |
| **Blockchain token** | Reálny token na blockchaine, voliteľne „claimnutý“ za in-app coiny | Môže byť cenný papier / investičný nástroj — vyššie riziko |

---

## 2. Kľúčové právne otázky

### 2.1 Je token cenným papierom?

**Riziko:** Ak token slúži ako investícia s očakávaním zisku, môže byť považovaný za cenný papier (EU: MiFID II, USA: Howey test).

**Ako minimalizovať:**
- Token má **utility** (prístup k funkciám, zľavy, hlasovanie) — nie primárne investícia
- Žiadne sľuby na zhodnotenie, dividendy ani garancie
- Jasne komunikovať: „gIVEMECOIN je utility token pre platformu, nie investícia“
- Nepoužívať slová: investícia, zhodnotenie, ROI, garantovaný výnos

### 2.2 KYC / AML (poznanie zákazníka, protipr pranie)

**Riziko:** Pri výmene tokenov za reálnu hodnotu môžu platiť povinnosti AML.

**Odporúčanie:**
- Pre malé množstvá (napr. do 100 EUR ekvivalent ročne) — často výnimky
- Pri vyšších sumách — zvážiť KYC (overenie identity)
- Konzultovať s AML špecialistom v tvojej krajine

### 2.3 DPH a zdanenie

**Riziko:** Token môže byť predmetom DPH alebo daňových povinností.

**Odporúčanie:**
- Konzultovať daňového poradcu
- V EU: niektoré tokeny sú oslobodené od DPH, iné nie — závisí od charakteru

### 2.4 Ochrana spotrebiteľa

**Povinnosti:**
- Jasné obchodné podmienky (Terms of Service)
- Zásady ochrany osobných údajov (GDPR)
- Informácie o tom, čo používateľ dostáva a aké má práva

### 2.5 Vek používateľov

**gIVEMEGAME.IO** je vzdelávací projekt — môžu ho používať deti.

**Riziko:** Kryptomeny a blockchain sú často 18+.

**Odporúčanie:**
- **In-app coiny:** OK pre všetky veky (ako herná mena)
- **Blockchain claim:** Obmedziť na 18+ alebo vyžadovať súhlas zákonného zástupcu
- Pridať vekovú bránu pred pripojením peňaženky

---

## 3. Dokumenty, ktoré treba pripraviť

| Dokument | Účel |
|----------|------|
| **Terms of Service (ToS)** | Pravidlá používania, čo sú coiny, čo je token, disclaimery |
| **Privacy Policy** | GDPR, aké údaje zbierate, prečo |
| **Token Disclaimer** | „gIVEMECOIN token nie je investícia, žiadne garancie“ |
| **Cookie Policy** | Ak používate cookies |

---

## 4. Odporúčaný postup pred spustením tokenu

1. **Konzultácia s právnikom** — aspoň 1–2 hodiny na review modelu
2. **Jurisdikcia** — určiť, podľa ktorej krajiny sa riaďete (sídlo spoločnosti, používatelia)
3. **Pripraviť ToS a Privacy Policy** — pred akýmkoľvek zberom údajov
4. **Veková brána** — pre blockchain časť
5. **Disclaimery v UI** — pri claimovaní tokenu zobraziť upozornenie

---

## 5. Šablóna Token Disclaimer (text do UI)

```
gIVEMECOIN token je utility token pre platformu gIVEMEGAME.IO.
Nie je investíciou ani cenným papierom. Žiadne garancie zhodnotenia.
Použitie na vlastné riziko. Odporúčame konzultovať odborníka.
```

---

## 6. Kontakty pre konzultáciu (Slovensko / Česko)

- **Právnik špecializujúci sa na krypto** — vyhľadaj „krypto právnik“ + tvoj región
- **Daňový poradca** — pre DPH a zdanenie tokenov
- **Regulačné orgány:** NBS (SK), ČNB (CZ) — informačné stránky o krypto

---

## 7. Zhrnutie — čo urobiť pred spustením

- [ ] Konzultovať právnika (1–2h)
- [ ] Pripraviť Terms of Service
- [ ] Pripraviť Privacy Policy
- [ ] Pridať Token Disclaimer do UI
- [ ] Veková brána 18+ pre blockchain claim
- [ ] Určiť jurisdikciu
- [ ] Zvážiť KYC pri vyšších sumách
