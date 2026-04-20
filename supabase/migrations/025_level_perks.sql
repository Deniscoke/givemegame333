-- ═══════════════════════════════════════════════════════════════════
-- gIVEMEGAME.IO — Level-based IRL perks (RPG rewards)
-- Migration 025
--
-- Students unlock real-world classroom perks as they level up.
-- If the student is a member of an EDU school, their perk claims go
-- to 'pending' and require a teacher to approve. Outside EDU, claims
-- activate immediately.
-- ═══════════════════════════════════════════════════════════════════

-- 1. Catalogue of perks keyed by unlock level
CREATE TABLE IF NOT EXISTS public.rpg_level_perks (
  level              INT PRIMARY KEY CHECK (level BETWEEN 2 AND 10),
  perk_key           TEXT UNIQUE NOT NULL,
  icon               TEXT NOT NULL,
  title              TEXT NOT NULL,
  description        TEXT NOT NULL,
  cooldown_hours     INT  NOT NULL CHECK (cooldown_hours >= 0),
  duration_minutes   INT  CHECK (duration_minutes IS NULL OR duration_minutes > 0)
);

COMMENT ON TABLE public.rpg_level_perks IS
  'Catalogue of unlockable IRL perks (one per level 2-10). Static — seeded by migration.';

-- 2. Per-user claim log
CREATE TABLE IF NOT EXISTS public.rpg_perk_uses (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  perk_key     TEXT NOT NULL REFERENCES public.rpg_level_perks(perk_key) ON DELETE CASCADE,
  claimed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','approved','rejected','auto_approved')),
  decided_at   TIMESTAMPTZ,
  decided_by   UUID REFERENCES auth.users(id),
  teacher_note TEXT,
  school_id    UUID REFERENCES public.edu_schools(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_perk_uses_user     ON public.rpg_perk_uses(user_id, claimed_at DESC);
CREATE INDEX IF NOT EXISTS idx_perk_uses_pending  ON public.rpg_perk_uses(school_id, status)
  WHERE status = 'pending';

-- 3. RLS
ALTER TABLE public.rpg_level_perks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rpg_perk_uses   ENABLE ROW LEVEL SECURITY;

-- Catalogue: everyone authenticated can read
DROP POLICY IF EXISTS "perks readable" ON public.rpg_level_perks;
CREATE POLICY "perks readable" ON public.rpg_level_perks FOR SELECT USING (true);

-- Uses: user sees own; teachers in same school see pending from their school
DROP POLICY IF EXISTS "perk uses own read" ON public.rpg_perk_uses;
CREATE POLICY "perk uses own read" ON public.rpg_perk_uses
  FOR SELECT USING (
    auth.uid() = user_id
    OR EXISTS (
      SELECT 1 FROM public.edu_school_memberships m
      WHERE m.user_id = auth.uid()
        AND m.role IN ('teacher','admin')
        AND m.school_id = rpg_perk_uses.school_id
    )
  );

DROP POLICY IF EXISTS "perk uses own insert" ON public.rpg_perk_uses;
CREATE POLICY "perk uses own insert" ON public.rpg_perk_uses
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "perk uses teacher decide" ON public.rpg_perk_uses;
CREATE POLICY "perk uses teacher decide" ON public.rpg_perk_uses
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.edu_school_memberships m
      WHERE m.user_id = auth.uid()
        AND m.role IN ('teacher','admin')
        AND m.school_id = rpg_perk_uses.school_id
    )
  );

GRANT SELECT ON public.rpg_level_perks TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.rpg_perk_uses TO authenticated;

-- 4. Seed the 9 perks
INSERT INTO public.rpg_level_perks (level, perk_key, icon, title, description, cooldown_hours, duration_minutes) VALUES
  (2,  'phone_break',    '📱', 'Telefónna prestávka',  'Pozri si mobil na hodine — 3 min.',                                   72,  3),
  (3,  'micro_pause',    '☕', 'Micro-pauza',           'Vypni sa kdekoľvek v škole na 20 min.',                               48,  20),
  (4,  'own_soundtrack', '🎵', 'Vlastný soundtrack',    'Slúchadlá pri samostatnej práci — celá hodina.',                      48,  45),
  (5,  'free_seat',      '🪑', 'Voľné sedenie',         'Vyber si miesto v triede na celý deň.',                               168, NULL),
  (6,  'skip_task',      '🎯', 'Skip 1 úlohu',          'Odpusť si jednu domácu úlohu bez straty známky.',                    168, NULL),
  (7,  'topic_choice',   '📚', 'Voľba témy',            'Vyber si tému vlastného projektu alebo referátu.',                   336, NULL),
  (8,  'second_try',     '🔁', 'Second try',            'Jedna oprava testu bez negatívneho dopadu.',                         336, NULL),
  (9,  'late_start',     '⏰', 'Neskorý štart',         'Príď o 15 min neskôr — ráno je tvoje.',                               336, 15),
  (10, 'mentor_day',     '👑', 'Mentor dňa',            'Si učiteľov asistent na jednu hodinu — sám vyberieš aktivitu.',     720, 45)
ON CONFLICT (perk_key) DO NOTHING;
