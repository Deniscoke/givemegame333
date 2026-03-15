-- ═══════════════════════════════════════════════════════════════════
-- gIVEMEGAME.IO — Game Feedback (rating + text)
-- Migration 013
-- Run in Supabase Dashboard → SQL Editor
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.saved_games
  ADD COLUMN IF NOT EXISTS rating   SMALLINT CHECK (rating >= 1 AND rating <= 5),
  ADD COLUMN IF NOT EXISTS feedback TEXT     CHECK (char_length(feedback) <= 500);
