# gIVEMECOIN — Dokumentácia hybrid scenára

Tento priečinok obsahuje podklady pre Scenár C: **In-app coiny + voliteľný blockchain token**.

---

## Dokumenty

| Súbor | Obsah |
|-------|-------|
| **gIVEMECOIN_LEGAL_CONSIDERATIONS.md** | Právne hľadiská, token disclaimer, čo konzultovať s právnikom |
| **gIVEMECOIN_HYBRID_SPEC.md** | Technická špecifikácia, databáza, API, flow claimu |
| **gIVEMECOIN_IMPLEMENTATION_PLAN.md** | Implementačný plán, checklist, fázy |

---

## Migrácie

| Súbor | Popis |
|-------|-------|
| `supabase/migrations/006_coin_transactions.sql` | Tabuľka pre históriu transakcií |
| `007_token_claims.sql` | (budúce) Pre blockchain claimy |

---

## Odporúčaný postup

1. Prečítaj **Legal Considerations** — pochop riziká
2. Prečítaj **Hybrid Spec** — technický návrh
3. Nasleduj **Implementation Plan** — fáza po fáze
4. Pred blockchainom — konzultuj právnika
