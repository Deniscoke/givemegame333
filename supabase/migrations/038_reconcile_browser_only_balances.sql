-- ═══════════════════════════════════════════════════════════════════
-- 038 — Balance reconciliation candidates (review only, P0 review)
--
-- Before 036 the browser kept max(localStorage, profiles.coins) and upserted
-- it into profiles.coins. On databases that ran 030 but not 033 that upsert
-- failed with 42501, so some real balances lived only in localStorage. Since
-- 036 coins.js reads only the server balance.
--
-- This migration does NOT change any balance. Pre-036 coin_transactions rows
-- were reported by the browser through /api/coins/log, so a ledger sum is not
-- trustworthy evidence: crediting it automatically would let anyone who
-- forged log entries mint coins. Instead it records users whose ledger
-- evidence is higher than profiles.coins in public.coin_reconcile_candidates
-- (service role only) so the owner can review them and apply any correction
-- by hand, with a 'balance_reconcile' ledger row per change.
--
--   evidence = SUM(coin_transactions.amount)
--            - SUM(donations the user sent)      -- pre-037 donor debits were never logged
--            + SUM(donations the user received)  -- 003 trigger credited them without a ledger row
--
-- Idempotent: candidates are upserted; re-running refreshes unreviewed rows.
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.coin_reconcile_candidates (
  user_id        UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  previous_coins BIGINT NOT NULL,
  ledger_sum     BIGINT NOT NULL,
  donated        BIGINT NOT NULL DEFAULT 0,
  received       BIGINT NOT NULL DEFAULT 0,
  evidence       BIGINT NOT NULL,
  captured_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at    TIMESTAMPTZ,
  review_note    TEXT
);
ALTER TABLE public.coin_reconcile_candidates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.coin_reconcile_candidates FROM PUBLIC;
REVOKE ALL ON public.coin_reconcile_candidates FROM anon;
REVOKE ALL ON public.coin_reconcile_candidates FROM authenticated;

DO $$
DECLARE
  has_donations boolean := to_regclass('public.giveme_coin_donations') IS NOT NULL;
  found_count integer := 0;
BEGIN
  IF to_regclass('public.coin_transactions') IS NULL OR to_regclass('public.profiles') IS NULL THEN
    RAISE NOTICE '038: coin_transactions or profiles missing, skipping';
    RETURN;
  END IF;

  CREATE TEMP TABLE _coin_evidence ON COMMIT DROP AS
    SELECT p.id AS user_id,
           COALESCE(p.coins, 0)::bigint AS previous_coins,
           COALESCE(l.ledger_sum, 0)::bigint AS ledger_sum,
           0::bigint AS donated,
           0::bigint AS received
      FROM public.profiles p
      JOIN (SELECT user_id, SUM(amount)::bigint AS ledger_sum
              FROM public.coin_transactions
             GROUP BY user_id) l ON l.user_id = p.id;

  IF has_donations THEN
    UPDATE _coin_evidence e
       SET donated = COALESCE((SELECT SUM(d.amount) FROM public.giveme_coin_donations d WHERE d.donor_id = e.user_id), 0),
           received = COALESCE((SELECT SUM(d.amount) FROM public.giveme_coin_donations d WHERE d.recipient_id = e.user_id), 0);
  END IF;

  INSERT INTO public.coin_reconcile_candidates
         (user_id, previous_coins, ledger_sum, donated, received, evidence)
  SELECT user_id, previous_coins, ledger_sum, donated, received,
         ledger_sum - donated + received
    FROM _coin_evidence
   WHERE ledger_sum - donated + received > previous_coins
  ON CONFLICT (user_id) DO UPDATE
     SET previous_coins = EXCLUDED.previous_coins,
         ledger_sum = EXCLUDED.ledger_sum,
         donated = EXCLUDED.donated,
         received = EXCLUDED.received,
         evidence = EXCLUDED.evidence,
         captured_at = now()
   WHERE public.coin_reconcile_candidates.reviewed_at IS NULL;
  GET DIAGNOSTICS found_count = ROW_COUNT;

  RAISE NOTICE '038: % reconciliation candidate(s) recorded for manual review; no balance changed', found_count;
END
$$;
