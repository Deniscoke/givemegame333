-- ═══════════════════════════════════════════════════════════════════
-- Migration 021 — Make edu_audit_log append-only
--
-- WHY: The service role key bypasses RLS, so a bug or compromised
-- service key could silently alter or delete audit rows. A trigger
-- fires at the row level BEFORE UPDATE/DELETE regardless of the
-- calling role (including service_role), making the log tamper-evident.
--
-- EFFECT: Any attempt to UPDATE or DELETE a row in edu_audit_log will
-- raise an exception and roll back the operation. Inserts are unaffected.
--
-- ROLLBACK: DROP TRIGGER IF EXISTS edu_audit_log_immutable ON public.edu_audit_log;
--           DROP FUNCTION IF EXISTS public.edu_audit_log_no_modify();
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.edu_audit_log_no_modify()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'edu_audit_log is append-only: % on row id=% is not permitted',
    TG_OP,
    OLD.id;
END;
$$ LANGUAGE plpgsql;

-- Drop before recreate so re-running the migration is safe
DROP TRIGGER IF EXISTS edu_audit_log_immutable ON public.edu_audit_log;

CREATE TRIGGER edu_audit_log_immutable
  BEFORE UPDATE OR DELETE ON public.edu_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.edu_audit_log_no_modify();
