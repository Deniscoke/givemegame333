-- ═══════════════════════════════════════════════════════════════════
-- 037 — gIVEME coin donations go through the server only (P0 review)
--
-- 003 lets authenticated users INSERT into giveme_coin_donations, and its
-- SECURITY DEFINER trigger on_giveme_donation credits the post author's
-- profiles.coins. Nothing debits the donor in the database: before 036 the
-- browser lowered its own balance and upserted profiles.coins, and since
-- 036 (no client coin writes) a donation cost the donor nothing at all, so
-- anyone could mint coins for another account and inflate "coins received".
--
-- POST /api/giveme/donate (server.js, lib/coin-ledger.js applyDonation) now
-- debits the donor, inserts the donation row (the trigger still credits the
-- author) and writes both coin_transactions rows in one transaction through
-- the privileged pg pool, which bypasses these grants and RLS. The browser
-- keeps SELECT so the feed can show donation totals.
--
-- Idempotent: REVOKE is repeatable and the block is skipped when the table
-- does not exist.
-- ═══════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF to_regclass('public.giveme_coin_donations') IS NULL THEN
    RAISE NOTICE '037: public.giveme_coin_donations does not exist, skipping';
    RETURN;
  END IF;

  REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.giveme_coin_donations FROM PUBLIC;
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.giveme_coin_donations FROM anon;
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.giveme_coin_donations FROM authenticated;

  -- The INSERT policy from 003 is unreachable without the grant; drop it so
  -- a later GRANT cannot silently reopen browser inserts.
  DROP POLICY IF EXISTS "Users can insert own donation" ON public.giveme_coin_donations;
END
$$;
