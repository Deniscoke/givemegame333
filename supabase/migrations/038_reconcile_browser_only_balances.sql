-- ═══════════════════════════════════════════════════════════════════
-- 038 — One-time balance reconciliation from ledger evidence (P0 review)
--
-- Before 036 the browser kept max(localStorage, profiles.coins) and upserted
-- it into profiles.coins. On databases that ran 030 but not 033 that upsert
-- failed with 42501 (see the 033 header), coins.js then stopped syncing, and
-- the real balance lived only in localStorage. Since 036 the server balance
-- is the only one coins.js reads, so those users would silently fall back to
-- a stale profiles.coins. The localStorage number is not trusted (any
-- browser could set it), so this migration uses the server-side ledger:
--
--   evidence = SUM(coin_transactions.amount)        -- events /api/coins/log and server routes recorded
--            - SUM(donations the user sent)         -- pre-037 donor debits were never logged
--            + SUM(donations the user received)     -- 003 trigger credited them without a ledger row
--
-- A user whose evidence is higher than profiles.coins is raised to the
-- evidence, never above RECONCILE_CEILING (25 000 coins: older ledger rows
-- were client-reported, so an implausible total is not restored in full),
-- and never lowered. Each raise writes a 'balance_reconcile' ledger row with
-- the previous balance and the evidence in metadata, so support can audit it.
--
-- Runs once: public.economy_migration_markers records the run, and a later
-- re-run (when new ledger rows such as 'giveme_donation_sent' exist and the
-- formula above no longer holds) does nothing. Users must be told about the
-- reconciliation in the release notes (docs/ENV_SETUP.md).
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.economy_migration_markers (
  key TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  details JSONB
);
ALTER TABLE public.economy_migration_markers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.economy_migration_markers FROM PUBLIC;
REVOKE ALL ON public.economy_migration_markers FROM anon;
REVOKE ALL ON public.economy_migration_markers FROM authenticated;

DO $$
DECLARE
  reconcile_ceiling CONSTANT integer := 25000;
  has_donations boolean := to_regclass('public.giveme_coin_donations') IS NOT NULL;
  raised integer := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM public.economy_migration_markers WHERE key = '038_reconcile_browser_only_balances') THEN
    RAISE NOTICE '038: reconciliation already applied, skipping';
    RETURN;
  END IF;
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

  CREATE TEMP TABLE _coin_raise ON COMMIT DROP AS
    SELECT user_id, previous_coins, ledger_sum, donated, received,
           LEAST(ledger_sum - donated + received, reconcile_ceiling) AS target
      FROM _coin_evidence
     WHERE LEAST(ledger_sum - donated + received, reconcile_ceiling) > previous_coins;

  UPDATE public.profiles p
     SET coins = r.target
    FROM _coin_raise r
   WHERE p.id = r.user_id;
  GET DIAGNOSTICS raised = ROW_COUNT;

  INSERT INTO public.coin_transactions (user_id, amount, action, metadata)
  SELECT user_id, (target - previous_coins)::integer, 'balance_reconcile',
         jsonb_build_object(
           'migration', '038',
           'previous_coins', previous_coins,
           'ledger_sum', ledger_sum,
           'donated', donated,
           'received', received,
           'ceiling', reconcile_ceiling
         )
    FROM _coin_raise;

  INSERT INTO public.economy_migration_markers (key, details)
  VALUES ('038_reconcile_browser_only_balances', jsonb_build_object('raised_users', raised, 'ceiling', reconcile_ceiling))
  ON CONFLICT (key) DO NOTHING;

  RAISE NOTICE '038: raised % balance(s) from ledger evidence', raised;
END
$$;
