-- ═══════════════════════════════════════════════════════════════════
-- gIVEMEGAME.IO — INVOK Pre/Post Assessment Module
-- Migration 028
--
-- PURPOSE:
--   Formal pre/post test framework for INVOK impact measurement.
--   Four INVOK modules:
--     - entrepreneurship
--     - critical_media_thinking
--     - teamwork_digital_tools
--     - presentation_communication
--
--   Three question types: multiple_choice, text, scale_1_5
--   Auditability: every attempt links user_id + module + type + timestamps.
--
-- LEGAL/COMPLIANCE NOTES:
--   - All FK to auth.users use ON DELETE CASCADE for GDPR "right to be
--     forgotten" compliance — when a user is deleted, their attempts go too.
--   - institution_id / class_id are nullable: solo (non-school) usage is OK.
--   - No row-level security policies yet — application enforces ownership.
--     Future: add RLS analogous to edu_classes when sprint allows.
-- ═══════════════════════════════════════════════════════════════════

-- ─── 1. Assessments (templates) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.assessments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title           TEXT NOT NULL,
  description     TEXT,
  module_key      TEXT NOT NULL CHECK (module_key IN (
    'entrepreneurship',
    'critical_media_thinking',
    'teamwork_digital_tools',
    'presentation_communication'
  )),
  assessment_type TEXT NOT NULL CHECK (assessment_type IN ('pre','post','generic')),
  created_by      UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_assessments_created_by
  ON public.assessments(created_by);
CREATE INDEX IF NOT EXISTS idx_assessments_module_type
  ON public.assessments(module_key, assessment_type);

-- ─── 2. Questions ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.assessment_questions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id   UUID NOT NULL REFERENCES public.assessments(id) ON DELETE CASCADE,
  question_order  INTEGER NOT NULL DEFAULT 0,
  question_type   TEXT NOT NULL CHECK (question_type IN (
    'multiple_choice','text','scale_1_5'
  )),
  prompt          TEXT NOT NULL,
  options         JSONB,         -- multiple_choice: ["A","B",...]
  correct_answer  JSONB,         -- multiple_choice: ["A"]; scale: {"target":5}
  max_points      NUMERIC NOT NULL DEFAULT 1 CHECK (max_points >= 0),
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_assess_q_assessment
  ON public.assessment_questions(assessment_id, question_order);

-- ─── 3. Attempts (one student × one assessment, possibly many times) ─
CREATE TABLE IF NOT EXISTS public.assessment_attempts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id   UUID NOT NULL REFERENCES public.assessments(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  institution_id  UUID REFERENCES public.edu_schools(id) ON DELETE SET NULL,
  class_id        UUID REFERENCES public.edu_classes(id) ON DELETE SET NULL,
  module_key      TEXT NOT NULL CHECK (module_key IN (
    'entrepreneurship',
    'critical_media_thinking',
    'teamwork_digital_tools',
    'presentation_communication'
  )),
  assessment_type TEXT NOT NULL CHECK (assessment_type IN ('pre','post','generic')),
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at    TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'in_progress'
                  CHECK (status IN ('in_progress','submitted','abandoned')),
  total_score     NUMERIC,
  max_score       NUMERIC,
  percent_score   NUMERIC
);
CREATE INDEX IF NOT EXISTS idx_assess_att_user
  ON public.assessment_attempts(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_assess_att_assessment
  ON public.assessment_attempts(assessment_id);
-- Composite index for the pre/post delta query (per-user per-module per-type)
CREATE INDEX IF NOT EXISTS idx_assess_att_user_module
  ON public.assessment_attempts(user_id, module_key, assessment_type, submitted_at DESC);
-- For institution-level reporting
CREATE INDEX IF NOT EXISTS idx_assess_att_institution
  ON public.assessment_attempts(institution_id) WHERE institution_id IS NOT NULL;

-- ─── 4. Answers ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.assessment_answers (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id          UUID NOT NULL REFERENCES public.assessment_attempts(id) ON DELETE CASCADE,
  question_id         UUID NOT NULL REFERENCES public.assessment_questions(id) ON DELETE RESTRICT,
  answer              JSONB,         -- e.g. {"value":"A"} or {"value":4}
  score               NUMERIC NOT NULL DEFAULT 0,
  max_points          NUMERIC NOT NULL DEFAULT 1,
  needs_manual_review BOOLEAN NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(attempt_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_assess_ans_attempt
  ON public.assessment_answers(attempt_id);

-- ─── 5. updated_at trigger on assessments ───────────────────────────
CREATE OR REPLACE FUNCTION public.touch_assessments_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_assessments_updated_at'
  ) THEN
    CREATE TRIGGER trg_assessments_updated_at
      BEFORE UPDATE ON public.assessments
      FOR EACH ROW EXECUTE FUNCTION public.touch_assessments_updated_at();
  END IF;
END $$;
