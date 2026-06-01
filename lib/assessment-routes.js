/**
 * lib/assessment-routes.js — INVOK Assessment Express router
 *
 * Factory: createAssessmentRouter({ pool, requireSupabaseUser })
 *
 * Routes (all under /api):
 *   GET    /api/assessments                              List assessments
 *   POST   /api/assessments                              Create (teacher)
 *   GET    /api/assessments/:id                          Detail + questions
 *   POST   /api/assessments/:id/start                    Start attempt
 *   POST   /api/assessment-attempts/:attemptId/submit    Submit answers
 *   GET    /api/assessment-results/me                    My results + deltas
 *   GET    /api/assessment-results/summary               Teacher summary
 *   GET    /api/assessment-results/export.csv            CSV export (own only)
 *
 * Authorisation model (MVP, conservative):
 *   - Every endpoint requires authenticated user (requireSupabaseUser).
 *   - Reading own results: always allowed.
 *   - Reading aggregated summary: only for assessments where created_by = user.id.
 *   - correct_answer is hidden from non-owners (anti-cheating).
 *   - No raw access to other students' answers — only aggregates.
 *
 * Future (Phase 2):
 *   - Institution-scoped reporting (riaditeľ vidí celú školu)
 *   - Class-scoped reporting (učiteľ vidí svoju triedu)
 *   - Both via edu_school_memberships role checks.
 */

'use strict';

const express = require('express');
const {
  MODULE_KEYS,
  ASSESSMENT_TYPES,
  QUESTION_TYPES,
  isValidModuleKey,
  isValidAssessmentType,
  isValidQuestionType,
  scoreAnswer,
  computeAttemptScore,
  computeDelta,
  validateAnswerShape,
  canCreateAssessment,
  canSubmitAttempt,
  canStartAttempt,
} = require('./assessment');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUUID = (s) => typeof s === 'string' && UUID_RE.test(s.trim());
const clampStr = (s, max) =>
  typeof s === 'string' ? s.trim().substring(0, max) : '';

const MAX_QUESTIONS_PER_ASSESSMENT = 100;
const MAX_ANSWERS_PER_SUBMIT = 200;

// ─── Rate limiter (mirrors lib/edu-routes.js pattern) ───────────────
// In-memory per-process. On Vercel Fluid Compute multiple instances may
// each hold their own bucket — soft cap only. Logged as known limit
// in PROJECT_STATE.md. For hard caps move to Redis / Vercel KV.
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
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _rateBuckets.entries()) {
    if (now > v.resetAt) _rateBuckets.delete(k);
  }
}, 10 * 60 * 1000).unref?.();

const HOUR_MS = 60 * 60 * 1000;
const LIMIT_CREATE = 20;   // assessments / hour / user
const LIMIT_START  = 60;   // attempts / hour / user
const LIMIT_SUBMIT = 60;   // submits / hour / user

// Internal helper exposed for unit tests
const _testHelpers = { rateLimit, _rateBuckets };

/**
 * @param {{ pool: import('pg').Pool, requireSupabaseUser: Function }} deps
 */
function createAssessmentRouter({ pool, requireSupabaseUser }) {
  if (!pool) throw new Error('createAssessmentRouter: pool is required');
  if (typeof requireSupabaseUser !== 'function') {
    throw new Error('createAssessmentRouter: requireSupabaseUser must be a function');
  }

  const router = express.Router();

  // ─── List assessments (optional filters) ──────────────────────────
  router.get('/assessments', async (req, res) => {
    const user = await requireSupabaseUser(req, res);
    if (!user) return;

    try {
      const where = ['is_active = true'];
      const params = [];

      const { module_key, assessment_type, mine } = req.query;
      if (module_key && isValidModuleKey(module_key)) {
        params.push(module_key);
        where.push(`module_key = $${params.length}`);
      }
      if (assessment_type && isValidAssessmentType(assessment_type)) {
        params.push(assessment_type);
        where.push(`assessment_type = $${params.length}`);
      }
      if (mine === '1') {
        params.push(user.id);
        where.push(`created_by = $${params.length}`);
      }

      const { rows } = await pool.query(
        `SELECT id, title, description, module_key, assessment_type,
                created_by, created_at,
                (created_by = $${params.length + 1}) AS is_mine
         FROM public.assessments
         WHERE ${where.join(' AND ')}
         ORDER BY created_at DESC
         LIMIT 200`,
        [...params, user.id]
      );
      res.json({ items: rows });
    } catch (err) {
      console.error('[Assess] list failed:', err.message);
      res.status(500).json({ error: 'Failed to list assessments', code: 'LIST_ERROR' });
    }
  });

  // ─── Create assessment (teacher/admin only) ───────────────────────
  router.post('/assessments', async (req, res) => {
    const user = await requireSupabaseUser(req, res);
    if (!user) return;

    if (!rateLimit(`assess:create:${user.id}`, LIMIT_CREATE, HOUR_MS)) {
      return res.status(429).json({
        error: 'Too many assessments created. Try again later.',
        code: 'RATE_LIMITED',
      });
    }

    // Role guard: only educators (teacher / admin in ≥1 active school
    // membership) may create assessments. Mirrors RLS policy in 029.
    try {
      const { rows: memberships } = await pool.query(
        `SELECT role, school_id, archived_at
         FROM public.edu_school_memberships
         WHERE user_id = $1 AND archived_at IS NULL`,
        [user.id]
      );
      if (!canCreateAssessment(memberships)) {
        return res.status(403).json({
          error: 'Only teachers/admins can create assessments',
          code: 'NOT_EDUCATOR',
        });
      }
    } catch (err) {
      console.error('[Assess] role check failed:', err.message);
      return res.status(500).json({ error: 'Role check failed', code: 'ROLE_ERROR' });
    }

    const { title, description, module_key, assessment_type, questions } = req.body || {};

    if (!title || typeof title !== 'string' || title.trim().length === 0 || title.length > 200) {
      return res.status(400).json({ error: 'title required (1–200 chars)', code: 'BAD_TITLE' });
    }
    if (!isValidModuleKey(module_key)) {
      return res.status(400).json({
        error: 'invalid module_key',
        code: 'BAD_MODULE',
        valid: [...MODULE_KEYS],
      });
    }
    if (!isValidAssessmentType(assessment_type)) {
      return res.status(400).json({
        error: 'invalid assessment_type',
        code: 'BAD_TYPE',
        valid: [...ASSESSMENT_TYPES],
      });
    }
    if (!Array.isArray(questions) || questions.length === 0
        || questions.length > MAX_QUESTIONS_PER_ASSESSMENT) {
      return res.status(400).json({
        error: `questions array required (1–${MAX_QUESTIONS_PER_ASSESSMENT})`,
        code: 'BAD_QUESTIONS',
      });
    }
    for (const q of questions) {
      if (!isValidQuestionType(q.question_type)) {
        return res.status(400).json({
          error: 'invalid question_type',
          code: 'BAD_Q_TYPE',
          valid: [...QUESTION_TYPES],
        });
      }
      if (!q.prompt || typeof q.prompt !== 'string' || q.prompt.length > 2000) {
        return res.status(400).json({
          error: 'each question needs prompt (≤2000 chars)',
          code: 'BAD_PROMPT',
        });
      }
      if (q.max_points !== undefined && (!Number.isFinite(Number(q.max_points)) || Number(q.max_points) < 0)) {
        return res.status(400).json({ error: 'max_points must be non-negative', code: 'BAD_MAX_POINTS' });
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: a } = await client.query(
        `INSERT INTO public.assessments
           (title, description, module_key, assessment_type, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, created_at`,
        [
          clampStr(title, 200),
          description ? clampStr(description, 2000) : null,
          module_key,
          assessment_type,
          user.id,
        ]
      );
      const assessmentId = a[0].id;

      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        await client.query(
          `INSERT INTO public.assessment_questions
             (assessment_id, question_order, question_type, prompt,
              options, correct_answer, max_points)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            assessmentId,
            i,
            q.question_type,
            clampStr(q.prompt, 2000),
            q.options ? JSON.stringify(q.options) : null,
            q.correct_answer ? JSON.stringify(q.correct_answer) : null,
            Number.isFinite(Number(q.max_points)) ? Number(q.max_points) : 1,
          ]
        );
      }

      await client.query('COMMIT');
      res.status(201).json({ id: assessmentId, created_at: a[0].created_at });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[Assess] create failed:', err.message);
      res.status(500).json({ error: 'Failed to create assessment', code: 'CREATE_ERROR' });
    } finally {
      client.release();
    }
  });

  // ─── Detail (with questions) ──────────────────────────────────────
  router.get('/assessments/:id', async (req, res) => {
    const user = await requireSupabaseUser(req, res);
    if (!user) return;
    if (!isUUID(req.params.id)) {
      return res.status(400).json({ error: 'Bad id', code: 'BAD_ID' });
    }

    try {
      const { rows: a } = await pool.query(
        `SELECT id, title, description, module_key, assessment_type,
                created_by, created_at
         FROM public.assessments
         WHERE id = $1 AND is_active = true`,
        [req.params.id]
      );
      if (!a.length) {
        return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
      }

      const isOwner = a[0].created_by === user.id;
      // Non-owners do NOT receive correct_answer (cheating prevention).
      const cols = isOwner
        ? 'id, question_order, question_type, prompt, options, correct_answer, max_points'
        : 'id, question_order, question_type, prompt, options, max_points';

      const { rows: qs } = await pool.query(
        `SELECT ${cols}
         FROM public.assessment_questions
         WHERE assessment_id = $1
         ORDER BY question_order ASC`,
        [req.params.id]
      );

      res.json({ ...a[0], is_owner: isOwner, questions: qs });
    } catch (err) {
      console.error('[Assess] get failed:', err.message);
      res.status(500).json({ error: 'Failed', code: 'GET_ERROR' });
    }
  });

  // ─── Start an attempt ─────────────────────────────────────────────
  router.post('/assessments/:id/start', async (req, res) => {
    const user = await requireSupabaseUser(req, res);
    if (!user) return;
    if (!isUUID(req.params.id)) {
      return res.status(400).json({ error: 'Bad id', code: 'BAD_ID' });
    }
    if (!rateLimit(`assess:start:${user.id}`, LIMIT_START, HOUR_MS)) {
      return res.status(429).json({ error: 'Too many starts', code: 'RATE_LIMITED' });
    }

    try {
      // Fetch with is_active included so canStartAttempt can decide.
      const { rows: a } = await pool.query(
        `SELECT id, module_key, assessment_type, is_active
         FROM public.assessments
         WHERE id = $1`,
        [req.params.id]
      );
      if (!a.length) {
        return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
      }
      const gate = canStartAttempt(a[0]);
      if (!gate.ok) {
        const code = gate.reason;
        const status = code === 'NOT_ACTIVE' ? 409 : 404;
        return res.status(status).json({ error: code, code });
      }

      const { rows: att } = await pool.query(
        `INSERT INTO public.assessment_attempts
           (assessment_id, user_id, module_key, assessment_type, status)
         VALUES ($1, $2, $3, $4, 'in_progress')
         RETURNING id, started_at`,
        [req.params.id, user.id, a[0].module_key, a[0].assessment_type]
      );

      res.status(201).json({
        attempt_id: att[0].id,
        started_at: att[0].started_at,
      });
    } catch (err) {
      console.error('[Assess] start failed:', err.message);
      res.status(500).json({ error: 'Failed to start', code: 'START_ERROR' });
    }
  });

  // ─── Submit attempt with answers ──────────────────────────────────
  router.post('/assessment-attempts/:attemptId/submit', async (req, res) => {
    const user = await requireSupabaseUser(req, res);
    if (!user) return;
    if (!isUUID(req.params.attemptId)) {
      return res.status(400).json({ error: 'Bad id', code: 'BAD_ID' });
    }
    if (!rateLimit(`assess:submit:${user.id}`, LIMIT_SUBMIT, HOUR_MS)) {
      return res.status(429).json({ error: 'Too many submits', code: 'RATE_LIMITED' });
    }

    const { answers } = req.body || {};
    if (!Array.isArray(answers)) {
      return res.status(400).json({ error: 'answers array required', code: 'BAD_ANSWERS' });
    }
    if (answers.length > MAX_ANSWERS_PER_SUBMIT) {
      return res.status(400).json({ error: 'too many answers', code: 'TOO_MANY' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Lock the attempt row to prevent concurrent submit.
      const { rows: att } = await client.query(
        `SELECT id, assessment_id, user_id, status
         FROM public.assessment_attempts
         WHERE id = $1 FOR UPDATE`,
        [req.params.attemptId]
      );
      const gate = canSubmitAttempt(att[0], user.id);
      if (!gate.ok) {
        await client.query('ROLLBACK');
        const status =
          gate.reason === 'NOT_FOUND' ? 404 :
          gate.reason === 'NOT_OWNER' ? 403 :
          409;
        return res.status(status).json({ error: gate.reason, code: gate.reason });
      }

      // Load all questions for this assessment.
      const { rows: qs } = await client.query(
        `SELECT id, question_type, options, correct_answer, max_points
         FROM public.assessment_questions
         WHERE assessment_id = $1`,
        [att[0].assessment_id]
      );
      const qById = new Map(qs.map((q) => [q.id, q]));

      const scoredAnswers = [];

      // Process submitted answers
      for (const ans of answers) {
        if (!isUUID(ans.question_id)) continue;
        const q = qById.get(ans.question_id);
        if (!q) continue; // silently skip unknown question_ids

        let normalised;
        try {
          normalised = validateAnswerShape(q, ans.answer);
        } catch (e) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: e.message,
            code: 'BAD_ANSWER',
            question_id: ans.question_id,
          });
        }

        const { score, maxPoints, needsManualReview } = scoreAnswer(q, normalised);
        scoredAnswers.push({ score, maxPoints });

        await client.query(
          `INSERT INTO public.assessment_answers
             (attempt_id, question_id, answer, score, max_points, needs_manual_review)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (attempt_id, question_id) DO UPDATE
             SET answer = EXCLUDED.answer,
                 score = EXCLUDED.score,
                 max_points = EXCLUDED.max_points,
                 needs_manual_review = EXCLUDED.needs_manual_review`,
          [
            req.params.attemptId,
            ans.question_id,
            normalised ? JSON.stringify(normalised) : null,
            score,
            maxPoints,
            needsManualReview,
          ]
        );
      }

      // For unanswered questions, count their max_points toward the denominator
      // (otherwise students could skip hard questions to inflate %).
      const answeredIds = new Set(
        answers.filter((a) => isUUID(a.question_id) && qById.has(a.question_id))
          .map((a) => a.question_id)
      );
      for (const q of qs) {
        if (!answeredIds.has(q.id)) {
          scoredAnswers.push({ score: 0, maxPoints: Number(q.max_points) || 1 });
        }
      }

      const totals = computeAttemptScore(scoredAnswers);

      await client.query(
        `UPDATE public.assessment_attempts
         SET submitted_at = now(),
             status = 'submitted',
             total_score = $1,
             max_score = $2,
             percent_score = $3
         WHERE id = $4`,
        [totals.total, totals.max, totals.percent, req.params.attemptId]
      );

      await client.query('COMMIT');

      res.json({
        attempt_id: req.params.attemptId,
        total_score: totals.total,
        max_score: totals.max,
        percent_score: totals.percent,
      });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_e) { /* ignore */ }
      console.error('[Assess] submit failed:', err.message);
      res.status(500).json({ error: 'Failed to submit', code: 'SUBMIT_ERROR' });
    } finally {
      client.release();
    }
  });

  // ─── My results ───────────────────────────────────────────────────
  router.get('/assessment-results/me', async (req, res) => {
    const user = await requireSupabaseUser(req, res);
    if (!user) return;

    try {
      const { rows } = await pool.query(
        `SELECT id, assessment_id, module_key, assessment_type,
                started_at, submitted_at, status,
                total_score, max_score, percent_score
         FROM public.assessment_attempts
         WHERE user_id = $1
         ORDER BY started_at DESC
         LIMIT 200`,
        [user.id]
      );

      // Compute pre/post delta per module (latest pre vs latest post).
      const byModule = {};
      for (const r of rows) {
        if (r.status !== 'submitted') continue;
        byModule[r.module_key] = byModule[r.module_key] || { pre: null, post: null };
        if (r.assessment_type === 'pre' && !byModule[r.module_key].pre) {
          byModule[r.module_key].pre = r;
        }
        if (r.assessment_type === 'post' && !byModule[r.module_key].post) {
          byModule[r.module_key].post = r;
        }
      }
      const deltas = {};
      for (const k of Object.keys(byModule)) {
        const d = computeDelta(byModule[k].pre, byModule[k].post);
        if (d) deltas[k] = d;
      }

      res.json({ attempts: rows, deltas });
    } catch (err) {
      console.error('[Assess] me failed:', err.message);
      res.status(500).json({ error: 'Failed', code: 'ME_ERROR' });
    }
  });

  // ─── Teacher summary (for assessments I created) ──────────────────
  router.get('/assessment-results/summary', async (req, res) => {
    const user = await requireSupabaseUser(req, res);
    if (!user) return;

    try {
      const { rows } = await pool.query(
        `SELECT a.id AS assessment_id,
                a.title,
                a.module_key,
                a.assessment_type,
                COUNT(att.id)::int AS attempt_count,
                COUNT(att.id) FILTER (WHERE att.status = 'submitted')::int AS submitted_count,
                ROUND(AVG(att.percent_score) FILTER (WHERE att.status = 'submitted')::numeric, 2)
                  AS avg_percent
         FROM public.assessments a
         LEFT JOIN public.assessment_attempts att ON att.assessment_id = a.id
         WHERE a.created_by = $1
         GROUP BY a.id, a.title, a.module_key, a.assessment_type, a.created_at
         ORDER BY a.created_at DESC
         LIMIT 200`,
        [user.id]
      );
      res.json({ items: rows });
    } catch (err) {
      console.error('[Assess] summary failed:', err.message);
      res.status(500).json({ error: 'Failed', code: 'SUMMARY_ERROR' });
    }
  });

  // ─── CSV export of own submitted attempts ─────────────────────────
  router.get('/assessment-results/export.csv', async (req, res) => {
    const user = await requireSupabaseUser(req, res);
    if (!user) return;

    try {
      const { rows } = await pool.query(
        `SELECT module_key, assessment_type, started_at, submitted_at,
                total_score, max_score, percent_score
         FROM public.assessment_attempts
         WHERE user_id = $1 AND status = 'submitted'
         ORDER BY submitted_at DESC`,
        [user.id]
      );

      const escapeCsv = (v) => {
        if (v === null || v === undefined) return '';
        const s = String(v);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      const toIso = (v) => (v && v.toISOString ? v.toISOString() : v || '');

      const header = 'module_key,assessment_type,started_at,submitted_at,total_score,max_score,percent_score';
      const lines = rows.map((r) => [
        escapeCsv(r.module_key),
        escapeCsv(r.assessment_type),
        escapeCsv(toIso(r.started_at)),
        escapeCsv(toIso(r.submitted_at)),
        escapeCsv(r.total_score),
        escapeCsv(r.max_score),
        escapeCsv(r.percent_score),
      ].join(','));

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="my-assessments.csv"');
      res.send([header, ...lines].join('\n'));
    } catch (err) {
      console.error('[Assess] export failed:', err.message);
      res.status(500).json({ error: 'Failed', code: 'EXPORT_ERROR' });
    }
  });

  return router;
}

module.exports = { createAssessmentRouter, _testHelpers };
