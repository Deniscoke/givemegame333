-- ═══════════════════════════════════════════════════════════════════
-- gIVEMEGAME.IO — RPG avatar foundation
-- Adds rpg_avatar_id to profiles. Nullable — avatar selection is optional.
-- Valid IDs: 2–8 (matching /avatars/{id}.png files).
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS rpg_avatar_id SMALLINT
    CHECK (rpg_avatar_id IS NULL OR (rpg_avatar_id >= 2 AND rpg_avatar_id <= 8));

COMMENT ON COLUMN public.profiles.rpg_avatar_id IS
  'Selected pixel-art RPG avatar (2-8). NULL = no avatar chosen yet.';
