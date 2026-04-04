-- ═══════════════════════════════════════════════════════════════════
-- gIVEMEEDU — Sprint 1: Core school administration tables
-- Migration 018
--
-- LEGAL CONTEXT (GDPR / SK & CZ school law):
--   - School = data controller; platform = data processor
--   - No hard-delete on core educational records (grades, attendance)
--   - Use archived_at / anonymization for retention workflows
--   - Audit log for all grade/attendance mutations
--   - RLS enforces strict school-level tenancy
-- ═══════════════════════════════════════════════════════════════════

-- ─── 1. Schools ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.edu_schools (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  address    TEXT,
  ico        TEXT,                          -- business ID (IČO)
  type       TEXT DEFAULT 'basic_school'
               CHECK (type IN ('basic_school','high_school','gymnasium','other')),
  created_at TIMESTAMPTZ DEFAULT now(),
  archived_at TIMESTAMPTZ                   -- soft-delete / retention
);

-- ─── 2. School memberships (role-based access) ───────────────────
CREATE TABLE IF NOT EXISTS public.edu_school_memberships (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id  UUID NOT NULL REFERENCES public.edu_schools(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('admin','teacher','student')),
  created_at TIMESTAMPTZ DEFAULT now(),
  archived_at TIMESTAMPTZ,
  UNIQUE(school_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_edu_sm_school ON public.edu_school_memberships(school_id);
CREATE INDEX IF NOT EXISTS idx_edu_sm_user   ON public.edu_school_memberships(user_id);

-- ─── 3. Classes ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.edu_classes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   UUID NOT NULL REFERENCES public.edu_schools(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,                -- e.g. "5.A"
  grade_level INTEGER,                      -- 1-9 for ZŠ, 1-4 for SŠ
  school_year TEXT NOT NULL,                -- "2025/2026"
  created_at  TIMESTAMPTZ DEFAULT now(),
  archived_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_edu_classes_school ON public.edu_classes(school_id);

-- ─── 4. Class enrollments (student ↔ class) ─────────────────────
CREATE TABLE IF NOT EXISTS public.edu_class_enrollments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id    UUID NOT NULL REFERENCES public.edu_classes(id) ON DELETE CASCADE,
  student_id  UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  enrolled_at TIMESTAMPTZ DEFAULT now(),
  archived_at TIMESTAMPTZ,
  UNIQUE(class_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_edu_ce_class   ON public.edu_class_enrollments(class_id);
CREATE INDEX IF NOT EXISTS idx_edu_ce_student ON public.edu_class_enrollments(student_id);

-- ─── 5. Subjects ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.edu_subjects (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id    UUID NOT NULL REFERENCES public.edu_schools(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,               -- "Matematika"
  abbreviation TEXT,                        -- "MAT"
  rvp_area     TEXT,                        -- links to rvp.json areas
  created_at   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_edu_subjects_school ON public.edu_subjects(school_id);

-- ─── 6. Teaching assignments (teacher ↔ class ↔ subject) ────────
CREATE TABLE IF NOT EXISTS public.edu_teaching_assignments (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id   UUID NOT NULL REFERENCES public.edu_classes(id) ON DELETE CASCADE,
  subject_id UUID NOT NULL REFERENCES public.edu_subjects(id) ON DELETE CASCADE,
  teacher_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(class_id, subject_id, teacher_id)
);
CREATE INDEX IF NOT EXISTS idx_edu_ta_teacher ON public.edu_teaching_assignments(teacher_id);

-- ─── 7. Grade items (assignment/test/project metadata) ──────────
CREATE TABLE IF NOT EXISTS public.edu_grade_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id    UUID NOT NULL REFERENCES public.edu_classes(id) ON DELETE CASCADE,
  subject_id  UUID NOT NULL REFERENCES public.edu_subjects(id) ON DELETE CASCADE,
  teacher_id  UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,                -- "Test z rovníc"
  type        TEXT NOT NULL DEFAULT 'test'
                CHECK (type IN ('test','oral','homework','project','competency','other')),
  max_points  NUMERIC,                      -- optional max score
  weight      NUMERIC NOT NULL DEFAULT 1.0, -- grade weight
  date        DATE NOT NULL DEFAULT CURRENT_DATE,
  semester    INTEGER NOT NULL DEFAULT 1 CHECK (semester IN (1, 2)),
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_edu_gi_class ON public.edu_grade_items(class_id);

-- ─── 8. Grade entries (student result per grade item) ────────────
CREATE TABLE IF NOT EXISTS public.edu_grade_entries (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  grade_item_id UUID NOT NULL REFERENCES public.edu_grade_items(id) ON DELETE CASCADE,
  student_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  value         TEXT NOT NULL,              -- "1", "2", "A", "95%" — flexible
  points        NUMERIC,                    -- numeric score if applicable
  note          TEXT,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE(grade_item_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_edu_ge_student ON public.edu_grade_entries(student_id);
CREATE INDEX IF NOT EXISTS idx_edu_ge_item    ON public.edu_grade_entries(grade_item_id);

-- ─── 9. Attendance records ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.edu_attendance (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id    UUID NOT NULL REFERENCES public.edu_classes(id) ON DELETE CASCADE,
  student_id  UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  date        DATE NOT NULL DEFAULT CURRENT_DATE,
  status      TEXT NOT NULL DEFAULT 'present'
                CHECK (status IN ('present','absent','late','excused')),
  note        TEXT,
  recorded_by UUID NOT NULL REFERENCES auth.users(id),
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE(class_id, student_id, date)        -- one record per student per class per day
);
CREATE INDEX IF NOT EXISTS idx_edu_att_class ON public.edu_attendance(class_id);
CREATE INDEX IF NOT EXISTS idx_edu_att_date  ON public.edu_attendance(date);

-- ─── 10. Audit log ──────────────────────────────────────────────
-- Records every mutation on grades, attendance, enrollments.
-- GDPR Art. 5(1)(f): integrity and accountability principle.
CREATE TABLE IF NOT EXISTS public.edu_audit_log (
  id         BIGSERIAL PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES auth.users(id),
  school_id  UUID NOT NULL REFERENCES public.edu_schools(id),
  action     TEXT NOT NULL,                 -- 'grade_create', 'attendance_update', etc.
  entity     TEXT NOT NULL,                 -- table name
  entity_id  UUID,                          -- row id
  old_data   JSONB,                         -- previous state (for updates)
  new_data   JSONB,                         -- new state
  ip_address TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_edu_audit_school ON public.edu_audit_log(school_id);
CREATE INDEX IF NOT EXISTS idx_edu_audit_user   ON public.edu_audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_edu_audit_time   ON public.edu_audit_log(created_at);

-- ═══════════════════════════════════════════════════════════════════
-- RLS POLICIES — strict school-level tenancy
-- All EDU queries go through the backend (service role), so RLS here
-- is defense-in-depth. Backend enforces role checks in application code.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.edu_schools ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.edu_school_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.edu_classes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.edu_class_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.edu_subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.edu_teaching_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.edu_grade_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.edu_grade_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.edu_attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.edu_audit_log ENABLE ROW LEVEL SECURITY;

-- Helper: check if user is member of a school
-- (Used in policies below)

-- Schools: members can see their school
CREATE POLICY "edu_schools_select" ON public.edu_schools FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.edu_school_memberships WHERE school_id = id AND user_id = auth.uid() AND archived_at IS NULL)
);
CREATE POLICY "edu_schools_insert" ON public.edu_schools FOR INSERT WITH CHECK (true);
CREATE POLICY "edu_schools_update" ON public.edu_schools FOR UPDATE USING (
  EXISTS (SELECT 1 FROM public.edu_school_memberships WHERE school_id = id AND user_id = auth.uid() AND role = 'admin' AND archived_at IS NULL)
);

-- School memberships: see own membership + admins see all in school
CREATE POLICY "edu_sm_select" ON public.edu_school_memberships FOR SELECT USING (
  user_id = auth.uid()
  OR EXISTS (SELECT 1 FROM public.edu_school_memberships sm2 WHERE sm2.school_id = school_id AND sm2.user_id = auth.uid() AND sm2.role = 'admin' AND sm2.archived_at IS NULL)
);

-- Classes: school members can see classes in their school
CREATE POLICY "edu_classes_select" ON public.edu_classes FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.edu_school_memberships WHERE school_id = edu_classes.school_id AND user_id = auth.uid() AND archived_at IS NULL)
);

-- Class enrollments: teachers/admins of the school can see
CREATE POLICY "edu_ce_select" ON public.edu_class_enrollments FOR SELECT USING (
  student_id = auth.uid()
  OR EXISTS (
    SELECT 1 FROM public.edu_school_memberships sm
    JOIN public.edu_classes c ON c.school_id = sm.school_id
    WHERE c.id = edu_class_enrollments.class_id AND sm.user_id = auth.uid() AND sm.role IN ('admin','teacher') AND sm.archived_at IS NULL
  )
);

-- Subjects: school members can see
CREATE POLICY "edu_subjects_select" ON public.edu_subjects FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.edu_school_memberships WHERE school_id = edu_subjects.school_id AND user_id = auth.uid() AND archived_at IS NULL)
);

-- Teaching assignments: school members can see
CREATE POLICY "edu_ta_select" ON public.edu_teaching_assignments FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM public.edu_school_memberships sm
    JOIN public.edu_classes c ON c.school_id = sm.school_id
    WHERE c.id = edu_teaching_assignments.class_id AND sm.user_id = auth.uid() AND sm.archived_at IS NULL
  )
);

-- Grade items: teacher who owns it, or admin, or the student can see
CREATE POLICY "edu_gi_select" ON public.edu_grade_items FOR SELECT USING (
  teacher_id = auth.uid()
  OR EXISTS (
    SELECT 1 FROM public.edu_school_memberships sm
    JOIN public.edu_classes c ON c.school_id = sm.school_id
    WHERE c.id = edu_grade_items.class_id AND sm.user_id = auth.uid() AND sm.role = 'admin' AND sm.archived_at IS NULL
  )
  OR EXISTS (
    SELECT 1 FROM public.edu_class_enrollments ce
    WHERE ce.class_id = edu_grade_items.class_id AND ce.student_id = auth.uid() AND ce.archived_at IS NULL
  )
);

-- Grade entries: student sees own, teacher/admin sees all in their scope
CREATE POLICY "edu_ge_select" ON public.edu_grade_entries FOR SELECT USING (
  student_id = auth.uid()
  OR EXISTS (
    SELECT 1 FROM public.edu_grade_items gi
    WHERE gi.id = edu_grade_entries.grade_item_id AND gi.teacher_id = auth.uid()
  )
  OR EXISTS (
    SELECT 1 FROM public.edu_grade_items gi
    JOIN public.edu_school_memberships sm ON sm.school_id = (SELECT school_id FROM public.edu_classes WHERE id = gi.class_id)
    WHERE gi.id = edu_grade_entries.grade_item_id AND sm.user_id = auth.uid() AND sm.role = 'admin' AND sm.archived_at IS NULL
  )
);

-- Attendance: student sees own, teacher/admin sees class
CREATE POLICY "edu_att_select" ON public.edu_attendance FOR SELECT USING (
  student_id = auth.uid()
  OR recorded_by = auth.uid()
  OR EXISTS (
    SELECT 1 FROM public.edu_school_memberships sm
    JOIN public.edu_classes c ON c.school_id = sm.school_id
    WHERE c.id = edu_attendance.class_id AND sm.user_id = auth.uid() AND sm.role IN ('admin','teacher') AND sm.archived_at IS NULL
  )
);

-- Audit log: admins of the school can read
CREATE POLICY "edu_audit_select" ON public.edu_audit_log FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.edu_school_memberships WHERE school_id = edu_audit_log.school_id AND user_id = auth.uid() AND role = 'admin' AND archived_at IS NULL)
);

-- GRANTs (backend uses service role for writes, but authenticated needs SELECT)
GRANT SELECT ON public.edu_schools TO authenticated;
GRANT SELECT ON public.edu_school_memberships TO authenticated;
GRANT SELECT ON public.edu_classes TO authenticated;
GRANT SELECT ON public.edu_class_enrollments TO authenticated;
GRANT SELECT ON public.edu_subjects TO authenticated;
GRANT SELECT ON public.edu_teaching_assignments TO authenticated;
GRANT SELECT ON public.edu_grade_items TO authenticated;
GRANT SELECT ON public.edu_grade_entries TO authenticated;
GRANT SELECT ON public.edu_attendance TO authenticated;
GRANT SELECT ON public.edu_audit_log TO authenticated;

-- Service role (backend) gets full access for writes
GRANT ALL ON public.edu_schools TO service_role;
GRANT ALL ON public.edu_school_memberships TO service_role;
GRANT ALL ON public.edu_classes TO service_role;
GRANT ALL ON public.edu_class_enrollments TO service_role;
GRANT ALL ON public.edu_subjects TO service_role;
GRANT ALL ON public.edu_teaching_assignments TO service_role;
GRANT ALL ON public.edu_grade_items TO service_role;
GRANT ALL ON public.edu_grade_entries TO service_role;
GRANT ALL ON public.edu_attendance TO service_role;
GRANT ALL ON public.edu_audit_log TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.edu_audit_log_id_seq TO service_role;
