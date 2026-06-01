-- ═══════════════════════════════════════════════════════════════════
-- gIVEMEGAME.IO — INVOK Assessment Security Hardening
-- Migration 029
--
-- PURPOSE:
--   Add Row-Level Security (RLS) policies to the four assessment tables
--   introduced in migration 028. The Node backend uses a service-role
--   connection that bypasses RLS, so this is DEFENSE-IN-DEPTH — protects
--   against future direct client (supabase-js) access if/when it is added.
--
-- ACCESS MODEL (mirrors lib/assessment-routes.js):
--   - Students: read active assessments (without correct_answer); read,
--     insert, update only their own attempts/answers.
--   - Teachers/admins (per edu_school_memberships): create assessments;
--     read full detail (including correct_answer) of their own.
--   - No global admin — school-scoped only.
--
-- IDEMPOTENT: DROP POLICY IF EXISTS + CREATE POLICY pattern, so this
-- migration can be re-run safely.
-- ═══════════════════════════════════════════════════════════════════

-- ─── 1. Performance indexes for RLS predicates ──────────────────────
-- Most RLS checks join attempts → assessments(created_by) or filter by
-- user_id; existing indexes cover this, but we add an explicit
-- (assessment_id, user_id) composite for the answer-ownership lookup.
CREATE INDEX IF NOT EXISTS idx_assess_att_assessment_user
  ON public.assessment_attempts(assessment_id, user_id);

-- ─── 2. Helper function: is user a teacher/admin in any school? ─────
-- Returns true when the user holds a non-archived teacher OR admin
-- membership in at least one school. Used by INSERT policies on
-- assessments + assessment_questions.
CREATE OR REPLACE FUNCTION public.fn_is_educator(uid UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.edu_school_memberships
    WHERE user_id = uid
      AND role IN ('teacher', 'admin')
      AND archived_at IS NULL
  );
$$;

-- ─── 3. Enable RLS ──────────────────────────────────────────────────
ALTER TABLE public.assessments              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assessment_questions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assessment_attempts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assessment_answers       ENABLE ROW LEVEL SECURITY;

-- ─── 4. Policies on assessments ─────────────────────────────────────
-- SELECT: any authenticated user can read active assessments.
-- The frontend route hides correct_answer for non-owners; correct_answer
-- column itself is read via assessment_questions policies below.
DROP POLICY IF EXISTS "assessments_select" ON public.assessments;
CREATE POLICY "assessments_select" ON public.assessments
  FOR SELECT
  USING (
    is_active = true
    OR created_by = auth.uid()
  );

-- INSERT: only educators (teacher/admin in at least one school) may
-- create assessments. created_by must be the authenticated user.
DROP POLICY IF EXISTS "assessments_insert" ON public.assessments;
CREATE POLICY "assessments_insert" ON public.assessments
  FOR INSERT
  WITH CHECK (
    created_by = auth.uid()
    AND public.fn_is_educator(auth.uid())
  );

-- UPDATE: only the creator.
DROP POLICY IF EXISTS "assessments_update" ON public.assessments;
CREATE POLICY "assessments_update" ON public.assessments
  FOR UPDATE
  USING (created_by = auth.uid())
  WITH CHECK (created_by = auth.uid());

-- DELETE: deliberately not permitted in MVP. Soft-delete via is_active = false.
-- (No policy → blocked when RLS is enforced for non-service callers.)

-- ─── 5. Policies on assessment_questions ────────────────────────────
-- SELECT: anyone who can SELECT the parent assessment can read questions
-- BUT this includes correct_answer at the row level. The route layer
-- still strips correct_answer for non-owners. For a tighter posture in
-- the future, split correct_answer into a separate table; for MVP we
-- accept that any direct supabase-js read would see correct_answer too.
DROP POLICY IF EXISTS "assessment_questions_select" ON public.assessment_questions;
CREATE POLICY "assessment_questions_select" ON public.assessment_questions
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.assessments a
      WHERE a.id = assessment_questions.assessment_id
        AND (a.is_active = true OR a.created_by = auth.uid())
    )
  );

-- INSERT/UPDATE/DELETE: only the creator of the parent assessment.
DROP POLICY IF EXISTS "assessment_questions_write" ON public.assessment_questions;
CREATE POLICY "assessment_questions_write" ON public.assessment_questions
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.assessments a
      WHERE a.id = assessment_questions.assessment_id
        AND a.created_by = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.assessments a
      WHERE a.id = assessment_questions.assessment_id
        AND a.created_by = auth.uid()
    )
  );

-- ─── 6. Policies on assessment_attempts ─────────────────────────────
-- SELECT: the student who owns the attempt OR the creator of the parent
-- assessment (so a teacher can see student results on their own tests).
DROP POLICY IF EXISTS "assessment_attempts_select" ON public.assessment_attempts;
CREATE POLICY "assessment_attempts_select" ON public.assessment_attempts
  FOR SELECT
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.assessments a
      WHERE a.id = assessment_attempts.assessment_id
        AND a.created_by = auth.uid()
    )
  );

-- INSERT: only the student themself, and only for active assessments.
DROP POLICY IF EXISTS "assessment_attempts_insert" ON public.assessment_attempts;
CREATE POLICY "assessment_attempts_insert" ON public.assessment_attempts
  FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.assessments a
      WHERE a.id = assessment_attempts.assessment_id
        AND a.is_active = true
    )
  );

-- UPDATE: only the student themself (for submit transition).
DROP POLICY IF EXISTS "assessment_attempts_update" ON public.assessment_attempts;
CREATE POLICY "assessment_attempts_update" ON public.assessment_attempts
  FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ─── 7. Policies on assessment_answers ──────────────────────────────
-- SELECT/INSERT/UPDATE: only via an attempt the user owns OR an attempt
-- whose parent assessment the user created.
DROP POLICY IF EXISTS "assessment_answers_select" ON public.assessment_answers;
CREATE POLICY "assessment_answers_select" ON public.assessment_answers
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.assessment_attempts att
      WHERE att.id = assessment_answers.attempt_id
        AND (
          att.user_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.assessments a
            WHERE a.id = att.assessment_id
              AND a.created_by = auth.uid()
          )
        )
    )
  );

DROP POLICY IF EXISTS "assessment_answers_write" ON public.assessment_answers;
CREATE POLICY "assessment_answers_write" ON public.assessment_answers
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.assessment_attempts att
      WHERE att.id = assessment_answers.attempt_id
        AND att.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.assessment_attempts att
      WHERE att.id = assessment_answers.attempt_id
        AND att.user_id = auth.uid()
    )
  );

-- ─── 8. Notes ───────────────────────────────────────────────────────
-- - The Node backend keeps a service-role pg.Pool which bypasses RLS.
--   These policies become active when (and only when) requests reach
--   the database via supabase-js with an authenticated JWT.
-- - Soft-delete model: setting is_active = false hides assessments from
--   non-owner SELECTs and blocks new attempt INSERTs.
-- - DELETE policies intentionally omitted — the app uses soft-delete
--   only. Hard-delete from the DB is an admin/ops task.
