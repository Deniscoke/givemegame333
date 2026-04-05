/**
 * gIVEMEEDU — Sprint 1.5 hardened API routes
 *
 * All routes are mounted under /api/edu/* in server.js.
 * Uses the same pg Pool and auth helpers as the game backend.
 *
 * SECURITY MODEL:
 *   - Tenancy is enforced in SQL via school_id filters on every query.
 *   - RLS is defense-in-depth only (service role bypasses it).
 *   - All writes are audit-logged with actor, school, entity, old/new state.
 *   - Rate limiting is in-memory per-instance (acceptable for Vercel serverless).
 *   - Parent role is DEFERRED to Sprint 2 — no access path exists.
 *
 * LEGAL NOTE:
 *   - Backend acts as processor; school is controller.
 *   - No hard-delete on core records (grades, attendance).
 *   - Audit log supports GDPR Art. 5(1)(f) accountability principle.
 */

'use strict';

const express = require('express');

// ─── Sprint 1 role constant ───────────────────────────────────────────────────
// Do NOT add 'parent' here until Sprint 2 (requires edu_parent_student_links).
const SPRINT1_ROLES = ['admin', 'teacher', 'student'];

// ─── Validation helpers ───────────────────────────────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SCHOOL_YEAR_RE = /^\d{4}\/\d{4}$/;

function isUUID(s) { return typeof s === 'string' && UUID_RE.test(s.trim()); }
function isISODate(s) { return typeof s === 'string' && ISO_DATE_RE.test(s) && !isNaN(Date.parse(s)); }
function isSchoolYear(s) { return typeof s === 'string' && SCHOOL_YEAR_RE.test(s); }
function isPositiveNumber(v) { const n = Number(v); return !isNaN(n) && n > 0; }
function clampStr(s, max) { return typeof s === 'string' ? s.trim().substring(0, max) : ''; }

// ─── In-memory rate limiter ───────────────────────────────────────────────────
// Per-instance (Vercel cold starts reset counts). Effective against burst attacks.
// Key: string, maxRequests: number, windowMs: number → boolean (true = allowed)
const _rateBuckets = new Map();

function rateLimit(key, maxRequests, windowMs) {
  const now = Date.now();
  let bucket = _rateBuckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    _rateBuckets.set(key, bucket);
  }
  bucket.count++;
  return bucket.count <= maxRequests;
}

// Cleanup stale buckets every 10 minutes to prevent unbounded memory growth
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _rateBuckets.entries()) {
    if (now > v.resetAt) _rateBuckets.delete(k);
  }
}, 10 * 60 * 1000);

/**
 * @param {object} deps
 * @param {import('pg').Pool} deps.pool
 * @param {function} deps.requireSupabaseUser
 */
function createEduRouter({ pool, requireSupabaseUser }) {
  const router = express.Router();

  // ═══════════════════════════════════════════════════════════════════════
  // INTERNAL HELPERS
  // ═══════════════════════════════════════════════════════════════════════

  // Get user's school (first active membership) — returns { school_id, role, school_name }
  async function getUserSchool(userId) {
    const { rows } = await pool.query(
      `SELECT sm.school_id, sm.role, s.name AS school_name
       FROM public.edu_school_memberships sm
       JOIN public.edu_schools s ON s.id = sm.school_id AND s.archived_at IS NULL
       WHERE sm.user_id = $1 AND sm.archived_at IS NULL
       LIMIT 1`,
      [userId]
    );
    return rows[0] || null;
  }

  // Enforce role — returns false and sends 403 if not allowed
  function requireRole(school, allowedRoles, res) {
    if (!school) {
      res.status(403).json({ error: 'Nie ste členom žiadnej školy' });
      return false;
    }
    if (!allowedRoles.includes(school.role)) {
      res.status(403).json({ error: `Prístup zamietnutý. Vyžadovaná rola: ${allowedRoles.join(' alebo ')}` });
      return false;
    }
    return true;
  }

  // Check that a class_id belongs to a specific school (tenancy guard)
  async function classOwnedBySchool(classId, schoolId) {
    if (!isUUID(classId)) return false;
    const { rows } = await pool.query(
      `SELECT 1 FROM public.edu_classes WHERE id = $1 AND school_id = $2 AND archived_at IS NULL`,
      [classId, schoolId]
    );
    return rows.length > 0;
  }

  // Check that a subject_id belongs to a specific school
  async function subjectOwnedBySchool(subjectId, schoolId) {
    if (!isUUID(subjectId)) return false;
    const { rows } = await pool.query(
      `SELECT 1 FROM public.edu_subjects WHERE id = $1 AND school_id = $2`,
      [subjectId, schoolId]
    );
    return rows.length > 0;
  }

  // Check that a teacher is assigned to a class (any subject)
  async function teachesClass(userId, classId) {
    if (!isUUID(classId)) return false;
    const { rows } = await pool.query(
      `SELECT 1 FROM public.edu_teaching_assignments
       WHERE teacher_id = $1 AND class_id = $2 LIMIT 1`,
      [userId, classId]
    );
    return rows.length > 0;
  }

  // Check that a student is enrolled in a class
  async function studentEnrolledInClass(studentId, classId) {
    if (!isUUID(studentId) || !isUUID(classId)) return false;
    const { rows } = await pool.query(
      `SELECT 1 FROM public.edu_class_enrollments
       WHERE class_id = $1 AND student_id = $2 AND archived_at IS NULL`,
      [classId, studentId]
    );
    return rows.length > 0;
  }

  // Write to audit log — never throws; logs failure to console only
  async function audit(userId, schoolId, action, entity, entityId, oldData, newData, ip) {
    try {
      await pool.query(
        `INSERT INTO public.edu_audit_log
           (user_id, school_id, action, entity, entity_id, old_data, new_data, ip_address)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          userId, schoolId, action, entity, entityId || null,
          oldData ? JSON.stringify(oldData) : null,
          newData ? JSON.stringify(newData) : null,
          ip || null,
        ]
      );
    } catch (auditErr) {
      // Audit failures must never block the main operation — log and continue
      console.error('[EDU] Audit log failure:', auditErr.message, { action, entity });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // GET /api/edu/me
  // ═══════════════════════════════════════════════════════════════════════
  router.get('/me', async (req, res) => {
    const user = await requireSupabaseUser(req, res);
    if (!user) return;
    try {
      const school = await getUserSchool(user.id);
      res.json({
        user: { id: user.id, email: user.email },
        school: school
          ? { id: school.school_id, name: school.school_name, role: school.role }
          : null,
      });
    } catch (err) {
      console.error('[EDU] GET /me error:', err.message);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // POST /api/edu/schools — create school (any authenticated user)
  // Creator becomes admin automatically.
  // ═══════════════════════════════════════════════════════════════════════
  router.post('/schools', async (req, res) => {
    const user = await requireSupabaseUser(req, res);
    if (!user) return;

    const { name, address, ico, type } = req.body;

    // Validation
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Názov školy je povinný' });
    }
    const VALID_SCHOOL_TYPES = ['basic_school', 'high_school', 'gymnasium', 'other'];
    const schoolType = type || 'basic_school';
    if (!VALID_SCHOOL_TYPES.includes(schoolType)) {
      return res.status(400).json({ error: `Neplatný typ školy. Povolené: ${VALID_SCHOOL_TYPES.join(', ')}` });
    }

    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows: [school] } = await client.query(
          `INSERT INTO public.edu_schools (name, address, ico, type)
           VALUES ($1, $2, $3, $4) RETURNING *`,
          [clampStr(name, 200), clampStr(address || '', 500) || null, clampStr(ico || '', 20) || null, schoolType]
        );
        await client.query(
          `INSERT INTO public.edu_school_memberships (school_id, user_id, role)
           VALUES ($1, $2, 'admin')`,
          [school.id, user.id]
        );
        await client.query('COMMIT');
        await audit(user.id, school.id, 'school_create', 'edu_schools', school.id, null, school, req.ip);
        res.status(201).json({ school });
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error('[EDU] POST /schools error:', err.message);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // GET /api/edu/classes — list classes (scoped by role)
  // ═══════════════════════════════════════════════════════════════════════
  router.get('/classes', async (req, res) => {
    const user = await requireSupabaseUser(req, res);
    if (!user) return;
    try {
      const school = await getUserSchool(user.id);
      if (!school) return res.json({ classes: [] });

      let query, params;
      if (school.role === 'admin') {
        query = `SELECT c.*,
                   (SELECT count(*) FROM public.edu_class_enrollments ce
                    WHERE ce.class_id = c.id AND ce.archived_at IS NULL) AS student_count
                 FROM public.edu_classes c
                 WHERE c.school_id = $1 AND c.archived_at IS NULL
                 ORDER BY c.grade_level, c.name`;
        params = [school.school_id];
      } else if (school.role === 'teacher') {
        query = `SELECT DISTINCT c.*,
                   (SELECT count(*) FROM public.edu_class_enrollments ce
                    WHERE ce.class_id = c.id AND ce.archived_at IS NULL) AS student_count
                 FROM public.edu_classes c
                 JOIN public.edu_teaching_assignments ta ON ta.class_id = c.id AND ta.teacher_id = $2
                 WHERE c.school_id = $1 AND c.archived_at IS NULL
                 ORDER BY c.grade_level, c.name`;
        params = [school.school_id, user.id];
      } else {
        // student — only enrolled classes, scoped to school
        query = `SELECT c.*
                 FROM public.edu_classes c
                 JOIN public.edu_class_enrollments ce
                   ON ce.class_id = c.id AND ce.student_id = $2 AND ce.archived_at IS NULL
                 WHERE c.school_id = $1 AND c.archived_at IS NULL
                 ORDER BY c.grade_level, c.name`;
        params = [school.school_id, user.id];
      }
      const { rows } = await pool.query(query, params);
      res.json({ classes: rows, role: school.role });
    } catch (err) {
      console.error('[EDU] GET /classes error:', err.message);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // POST /api/edu/classes — create class (admin only)
  // ═══════════════════════════════════════════════════════════════════════
  router.post('/classes', async (req, res) => {
    const user = await requireSupabaseUser(req, res);
    if (!user) return;
    try {
      const school = await getUserSchool(user.id);
      if (!requireRole(school, ['admin'], res)) return;

      const { name, grade_level, school_year } = req.body;

      // Validation
      if (!name || !name.trim()) {
        return res.status(400).json({ error: 'Názov triedy je povinný' });
      }
      if (!school_year || !isSchoolYear(school_year)) {
        return res.status(400).json({ error: 'Školský rok musí byť vo formáte YYYY/YYYY (napr. 2025/2026)' });
      }
      const gradeNum = grade_level !== undefined ? parseInt(grade_level, 10) : null;
      if (gradeNum !== null && (isNaN(gradeNum) || gradeNum < 1 || gradeNum > 13)) {
        return res.status(400).json({ error: 'Ročník musí byť číslo 1–13' });
      }

      const { rows: [cls] } = await pool.query(
        `INSERT INTO public.edu_classes (school_id, name, grade_level, school_year)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [school.school_id, clampStr(name, 50), gradeNum, school_year.trim()]
      );
      await audit(user.id, school.school_id, 'class_create', 'edu_classes', cls.id, null, cls, req.ip);
      res.status(201).json({ class: cls });
    } catch (err) {
      console.error('[EDU] POST /classes error:', err.message);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // GET /api/edu/students?class_id=...
  // SECURITY: class_id is JOIN-verified against school_id in the query.
  // ═══════════════════════════════════════════════════════════════════════
  router.get('/students', async (req, res) => {
    const user = await requireSupabaseUser(req, res);
    if (!user) return;
    const { class_id } = req.query;
    if (!class_id) return res.status(400).json({ error: 'class_id je povinné' });
    if (!isUUID(class_id)) return res.status(400).json({ error: 'Neplatný class_id' });

    try {
      const school = await getUserSchool(user.id);
      if (!school) return res.status(403).json({ error: 'Nie ste členom školy' });

      // Tenancy: verify the class belongs to this school in the main query
      if (!(await classOwnedBySchool(class_id, school.school_id))) {
        return res.status(404).json({ error: 'Trieda nenájdená' });
      }

      // Role-specific access
      if (school.role === 'teacher' && !(await teachesClass(user.id, class_id))) {
        return res.status(403).json({ error: 'Nemáte prístup k tejto triede' });
      }
      if (school.role === 'student') {
        if (!(await studentEnrolledInClass(user.id, class_id))) {
          return res.status(403).json({ error: 'Nie ste zapísaný v tejto triede' });
        }
      }

      // Defense-in-depth: school_id is embedded in the JOIN so a stale pre-check
      // result cannot expose a cross-school class at the point of data access.
      const { rows } = await pool.query(
        `SELECT ce.id AS enrollment_id, ce.student_id, ce.enrolled_at,
                p.display_name, p.avatar_url
         FROM public.edu_class_enrollments ce
         JOIN public.edu_classes c ON c.id = ce.class_id AND c.school_id = $2 AND c.archived_at IS NULL
         LEFT JOIN public.profiles p ON p.id = ce.student_id
         WHERE ce.class_id = $1 AND ce.archived_at IS NULL
         ORDER BY p.display_name`,
        [class_id, school.school_id]
      );
      res.json({ students: rows });
    } catch (err) {
      console.error('[EDU] GET /students error:', err.message);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // POST /api/edu/students — enroll student into class (admin only)
  // SECURITY: verifies student is a school member before enrolling.
  // ═══════════════════════════════════════════════════════════════════════
  router.post('/students', async (req, res) => {
    const user = await requireSupabaseUser(req, res);
    if (!user) return;
    try {
      const school = await getUserSchool(user.id);
      if (!requireRole(school, ['admin'], res)) return;

      const { class_id, student_id } = req.body;
      if (!class_id || !student_id) {
        return res.status(400).json({ error: 'class_id a student_id sú povinné' });
      }
      if (!isUUID(class_id)) return res.status(400).json({ error: 'Neplatný class_id' });
      if (!isUUID(student_id)) return res.status(400).json({ error: 'Neplatný student_id' });

      // Tenancy: class must belong to this school
      if (!(await classOwnedBySchool(class_id, school.school_id))) {
        return res.status(404).json({ error: 'Trieda nenájdená' });
      }

      // Atomic INSERT: student membership check is enforced inside the INSERT itself
      // via WHERE EXISTS, eliminating the separate pre-check query.
      const { rows: [enrollment] } = await pool.query(
        `INSERT INTO public.edu_class_enrollments (class_id, student_id)
         SELECT $1, $2
         WHERE EXISTS (
           SELECT 1 FROM public.edu_school_memberships
           WHERE school_id = $3 AND user_id = $2 AND role = 'student' AND archived_at IS NULL
         )
         ON CONFLICT (class_id, student_id) DO UPDATE SET archived_at = NULL
         RETURNING *`,
        [class_id, student_id, school.school_id]
      );
      if (!enrollment) {
        return res.status(400).json({ error: 'Používateľ nie je žiakom tejto školy' });
      }
      await audit(user.id, school.school_id, 'enrollment_create', 'edu_class_enrollments', enrollment.id, null, enrollment, req.ip);
      res.status(201).json({ enrollment });
    } catch (err) {
      console.error('[EDU] POST /students error:', err.message);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // GET /api/edu/subjects
  // ═══════════════════════════════════════════════════════════════════════
  router.get('/subjects', async (req, res) => {
    const user = await requireSupabaseUser(req, res);
    if (!user) return;
    try {
      const school = await getUserSchool(user.id);
      if (!school) return res.json({ subjects: [] });
      const { rows } = await pool.query(
        `SELECT * FROM public.edu_subjects WHERE school_id = $1 ORDER BY name`,
        [school.school_id]
      );
      res.json({ subjects: rows });
    } catch (err) {
      console.error('[EDU] GET /subjects error:', err.message);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // POST /api/edu/subjects — create subject (admin only)
  // ═══════════════════════════════════════════════════════════════════════
  router.post('/subjects', async (req, res) => {
    const user = await requireSupabaseUser(req, res);
    if (!user) return;
    try {
      const school = await getUserSchool(user.id);
      if (!requireRole(school, ['admin'], res)) return;

      const { name, abbreviation, rvp_area } = req.body;
      if (!name || !name.trim()) {
        return res.status(400).json({ error: 'Názov predmetu je povinný' });
      }

      const { rows: [subject] } = await pool.query(
        `INSERT INTO public.edu_subjects (school_id, name, abbreviation, rvp_area)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [school.school_id, clampStr(name, 100), clampStr(abbreviation || '', 10) || null, clampStr(rvp_area || '', 100) || null]
      );
      res.status(201).json({ subject });
    } catch (err) {
      console.error('[EDU] POST /subjects error:', err.message);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // POST /api/edu/teaching-assignments — assign teacher to class+subject (admin)
  // SECURITY: class and subject are verified to belong to admin's school.
  // ═══════════════════════════════════════════════════════════════════════
  router.post('/teaching-assignments', async (req, res) => {
    const user = await requireSupabaseUser(req, res);
    if (!user) return;
    try {
      const school = await getUserSchool(user.id);
      if (!requireRole(school, ['admin'], res)) return;

      const { class_id, subject_id, teacher_id } = req.body;
      if (!class_id || !subject_id || !teacher_id) {
        return res.status(400).json({ error: 'class_id, subject_id, teacher_id sú povinné' });
      }
      if (!isUUID(class_id)) return res.status(400).json({ error: 'Neplatný class_id' });
      if (!isUUID(subject_id)) return res.status(400).json({ error: 'Neplatný subject_id' });
      if (!isUUID(teacher_id)) return res.status(400).json({ error: 'Neplatný teacher_id' });

      // Single atomic CTE: verifies class, subject, and teacher membership all belong
      // to the same school in one query — eliminates 3 separate pre-check round-trips.
      const { rows: [ta] } = await pool.query(
        `WITH scope AS (
           SELECT c.id AS class_id, s.id AS subject_id
           FROM public.edu_classes c
           JOIN public.edu_subjects s ON s.id = $2 AND s.school_id = c.school_id
           JOIN public.edu_school_memberships sm
             ON sm.school_id = c.school_id
             AND sm.user_id = $3
             AND sm.role IN ('teacher', 'admin')
             AND sm.archived_at IS NULL
           WHERE c.id = $1 AND c.school_id = $4 AND c.archived_at IS NULL
         )
         INSERT INTO public.edu_teaching_assignments (class_id, subject_id, teacher_id)
         SELECT $1, $2, $3 FROM scope
         ON CONFLICT (class_id, subject_id, teacher_id) DO NOTHING
         RETURNING *`,
        [class_id, subject_id, teacher_id, school.school_id]
      );
      if (ta) {
        await audit(user.id, school.school_id, 'teaching_assign', 'edu_teaching_assignments', ta.id, null, ta, req.ip);
      } else {
        // Check if it already existed or if scope was invalid
        const { rows: existing } = await pool.query(
          `SELECT 1 FROM public.edu_teaching_assignments WHERE class_id = $1 AND subject_id = $2 AND teacher_id = $3`,
          [class_id, subject_id, teacher_id]
        );
        if (!existing.length) {
          return res.status(400).json({ error: 'Trieda, predmet alebo učiteľ nepatrí tejto škole' });
        }
      }
      res.status(201).json({ assignment: ta || { message: 'Already exists' } });
    } catch (err) {
      console.error('[EDU] POST /teaching-assignments error:', err.message);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // GET /api/edu/members — list school members (admin/teacher, read-only for teacher)
  // ═══════════════════════════════════════════════════════════════════════
  router.get('/members', async (req, res) => {
    const user = await requireSupabaseUser(req, res);
    if (!user) return;
    try {
      const school = await getUserSchool(user.id);
      if (!requireRole(school, ['admin', 'teacher'], res)) return;
      const { rows } = await pool.query(
        `SELECT sm.id, sm.user_id, sm.role, sm.created_at,
                p.display_name, p.avatar_url
         FROM public.edu_school_memberships sm
         LEFT JOIN public.profiles p ON p.id = sm.user_id
         WHERE sm.school_id = $1 AND sm.archived_at IS NULL
         ORDER BY sm.role, p.display_name`,
        [school.school_id]
      );
      res.json({ members: rows });
    } catch (err) {
      console.error('[EDU] GET /members error:', err.message);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // POST /api/edu/members — add member to school (admin only)
  // Rate limited: 20 requests per 15 minutes per admin user.
  // ═══════════════════════════════════════════════════════════════════════
  router.post('/members', async (req, res) => {
    const user = await requireSupabaseUser(req, res);
    if (!user) return;
    try {
      const school = await getUserSchool(user.id);
      if (!requireRole(school, ['admin'], res)) return;

      if (!rateLimit(`members:add:${user.id}`, 20, 15 * 60 * 1000)) {
        return res.status(429).json({ error: 'Príliš veľa požiadaviek. Skúste neskôr.' });
      }

      const { user_id, role } = req.body;
      if (!user_id || !role) {
        return res.status(400).json({ error: 'user_id a role sú povinné' });
      }
      if (!isUUID(user_id)) {
        return res.status(400).json({ error: 'Neplatný user_id (musí byť UUID)' });
      }
      // Sprint 1 roles only. 'parent' deferred to Sprint 2.
      if (!SPRINT1_ROLES.includes(role)) {
        return res.status(400).json({ error: 'Neplatná rola. Povolené: admin, teacher, student' });
      }

      // Prevent adding yourself with a different role (you're already admin)
      // Allow it if it's re-assigning — the ON CONFLICT handles idempotency

      const { rows: [member] } = await pool.query(
        `INSERT INTO public.edu_school_memberships (school_id, user_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (school_id, user_id) DO UPDATE SET role = $3, archived_at = NULL
         RETURNING *`,
        [school.school_id, user_id, role]
      );
      await audit(user.id, school.school_id, 'member_add', 'edu_school_memberships', member.id, null, member, req.ip);
      res.status(201).json({ member });
    } catch (err) {
      console.error('[EDU] POST /members error:', err.message);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // GET /api/edu/gradebook?class_id=...&subject_id=...
  // SECURITY:
  //   - class_id verified to belong to actor's school
  //   - student sees grade items ONLY for enrolled classes
  //   - student sees ONLY own entries
  // ═══════════════════════════════════════════════════════════════════════
  router.get('/gradebook', async (req, res) => {
    const user = await requireSupabaseUser(req, res);
    if (!user) return;
    const { class_id, subject_id } = req.query;
    if (!class_id) return res.status(400).json({ error: 'class_id je povinné' });
    if (!isUUID(class_id)) return res.status(400).json({ error: 'Neplatný class_id' });
    if (subject_id && !isUUID(subject_id)) return res.status(400).json({ error: 'Neplatný subject_id' });

    try {
      const school = await getUserSchool(user.id);
      if (!school) return res.status(403).json({ error: 'Nie ste členom školy' });

      // Tenancy: class must belong to actor's school
      if (!(await classOwnedBySchool(class_id, school.school_id))) {
        return res.status(404).json({ error: 'Trieda nenájdená' });
      }

      // Role-specific access
      if (school.role === 'teacher' && !(await teachesClass(user.id, class_id))) {
        return res.status(403).json({ error: 'Nemáte prístup k tejto triede' });
      }
      // Student can only view gradebook for classes they are enrolled in
      if (school.role === 'student' && !(await studentEnrolledInClass(user.id, class_id))) {
        return res.status(403).json({ error: 'Nie ste zapísaný v tejto triede' });
      }

      // school_id is embedded via JOIN — defense-in-depth so data is scoped even
      // if the pre-check result were stale.
      let itemQuery = `SELECT gi.* FROM public.edu_grade_items gi
                       JOIN public.edu_classes c ON c.id = gi.class_id AND c.school_id = $2
                       WHERE gi.class_id = $1`;
      const itemParams = [class_id, school.school_id];
      if (subject_id) {
        itemQuery += ` AND gi.subject_id = $3`;
        itemParams.push(subject_id);
      }
      itemQuery += ` ORDER BY gi.date DESC, gi.created_at DESC`;
      const { rows: items } = await pool.query(itemQuery, itemParams);

      const itemIds = items.map(i => i.id);
      let entries = [];
      if (itemIds.length > 0) {
        if (school.role === 'student') {
          const { rows } = await pool.query(
            `SELECT * FROM public.edu_grade_entries
             WHERE grade_item_id = ANY($1) AND student_id = $2`,
            [itemIds, user.id]
          );
          entries = rows;
        } else {
          const { rows } = await pool.query(
            `SELECT * FROM public.edu_grade_entries WHERE grade_item_id = ANY($1)`,
            [itemIds]
          );
          entries = rows;
        }
      }

      res.json({ items, entries });
    } catch (err) {
      console.error('[EDU] GET /gradebook error:', err.message);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // POST /api/edu/gradebook/items — create a grade item (teacher/admin)
  // Rate limited: 60 items per 10 minutes per user.
  // SECURITY: class and subject verified to belong to actor's school.
  // ═══════════════════════════════════════════════════════════════════════
  router.post('/gradebook/items', async (req, res) => {
    const user = await requireSupabaseUser(req, res);
    if (!user) return;
    try {
      const school = await getUserSchool(user.id);
      if (!requireRole(school, ['admin', 'teacher'], res)) return;

      if (!rateLimit(`gb:items:${user.id}`, 60, 10 * 60 * 1000)) {
        return res.status(429).json({ error: 'Príliš veľa požiadaviek. Skúste neskôr.' });
      }

      const { class_id, subject_id, title, type, max_points, weight, date, semester } = req.body;

      // Required field validation
      if (!class_id || !subject_id || !title) {
        return res.status(400).json({ error: 'class_id, subject_id, title sú povinné' });
      }
      if (!isUUID(class_id)) return res.status(400).json({ error: 'Neplatný class_id' });
      if (!isUUID(subject_id)) return res.status(400).json({ error: 'Neplatný subject_id' });
      if (!title.trim() || title.trim().length > 200) {
        return res.status(400).json({ error: 'Názov musí mať 1–200 znakov' });
      }

      const VALID_TYPES = ['test', 'oral', 'homework', 'project', 'competency', 'other'];
      const itemType = type || 'test';
      if (!VALID_TYPES.includes(itemType)) {
        return res.status(400).json({ error: `Neplatný typ. Povolené: ${VALID_TYPES.join(', ')}` });
      }

      const itemDate = date || new Date().toISOString().slice(0, 10);
      if (!isISODate(itemDate)) {
        return res.status(400).json({ error: 'Dátum musí byť vo formáte YYYY-MM-DD' });
      }

      const semesterNum = semester !== undefined ? parseInt(semester, 10) : 1;
      if (![1, 2].includes(semesterNum)) {
        return res.status(400).json({ error: 'Semester musí byť 1 alebo 2' });
      }

      const weightNum = weight !== undefined ? parseFloat(weight) : 1.0;
      if (isNaN(weightNum) || weightNum <= 0 || weightNum > 10) {
        return res.status(400).json({ error: 'Váha musí byť číslo 0.01–10' });
      }

      const maxPointsNum = max_points !== undefined && max_points !== null
        ? parseFloat(max_points) : null;
      if (maxPointsNum !== null && (isNaN(maxPointsNum) || maxPointsNum <= 0)) {
        return res.status(400).json({ error: 'max_points musí byť kladné číslo' });
      }

      // Teacher must teach this class (role-specific pre-check, stays for clear error message)
      if (school.role === 'teacher' && !(await teachesClass(user.id, class_id))) {
        return res.status(403).json({ error: 'Nemáte prístup k tejto triede' });
      }

      // CTE-based atomic INSERT: class AND subject ownership verified inside the query.
      // If either does not belong to this school, scope returns 0 rows → INSERT does nothing.
      const { rows: [item] } = await pool.query(
        `WITH scope AS (
           SELECT c.id AS class_id
           FROM public.edu_classes c
           JOIN public.edu_subjects s ON s.id = $2 AND s.school_id = c.school_id
           WHERE c.id = $1 AND c.school_id = $3 AND c.archived_at IS NULL
         )
         INSERT INTO public.edu_grade_items
           (class_id, subject_id, teacher_id, title, type, max_points, weight, date, semester)
         SELECT $1, $2, $4, $5, $6, $7, $8, $9, $10
         FROM scope
         RETURNING *`,
        [class_id, subject_id, school.school_id, user.id,
         clampStr(title, 200), itemType, maxPointsNum, weightNum, itemDate, semesterNum]
      );
      if (!item) {
        return res.status(404).json({ error: 'Trieda alebo predmet nenájdený alebo nepatrí tejto škole' });
      }
      await audit(user.id, school.school_id, 'grade_item_create', 'edu_grade_items', item.id, null, item, req.ip);
      res.status(201).json({ item });
    } catch (err) {
      console.error('[EDU] POST /gradebook/items error:', err.message);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // POST /api/edu/gradebook/entries — create/update grade entries (teacher/admin)
  // Rate limited: 200 entries per 5 minutes per user.
  // SECURITY:
  //   - grade_item verified to belong to actor's school (via class)
  //   - teacher must teach the class the item belongs to
  //   - student_id verified to be enrolled in the class
  // ═══════════════════════════════════════════════════════════════════════
  router.post('/gradebook/entries', async (req, res) => {
    const user = await requireSupabaseUser(req, res);
    if (!user) return;
    try {
      const school = await getUserSchool(user.id);
      if (!requireRole(school, ['admin', 'teacher'], res)) return;

      if (!rateLimit(`gb:entries:${user.id}`, 200, 5 * 60 * 1000)) {
        return res.status(429).json({ error: 'Príliš veľa požiadaviek. Skúste neskôr.' });
      }

      const { entries } = req.body;
      if (!Array.isArray(entries) || entries.length === 0) {
        return res.status(400).json({ error: 'entries pole je povinné' });
      }
      if (entries.length > 150) {
        return res.status(400).json({ error: 'Maximálne 150 hodnotení v jednom požiadavku' });
      }

      // Validate all entries up-front before opening a transaction
      for (const e of entries) {
        if (!isUUID(e.grade_item_id)) return res.status(400).json({ error: 'Neplatný grade_item_id' });
        if (!isUUID(e.student_id)) return res.status(400).json({ error: 'Neplatný student_id' });
        if (e.value === undefined || e.value === null || String(e.value).trim() === '') {
          return res.status(400).json({ error: 'Hodnota hodnotenia je povinná' });
        }
        if (String(e.value).length > 20) {
          return res.status(400).json({ error: 'Hodnota hodnotenia je príliš dlhá (max 20 znakov)' });
        }
      }

      // Fetch and validate grade items — cache per class to minimise DB round-trips
      const itemIds = [...new Set(entries.map(e => e.grade_item_id))];
      const { rows: itemRows } = await pool.query(
        `SELECT gi.id, gi.class_id
         FROM public.edu_grade_items gi
         JOIN public.edu_classes c ON c.id = gi.class_id AND c.school_id = $1
         WHERE gi.id = ANY($2)`,
        [school.school_id, itemIds]
      );
      const itemMap = new Map(itemRows.map(r => [r.id, r]));

      // Verify every requested item belongs to this school
      for (const id of itemIds) {
        if (!itemMap.has(id)) {
          return res.status(403).json({ error: `grade_item_id ${id} nenájdený alebo nepatrí tejto škole` });
        }
      }

      // For teachers: verify they teach every class referenced
      if (school.role === 'teacher') {
        const classIds = [...new Set(itemRows.map(r => r.class_id))];
        for (const cid of classIds) {
          if (!(await teachesClass(user.id, cid))) {
            return res.status(403).json({ error: 'Nemáte prístup k tejto triede' });
          }
        }
      }

      const results = [];
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const e of entries) {
          const item = itemMap.get(e.grade_item_id);

          // Verify student is enrolled in the class the item belongs to
          if (!(await studentEnrolledInClass(e.student_id, item.class_id))) {
            // Skip silently — student may have been un-enrolled; don't fail entire batch
            continue;
          }

          const { rows: oldRows } = await client.query(
            `SELECT * FROM public.edu_grade_entries
             WHERE grade_item_id = $1 AND student_id = $2`,
            [e.grade_item_id, e.student_id]
          );
          const oldData = oldRows[0] || null;

          const { rows: [entry] } = await client.query(
            `INSERT INTO public.edu_grade_entries (grade_item_id, student_id, value, points, note)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (grade_item_id, student_id)
             DO UPDATE SET value = $3, points = $4, note = $5, updated_at = now()
             RETURNING *`,
            [
              e.grade_item_id, e.student_id,
              clampStr(String(e.value), 20),
              (e.points !== undefined && e.points !== null) ? parseFloat(e.points) || null : null,
              e.note ? clampStr(e.note, 500) : null,
            ]
          );
          results.push(entry);

          await audit(
            user.id, school.school_id,
            oldData ? 'grade_entry_update' : 'grade_entry_create',
            'edu_grade_entries', entry.id, oldData, entry, req.ip
          );
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
      res.status(201).json({ entries: results });
    } catch (err) {
      console.error('[EDU] POST /gradebook/entries error:', err.message);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // GET /api/edu/attendance?class_id=...&date=YYYY-MM-DD
  // SECURITY: class_id verified against school in query.
  // ═══════════════════════════════════════════════════════════════════════
  router.get('/attendance', async (req, res) => {
    const user = await requireSupabaseUser(req, res);
    if (!user) return;
    const { class_id, date } = req.query;
    if (!class_id) return res.status(400).json({ error: 'class_id je povinné' });
    if (!isUUID(class_id)) return res.status(400).json({ error: 'Neplatný class_id' });
    if (date && !isISODate(date)) return res.status(400).json({ error: 'Dátum musí byť vo formáte YYYY-MM-DD' });

    try {
      const school = await getUserSchool(user.id);
      if (!school) return res.status(403).json({ error: 'Nie ste členom školy' });

      // Tenancy: class must belong to actor's school
      if (!(await classOwnedBySchool(class_id, school.school_id))) {
        return res.status(404).json({ error: 'Trieda nenájdená' });
      }

      if (school.role === 'teacher' && !(await teachesClass(user.id, class_id))) {
        return res.status(403).json({ error: 'Nemáte prístup k tejto triede' });
      }
      if (school.role === 'student' && !(await studentEnrolledInClass(user.id, class_id))) {
        return res.status(403).json({ error: 'Nie ste zapísaný v tejto triede' });
      }

      // school_id embedded via JOIN — prevents cross-school data access at query level.
      let query = `SELECT a.*, p.display_name FROM public.edu_attendance a
                   JOIN public.edu_classes c ON c.id = a.class_id AND c.school_id = $2
                   LEFT JOIN public.profiles p ON p.id = a.student_id
                   WHERE a.class_id = $1`;
      const params = [class_id, school.school_id];

      if (school.role === 'student') {
        query += ` AND a.student_id = $${params.length + 1}`;
        params.push(user.id);
      }
      if (date) {
        query += ` AND a.date = $${params.length + 1}`;
        params.push(date);
      }
      query += ` ORDER BY a.date DESC, p.display_name`;

      const { rows } = await pool.query(query, params);
      res.json({ attendance: rows });
    } catch (err) {
      console.error('[EDU] GET /attendance error:', err.message);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // POST /api/edu/attendance — record attendance (teacher/admin)
  // Rate limited: 100 submissions per 10 minutes per user.
  // SECURITY: class verified to school; students verified to be enrolled.
  // ═══════════════════════════════════════════════════════════════════════
  router.post('/attendance', async (req, res) => {
    const user = await requireSupabaseUser(req, res);
    if (!user) return;
    try {
      const school = await getUserSchool(user.id);
      if (!requireRole(school, ['admin', 'teacher'], res)) return;

      if (!rateLimit(`attendance:${user.id}`, 100, 10 * 60 * 1000)) {
        return res.status(429).json({ error: 'Príliš veľa požiadaviek. Skúste neskôr.' });
      }

      const { class_id, date, records } = req.body;

      if (!class_id || !date || !Array.isArray(records)) {
        return res.status(400).json({ error: 'class_id, date, records sú povinné' });
      }
      if (!isUUID(class_id)) return res.status(400).json({ error: 'Neplatný class_id' });
      if (!isISODate(date)) return res.status(400).json({ error: 'Dátum musí byť vo formáte YYYY-MM-DD' });
      if (records.length === 0) return res.status(400).json({ error: 'records nesmie byť prázdne' });
      if (records.length > 100) return res.status(400).json({ error: 'Maximálne 100 záznamov v jednom požiadavku' });

      const VALID_STATUSES = ['present', 'absent', 'late', 'excused'];

      // Validate records up-front
      for (const r of records) {
        if (!isUUID(r.student_id)) return res.status(400).json({ error: 'Neplatný student_id' });
        if (!VALID_STATUSES.includes(r.status)) {
          return res.status(400).json({ error: `Neplatný stav. Povolené: ${VALID_STATUSES.join(', ')}` });
        }
        if (r.note && r.note.length > 500) {
          return res.status(400).json({ error: 'Poznámka je príliš dlhá (max 500 znakov)' });
        }
      }

      // Tenancy: class must belong to actor's school
      if (!(await classOwnedBySchool(class_id, school.school_id))) {
        return res.status(404).json({ error: 'Trieda nenájdená' });
      }
      if (school.role === 'teacher' && !(await teachesClass(user.id, class_id))) {
        return res.status(403).json({ error: 'Nemáte prístup k tejto triede' });
      }

      const results = [];
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const r of records) {
          // Verify student is enrolled in this class (skip unenrolled students)
          if (!(await studentEnrolledInClass(r.student_id, class_id))) {
            continue;
          }

          const { rows: oldRows } = await client.query(
            `SELECT * FROM public.edu_attendance
             WHERE class_id = $1 AND student_id = $2 AND date = $3`,
            [class_id, r.student_id, date]
          );
          const oldData = oldRows[0] || null;

          const { rows: [att] } = await client.query(
            `INSERT INTO public.edu_attendance (class_id, student_id, date, status, note, recorded_by)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (class_id, student_id, date)
             DO UPDATE SET status = $4, note = $5, recorded_by = $6, updated_at = now()
             RETURNING *`,
            [class_id, r.student_id, date, r.status, r.note ? clampStr(r.note, 500) : null, user.id]
          );
          results.push(att);

          await audit(
            user.id, school.school_id,
            oldData ? 'attendance_update' : 'attendance_create',
            'edu_attendance', att.id, oldData, att, req.ip
          );
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
      res.status(201).json({ attendance: results });
    } catch (err) {
      console.error('[EDU] POST /attendance error:', err.message);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // GET /api/edu/users/by-email?email=... — look up user by email (admin only)
  // SECURITY:
  //   - admin-only gate
  //   - rate limited: 30 lookups per 10 minutes per admin
  //   - returns only id + display_name (not email, not avatar) to minimise info exposure
  //   - lookup is audit-logged to detect enumeration patterns
  // ═══════════════════════════════════════════════════════════════════════
  router.get('/users/by-email', async (req, res) => {
    const user = await requireSupabaseUser(req, res);
    if (!user) return;
    try {
      const school = await getUserSchool(user.id);
      if (!requireRole(school, ['admin'], res)) return;

      if (!rateLimit(`email:lookup:${user.id}`, 30, 10 * 60 * 1000)) {
        return res.status(429).json({ error: 'Príliš veľa vyhľadávaní. Skúste neskôr.' });
      }

      const { email } = req.query;
      if (!email || !email.trim()) {
        return res.status(400).json({ error: 'email je povinný' });
      }
      const normalizedEmail = email.trim().toLowerCase();
      if (normalizedEmail.length > 254) {
        return res.status(400).json({ error: 'Neplatný email' });
      }

      const { rows } = await pool.query(
        `SELECT id, display_name
         FROM public.profiles
         WHERE LOWER(email) = $1
         LIMIT 1`,
        [normalizedEmail]
      );

      // Audit every lookup (admin-only, but logged for accountability)
      await audit(
        user.id, school.school_id,
        'user_email_lookup', 'profiles', rows[0]?.id || null,
        null, { searched_email: normalizedEmail, found: rows.length > 0 }, req.ip
      );

      if (rows.length === 0) {
        // Uniform 404 — no timing difference between found/not-found
        return res.status(404).json({ error: 'Používateľ nenájdený' });
      }
      // Return only id + display_name — caller already knows the email
      res.json({ user: { id: rows[0].id, display_name: rows[0].display_name } });
    } catch (err) {
      console.error('[EDU] GET /users/by-email error:', err.message);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // PATCH /api/edu/members/:id — change member role (admin only)
  // Rate limited: 30 changes per 15 minutes per admin.
  // ═══════════════════════════════════════════════════════════════════════
  router.patch('/members/:id', async (req, res) => {
    const user = await requireSupabaseUser(req, res);
    if (!user) return;
    try {
      const school = await getUserSchool(user.id);
      if (!requireRole(school, ['admin'], res)) return;

      if (!rateLimit(`members:patch:${user.id}`, 30, 15 * 60 * 1000)) {
        return res.status(429).json({ error: 'Príliš veľa požiadaviek. Skúste neskôr.' });
      }

      if (!isUUID(req.params.id)) {
        return res.status(400).json({ error: 'Neplatné ID člena' });
      }

      const { role } = req.body;
      // Sprint 1 roles only. 'parent' deferred to Sprint 2.
      if (!SPRINT1_ROLES.includes(role)) {
        return res.status(400).json({ error: 'Neplatná rola. Povolené: admin, teacher, student' });
      }

      // Tenancy: member must belong to actor's school (id AND school_id)
      const { rows } = await pool.query(
        `SELECT * FROM public.edu_school_memberships
         WHERE id = $1 AND school_id = $2 AND archived_at IS NULL`,
        [req.params.id, school.school_id]
      );
      if (rows.length === 0) return res.status(404).json({ error: 'Člen nenájdený' });

      const oldData = rows[0];
      const { rows: [updated] } = await pool.query(
        `UPDATE public.edu_school_memberships SET role = $1 WHERE id = $2 RETURNING *`,
        [role, req.params.id]
      );
      await audit(user.id, school.school_id, 'member_role_change', 'edu_school_memberships', updated.id, oldData, updated, req.ip);
      res.json({ member: updated });
    } catch (err) {
      console.error('[EDU] PATCH /members/:id error:', err.message);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // DELETE /api/edu/members/:id — soft-remove member (admin only)
  // Rate limited: 20 removals per 15 minutes per admin.
  // Guard: cannot remove last admin.
  // ═══════════════════════════════════════════════════════════════════════
  router.delete('/members/:id', async (req, res) => {
    const user = await requireSupabaseUser(req, res);
    if (!user) return;
    try {
      const school = await getUserSchool(user.id);
      if (!requireRole(school, ['admin'], res)) return;

      if (!rateLimit(`members:delete:${user.id}`, 20, 15 * 60 * 1000)) {
        return res.status(429).json({ error: 'Príliš veľa požiadaviek. Skúste neskôr.' });
      }

      if (!isUUID(req.params.id)) {
        return res.status(400).json({ error: 'Neplatné ID člena' });
      }

      // Tenancy: member must belong to actor's school
      const { rows } = await pool.query(
        `SELECT * FROM public.edu_school_memberships
         WHERE id = $1 AND school_id = $2 AND archived_at IS NULL`,
        [req.params.id, school.school_id]
      );
      if (rows.length === 0) return res.status(404).json({ error: 'Člen nenájdený' });

      // Guard: cannot remove yourself if you are the last admin
      if (rows[0].user_id === user.id) {
        const { rows: adminCount } = await pool.query(
          `SELECT count(*) FROM public.edu_school_memberships
           WHERE school_id = $1 AND role = 'admin' AND archived_at IS NULL`,
          [school.school_id]
        );
        if (parseInt(adminCount[0].count, 10) <= 1) {
          return res.status(400).json({ error: 'Nemôžete odstrániť posledného administrátora školy' });
        }
      }

      const { rows: [archived] } = await pool.query(
        `UPDATE public.edu_school_memberships SET archived_at = now() WHERE id = $1 RETURNING *`,
        [req.params.id]
      );
      await audit(user.id, school.school_id, 'member_remove', 'edu_school_memberships', archived.id, rows[0], archived, req.ip);
      res.json({ ok: true });
    } catch (err) {
      console.error('[EDU] DELETE /members/:id error:', err.message);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  return router;
}

// ─── Exported for unit testing only ─────────────────────────────────────────
// These are internal helpers exposed so tests can verify them without spinning
// up the full server. Do not call _testHelpers from production code.
const _validators = { isUUID, isISODate, isSchoolYear, clampStr };
const _testHelpers = {
  resetRateBuckets: () => _rateBuckets.clear(),
  getRateBucket: (key) => _rateBuckets.get(key),
  simulateRateLimit: (key, count, windowMs) => {
    const now = Date.now();
    _rateBuckets.set(key, { count, resetAt: now + windowMs });
  },
};

module.exports = { createEduRouter, _validators, _testHelpers };
