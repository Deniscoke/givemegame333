-- ═══════════════════════════════════════════════════════════════════
-- gIVEMEGAME.IO — RPG Progression foundation
-- Adds rpg_xp to profiles.
-- Level is computed from XP in application code (deterministic formula).
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS rpg_xp INT NOT NULL DEFAULT 0
    CHECK (rpg_xp >= 0 AND rpg_xp <= 999999);

COMMENT ON COLUMN public.profiles.rpg_xp IS
  'Accumulated RPG experience points. Level is derived in code from XP_THRESHOLDS[]. Max 999 999.';

-- Index for leaderboard queries (future)
CREATE INDEX IF NOT EXISTS idx_profiles_rpg_xp ON public.profiles(rpg_xp DESC)
  WHERE rpg_xp > 0;
