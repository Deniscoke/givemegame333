-- ═══════════════════════════════════════════════════════════════════
-- gIVEMEGAME.IO — Immutable assessment scope evidence
-- Migration 032
--
-- A class-scoped attempt must carry database-stamped evidence that its
-- owner was an active student member enrolled in that exact active class
-- when the attempt was inserted. Reporting trusts only this immutable
-- snapshot; later roster archival, reactivation, or role changes cannot
-- rewrite whether the attempt was valid.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.assessment_attempts
  ADD COLUMN IF NOT EXISTS scope_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS scope_verified_role TEXT,
  ADD COLUMN IF NOT EXISTS scope_membership_id UUID,
  ADD COLUMN IF NOT EXISTS scope_enrollment_id UUID;

-- Evidence IDs are deliberately immutable opaque snapshots rather than
-- foreign keys. Deleting or reusing a mutable roster row must not alter old
-- evidence or block the existing auth.users GDPR cascade on attempts.
DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conname = 'assessment_attempts_scope_evidence_shape'
      AND conrelid = 'public.assessment_attempts'::regclass
  ) THEN
    ALTER TABLE public.assessment_attempts
      ADD CONSTRAINT assessment_attempts_scope_evidence_shape
      CHECK (
        (
          scope_verified_at IS NULL
          AND scope_verified_role IS NULL
          AND scope_membership_id IS NULL
          AND scope_enrollment_id IS NULL
        )
        OR (
          institution_id IS NOT NULL
          AND class_id IS NOT NULL
          AND scope_verified_role = 'student'
          AND scope_verified_at = started_at
          AND scope_membership_id IS NOT NULL
          AND scope_enrollment_id IS NOT NULL
        )
      ) NOT VALID;
  END IF;
END
$constraint$;

ALTER TABLE public.assessment_attempts
  VALIDATE CONSTRAINT assessment_attempts_scope_evidence_shape;

-- Mutable membership/enrollment rows do not retain removal gaps or role
-- history after reactivation. Legacy class-scoped rows remain unverified:
-- migration 032 intentionally performs no roster-derived evidence backfill.
COMMENT ON COLUMN public.assessment_attempts.scope_verified_at IS
  'NULL marks solo or legacy/unverified scope; only DB-stamped student evidence is reportable.';

CREATE INDEX IF NOT EXISTS idx_assess_att_verified_scope
  ON public.assessment_attempts(
    institution_id,
    class_id,
    module_key,
    assessment_type,
    submitted_at
  )
  WHERE scope_verified_role = 'student'
    AND scope_verified_at IS NOT NULL
    AND scope_membership_id IS NOT NULL
    AND scope_enrollment_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.fn_enforce_assessment_scope_evidence()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_verified_at TIMESTAMPTZ;
  v_membership_id UUID;
  v_enrollment_id UUID;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.institution_id IS DISTINCT FROM OLD.institution_id
       OR NEW.class_id IS DISTINCT FROM OLD.class_id
       OR NEW.started_at IS DISTINCT FROM OLD.started_at
       OR NEW.scope_verified_at IS DISTINCT FROM OLD.scope_verified_at
       OR NEW.scope_verified_role IS DISTINCT FROM OLD.scope_verified_role
       OR NEW.scope_membership_id IS DISTINCT FROM OLD.scope_membership_id
       OR NEW.scope_enrollment_id IS DISTINCT FROM OLD.scope_enrollment_id THEN
      RAISE EXCEPTION 'assessment attempt scope evidence is immutable'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  -- started_at is evidence-critical. Always replace caller input with the
  -- database clock so an authenticated direct client cannot backdate scope.
  v_verified_at := pg_catalog.clock_timestamp();
  NEW.started_at := v_verified_at;

  IF (NEW.institution_id IS NULL) <> (NEW.class_id IS NULL) THEN
    RAISE EXCEPTION 'assessment attempt scope must be fully solo or fully class-scoped'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.institution_id IS NULL THEN
    NEW.scope_verified_at := NULL;
    NEW.scope_verified_role := NULL;
    NEW.scope_membership_id := NULL;
    NEW.scope_enrollment_id := NULL;
    RETURN NEW;
  END IF;

  SELECT sm.id, ce.id
    INTO v_membership_id, v_enrollment_id
  FROM public.edu_classes c
  JOIN public.edu_schools s
    ON s.id = c.school_id
   AND s.archived_at IS NULL
  JOIN public.edu_school_memberships sm
    ON sm.school_id = c.school_id
   AND sm.user_id = NEW.user_id
   AND sm.role = 'student'
   AND sm.archived_at IS NULL
  JOIN public.edu_class_enrollments ce
    ON ce.class_id = c.id
   AND ce.student_id = NEW.user_id
   AND ce.archived_at IS NULL
  WHERE c.id = NEW.class_id
    AND c.school_id = NEW.institution_id
    AND c.archived_at IS NULL
    AND c.created_at <= v_verified_at
    AND sm.created_at <= v_verified_at
    AND ce.enrolled_at <= v_verified_at
  FOR SHARE OF c, s, sm, ce;

  IF v_membership_id IS NULL OR v_enrollment_id IS NULL THEN
    RAISE EXCEPTION 'class scope requires an active student membership and enrollment'
      USING ERRCODE = '42501';
  END IF;

  NEW.scope_verified_at := v_verified_at;
  NEW.scope_verified_role := 'student';
  NEW.scope_membership_id := v_membership_id;
  NEW.scope_enrollment_id := v_enrollment_id;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_enforce_assessment_scope_evidence()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_assessment_scope_evidence
  ON public.assessment_attempts;
CREATE TRIGGER trg_assessment_scope_evidence
  BEFORE INSERT OR UPDATE ON public.assessment_attempts
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_enforce_assessment_scope_evidence();

-- Direct authenticated clients can supply only the request fields. Evidence
-- and started_at are trigger-owned; updates are limited to submission data.
-- The backend service connection keeps its existing owner/service privileges,
-- but the trigger still validates and stamps every insert it performs.
REVOKE INSERT, UPDATE ON public.assessment_attempts
  FROM PUBLIC, anon, authenticated;
GRANT INSERT (
  assessment_id, user_id, institution_id, class_id,
  module_key, assessment_type, status
) ON public.assessment_attempts TO authenticated;
GRANT UPDATE (
  submitted_at, status, total_score, max_score, percent_score
) ON public.assessment_attempts TO authenticated;
