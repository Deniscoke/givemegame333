-- ═══════════════════════════════════════════════════════════════════
-- gIVEMEGAME.IO — Scoreboard (statistiky) per používateľ
-- games_generated + games_exported — každý účet má svoj scoreboard
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS games_generated INTEGER DEFAULT 0;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS games_exported INTEGER DEFAULT 0;

UPDATE public.profiles SET games_generated = COALESCE(games_generated, 0) WHERE games_generated IS NULL;
UPDATE public.profiles SET games_exported = COALESCE(games_exported, 0) WHERE games_exported IS NULL;
