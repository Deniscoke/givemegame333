'use strict';

const { afterEach, beforeEach, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const {
  createAssessmentRouter,
  _testHelpers: assessmentTestHelpers,
} = require('../lib/assessment-routes');
const { createInstitutionRouter } = require('../lib/institution-routes');

const TEACHER_ID = '11111111-1111-4111-8111-111111111111';
const STUDENT_ID = '22222222-2222-4222-8222-222222222222';
const SCHOOL_A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SCHOOL_B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CLASS_A_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const CLASS_B_ID = 'bbbbbbbb-0000-4000-8000-000000000002';
const STUDENT_MEMBERSHIP_ID = '33333333-3333-4333-8333-333333333333';
const STUDENT_ENROLLMENT_ID = '44444444-4444-4444-8444-444444444444';
const MODULE_KEY = 'entrepreneurship';

function normalized(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function assertEligibleStudentAttemptSql(sql) {
  const compact = normalized(sql);
  assert.match(compact, /aa\.institution_id IS NOT NULL/i);
  assert.match(compact, /aa\.class_id IS NOT NULL/i);
  assert.match(compact, /aa\.scope_verified_at = aa\.started_at/i);
  assert.match(compact, /aa\.scope_verified_role = 'student'/i);
  assert.match(compact, /aa\.scope_membership_id IS NOT NULL/i);
  assert.match(compact, /aa\.scope_enrollment_id IS NOT NULL/i);
  assert.doesNotMatch(compact, /public\.edu_school_memberships/i);
  assert.doesNotMatch(compact, /public\.edu_class_enrollments/i);
  assert.doesNotMatch(compact, /public\.edu_classes/i);
}

function assertStrictDeltaSql(sql, params) {
  const pre = sql.match(/pre_latest\s+AS\s*\(([\s\S]*?)\),\s*post_latest\s+AS/i);
  const post = sql.match(/post_latest\s+AS\s*\(([\s\S]*?)\)\s*SELECT/i);
  assert.ok(pre, 'delta SQL must contain a pre_latest CTE');
  assert.ok(post, 'delta SQL must contain a post_latest CTE');

  for (const [name, body] of [['pre_latest', pre[1]], ['post_latest', post[1]]]) {
    assert.match(body, /FROM\s+public\.assessment_attempts\s+aa\b/i,
      name + ' must declare the aa alias');
    const aliases = [...body.matchAll(/\b([a-z_][a-z0-9_]*)\./gi)]
      .map((match) => match[1].toLowerCase())
      .filter((alias) => !new Set(['public', 'aa']).has(alias));
    assert.deepEqual(aliases, [], name + ' contains a reference to an undeclared alias');
    assert.match(body, /DISTINCT\s+ON\s*\(\s*aa\.user_id\s*,\s*aa\.module_key\s*\)/i);
    assert.match(body, /aa\.assessment_type\s*=\s*'(pre|post)'/i);
    assert.match(body, /aa\.status\s*=\s*'submitted'/i);
    assertEligibleStudentAttemptSql(body);
  }

  const placeholders = [...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
  assert.ok(placeholders.length > 0, 'delta SQL must be parameterized');
  assert.equal(Math.max(...placeholders), params.length,
    'highest SQL placeholder must match the parameter count');
  for (let position = 1; position <= params.length; position++) {
    assert.ok(placeholders.includes(position), 'missing SQL placeholder $' + position);
  }
}

class StrictAssessmentPool {
  constructor() {
    this.assessments = [];
    this.questions = [];
    this.attempts = [];
    this.deltaQueries = [];
    this.classAuthorizationQueries = [];
    this.nextAssessment = 1;
    this.nextQuestion = 1;
    this.nextAttempt = 1;
    this.classes = [
      {
        id: CLASS_A_ID,
        school_id: SCHOOL_A_ID,
        created_at: '2026-07-01T00:00:00.000Z',
        archived_at: null,
        school_archived_at: null,
      },
      {
        id: CLASS_B_ID,
        school_id: SCHOOL_B_ID,
        created_at: '2026-07-01T00:00:00.000Z',
        archived_at: null,
        school_archived_at: null,
      },
    ];
    this.memberships = [
      {
        id: '55555555-5555-4555-8555-555555555551',
        school_id: SCHOOL_A_ID,
        user_id: TEACHER_ID,
        role: 'teacher',
        created_at: '2026-07-01T00:00:00.000Z',
        archived_at: null,
      },
      {
        id: STUDENT_MEMBERSHIP_ID,
        school_id: SCHOOL_A_ID,
        user_id: STUDENT_ID,
        role: 'student',
        created_at: '2026-07-01T00:00:00.000Z',
        archived_at: null,
      },
    ];
    this.enrollments = [
      {
        id: STUDENT_ENROLLMENT_ID,
        class_id: CLASS_A_ID,
        student_id: STUDENT_ID,
        enrolled_at: '2026-08-01T00:00:00.000Z',
        archived_at: null,
      },
    ];
    this.teachingAssignments = [
      { class_id: CLASS_A_ID, teacher_id: TEACHER_ID },
    ];
  }

  assessmentId() {
    const digit = String(this.nextAssessment++);
    return digit.repeat(8) + '-0000-4000-8000-' + digit.repeat(12);
  }

  questionId() {
    const digit = String(this.nextQuestion++);
    return '9000000' + digit + '-0000-4000-8000-00000000000' + digit;
  }

  attemptId() {
    const digit = String(this.nextAttempt++);
    return '8000000' + digit + '-0000-4000-8000-00000000000' + digit;
  }

  seedAssessment(overrides) {
    const row = {
      id: this.assessmentId(),
      title: 'Seed assessment',
      description: null,
      module_key: MODULE_KEY,
      assessment_type: 'pre',
      created_by: TEACHER_ID,
      is_active: true,
      created_at: '2026-08-01T08:00:00.000Z',
      ...(overrides || {}),
    };
    this.assessments.push(row);
    return row;
  }

  connect() {
    return Promise.resolve({
      query: (sql, params) => this.query(sql, params),
      release() {},
    });
  }

  isEligibleStudentAttempt(attempt) {
    return Boolean(
      attempt.institution_id
      && attempt.class_id
      && attempt.scope_verified_at === attempt.started_at
      && attempt.scope_verified_role === 'student'
      && attempt.scope_membership_id
      && attempt.scope_enrollment_id
    );
  }

  reportingRows(compact, params) {
    assertEligibleStudentAttemptSql(compact);
    let rows = this.attempts.filter((attempt) =>
      attempt.status === 'submitted'
      && this.isEligibleStudentAttempt(attempt)
      && (compact.includes('aa.institution_id = $1')
        ? attempt.institution_id === params[0]
        : attempt.class_id === params[0]));

    let position = 1;
    if (compact.includes('aa.module_key = $' + (position + 1))) {
      rows = rows.filter((attempt) => attempt.module_key === params[position]);
      position++;
    }
    if (compact.includes('aa.class_id = $' + (position + 1))) {
      rows = rows.filter((attempt) => attempt.class_id === params[position]);
      position++;
    }
    if (compact.includes('aa.submitted_at >= $' + (position + 1))) {
      rows = rows.filter((attempt) =>
        attempt.submitted_at.slice(0, 10) >= params[position]);
      position++;
    }
    if (compact.includes('aa.submitted_at < ($' + (position + 1))) {
      rows = rows.filter((attempt) =>
        attempt.submitted_at.slice(0, 10) <= params[position]);
    }
    return rows;
  }

  async query(sql, params = []) {
    const compact = normalized(sql);

    if (compact === 'BEGIN' || compact === 'COMMIT' || compact === 'ROLLBACK') {
      return { rows: [] };
    }

    if (/SELECT role, school_id, archived_at FROM public\.edu_school_memberships WHERE user_id = \$1/i.test(compact)) {
      return {
        rows: this.memberships.filter((row) =>
          row.user_id === params[0] && row.archived_at === null),
      };
    }

    if (/INSERT INTO public\.assessments\b/i.test(compact)) {
      const row = this.seedAssessment({
        title: params[0],
        description: params[1],
        module_key: params[2],
        assessment_type: params[3],
        created_by: params[4],
        created_at: '2026-08-01T08:00:00.000Z',
      });
      return { rows: [{ id: row.id, created_at: row.created_at }] };
    }

    if (/INSERT INTO public\.assessment_questions\b/i.test(compact)) {
      const row = {
        id: this.questionId(),
        assessment_id: params[0],
        question_order: params[1],
        question_type: params[2],
        prompt: params[3],
        options: params[4] ? JSON.parse(params[4]) : null,
        correct_answer: params[5] ? JSON.parse(params[5]) : null,
        max_points: params[6],
      };
      this.questions.push(row);
      return { rows: [] };
    }

    if (/SELECT id, title, description, module_key, assessment_type, created_by, created_at,/i.test(compact)
        && /FROM public\.assessments/i.test(compact)) {
      const currentUser = params[params.length - 1];
      return {
        rows: this.assessments
          .filter((row) => row.is_active)
          .map((row) => ({ ...row, is_mine: row.created_by === currentUser })),
      };
    }

    if (/SELECT id, module_key, assessment_type, is_active FROM public\.assessments WHERE id = \$1/i.test(compact)) {
      const row = this.assessments.find((assessment) => assessment.id === params[0]);
      return { rows: row ? [{
        id: row.id,
        module_key: row.module_key,
        assessment_type: row.assessment_type,
        is_active: row.is_active,
      }] : [] };
    }

    if (/FROM public\.edu_classes c/i.test(compact)
        && /public\.edu_class_enrollments/i.test(compact)
        && /institution_id/i.test(compact)) {
      this.classAuthorizationQueries.push({ sql, params: [...params] });
      assert.match(compact, /c\.archived_at IS NULL/i);
      assert.match(compact, /s\.archived_at IS NULL/i);
      assert.match(compact, /ce\.class_id = c\.id/i);
      assert.match(compact, /ce\.student_id = \$2/i);
      assert.match(compact, /ce\.archived_at IS NULL/i);
      assert.match(compact, /sm\.school_id = c\.school_id/i);
      assert.match(compact, /sm\.user_id = \$2/i);
      assert.match(compact, /sm\.archived_at IS NULL/i);
      assert.match(compact, /sm\.role = 'student'/i);
      assert.doesNotMatch(compact, /sm\.role = 'admin'/i);
      assert.doesNotMatch(compact, /sm\.role = 'teacher'/i);
      assert.doesNotMatch(compact, /public\.edu_teaching_assignments/i);

      const [classId, userId] = params;
      const classRow = this.classes.find((row) =>
        row.id === classId && row.archived_at === null && row.school_archived_at === null);
      if (!classRow) return { rows: [] };

      const enrolled = this.enrollments.some((row) =>
        row.class_id === classId && row.student_id === userId && row.archived_at === null);
      const membership = this.memberships.find((row) =>
        row.school_id === classRow.school_id && row.user_id === userId && row.archived_at === null);
      const activeStudent = membership && membership.role === 'student' && enrolled;

      return {
        rows: activeStudent
          ? [{ class_id: classRow.id, institution_id: classRow.school_id }]
          : [],
      };
    }

    if (/INSERT INTO public\.assessment_attempts\b/i.test(compact)) {
      assert.match(compact,
        /\(assessment_id, user_id, institution_id, class_id, module_key, assessment_type, status\)/i,
        'attempt insert must explicitly persist both scope columns');
      assert.equal(params.length, 6);
      const id = this.attemptId();
      const startedAt = this.nextAttempt === 2
        ? '2026-08-02T09:00:00.000Z'
        : '2026-08-20T09:00:00.000Z';
      const scoped = Boolean(params[2] && params[3]);
      const row = {
        id,
        assessment_id: params[0],
        user_id: params[1],
        institution_id: params[2],
        class_id: params[3],
        module_key: params[4],
        assessment_type: params[5],
        status: 'in_progress',
        started_at: startedAt,
        scope_verified_at: scoped ? startedAt : null,
        scope_verified_role: scoped ? 'student' : null,
        scope_membership_id: scoped ? STUDENT_MEMBERSHIP_ID : null,
        scope_enrollment_id: scoped ? STUDENT_ENROLLMENT_ID : null,
        submitted_at: null,
        total_score: null,
        max_score: null,
        percent_score: null,
      };
      this.attempts.push(row);
      return { rows: [{ id: row.id, started_at: row.started_at }] };
    }

    if (/SELECT id, assessment_id, user_id, status FROM public\.assessment_attempts WHERE id = \$1 FOR UPDATE/i.test(compact)) {
      const row = this.attempts.find((attempt) => attempt.id === params[0]);
      return { rows: row ? [{
        id: row.id,
        assessment_id: row.assessment_id,
        user_id: row.user_id,
        status: row.status,
      }] : [] };
    }

    if (/SELECT id, question_type, options, correct_answer, max_points FROM public\.assessment_questions WHERE assessment_id = \$1/i.test(compact)) {
      return {
        rows: this.questions.filter((question) => question.assessment_id === params[0]),
      };
    }

    if (/INSERT INTO public\.assessment_answers\b/i.test(compact)) {
      return { rows: [] };
    }

    if (/UPDATE public\.assessment_attempts SET submitted_at = now\(\)/i.test(compact)) {
      const row = this.attempts.find((attempt) => attempt.id === params[3]);
      assert.ok(row, 'submit must update an existing attempt');
      row.total_score = params[0];
      row.max_score = params[1];
      row.percent_score = params[2];
      row.status = 'submitted';
      row.submitted_at = row.assessment_type === 'pre'
        ? '2026-08-02T09:05:00.000Z'
        : '2026-08-20T09:05:00.000Z';
      return { rows: [] };
    }

    if (/SELECT school_id, user_id, role, archived_at FROM public\.edu_school_memberships WHERE school_id = \$1 AND user_id = \$2/i.test(compact)) {
      const row = this.memberships.find((membership) =>
        membership.school_id === params[0] && membership.user_id === params[1]);
      return { rows: row ? [row] : [] };
    }

    if (/SELECT id FROM public\.edu_classes WHERE id = \$1 AND school_id = \$2 AND archived_at IS NULL/i.test(compact)) {
      const row = this.classes.find((classRow) =>
        classRow.id === params[0]
        && classRow.school_id === params[1]
        && classRow.archived_at === null);
      return { rows: row ? [{ id: row.id }] : [] };
    }

    if (/SELECT COUNT\(\*\)::int AS attempts_count/i.test(compact)
        && /FROM public\.assessment_attempts aa/i.test(compact)) {
      const rows = this.reportingRows(compact, params);
      const average = rows.length
        ? rows.reduce((sum, row) => sum + row.percent_score, 0) / rows.length
        : null;
      return {
        rows: [{
          attempts_count: rows.length,
          students_count: new Set(rows.map((row) => row.user_id)).size,
          avg_percent_score: average,
        }],
      };
    }

    if (/SELECT aa\.module_key, COUNT\(\*\)::int AS attempts_count/i.test(compact)
        && /GROUP BY aa\.module_key/i.test(compact)) {
      const rows = this.reportingRows(compact, params);
      const modules = new Map();
      for (const row of rows) {
        if (!modules.has(row.module_key)) modules.set(row.module_key, []);
        modules.get(row.module_key).push(row);
      }
      return {
        rows: [...modules.entries()].map(([moduleKey, attempts]) => ({
          module_key: moduleKey,
          attempts_count: attempts.length,
          students_count: new Set(attempts.map((row) => row.user_id)).size,
          avg_percent_score: attempts.reduce((sum, row) =>
            sum + row.percent_score, 0) / attempts.length,
        })),
      };
    }

    if (/SELECT aa\.module_key, aa\.assessment_type/i.test(compact)
        && /GROUP BY aa\.module_key, aa\.assessment_type/i.test(compact)) {
      const rows = this.reportingRows(compact, params);
      const groups = new Map();
      for (const row of rows) {
        const key = row.module_key + ':' + row.assessment_type;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
      }
      return {
        rows: [...groups.values()].map((attempts) => ({
          module_key: attempts[0].module_key,
          assessment_type: attempts[0].assessment_type,
          attempts_count: attempts.length,
          students_count: new Set(attempts.map((row) => row.user_id)).size,
          avg_percent_score: attempts.reduce((sum, row) =>
            sum + row.percent_score, 0) / attempts.length,
        })),
      };
    }

    if (/WITH pre_latest AS/i.test(compact)) {
      assertStrictDeltaSql(sql, params);
      this.deltaQueries.push({ sql, params: [...params] });
      const rows = this.reportingRows(compact, params);

      const pre = rows
        .filter((attempt) => attempt.assessment_type === 'pre')
        .sort((a, b) => a.submitted_at.localeCompare(b.submitted_at))[0];
      const post = rows
        .filter((attempt) => attempt.assessment_type === 'post')
        .sort((a, b) => b.submitted_at.localeCompare(a.submitted_at))[0];
      if (!pre || !post) return { rows: [] };

      return {
        rows: [{
          user_id: pre.user_id,
          class_id: pre.class_id,
          module_key: pre.module_key,
          pre_percent: pre.percent_score,
          post_percent: post.percent_score,
          delta_percent_points: post.percent_score - pre.percent_score,
          pre_submitted_at: pre.submitted_at,
          post_submitted_at: post.submitted_at,
        }],
      };
    }

    throw new Error('Unexpected SQL in strict assessment pool: ' + compact);
  }
}

async function createServer(pool) {
  const app = express();
  app.use(express.json());
  const requireSupabaseUser = async (req, res) => {
    const id = req.get('x-test-user');
    if (!id) {
      res.status(401).json({ error: 'Unauthorized' });
      return null;
    }
    return { id, email: id + '@example.test' };
  };
  app.use('/api', createAssessmentRouter({ pool, requireSupabaseUser }));
  app.use('/api/institution', createInstitutionRouter({ pool, requireSupabaseUser }));

  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  return {
    origin: 'http://127.0.0.1:' + server.address().port,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function jsonRequest(origin, path, userId, options) {
  const request = { ...(options || {}) };
  request.headers = {
    'content-type': 'application/json',
    'x-test-user': userId,
    ...(request.headers || {}),
  };
  const response = await fetch(origin + path, request);
  const data = await response.json();
  return { response, data };
}

function assessmentPayload(type) {
  return {
    title: type === 'pre' ? 'Vstupné meranie' : 'Výstupné meranie',
    description: 'INVOK flow fixture',
    module_key: MODULE_KEY,
    assessment_type: type,
    questions: [{
      question_type: 'multiple_choice',
      prompt: 'Vyber správnu odpoveď',
      options: ['wrong', 'correct'],
      correct_answer: ['correct'],
      max_points: 1,
    }],
  };
}

describe('assessment attempt reporting scope', () => {
  let context;

  beforeEach(() => {
    assessmentTestHelpers._rateBuckets.clear();
  });

  afterEach(async () => {
    if (context) await context.close();
    context = null;
  });

  test('solo starts remain valid and explicitly store null institution and class scope', async () => {
    const pool = new StrictAssessmentPool();
    const assessment = pool.seedAssessment();
    context = await createServer(pool);

    const { response, data } = await jsonRequest(
      context.origin,
      '/api/assessments/' + assessment.id + '/start',
      STUDENT_ID,
      { method: 'POST', body: '{}' }
    );

    assert.equal(response.status, 201);
    assert.ok(data.attempt_id);
    assert.equal(pool.attempts.length, 1);
    assert.equal(pool.attempts[0].institution_id, null);
    assert.equal(pool.attempts[0].class_id, null);
    assert.equal(pool.classAuthorizationQueries.length, 0);
  });

  test('a malformed class_id is rejected before any attempt is inserted', async () => {
    const pool = new StrictAssessmentPool();
    const assessment = pool.seedAssessment();
    context = await createServer(pool);

    const { response, data } = await jsonRequest(
      context.origin,
      '/api/assessments/' + assessment.id + '/start',
      STUDENT_ID,
      { method: 'POST', body: JSON.stringify({ class_id: 'not-a-uuid' }) }
    );

    assert.equal(response.status, 400);
    assert.equal(data.code, 'BAD_CLASS_ID');
    assert.equal(pool.attempts.length, 0);
  });

  test('a class outside the caller exact active student enrollment is rejected', async () => {
    const pool = new StrictAssessmentPool();
    const assessment = pool.seedAssessment();
    context = await createServer(pool);

    const { response, data } = await jsonRequest(
      context.origin,
      '/api/assessments/' + assessment.id + '/start',
      STUDENT_ID,
      { method: 'POST', body: JSON.stringify({ class_id: CLASS_B_ID }) }
    );

    assert.equal(response.status, 403);
    assert.equal(data.code, 'CLASS_NOT_AUTHORIZED');
    assert.equal(pool.attempts.length, 0);
    assert.equal(pool.classAuthorizationQueries.length, 1);
  });

  test('teacher previews are solo and cannot create institution-scoped evidence', async () => {
    const pool = new StrictAssessmentPool();
    const assessment = pool.seedAssessment();
    context = await createServer(pool);

    const scoped = await jsonRequest(
      context.origin,
      '/api/assessments/' + assessment.id + '/start',
      TEACHER_ID,
      { method: 'POST', body: JSON.stringify({ class_id: CLASS_A_ID }) }
    );
    assert.equal(scoped.response.status, 403);
    assert.equal(scoped.data.code, 'CLASS_NOT_AUTHORIZED');
    assert.equal(pool.attempts.length, 0);

    const solo = await jsonRequest(
      context.origin,
      '/api/assessments/' + assessment.id + '/start',
      TEACHER_ID,
      { method: 'POST', body: '{}' }
    );
    assert.equal(solo.response.status, 201);
    assert.equal(pool.attempts.length, 1);
    assert.equal(pool.attempts[0].institution_id, null);
    assert.equal(pool.attempts[0].class_id, null);
  });

  test('immutable evidence preserves attempts after a student role changes to educator', async () => {
    const pool = new StrictAssessmentPool();
    context = await createServer(pool);

    pool.attempts.push(
      {
        id: pool.attemptId(),
        assessment_id: '70000001-0000-4000-8000-000000000001',
        user_id: STUDENT_ID,
        institution_id: SCHOOL_A_ID,
        class_id: CLASS_A_ID,
        module_key: MODULE_KEY,
        assessment_type: 'pre',
        status: 'submitted',
        started_at: '2026-08-02T09:00:00.000Z',
        submitted_at: '2026-08-02T09:05:00.000Z',
        scope_verified_at: '2026-08-02T09:00:00.000Z',
        scope_verified_role: 'student',
        scope_membership_id: STUDENT_MEMBERSHIP_ID,
        scope_enrollment_id: STUDENT_ENROLLMENT_ID,
        total_score: 1,
        max_score: 1,
        percent_score: 20,
      },
      {
        id: pool.attemptId(),
        assessment_id: '70000002-0000-4000-8000-000000000002',
        user_id: STUDENT_ID,
        institution_id: SCHOOL_A_ID,
        class_id: CLASS_A_ID,
        module_key: MODULE_KEY,
        assessment_type: 'post',
        status: 'submitted',
        started_at: '2026-08-20T09:00:00.000Z',
        submitted_at: '2026-08-20T09:05:00.000Z',
        scope_verified_at: '2026-08-20T09:00:00.000Z',
        scope_verified_role: 'student',
        scope_membership_id: STUDENT_MEMBERSHIP_ID,
        scope_enrollment_id: STUDENT_ENROLLMENT_ID,
        total_score: 1,
        max_score: 1,
        percent_score: 80,
      }
    );
    pool.memberships.find((row) => row.user_id === STUDENT_ID).role = 'teacher';

    const filters = '?module_key=' + MODULE_KEY + '&class_id=' + CLASS_A_ID;
    const summary = await jsonRequest(
      context.origin,
      '/api/institution/schools/' + SCHOOL_A_ID + '/assessment-summary' + filters,
      TEACHER_ID
    );
    assert.equal(summary.response.status, 200);
    assert.equal(summary.data.summary.attempts_count, 2);
    assert.equal(summary.data.summary.students_count, 1);

    const deltas = await jsonRequest(
      context.origin,
      '/api/institution/schools/' + SCHOOL_A_ID + '/pre-post-deltas' + filters,
      TEACHER_ID
    );
    assert.equal(deltas.response.status, 200);
    assert.equal(deltas.data.deltas.length, 1);
    assert.equal(deltas.data.deltas[0].delta_percent_points, 60);
  });

  test('reactivation cannot certify unverified attempts created during a removal gap', async () => {
    const pool = new StrictAssessmentPool();
    context = await createServer(pool);

    const base = {
      assessment_id: '70000001-0000-4000-8000-000000000001',
      user_id: STUDENT_ID,
      institution_id: SCHOOL_A_ID,
      class_id: CLASS_A_ID,
      module_key: MODULE_KEY,
      status: 'submitted',
      total_score: 1,
      max_score: 1,
    };
    pool.attempts.push(
      {
        ...base,
        id: pool.attemptId(),
        assessment_type: 'pre',
        started_at: '2026-08-02T09:00:00.000Z',
        submitted_at: '2026-08-02T09:05:00.000Z',
        scope_verified_at: '2026-08-02T09:00:00.000Z',
        scope_verified_role: 'student',
        scope_membership_id: STUDENT_MEMBERSHIP_ID,
        scope_enrollment_id: STUDENT_ENROLLMENT_ID,
        percent_score: 20,
      },
      {
        ...base,
        id: pool.attemptId(),
        assessment_type: 'post',
        started_at: '2026-08-10T09:00:00.000Z',
        submitted_at: '2026-08-10T09:05:00.000Z',
        scope_verified_at: '2026-08-10T09:00:00.000Z',
        scope_verified_role: 'student',
        scope_membership_id: STUDENT_MEMBERSHIP_ID,
        scope_enrollment_id: STUDENT_ENROLLMENT_ID,
        percent_score: 80,
      },
      {
        ...base,
        id: pool.attemptId(),
        assessment_type: 'pre',
        started_at: '2026-08-15T09:00:00.000Z',
        submitted_at: '2026-08-15T09:05:00.000Z',
        scope_verified_at: null,
        scope_verified_role: null,
        scope_membership_id: null,
        scope_enrollment_id: null,
        percent_score: 100,
      },
      {
        ...base,
        id: pool.attemptId(),
        assessment_type: 'post',
        started_at: '2026-08-16T09:00:00.000Z',
        submitted_at: '2026-08-16T09:05:00.000Z',
        scope_verified_at: null,
        scope_verified_role: null,
        scope_membership_id: null,
        scope_enrollment_id: null,
        percent_score: 0,
      }
    );

    // The current EDU model reuses the same rows and clears archived_at on
    // reactivation, erasing the removal gap. Reporting must not infer history
    // from these mutable rows.
    pool.memberships.find((row) => row.user_id === STUDENT_ID).archived_at = null;
    pool.memberships.find((row) => row.user_id === STUDENT_ID).role = 'student';
    pool.enrollments.find((row) => row.student_id === STUDENT_ID).archived_at = null;

    const filters = '?module_key=' + MODULE_KEY
      + '&class_id=' + CLASS_A_ID
      + '&from=2026-08-01&to=2026-08-31';
    const summary = await jsonRequest(
      context.origin,
      '/api/institution/schools/' + SCHOOL_A_ID + '/assessment-summary' + filters,
      TEACHER_ID
    );
    assert.equal(summary.response.status, 200);
    assert.equal(summary.data.summary.attempts_count, 2);
    assert.equal(summary.data.summary.students_count, 1);
    assert.equal(summary.data.summary.avg_percent_score, 50);

    const deltas = await jsonRequest(
      context.origin,
      '/api/institution/schools/' + SCHOOL_A_ID + '/pre-post-deltas' + filters,
      TEACHER_ID
    );
    assert.equal(deltas.response.status, 200);
    assert.equal(deltas.data.deltas.length, 1);
    assert.equal(deltas.data.deltas[0].pre_percent, 20);
    assert.equal(deltas.data.deltas[0].post_percent, 80);
    assert.equal(deltas.data.deltas[0].delta_percent_points, 60);

    const deltaExport = await fetch(
      context.origin + '/api/institution/schools/' + SCHOOL_A_ID
        + '/export.csv' + filters + '&scope=deltas',
      { headers: { 'x-test-user': TEACHER_ID } }
    );
    const deltaCsv = await deltaExport.text();
    assert.equal(deltaExport.status, 200);
    assert.match(deltaCsv, /,20,80,60,/);
    assert.equal(deltaCsv.trim().split('\n').length, 2);

    const summaryExport = await fetch(
      context.origin + '/api/institution/schools/' + SCHOOL_A_ID
        + '/export.csv' + filters + '&scope=summary',
      { headers: { 'x-test-user': TEACHER_ID } }
    );
    const summaryCsv = await summaryExport.text();
    assert.equal(summaryExport.status, 200);
    assert.match(summaryCsv, /entrepreneurship,pre,1,1,20/);
    assert.match(summaryCsv, /entrepreneurship,post,1,1,80/);
    assert.equal(summaryCsv.trim().split('\n').length, 3);
  });

  test('create, list, scoped pre/post start, submit, report and export preserve tenant filters', async () => {
    const pool = new StrictAssessmentPool();
    context = await createServer(pool);

    const created = [];
    for (const type of ['pre', 'post']) {
      const result = await jsonRequest(
        context.origin,
        '/api/assessments',
        TEACHER_ID,
        { method: 'POST', body: JSON.stringify(assessmentPayload(type)) }
      );
      assert.equal(result.response.status, 201);
      created.push(result.data.id);
    }

    const listed = await jsonRequest(context.origin, '/api/assessments', STUDENT_ID);
    assert.equal(listed.response.status, 200);
    assert.deepEqual(listed.data.items.map((item) => item.id), created);

    const attemptIds = [];
    for (const assessmentId of created) {
      const started = await jsonRequest(
        context.origin,
        '/api/assessments/' + assessmentId + '/start',
        STUDENT_ID,
        {
          method: 'POST',
          body: JSON.stringify({
            class_id: CLASS_A_ID,
            institution_id: SCHOOL_B_ID,
          }),
        }
      );
      assert.equal(started.response.status, 201);
      attemptIds.push(started.data.attempt_id);
    }

    assert.equal(pool.attempts.length, 2);
    for (const attempt of pool.attempts) {
      assert.equal(attempt.institution_id, SCHOOL_A_ID);
      assert.equal(attempt.class_id, CLASS_A_ID);
    }

    const answerValues = ['wrong', 'correct'];
    for (let i = 0; i < attemptIds.length; i++) {
      const assessmentId = created[i];
      const question = pool.questions.find((row) => row.assessment_id === assessmentId);
      const submitted = await jsonRequest(
        context.origin,
        '/api/assessment-attempts/' + attemptIds[i] + '/submit',
        STUDENT_ID,
        {
          method: 'POST',
          body: JSON.stringify({
            answers: [{ question_id: question.id, answer: { value: answerValues[i] } }],
          }),
        }
      );
      assert.equal(submitted.response.status, 200);
    }

    // Historical/malformed rows must not become student evidence: an
    // educator was once class-scoped, and a student row carries a class
    // belonging to another institution.
    pool.attempts.push(
      {
        id: pool.attemptId(),
        assessment_id: created[0],
        user_id: TEACHER_ID,
        institution_id: SCHOOL_A_ID,
        class_id: CLASS_A_ID,
        module_key: MODULE_KEY,
        assessment_type: 'pre',
        status: 'submitted',
        started_at: '2026-08-03T09:00:00.000Z',
        submitted_at: '2026-08-03T09:05:00.000Z',
        total_score: 1,
        max_score: 1,
        percent_score: 100,
      },
      {
        id: pool.attemptId(),
        assessment_id: created[1],
        user_id: TEACHER_ID,
        institution_id: SCHOOL_A_ID,
        class_id: CLASS_A_ID,
        module_key: MODULE_KEY,
        assessment_type: 'post',
        status: 'submitted',
        started_at: '2026-08-21T09:00:00.000Z',
        submitted_at: '2026-08-21T09:05:00.000Z',
        total_score: 0,
        max_score: 1,
        percent_score: 0,
      },
      {
        id: pool.attemptId(),
        assessment_id: created[0],
        user_id: STUDENT_ID,
        institution_id: SCHOOL_A_ID,
        class_id: CLASS_B_ID,
        module_key: MODULE_KEY,
        assessment_type: 'pre',
        status: 'submitted',
        started_at: '2026-08-04T09:00:00.000Z',
        submitted_at: '2026-08-04T09:05:00.000Z',
        total_score: 1,
        max_score: 1,
        percent_score: 100,
      }
    );

    const filterQuery = '?module_key=' + MODULE_KEY
      + '&class_id=' + CLASS_A_ID
      + '&from=2026-08-01&to=2026-08-31';
    const assessmentSummary = await jsonRequest(
      context.origin,
      '/api/institution/schools/' + SCHOOL_A_ID + '/assessment-summary' + filterQuery,
      TEACHER_ID
    );
    assert.equal(assessmentSummary.response.status, 200);
    assert.equal(assessmentSummary.data.summary.attempts_count, 2);
    assert.equal(assessmentSummary.data.summary.students_count, 1);
    assert.equal(assessmentSummary.data.summary.avg_percent_score, 50);
    assert.deepEqual(assessmentSummary.data.summary.modules, [{
      module_key: MODULE_KEY,
      attempts_count: 2,
      students_count: 1,
      avg_percent_score: 50,
    }]);

    const report = await jsonRequest(
      context.origin,
      '/api/institution/schools/' + SCHOOL_A_ID + '/pre-post-deltas' + filterQuery,
      TEACHER_ID
    );

    assert.equal(report.response.status, 200);
    assert.equal(report.data.deltas.length, 1);
    assert.equal(report.data.deltas[0].class_id, CLASS_A_ID);
    assert.equal(report.data.deltas[0].pre_percent, 0);
    assert.equal(report.data.deltas[0].post_percent, 100);
    assert.equal(report.data.summary.avg_delta_percent_points, 100);
    assert.deepEqual(pool.deltaQueries[0].params, [
      SCHOOL_A_ID,
      MODULE_KEY,
      CLASS_A_ID,
      '2026-08-01',
      '2026-08-31',
    ]);

    const exportResponse = await fetch(
      context.origin + '/api/institution/schools/' + SCHOOL_A_ID
        + '/export.csv' + filterQuery + '&scope=deltas',
      { headers: { 'x-test-user': TEACHER_ID } }
    );
    const csv = await exportResponse.text();
    assert.equal(exportResponse.status, 200);
    assert.match(csv, new RegExp(CLASS_A_ID));
    assert.doesNotMatch(csv, new RegExp(TEACHER_ID));
    assert.equal(csv.trim().split('\n').length, 2);
    assert.deepEqual(pool.deltaQueries[1].params, [
      SCHOOL_A_ID,
      MODULE_KEY,
      CLASS_A_ID,
      '2026-08-01',
      '2026-08-31',
    ]);

    const summaryExportResponse = await fetch(
      context.origin + '/api/institution/schools/' + SCHOOL_A_ID
        + '/export.csv' + filterQuery + '&scope=summary',
      { headers: { 'x-test-user': TEACHER_ID } }
    );
    const summaryCsv = await summaryExportResponse.text();
    assert.equal(summaryExportResponse.status, 200);
    assert.match(summaryCsv, /entrepreneurship,pre,1,1,0/);
    assert.match(summaryCsv, /entrepreneurship,post,1,1,100/);
    assert.equal(summaryCsv.trim().split('\n').length, 3);

    const classReport = await jsonRequest(
      context.origin,
      '/api/institution/schools/' + SCHOOL_A_ID + '/classes/' + CLASS_A_ID
        + '/pre-post-deltas?module_key=' + MODULE_KEY
        + '&from=2026-08-01&to=2026-08-31',
      TEACHER_ID
    );
    assert.equal(classReport.response.status, 200);
    assert.equal(classReport.data.class_id, CLASS_A_ID);
    assert.deepEqual(pool.deltaQueries[2].params, [
      CLASS_A_ID,
      MODULE_KEY,
      '2026-08-01',
      '2026-08-31',
    ]);

    const crossTenant = await jsonRequest(
      context.origin,
      '/api/institution/schools/' + SCHOOL_B_ID + '/pre-post-deltas' + filterQuery,
      TEACHER_ID
    );
    assert.equal(crossTenant.response.status, 403);
    assert.equal(crossTenant.data.code, 'NOT_EDUCATOR');
  });
});
