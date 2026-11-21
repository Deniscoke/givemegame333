/**
 * lib/institution-routes.js — INVOK Institutional Reporting API
 *
 * Factory: createInstitutionRouter({ pool, requireSupabaseUser })
 * Mounted at /api/institution in server.js.
 *
 * All endpoints require authenticated user.
 * Access is scoped to edu_school_memberships — no data leaks outside
 * the user's own schools/classes.
 *
 * Endpoints:
 *   GET /api/institution/me/schools
 *   GET /api/institution/schools/:schoolId
 *   GET /api/institution/schools/:schoolId/classes
 *   GET /api/institution/schools/:schoolId/assessment-summary
 *   GET /api/institution/schools/:schoolId/pre-post-deltas
 *   GET /api/institution/schools/:schoolId/classes/:classId/pre-post-deltas
 *   GET /api/institution/schools/:schoolId/export.csv
 */

'use strict';

const express = require('express');
const {
  canViewSchool,
  canViewSchoolSummary,
  canViewClass,
  canExportInstitutionData,
  normalizeReportFilters,
  computeDeltaSummary,
  sanitizeDeltaForExport,
} = require('./institution');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUUID = (s) => typeof s === 'string' && UUID_RE.test(s.trim());

function eligibleStudentAttempt(alias) {
  return `
    ${alias}.institution_id IS NOT NULL
    AND ${alias}.class_id IS NOT NULL
    AND ${alias}.scope_verified_at = ${alias}.started_at
    AND ${alias}.scope_verified_role = 'student'
    AND ${alias}.scope_membership_id IS NOT NULL
    AND ${alias}.scope_enrollment_id IS NOT NULL`.trim();
}

/**
 * @param {{ pool: import('pg').Pool, requireSupabaseUser: Function }} deps
 */
function createInstitutionRouter({ pool, requireSupabaseUser }) {
  if (!pool) throw new Error('createInstitutionRouter: pool is required');
  if (typeof requireSupabaseUser !== 'function') {
    throw new Error('createInstitutionRouter: requireSupabaseUser must be a function');
  }

  const router = express.Router();

  // ─── Internal: fetch membership for user+school ─────────────────
  async function getMembership(schoolId, userId) {
    const { rows } = await pool.query(
      `SELECT school_id, user_id, role, archived_at
       FROM public.edu_school_memberships
       WHERE school_id = $1 AND user_id = $2`,
      [schoolId, userId]
    );
    return rows[0] || null;
  }

  // ─── 1. My schools ───────────────────────────────────────────────
  router.get('/me/schools', async (req, res) => {
    const user = await requireSupabaseUser(req, res);
    if (!user) return;

    try {
      const { rows } = await pool.query(
        `SELECT
           s.id,
           s.name,
           s.type,
           s.created_at,
           m.role,
           (
             SELECT COUNT(*)::int
             FROM public.edu_classes ec
             WHERE ec.school_id = s.id AND ec.archived_at IS NULL
           ) AS classes_count,
           (
             SELECT COUNT(*)::int
             FROM public.edu_school_memberships sm2
             WHERE sm2.school_id = s.id AND sm2.archived_at IS NULL
           ) AS members_count,
           (
             SELECT COUNT(*)::int
             FROM public.assessment_attempts aa
             WHERE aa.institution_id = s.id
               AND aa.status = 'submitted'
               AND ${eligibleStudentAttempt('aa')}
           ) AS submitted_attempts_count
         FROM public.edu_schools s
         JOIN public.edu_school_memberships m
           ON m.school_id = s.id AND m.user_id = $1 AND m.archived_at IS NULL
         WHERE s.archived_at IS NULL
         ORDER BY s.name ASC`,
        [user.id]
      );

      res.json({
        schools: rows.map((r) => ({
          id:         r.id,
          name:       r.name,
          type:       r.type,
          role:       r.role,
          created_at: r.created_at,
          stats: {
            classes_count:            r.classes_count,
            members_count:            r.members_count,
            submitted_attempts_count: r.submitted_attempts_count,
          },
        })),
      });
    } catch (err) {
      console.error('[Inst] me/schools failed:', err.message);
      res.status(500).json({ error: 'Failed to load schools', code: 'LIST_ERROR' });
    }
  });

  // ─── 2. School detail ────────────────────────────────────────────
  router.get('/schools/:schoolId', async (req, res) => {
    const user = await requireSupabaseUser(req, res);
    if (!user) return;
    if (!isUUID(req.params.schoolId)) {
      return res.status(400).json({ error: 'Bad schoolId', code: 'BAD_ID' });
    }

    try {
      const membership = await getMembership(req.params.schoolId, user.id);
      if (!canViewSchool(membership)) {
        return res.status(403).json({ error: 'Not a member of this school', code: 'NOT_MEMBER' });
      }

      const { rows } = await pool.query(
        `SELECT
           s.id, s.name, s.type, s.address, s.ico, s.created_at,
           (
             SELECT COUNT(*)::int FROM public.edu_classes ec
             WHERE ec.school_id = s.id AND ec.archived_at IS NULL
           ) AS classes_count,
           (
             SELECT COUNT(*)::int FROM public.edu_school_memberships sm
             WHERE sm.school_id = s.id AND sm.archived_at IS NULL
           ) AS members_count,
           (
             SELECT COUNT(DISTINCT a.id)::int
              FROM public.assessments a
              JOIN public.assessment_attempts aa ON aa.assessment_id = a.id
              WHERE aa.institution_id = s.id
                AND ${eligibleStudentAttempt('aa')}
           ) AS assessments_count,
           (
             SELECT COUNT(*)::int FROM public.assessment_attempts aa
             WHERE aa.institution_id = s.id
               AND aa.status = 'submitted'
               AND ${eligibleStudentAttempt('aa')}
           ) AS submitted_attempts_count,
           (
             SELECT ROUND(AVG(aa.percent_score)::numeric, 2)
             FROM public.assessment_attempts aa
             WHERE aa.institution_id = s.id
               AND aa.status = 'submitted'
               AND ${eligibleStudentAttempt('aa')}
           ) AS avg_percent_score
         FROM public.edu_schools s
         WHERE s.id = $1 AND s.archived_at IS NULL`,
        [req.params.schoolId]
      );

      if (!rows.length) {
        return res.status(404).json({ error: 'School not found', code: 'NOT_FOUND' });
      }

      const r = rows[0];
      res.json({
        school: {
          id:         r.id,
          name:       r.name,
          type:       r.type,
          user_role:  membership.role,
          stats: {
            classes_count:            r.classes_count,
            members_count:            r.members_count,
            assessments_count:        r.assessments_count,
            submitted_attempts_count: r.submitted_attempts_count,
            avg_percent_score:        r.avg_percent_score ? Number(r.avg_percent_score) : null,
          },
        },
      });
    } catch (err) {
      console.error('[Inst] school detail failed:', err.message);
      res.status(500).json({ error: 'Failed to load school', code: 'DETAIL_ERROR' });
    }
  });

  // ─── 3. Classes in a school ──────────────────────────────────────
  router.get('/schools/:schoolId/classes', async (req, res) => {
    const user = await requireSupabaseUser(req, res);
    if (!user) return;
    if (!isUUID(req.params.schoolId)) {
      return res.status(400).json({ error: 'Bad schoolId', code: 'BAD_ID' });
    }

    try {
      const membership = await getMembership(req.params.schoolId, user.id);
      if (!canViewSchool(membership)) {
        return res.status(403).json({ error: 'Not a member', code: 'NOT_MEMBER' });
      }

      let rows;
      if (membership.role === 'student') {
        // Students see only their enrolled classes
        const r = await pool.query(
          `SELECT
             c.id, c.name, c.grade_level, c.school_year,
             (
               SELECT COUNT(*)::int FROM public.edu_class_enrollments e2
               WHERE e2.class_id = c.id AND e2.archived_at IS NULL
             ) AS students_count,
             (
                SELECT COUNT(*)::int FROM public.assessment_attempts aa
               WHERE aa.class_id = c.id
                 AND aa.status = 'submitted'
                 AND ${eligibleStudentAttempt('aa')}
             ) AS submitted_attempts_count,
             (
               SELECT ROUND(AVG(aa.percent_score)::numeric, 2)
               FROM public.assessment_attempts aa
               WHERE aa.class_id = c.id
                 AND aa.status = 'submitted'
                 AND ${eligibleStudentAttempt('aa')}
             ) AS avg_percent_score
           FROM public.edu_classes c
           JOIN public.edu_class_enrollments e
             ON e.class_id = c.id AND e.student_id = $1 AND e.archived_at IS NULL
           WHERE c.school_id = $2 AND c.archived_at IS NULL
           ORDER BY c.name ASC`,
          [user.id, req.params.schoolId]
        );
        rows = r.rows;
      } else {
        // Admin/teacher see all classes in the school
        const r = await pool.query(
          `SELECT
             c.id, c.name, c.grade_level, c.school_year,
             (
               SELECT COUNT(*)::int FROM public.edu_class_enrollments e
               WHERE e.class_id = c.id AND e.archived_at IS NULL
             ) AS students_count,
             (
               SELECT COUNT(*)::int FROM public.assessment_attempts aa
               WHERE aa.class_id = c.id
                 AND aa.status = 'submitted'
                 AND ${eligibleStudentAttempt('aa')}
             ) AS submitted_attempts_count,
             (
               SELECT ROUND(AVG(aa.percent_score)::numeric, 2)
               FROM public.assessment_attempts aa
               WHERE aa.class_id = c.id
                 AND aa.status = 'submitted'
                 AND ${eligibleStudentAttempt('aa')}
             ) AS avg_percent_score
           FROM public.edu_classes c
           WHERE c.school_id = $1 AND c.archived_at IS NULL
           ORDER BY c.name ASC`,
          [req.params.schoolId]
        );
        rows = r.rows;
      }

      res.json({
        classes: rows.map((c) => ({
          id:                       c.id,
          name:                     c.name,
          grade_level:              c.grade_level,
          school_year:              c.school_year,
          students_count:           c.students_count,
          submitted_attempts_count: c.submitted_attempts_count,
          avg_percent_score:        c.avg_percent_score ? Number(c.avg_percent_score) : null,
        })),
      });
    } catch (err) {
      console.error('[Inst] classes failed:', err.message);
      res.status(500).json({ error: 'Failed to load classes', code: 'CLASSES_ERROR' });
    }
  });

  // ─── 4. School assessment summary ───────────────────────────────
  router.get('/schools/:schoolId/assessment-summary', async (req, res) => {
    const user = await requireSupabaseUser(req, res);
    if (!user) return;
    if (!isUUID(req.params.schoolId)) {
      return res.status(400).json({ error: 'Bad schoolId', code: 'BAD_ID' });
    }

    const f = normalizeReportFilters(req.query);
    if (!f.valid) {
      return res.status(400).json({ error: f.error, code: f.code });
    }
    const { filters } = f;

    try {
      const membership = await getMembership(req.params.schoolId, user.id);
      if (!canViewSchoolSummary(membership)) {
        return res.status(403).json({
          error: 'Only teachers/admins can view school summary',
          code: 'NOT_EDUCATOR',
        });
      }

      // Build dynamic WHERE for attempts
      const conditions = [
        'aa.institution_id = $1',
        "aa.status = 'submitted'",
        eligibleStudentAttempt('aa'),
      ];
      const params = [req.params.schoolId];

      if (filters.module_key) {
        params.push(filters.module_key);
        conditions.push(`aa.module_key = $${params.length}`);
      }
      if (filters.class_id) {
        params.push(filters.class_id);
        conditions.push(`aa.class_id = $${params.length}`);
      }
      if (filters.from) {
        params.push(filters.from);
        conditions.push(`aa.submitted_at >= $${params.length}`);
      }
      if (filters.to) {
        params.push(filters.to);
        conditions.push(`aa.submitted_at < ($${params.length}::date + interval '1 day')`);
      }

      const where = conditions.join(' AND ');

      const { rows: overall } = await pool.query(
        `SELECT
           COUNT(*)::int                          AS attempts_count,
           COUNT(DISTINCT aa.user_id)::int        AS students_count,
           ROUND(AVG(aa.percent_score)::numeric, 2) AS avg_percent_score
         FROM public.assessment_attempts aa
         WHERE ${where}`,
        params
      );

      const { rows: byModule } = await pool.query(
        `SELECT
           aa.module_key,
           COUNT(*)::int                          AS attempts_count,
           COUNT(DISTINCT aa.user_id)::int        AS students_count,
           ROUND(AVG(aa.percent_score)::numeric, 2) AS avg_percent_score
         FROM public.assessment_attempts aa
         WHERE ${where}
         GROUP BY aa.module_key
         ORDER BY aa.module_key`,
        params
      );

      res.json({
        summary: {
          school_id:         req.params.schoolId,
          attempts_count:    overall[0].attempts_count,
          students_count:    overall[0].students_count,
          avg_percent_score: overall[0].avg_percent_score
            ? Number(overall[0].avg_percent_score) : null,
          modules: byModule.map((m) => ({
            module_key:        m.module_key,
            attempts_count:    m.attempts_count,
            students_count:    m.students_count,
            avg_percent_score: m.avg_percent_score ? Number(m.avg_percent_score) : null,
          })),
        },
      });
    } catch (err) {
      console.error('[Inst] assessment-summary failed:', err.message);
      res.status(500).json({ error: 'Failed to load summary', code: 'SUMMARY_ERROR' });
    }
  });

  // ─── Internal: pre/post delta SQL ────────────────────────────────
  // Pairs each student's earliest 'pre' with their latest 'post' for a
  // given module. Uses DISTINCT ON for Postgres efficiency.
  // schoolScope: SQL fragment to scope to school or class
  // params: $1 is always schoolId (or classId for class scope)
  async function _fetchDeltas(scopeCondition, scopeParams, filters) {
    const params = [...scopeParams];
    const extraConditions = [];

    if (filters.module_key) {
      params.push(filters.module_key);
      extraConditions.push(`aa.module_key = $${params.length}`);
    }
    if (filters.class_id) {
      params.push(filters.class_id);
      extraConditions.push(`aa.class_id = $${params.length}`);
    }
    if (filters.from) {
      params.push(filters.from);
      extraConditions.push(`aa.submitted_at >= $${params.length}`);
    }
    if (filters.to) {
      params.push(filters.to);
      extraConditions.push(`aa.submitted_at < ($${params.length}::date + interval '1 day')`);
    }

    const extraWhere = extraConditions.length
      ? ' AND ' + extraConditions.join(' AND ')
      : '';

    // DISTINCT ON: earliest pre per (user_id, module_key)
    //             latest  post per (user_id, module_key)
    // Then INNER JOIN pairs only students who have both.
    const sql = `
      WITH pre_latest AS (
        SELECT DISTINCT ON (aa.user_id, aa.module_key)
          aa.id, aa.user_id, aa.module_key, aa.class_id, aa.percent_score, aa.submitted_at
        FROM public.assessment_attempts aa
        WHERE aa.assessment_type = 'pre'
          AND aa.status = 'submitted'
          AND ${eligibleStudentAttempt('aa')}
          AND ${scopeCondition}
          ${extraWhere}
        ORDER BY aa.user_id, aa.module_key, aa.submitted_at ASC
      ),
      post_latest AS (
        SELECT DISTINCT ON (aa.user_id, aa.module_key)
          aa.id, aa.user_id, aa.module_key, aa.class_id, aa.percent_score, aa.submitted_at
        FROM public.assessment_attempts aa
        WHERE aa.assessment_type = 'post'
          AND aa.status = 'submitted'
          AND ${eligibleStudentAttempt('aa')}
          AND ${scopeCondition}
          ${extraWhere}
        ORDER BY aa.user_id, aa.module_key, aa.submitted_at DESC
      )
      SELECT
        pre_att.user_id,
        pre_att.class_id,
        pre_att.module_key,
        pre_att.percent_score                         AS pre_percent,
        post_att.percent_score                        AS post_percent,
        ROUND(
          (post_att.percent_score - pre_att.percent_score)::numeric, 2
        )                                             AS delta_percent_points,
        pre_att.submitted_at                          AS pre_submitted_at,
        post_att.submitted_at                         AS post_submitted_at
      FROM pre_latest  pre_att
      JOIN post_latest post_att
        ON post_att.user_id     = pre_att.user_id
       AND post_att.module_key  = pre_att.module_key
      ORDER BY pre_att.module_key, pre_att.user_id`;

    const { rows } = await pool.query(sql, params);
    return rows;
  }

  // ─── 5. School pre/post deltas ───────────────────────────────────
  router.get('/schools/:schoolId/pre-post-deltas', async (req, res) => {
    const user = await requireSupabaseUser(req, res);
    if (!user) return;
    if (!isUUID(req.params.schoolId)) {
      return res.status(400).json({ error: 'Bad schoolId', code: 'BAD_ID' });
    }

    const f = normalizeReportFilters(req.query);
    if (!f.valid) {
      return res.status(400).json({ error: f.error, code: f.code });
    }

    try {
      const membership = await getMembership(req.params.schoolId, user.id);
      if (!canViewSchoolSummary(membership)) {
        return res.status(403).json({ error: 'Not authorized', code: 'NOT_EDUCATOR' });
      }

      const rows = await _fetchDeltas(
        'aa.institution_id = $1',
        [req.params.schoolId],
        f.filters
      );

      res.json({
        deltas:  rows,
        summary: computeDeltaSummary(rows),
      });
    } catch (err) {
      console.error('[Inst] pre-post-deltas failed:', err.message);
      res.status(500).json({ error: 'Failed to compute deltas', code: 'DELTA_ERROR' });
    }
  });

  // ─── 6. Class pre/post deltas ────────────────────────────────────
  router.get('/schools/:schoolId/classes/:classId/pre-post-deltas', async (req, res) => {
    const user = await requireSupabaseUser(req, res);
    if (!user) return;
    if (!isUUID(req.params.schoolId)) {
      return res.status(400).json({ error: 'Bad schoolId', code: 'BAD_ID' });
    }
    if (!isUUID(req.params.classId)) {
      return res.status(400).json({ error: 'Bad classId', code: 'BAD_CLASS_ID' });
    }

    const f = normalizeReportFilters(req.query);
    if (!f.valid) {
      return res.status(400).json({ error: f.error, code: f.code });
    }

    try {
      const membership = await getMembership(req.params.schoolId, user.id);
      if (!canViewSchoolSummary(membership)) {
        return res.status(403).json({ error: 'Not authorized', code: 'NOT_EDUCATOR' });
      }

      // Verify the class belongs to this school
      const { rows: classRows } = await pool.query(
        `SELECT id FROM public.edu_classes
         WHERE id = $1 AND school_id = $2 AND archived_at IS NULL`,
        [req.params.classId, req.params.schoolId]
      );
      if (!classRows.length) {
        return res.status(404).json({ error: 'Class not found in this school', code: 'NOT_FOUND' });
      }

      const rows = await _fetchDeltas(
        'aa.class_id = $1',
        [req.params.classId],
        f.filters
      );

      res.json({
        class_id: req.params.classId,
        deltas:   rows,
        summary:  computeDeltaSummary(rows),
      });
    } catch (err) {
      console.error('[Inst] class deltas failed:', err.message);
      res.status(500).json({ error: 'Failed to compute class deltas', code: 'DELTA_ERROR' });
    }
  });

  // ─── 7. CSV export for INVOK reporting ──────────────────────────
  router.get('/schools/:schoolId/export.csv', async (req, res) => {
    const user = await requireSupabaseUser(req, res);
    if (!user) return;
    if (!isUUID(req.params.schoolId)) {
      return res.status(400).json({ error: 'Bad schoolId', code: 'BAD_ID' });
    }

    const f = normalizeReportFilters(req.query);
    if (!f.valid) {
      return res.status(400).json({ error: f.error, code: f.code });
    }
    const { filters } = f;

    try {
      const membership = await getMembership(req.params.schoolId, user.id);
      if (!canExportInstitutionData(membership)) {
        return res.status(403).json({
          error: 'Only teachers/admins can export data',
          code: 'NOT_EDUCATOR',
        });
      }

      const scope = filters.scope || 'deltas';

      let csvContent;
      if (scope === 'deltas') {
        const rows = await _fetchDeltas(
          'aa.institution_id = $1',
          [req.params.schoolId],
          filters
        );
        const sanitized = rows.map(sanitizeDeltaForExport);
        csvContent = buildCsv(
          ['user_id', 'class_id', 'module_key', 'pre_percent', 'post_percent',
           'delta_percent_points', 'pre_submitted_at', 'post_submitted_at'],
          sanitized
        );
      } else {
        // summary scope: aggregated per module, no individual user_ids
        const conditions = [
          'aa.institution_id = $1',
          "aa.status = 'submitted'",
          eligibleStudentAttempt('aa'),
        ];
        const params = [req.params.schoolId];
        if (filters.module_key) { params.push(filters.module_key); conditions.push(`aa.module_key = $${params.length}`); }
        if (filters.class_id)   { params.push(filters.class_id);   conditions.push(`aa.class_id = $${params.length}`); }
        if (filters.from)       { params.push(filters.from);       conditions.push(`aa.submitted_at >= $${params.length}`); }
        if (filters.to)         { params.push(filters.to);         conditions.push(`aa.submitted_at < ($${params.length}::date + interval '1 day')`); }
        const { rows } = await pool.query(
          `SELECT
             aa.module_key,
             aa.assessment_type,
             COUNT(*)::int                            AS attempts_count,
             COUNT(DISTINCT aa.user_id)::int          AS students_count,
             ROUND(AVG(aa.percent_score)::numeric, 2) AS avg_percent_score
           FROM public.assessment_attempts aa
           WHERE ${conditions.join(' AND ')}
           GROUP BY aa.module_key, aa.assessment_type
           ORDER BY aa.module_key, aa.assessment_type`,
          params
        );
        csvContent = buildCsv(
          ['module_key', 'assessment_type', 'attempts_count', 'students_count', 'avg_percent_score'],
          rows
        );
      }

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition',
        `attachment; filename="invok-report-${req.params.schoolId.slice(0, 8)}.csv"`);
      res.send(csvContent);
    } catch (err) {
      console.error('[Inst] export failed:', err.message);
      res.status(500).json({ error: 'Export failed', code: 'EXPORT_ERROR' });
    }
  });

  return router;
}

// ─── CSV builder ──────────────────────────────────────────────────
function buildCsv(columns, rows) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    if (s.includes('\n') || s.includes(',') || s.includes('"')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };
  const header = columns.map(esc).join(',');
  const lines  = rows.map((r) => columns.map((c) => esc(r[c])).join(','));
  return [header, ...lines].join('\n');
}

module.exports = { createInstitutionRouter };
