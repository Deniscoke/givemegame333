-- ═══════════════════════════════════════════════════════════════════
-- 039 — Play tickets, reflections and per-stat XP (Phase 5)
--
-- play_tickets  : the server's own copy of a game a user is playing solo.
--                 Issued at generation (or from the user's library) and
--                 started when the timer starts. /api/profile/complete-solo
--                 takes only the ticket id: duration, mode and competencies
--                 come from this row, never from the browser. Single use.
-- reflections   : solo reflection answers that passed the quality gate
--                 (all ratings, open answers >= 20 chars, not a repeat).
--                 One per ticket; it earns the +25 % reflection bonus.
-- user_stat_xp  : XP per attribute (6 stats + sub-tags motorika, vyziva,
--                 digitalna) from validated play.
--
-- All three are written only by the server (service connection). The browser
-- reads them through API routes, so anon/authenticated get no grants.
-- Idempotent: safe to re-run.
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.play_tickets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source        TEXT NOT NULL DEFAULT 'generated',
  game_hash     TEXT NOT NULL,
  game_json     JSONB NOT NULL,
  mode          TEXT,
  duration_min  INTEGER NOT NULL DEFAULT 5,
  duration_max  INTEGER NOT NULL DEFAULT 15,
  kompetence    TEXT[] NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  reflection_id UUID,
  reward        JSONB
);

DO $$
BEGIN
  -- 'local' = a game the server has no copy of (fixed 5-15 min, no bonus).
  -- Re-created when an older copy of this check does not list it yet.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'play_tickets_source_check'
                   AND pg_get_constraintdef(oid) LIKE '%local%') THEN
    ALTER TABLE public.play_tickets DROP CONSTRAINT IF EXISTS play_tickets_source_check;
    ALTER TABLE public.play_tickets
      ADD CONSTRAINT play_tickets_source_check CHECK (source IN ('generated', 'library', 'replay', 'local'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'play_tickets_duration_check') THEN
    ALTER TABLE public.play_tickets
      ADD CONSTRAINT play_tickets_duration_check
      CHECK (duration_min BETWEEN 1 AND 180 AND duration_max BETWEEN duration_min AND 180);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'play_tickets_completed_after_start') THEN
    ALTER TABLE public.play_tickets
      ADD CONSTRAINT play_tickets_completed_after_start
      CHECK (completed_at IS NULL OR started_at IS NOT NULL);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_play_tickets_user_created ON public.play_tickets (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_play_tickets_user_started ON public.play_tickets (user_id, started_at DESC)
  WHERE started_at IS NOT NULL;
-- Library copies are matched to the server's own generated game by content hash.
CREATE INDEX IF NOT EXISTS idx_play_tickets_generated_hash ON public.play_tickets (game_hash)
  WHERE source = 'generated';

CREATE TABLE IF NOT EXISTS public.reflections (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  ticket_id   UUID REFERENCES public.play_tickets(id) ON DELETE CASCADE,
  session_id  UUID,
  ratings     JSONB NOT NULL DEFAULT '{}'::jsonb,
  texts       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_reflections_ticket ON public.reflections (ticket_id) WHERE ticket_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reflections_user_created ON public.reflections (user_id, created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'play_tickets_reflection_fk') THEN
    ALTER TABLE public.play_tickets
      ADD CONSTRAINT play_tickets_reflection_fk
      FOREIGN KEY (reflection_id) REFERENCES public.reflections(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.user_stat_xp (
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  stat        TEXT NOT NULL,
  xp          INTEGER NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, stat)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_stat_xp_stat_check') THEN
    ALTER TABLE public.user_stat_xp
      ADD CONSTRAINT user_stat_xp_stat_check CHECK (stat IN (
        'insight', 'focus', 'creativity', 'resilience', 'communication', 'strategy',
        'motorika', 'vyziva', 'digitalna'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_stat_xp_range') THEN
    ALTER TABLE public.user_stat_xp
      ADD CONSTRAINT user_stat_xp_range CHECK (xp BETWEEN 0 AND 999999);
  END IF;
END $$;

-- Server-only tables: RLS on, no browser grants, no policies.
ALTER TABLE public.play_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reflections  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_stat_xp ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.play_tickets FROM PUBLIC;
REVOKE ALL ON public.play_tickets FROM anon;
REVOKE ALL ON public.play_tickets FROM authenticated;
REVOKE ALL ON public.reflections  FROM PUBLIC;
REVOKE ALL ON public.reflections  FROM anon;
REVOKE ALL ON public.reflections  FROM authenticated;
REVOKE ALL ON public.user_stat_xp FROM PUBLIC;
REVOKE ALL ON public.user_stat_xp FROM anon;
REVOKE ALL ON public.user_stat_xp FROM authenticated;

COMMENT ON TABLE public.play_tickets IS 'Phase 5: server copy of a solo game; complete-solo accepts only its id (single use).';
COMMENT ON TABLE public.reflections  IS 'Phase 5: quality-gated reflection answers (one per ticket) that earn the reflection bonus.';
COMMENT ON TABLE public.user_stat_xp IS 'Phase 5: XP per attribute / sub-tag from validated play. Server writes only.';
