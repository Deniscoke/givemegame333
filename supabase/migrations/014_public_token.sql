-- ═══════════════════════════════════════════════════════════════════
-- gIVEMEGAME.IO — Public share token for saved_games
-- Migration 014
-- Run in Supabase Dashboard → SQL Editor
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.saved_games
  ADD COLUMN IF NOT EXISTS public_token UUID DEFAULT NULL;

-- Partial unique index: only enforces uniqueness on non-NULL tokens
CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_games_public_token
  ON public.saved_games(public_token)
  WHERE public_token IS NOT NULL;
