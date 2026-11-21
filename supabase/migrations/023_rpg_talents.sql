-- ═══════════════════════════════════════════════════════════════════
-- 023 — RPG talent unlocks
--
-- The talent tree (lib/rpg-talents.js, /api/rpg/talents*) has used
-- public.rpg_user_talents since April 2026, but the table was created by
-- hand in production and never committed. A fresh database (local Docker,
-- a restored backup, a new project) therefore failed every talent and
-- generation request with `relation "public.rpg_user_talents" does not
-- exist`.
--
-- Only the server touches this table, through the privileged pool
-- (unlock = coin deduction + insert in one transaction). The browser reads
-- talents via /api/rpg/talents, so clients get no direct privileges.
--
-- Idempotent: safe on production, where the table already exists.
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.rpg_user_talents (
  user_id     UUID        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  talent_id   INTEGER     NOT NULL CHECK (talent_id > 0),
  unlocked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, talent_id)
);

ALTER TABLE public.rpg_user_talents ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.rpg_user_talents FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.rpg_user_talents TO service_role;
