-- ═══════════════════════════════════════════════════════════════════
-- gIVEMEGAME.IO — Assessment attempt scope hardening
-- Migration 031
--
-- Additive follow-up to the already published 029_assessment_security.sql.
-- Do not fold this function or these policy replacements back into 029:
-- existing environments may have recorded 029 by its published checksum.
-- ═══════════════════════════════════════════════════════════════════

-- A scoped attempt is either explicitly solo (both tenant columns null)
-- or belongs to an active class/school the authenticated caller can use.
-- SECURITY DEFINER keeps the check reliable under the EDU tables' RLS;
-- auth.uid() is read inside the function so callers cannot probe another
-- user's class authorization.
CREATE OR REPLACE FUNCTION public.fn_can_scope_assessment_attempt(
  target_school_id UUID,
  target_class_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    (target_school_id IS NULL AND target_class_id IS NULL)
    OR (
      target_school_id IS NOT NULL
      AND target_class_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM public.edu_classes c
        JOIN public.edu_schools s ON s.id = c.school_id
        JOIN public.edu_school_memberships sm
          ON sm.school_id = c.school_id
         AND sm.user_id = auth.uid()
         AND sm.role = 'student'
         AND sm.archived_at IS NULL
        JOIN public.edu_class_enrollments ce
          ON ce.class_id = c.id
         AND ce.student_id = auth.uid()
         AND ce.archived_at IS NULL
        WHERE c.id = target_class_id
          AND c.school_id = target_school_id
          AND c.archived_at IS NULL
          AND s.archived_at IS NULL
      )
    );
$$;

REVOKE ALL ON FUNCTION public.fn_can_scope_assessment_attempt(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_can_scope_assessment_attempt(UUID, UUID) TO authenticated;

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
    AND public.fn_can_scope_assessment_attempt(institution_id, class_id)
  );

DROP POLICY IF EXISTS "assessment_attempts_update" ON public.assessment_attempts;
CREATE POLICY "assessment_attempts_update" ON public.assessment_attempts
  FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (
    user_id = auth.uid()
    AND public.fn_can_scope_assessment_attempt(institution_id, class_id)
  );
