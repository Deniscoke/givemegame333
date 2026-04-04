/**
 * gIVEMEEDU — Sprint 1 API routes
 *
 * All routes are mounted under /api/edu/* in server.js.
 * Uses the same pg Pool and auth helpers as the game backend.
 *
 * LEGAL NOTE:
 *   - Backend acts as processor; school is controller.
 *   - No hard-delete on core records (grades, attendance).
 *   - Audit log written for every mutation.
 */

const express = require('express');

/**
 * @param {object} deps - Shared dependencies from server.js
 * @param {import('pg').Pool} deps.pool - Database pool
 * @param {function} deps.requireSupabaseUser - Auth middleware
 */
function createEduRouter({ pool, requireSupabaseUser }) {
  const router = express.Router();

  // ─── Helper: get user's EDU role in a school ───────────────────
  async function getUserMembership(userId, schoolId) {
    const { rows } = await pool.query(
      `SELECT role FROM public.edu_school_memberships
       WHERE user_id = $1 AND school_id = $2 AND archived_at IS NULL`,
      [userId, schoolId]
    );
    return rows[0] || null;
  }

  // ─── Helper: get user's school (first active membership) ──────
  async function getUserSchool(userId) {
    const { rows } = await pool.query(
      `SELECT sm.school_id, sm.role, s.name as school_name
       FROM public.edu_school_memberships sm
       JOIN public.edu_schools s ON s.id = sm.school_id AND s.archived_at IS NULL
       WHERE sm.user_id = $1 AND sm.archived_at IS NULL
       LIMIT 1`,
      [userId]
    );
    return rows[0] || null;
  }

  // ─── Helper: check if teacher teaches a class ─────────────────
  async function teachesClass(userId, classId) {
    const { rows } = await pool.query(
      `SELECT 1 FROM public.edu_teaching_assignments
       WHERE teacher_id = $1 AND class_id = $2 LIMIT 1`,
      [userId, classId]
    );
    return rows.length > 0;
  }

  // ─── Helper: write audit log ──────────────────────────────────
  async function audit(userId, schoolId, action, entity, entityId, oldData, newData, ip) {
    await pool.query(
      `INSERT INTO public.edu_audit_log (user_id, school_id, action, entity, entity_id, old_data, new_data, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [userId, schoolId, action, entity, entityId,
       oldData ? JSON.stringify(oldData) : null,
       newData ? JSON.stringify(newData) : null,
       ip || null]
    );
  }

  // ─── Helper: require role ─────────────────────────────────────
  function requireRole(membership, allowedRoles, res) {
    if (!membership) {
      res.status(403).json({ error: 'Nie ste členom žiadnej školy' });
      return false;
    }
    if (!allowedRoles.includes(membership.role)) {
      res.status(403).json({ error: `Vyžadovaná rola: ${allowedRoles.join(' alebo ')}` });
      return false;
    }
    return true;
  }

  // ═══════════════════════════════════════════════════════════════
  // GET /api/edu/me — current user's EDU profile + school info
  // ═══════════════════════════════════════════════════════════════
  router.get('/me', async (req, res) => {
    const user = await requireSupabaseUser(req, res);
    if (!user) return;
    try {
      const school = await getUserSchool(user.id);
      res.json({
        user: { id: user.id, email: user.email },
        school: school ? { id: school.school_id, name: school.school_name, role: school.role } : null
      });
    } catch (err) {
      console.error('[EDU] /me error:', err.message);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // POST /api/edu/schools — create a school (any authenticated user)
  // The creator becomes admin automatically.
  // ═══════════════════════════════════════════════════════════════
  router.post('/schools', async (req, res) => {
    const user = await requireSupabaseUser(req, res);
    if (!user) return;
    const { name, address, ico, type } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Názov školy je povinný' });
    }
    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows: [school] } = await client.query(
          `INSERT INTO public.edu_schools (name, address, ico, type)
           VALUES ($1, $2, $3, $4) RETURNING *`,
          [name.trim(), address || null, ico || null, type || 'basic_school']
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

  // ═══════════════════════════════════════════════════════════════
  // GET /api/edu/classes — list classes (scoped by role)
  // ═══════════════════════════════════════════════════════════════
  router.get('/classes', async (req, res) => {
    const user = await requireSupabaseUser(req, res);
    if (!user) return;
    try {
      const school = await getUserSchool(user.id);
      if (!school) return res.json({ classes: [] });

      let query, params;
      if (school.role === 'admin') {
        // Admin sees all classes in their school
        query = `SELECT c.*, (SELECT count(*) FROM public.edu_class_enrollments ce WHERE ce.class_id = c.id AND ce.archived_at IS NULL) as student_count
                 FROM public.edu_classes c
                 WHERE c.school_id = $1 AND c.archived_at IS NULL
                 ORDER BY c.grade_level, c.name`;
        params = [school.school_id];
      } else if (school.role === 'teacher') {
        // Teacher sees only classes they teach
        query = `SELECT DISTINCT c.*, (SELECT count(*) FROM public.edu_class_enrollments ce WHERE ce.class_id = c.id AND ce.archived_at IS NULL) as student_count
                 FROM public.edu_classes c
                 JOIN public.edu_teaching_assignments ta ON ta.class_id = c.id AND ta.teacher_id = $2
                 WHERE c.school_id = $1 AND c.archived_at IS NULL
                 ORDER BY c.grade_level, c.name`;
        params = [school.school_id, user.id];
      } else {
        // Student sees classes they're enrolled in
        query = `SELECT c.*
                 FROM public.edu_classes c
                 JOIN public.edu_class_enrollments ce ON ce.class_id = c.id AND ce.student_id = $2 AND ce.archived_at IS NULL
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

  // ═══════════════════════════════════════════════════════════════
  // POST /api/edu/classes — create a class (admin only)
  // ═══════════════════════════════════════════════════════════════
  router.post('/classes', async (req, res) => {
    const user = await requireSupabaseUser(req, res);
    if (!user) return;
    try {
      const school = await getUserSchool(user.id);
      if (!requireRole(school, ['admin'], res)) return;
      const { name, grade_level, school_year } = req.body;
      if (!name || !school_year) {
        return res.status(400).json({ error: 'Názov a školský rok sú povinné' });
      }
      const { rows: [cls] } = await pool.query(
        `INSERT INTO public.edu_classes (school_id, name, grade_level, school_year)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [school.school_id, name.trim(), grade_level || null, school_year.trim()]
      );
      await audit(user.id, school.school_id, 'class_create', 'edu_classes', cls.id, null, cls, req.ip);
      res.status(201).json({ class: cls });
    } catch (err) {
      console.error('[EDU] POST /classes error:', err.message);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // GET /api/edu/students?class_id=... — list students in a class
  // ═══════════════════════════════════════════════════════════════
  router.get('/students', async (req, res) => {
    const user = await requireSupabaseUser(req, res);
    if (!user) return;
    const { class_id } = req.query;
    if (!class_id) return res.status(400).json({ error: 'class_id je povinné' });
    try {
      const school = await getUserSchool(user.id);
      if (!school) return res.status(403).json({ error: 'Nie ste členom školy' });

      // Teachers must teach this class, students can only see if enrolled
      if (school.role === 'teacher') {
        if (!(await teachesClass(user.id, class_id))) {
          return res.status(403).json({ error: 'Nemáte prístup k tejto triede' });
        }
      } else if (school.role === 'student') {
        const { rows } = await pool.query(
          `SELECT 1 FROM public.edu_class_enrollments WHERE class_id = $1 AND student_id = $2 AND archived_at IS NULL`,
          [class_id, user.id]
        );
        if (rows.length === 0) return res.status(403).json({ error: 'Nie ste zapísaný v tejto triede' });
      }

      const { rows } = await pool.query(
        `SELECT ce.id as enrollment_id, ce.student_id, ce.enrolled_at,
                p.display_name, p.avatar_url
         FROM public.edu_class_enrollments ce
         LEFT JOIN public.profiles p ON p.id = ce.student_id
         WHERE ce.class_id = $1 AND ce.archived_at IS NULL
         ORDER BY p.display_name`,
        [class_id]
      );
      res.json({ students: rows });
    } catch (err) {
      console.error('[EDU] GET /students error:', err.message);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // POST /api/edu/students — enroll student into class (admin only)
  // ═══════════════════════════════════════════════════════════════
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
      const { rows: [enrollment] } = await pool.query(
        `INSERT INTO public.edu_class_enrollments (class_id, student_id)
         VALUES ($1, $2)
         ON CONFLICT (class_id, student_id) DO UPDATE SET archived_at = NULL
         RETURNING *`,
        [class_id, student_id]
      );
      await audit(user.id, school.school_id, 'enrollment_create', 'edu_class_enrollments', enrollment.id, null, enrollment, req.ip);
      res.status(201).json({ enrollment });
    } catch (err) {
      console.error('[EDU] POST /students error:', err.message);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // GET /api/edu/subjects — list subjects for the school
  // ═══════════════════════════════════════════════════════════════
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

  // ═══════════════════════════════════════════════════════════════
  // POST /api/edu/subjects — create subject (admin only)
  // ═══════════════════════════════════════════════════════════════
  router.post('/subjects', async (req, res) => {
    const user = await requireSupabaseUser(req, res);
    if (!user) return;
    try {
      const school = await getUserSchool(user.id);
      if (!requireRole(school, ['admin'], res)) return;
      const { name, abbreviation, rvp_area } = req.body;
      if (!name) return res.status(400).json({ error: 'Názov predmetu je povinný' });
      const { rows: [subject] } = await pool.query(
        `INSERT INTO public.edu_subjects (school_id, name, abbreviation, rvp_area)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [school.school_id, name.trim(), abbreviation || null, rvp_area || null]
      );
      res.status(201).json({ subject });
    } catch (err) {
      console.error('[EDU] POST /subjects error:', err.message);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // POST /api/edu/teaching-assignments — assign teacher to class+subject (admin)
  // ═══════════════════════════════════════════════════════════════
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
      const { rows: [ta] } = await pool.query(
        `INSERT INTO public.edu_teaching_assignments (class_id, subject_id, teacher_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (class_id, subject_id, teacher_id) DO NOTHING
         RETURNING *`,
        [class_id, subject_id, teacher_id]
      );
      if (ta) {
        await audit(user.id, school.school_id, 'teaching_assign', 'edu_teaching_assignments', ta.id, null, ta, req.ip);
      }
      res.status(201).json({ assignment: ta || { message: 'Already exists' } });
    } catch (err) {
      console.error('[EDU] POST /teaching-assignments error:', err.message);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // GET /api/edu/members — list school members (admin/teacher)
  // ═══════════════════════════════════════════════════════════════
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

  // ═══════════════════════════════════════════════════════════════
  // POST /api/edu/members — add member to school (admin)
  // ═══════════════════════════════════════════════════════════════
  router.post('/members', async (req, res) => {
    const user = await requireSupabaseUser(req, res);
    if (!user) return;
    try {
      const school = await getUserSchool(user.id);
      if (!requireRole(school, ['admin'], res)) return;
      const { user_id, role } = req.body;
      if (!user_id || !role) return res.status(400).json({ error: 'user_id a role sú povinné' });
      if (!['admin', 'teacher', 'student'].includes(role)) {
        return res.status(400).json({ error: 'Neplatná rola' });
      }
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

  // ═══════════════════════════════════════════════════════════════
  // GET /api/edu/gradebook?class_id=...&subject_id=...
  // Returns grade items + entries for a class/subject
  // ═══════════════════════════════════════════════════════════════
  router.get('/gradebook', async (req, res) => {
    const user = await requireSupabaseUser(req, res);
    if (!user) return;
    const { class_id, subject_id } = req.query;
    if (!class_id) return res.status(400).json({ error: 'class_id je povinné' });
    try {
      const school = await getUserSchool(user.id);
      if (!school) return res.status(403).json({ error: 'Nie ste členom školy' });

      // Access check
      if (school.role === 'teacher' && !(await teachesClass(user.id, class_id))) {
        return res.status(403).json({ error: 'Nemáte prístup k tejto triede' });
      }

      let itemQuery = `SELECT * FROM public.edu_grade_items WHERE class_id = $1`;
      const itemParams = [class_id];
      if (subject_id) {
        itemQuery += ` AND subject_id = $2`;
        itemParams.push(subject_id);
      }
      itemQuery += ` ORDER BY date DESC, created_at DESC`;
      const { rows: items } = await pool.query(itemQuery, itemParams);

      // Get all entries for these items
      const itemIds = items.map(i => i.id);
      let entries = [];
      if (itemIds.length > 0) {
        if (school.role === 'student') {
          // Student only sees own entries
          const { rows } = await pool.query(
            `SELECT * FROM public.edu_grade_entries WHERE grade_item_id = ANY($1) AND student_id = $2`,
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

  // ═══════════════════════════════════════════════════════════════
  // POST /api/edu/gradebook/items — create a grade item (teacher)
  // ═══════════════════════════════════════════════════════════════
  router.post('/gradebook/items', async (req, res) => {
    const user = await requireSupabaseUser(req, res);
    if (!user) return;
    try {
      const school = await getUserSchool(user.id);
      if (!requireRole(school, ['admin', 'teacher'], res)) return;
      const { class_id, subject_id, title, type, max_points, weight, date, semester } = req.body;
      if (!class_id || !subject_id || !title) {
        return res.status(400).json({ error: 'class_id, subject_id, title sú povinné' });
      }
      if (school.role === 'teacher' && !(await teachesClass(user.id, class_id))) {
        return res.status(403).json({ error: 'Nemáte prístup k tejto triede' });
      }
      const { rows: [item] } = await pool.query(
        `INSERT INTO public.edu_grade_items (class_id, subject_id, teacher_id, title, type, max_points, weight, date, semester)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [class_id, subject_id, user.id, title.trim(), type || 'test',
         max_points || null, weight || 1.0, date || new Date().toISOString().slice(0, 10), semester || 1]
      );
      await audit(user.id, school.school_id, 'grade_item_create', 'edu_grade_items', item.id, null, item, req.ip);
      res.status(201).json({ item });
    } catch (err) {
      console.error('[EDU] POST /gradebook/items error:', err.message);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // POST /api/edu/gradebook/entries — create/update grade entries (teacher)
  // Body: { entries: [{ grade_item_id, student_id, value, points, note }] }
  // ═══════════════════════════════════════════════════════════════
  router.post('/gradebook/entries', async (req, res) => {
    const user = await requireSupabaseUser(req, res);
    if (!user) return;
    try {
      const school = await getUserSchool(user.id);
      if (!requireRole(school, ['admin', 'teacher'], res)) return;
      const { entries } = req.body;
      if (!Array.isArray(entries) || entries.length === 0) {
        return res.status(400).json({ error: 'entries pole je povinné' });
      }
      const results = [];
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const e of entries) {
          if (!e.grade_item_id || !e.student_id || e.value === undefined) continue;

          // Fetch old data for audit
          const { rows: oldRows } = await client.query(
            `SELECT * FROM public.edu_grade_entries WHERE grade_item_id = $1 AND student_id = $2`,
            [e.grade_item_id, e.student_id]
          );
          const oldData = oldRows[0] || null;

          const { rows: [entry] } = await client.query(
            `INSERT INTO public.edu_grade_entries (grade_item_id, student_id, value, points, note)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (grade_item_id, student_id)
             DO UPDATE SET value = $3, points = $4, note = $5, updated_at = now()
             RETURNING *`,
            [e.grade_item_id, e.student_id, String(e.value), e.points || null, e.note || null]
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

  // ═══════════════════════════════════════════════════════════════
  // GET /api/edu/attendance?class_id=...&date=YYYY-MM-DD
  // ═══════════════════════════════════════════════════════════════
  router.get('/attendance', async (req, res) => {
    const user = await requireSupabaseUser(req, res);
    if (!user) return;
    const { class_id, date } = req.query;
    if (!class_id) return res.status(400).json({ error: 'class_id je povinné' });
    try {
      const school = await getUserSchool(user.id);
      if (!school) return res.status(403).json({ error: 'Nie ste členom školy' });

      if (school.role === 'teacher' && !(await teachesClass(user.id, class_id))) {
        return res.status(403).json({ error: 'Nemáte prístup k tejto triede' });
      }

      let query = `SELECT a.*, p.display_name FROM public.edu_attendance a
                    LEFT JOIN public.profiles p ON p.id = a.student_id
                    WHERE a.class_id = $1`;
      const params = [class_id];

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

  // ═══════════════════════════════════════════════════════════════
  // POST /api/edu/attendance — record attendance (teacher/admin)
  // Body: { class_id, date, records: [{ student_id, status, note }] }
  // ═══════════════════════════════════════════════════════════════
  router.post('/attendance', async (req, res) => {
    const user = await requireSupabaseUser(req, res);
    if (!user) return;
    try {
      const school = await getUserSchool(user.id);
      if (!requireRole(school, ['admin', 'teacher'], res)) return;
      const { class_id, date, records } = req.body;
      if (!class_id || !date || !Array.isArray(records)) {
        return res.status(400).json({ error: 'class_id, date, records sú povinné' });
      }
      if (school.role === 'teacher' && !(await teachesClass(user.id, class_id))) {
        return res.status(403).json({ error: 'Nemáte prístup k tejto triede' });
      }
      const VALID_STATUSES = ['present', 'absent', 'late', 'excused'];
      const results = [];
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const r of records) {
          if (!r.student_id || !VALID_STATUSES.includes(r.status)) continue;

          const { rows: oldRows } = await client.query(
            `SELECT * FROM public.edu_attendance WHERE class_id = $1 AND student_id = $2 AND date = $3`,
            [class_id, r.student_id, date]
          );
          const oldData = oldRows[0] || null;

          const { rows: [att] } = await client.query(
            `INSERT INTO public.edu_attendance (class_id, student_id, date, status, note, recorded_by)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (class_id, student_id, date)
             DO UPDATE SET status = $4, note = $5, recorded_by = $6, updated_at = now()
             RETURNING *`,
            [class_id, r.student_id, date, r.status, r.note || null, user.id]
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

  return router;
}

module.exports = { createEduRouter };
