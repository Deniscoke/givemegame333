-- ═══════════════════════════════════════════════════════════════════
-- 034 — Server-only assessment writes + scoped tier inheritance
--
-- 1. Assessment integrity
--    032 granted `authenticated` column-level INSERT on assessment_attempts
--    and UPDATE on (submitted_at, status, total_score, max_score,
--    percent_score), and Supabase's default privileges give it INSERT /
--    UPDATE / DELETE on assessment_answers. Together with the 029/031 RLS
--    policies this let a signed-in student grade their own attempt
--    straight through PostgREST (e.g. set percent_score = 100), which
--    corrupts the pre/post results schools rely on.
--    The browser never writes these tables: public/edu, public/student and
--    public/institution go through /api/assessment-* routes, which use the
--    privileged server pool (bypasses grants and RLS). So all client write
--    privileges are removed; SELECT stays as 033 left it.
--
-- 2. effective_tier() inheritance
--    026 let a student inherit 'teacher' tier from any class they were ever
--    enrolled in, even after the enrollment, class or school was archived.
--    Inheritance now requires an active enrollment in an active class of an
--    active school.
--
-- Idempotent: REVOKE is a no-op when the privilege is absent, and
-- CREATE OR REPLACE keeps the 026 signature and grants.
-- ═══════════════════════════════════════════════════════════════════

-- 1. Assessment writes: server only ---------------------------------
-- A table-level REVOKE also removes the column-level grants from 032.
REVOKE INSERT, UPDATE, DELETE ON public.assessment_attempts FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.assessment_answers  FROM PUBLIC, anon, authenticated;

-- 2. effective_tier: only active enrollments inherit -----------------
CREATE OR REPLACE FUNCTION public.effective_tier(p_user UUID)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  own_tier TEXT;
  inherited TEXT;
BEGIN
  IF auth.role() = 'authenticated' AND auth.uid() IS DISTINCT FROM p_user THEN
    RAISE EXCEPTION 'effective_tier may only be queried for the authenticated user'
      USING ERRCODE = '42501';
  END IF;

  SELECT tier INTO own_tier FROM public.profiles WHERE id = p_user;
  IF own_tier IS NULL THEN own_tier := 'free'; END IF;
  IF own_tier IN ('admin','school','teacher') THEN
    RETURN own_tier;
  END IF;

  -- Student in an ACTIVE class of a paying teacher inherits teacher-level unlocks.
  SELECT 'teacher' INTO inherited
  FROM public.edu_class_enrollments ce
  JOIN public.edu_classes c            ON c.id = ce.class_id
  JOIN public.edu_schools s            ON s.id = c.school_id
  JOIN public.edu_teaching_assignments ta ON ta.class_id = ce.class_id
  JOIN public.profiles pt              ON pt.id = ta.teacher_id
  WHERE ce.student_id = p_user
    AND ce.archived_at IS NULL
    AND c.archived_at IS NULL
    AND s.archived_at IS NULL
    AND pt.tier IN ('teacher','school','admin')
    AND EXISTS (
      SELECT 1 FROM public.edu_school_memberships sm
      WHERE sm.school_id = c.school_id
        AND sm.user_id = ta.teacher_id
        AND sm.role IN ('teacher','admin')
        AND sm.archived_at IS NULL
    )
  LIMIT 1;

  RETURN COALESCE(inherited, own_tier);
END $$;

REVOKE ALL ON FUNCTION public.effective_tier(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.effective_tier(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.effective_tier(UUID) TO authenticated, service_role;
