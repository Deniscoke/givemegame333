-- ═══════════════════════════════════════════════════════════════════
-- gIVEMEGAME.IO — Migration 041: test accounts (Phase 10)
-- Marks profiles created by scripts/seed-test-account.js so leaderboards,
-- analytics and institution reports can exclude them. Idempotent.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_test_account BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.profiles.is_test_account IS
  'True for the seeded all-unlocked test account. Excluded from rankings, analytics and institution reports.';

CREATE INDEX IF NOT EXISTS idx_profiles_is_test_account
  ON public.profiles(id) WHERE is_test_account;
