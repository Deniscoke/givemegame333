/**
 * test/edu/routes.integration.test.js
 * Integration tests for EDU API routes — Sprint 1.6
 *
 * Tests auth gating, role enforcement, input validation, rate limiting,
 * and SQL tenant-scoping. Uses injected mock dependencies — no real
 * Supabase or database connection required.
 *
 * Run: node --test test/edu/routes.integration.test.js
 */

'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { createEduRouter, _testHelpers } = require('../../lib/edu-routes');

// ─────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────
const SCHOOL_ID  = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_ID    = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const USER_ID2   = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const CLASS_ID   = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const SUBJECT_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const MEMBER_ID  = '11111111-1111-1111-1111-111111111111';
const ITEM_ID    = '22222222-2222-2222-2222-222222222222';

// ─────────────────────────────────────────────────────────────
// Mock factories
// ─────────────────────────────────────────────────────────────

/**
 * Mock requireSupabaseUser — matches actual API: async fn(req, res) → user | null.
 * When user is null, sends 401 and returns null. Otherwise returns the user object.
 */
function makeAuth(user = { id: USER_ID, email: 'test@skola.sk' }) {
  return async (req, res) => {
    if (!user) {
      res.status(401).json({ error: 'Not authenticated' });
      return null;
    }
    return user;
  };
}

/**
 * Mock transaction client for pool.connect() paths.
 * Captures query calls; BEGIN/COMMIT/ROLLBACK always succeed.
 */
function makeMockClient(queryCapture) {
  return {
    query: async (sql, params) => {
      queryCapture.push({ sql: sql || '', params: params || [] });
      if (sql && sql.includes('edu_audit_log')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
}

/**
 * Creates a mock pg.Pool.
 * - `role`: controls what getUserSchool returns (null = no membership → 403)
 * - `queryCapture`: array that receives every { sql, params } call
 */
function makePool({ role = 'admin', queryCapture = [] } = {}) {
  return {
    // Standard query interface
    query: async (sql, params) => {
      queryCapture.push({ sql: sql || '', params: params || [] });

      // getUserSchool — memberships + schools join (SELECT, not INSERT)
      if (
        sql.includes('edu_school_memberships') &&
        sql.includes('edu_schools') &&
        !sql.toUpperCase().trimStart().startsWith('INSERT')
      ) {
        if (!role) return { rows: [], rowCount: 0 };
        return {
          rows: [{ school_id: SCHOOL_ID, role, school_name: 'Test Skola' }],
          rowCount: 1,
        };
      }

      // Teacher's class list (teaching_assignments + classes join)
      if (sql.includes('edu_teaching_assignments') && sql.includes('edu_classes')) {
        return {
          rows: [{ id: CLASS_ID, name: 'Trieda 1A', school_year: '2024/2025', grade_level: 1, student_count: 0 }],
          rowCount: 1,
        };
      }

      // classOwnedBySchool — SELECT 1 FROM edu_classes WHERE id=$1 AND school_id=$2
      // Return a positive match when params are our test CLASS_ID + SCHOOL_ID fixtures.
      if (
        sql.includes('edu_classes') &&
        sql.includes('archived_at IS NULL') &&
        !sql.includes('edu_teaching_assignments') &&
        !sql.includes('edu_class_enrollments') &&
        !sql.toUpperCase().trimStart().startsWith('INSERT')
      ) {
        const hasClassId  = params && params.includes(CLASS_ID);
        const hasSchoolId = params && params.includes(SCHOOL_ID);
        if (hasClassId && hasSchoolId) return { rows: [{ '?column?': 1 }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }

      // edu_school_memberships INSERT (POST /members) — return a fake inserted row
      if (sql.includes('edu_school_memberships') && sql.toUpperCase().trimStart().startsWith('INSERT')) {
        return {
          rows: [{ id: MEMBER_ID, school_id: SCHOOL_ID, user_id: (params && params[1]) || USER_ID2, role: (params && params[2]) || 'student' }],
          rowCount: 1,
        };
      }

      // Audit log — always silent
      if (sql.includes('edu_audit_log')) return { rows: [], rowCount: 0 };

      // Default: empty result (causes 404 in routes that expect a record)
      return { rows: [], rowCount: 0 };
    },

    // Transaction client (used by POST /schools, POST /gradebook/entries, POST /attendance)
    connect: async () => makeMockClient(queryCapture),
  };
}

/**
 * Boots a temporary Express server with the EDU router mounted.
 * Returns { baseUrl, close }.
 */
async function buildServer({ auth, pool } = {}) {
  const app = express();
  app.use(express.json());
  const router = createEduRouter({
    pool: pool || makePool(),
    requireSupabaseUser: auth || makeAuth(),
  });
  app.use('/api/edu', router);

  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}/api/edu`,
        close: () => new Promise((res) => server.close(res)),
      });
    });
  });
}

/** Helper: fetch JSON from the test server. */
async function req(baseUrl, path, opts = {}) {
  const res = await fetch(baseUrl + path, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  let body;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

// ═══════════════════════════════════════════════════════════════════
// AUTH GATE — every endpoint must return 401 without a valid token
// ═══════════════════════════════════════════════════════════════════
describe('Auth gate — 401 without token', () => {
  let ctx;

  before(async () => {
    ctx = await buildServer({ auth: makeAuth(null) });
  });

  after(() => ctx.close());

  const protectedRoutes = [
    ['GET',    '/me'],
    ['GET',    '/classes'],
    ['POST',   '/classes'],
    ['GET',    '/members'],
    ['POST',   '/members'],
    ['GET',    '/subjects'],
    ['GET',    '/gradebook'],
    ['POST',   '/gradebook/items'],
    ['POST',   '/gradebook/entries'],
    ['GET',    '/attendance'],
    ['POST',   '/attendance'],
  ];

  for (const [method, path] of protectedRoutes) {
    it(`${method} ${path} → 401`, async () => {
      const { status } = await req(ctx.baseUrl, path, { method });
      assert.strictEqual(status, 401);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════
// ROLE ENFORCEMENT
// ═══════════════════════════════════════════════════════════════════
describe('Role enforcement', () => {
  describe('Student role — write endpoints blocked', () => {
    let ctx;

    before(async () => {
      ctx = await buildServer({ pool: makePool({ role: 'student' }) });
    });

    after(() => ctx.close());

    it('GET /members → 403', async () => {
      const { status } = await req(ctx.baseUrl, '/members', { method: 'GET' });
      assert.strictEqual(status, 403);
    });

    it('POST /members → 403', async () => {
      const { status } = await req(ctx.baseUrl, '/members', {
        method: 'POST',
        body: JSON.stringify({ user_id: USER_ID2, role: 'student' }),
      });
      assert.strictEqual(status, 403);
    });

    it('PATCH /members/:id → 403', async () => {
      const { status } = await req(ctx.baseUrl, `/members/${MEMBER_ID}`, {
        method: 'PATCH',
        body: JSON.stringify({ role: 'teacher' }),
      });
      assert.strictEqual(status, 403);
    });

    it('DELETE /members/:id → 403', async () => {
      const { status } = await req(ctx.baseUrl, `/members/${MEMBER_ID}`, { method: 'DELETE' });
      assert.strictEqual(status, 403);
    });

    it('POST /classes → 403', async () => {
      const { status } = await req(ctx.baseUrl, '/classes', {
        method: 'POST',
        body: JSON.stringify({ name: 'Trieda', school_year: '2024/2025' }),
      });
      assert.strictEqual(status, 403);
    });

    it('POST /gradebook/items → 403', async () => {
      const { status } = await req(ctx.baseUrl, '/gradebook/items', {
        method: 'POST',
        body: JSON.stringify({ class_id: CLASS_ID, subject_id: SUBJECT_ID, title: 'Test' }),
      });
      assert.strictEqual(status, 403);
    });

    it('POST /attendance → 403', async () => {
      const { status } = await req(ctx.baseUrl, '/attendance', {
        method: 'POST',
        body: JSON.stringify({ class_id: CLASS_ID, date: '2024-09-01', records: [] }),
      });
      assert.strictEqual(status, 403);
    });

    it('POST /gradebook/entries → 403', async () => {
      const { status } = await req(ctx.baseUrl, '/gradebook/entries', {
        method: 'POST',
        body: JSON.stringify({ entries: [{ grade_item_id: ITEM_ID, student_id: USER_ID2, value: '5' }] }),
      });
      assert.strictEqual(status, 403);
    });
  });

  describe('Teacher role — admin-only endpoints blocked', () => {
    let ctx;

    before(async () => {
      ctx = await buildServer({ pool: makePool({ role: 'teacher' }) });
    });

    after(() => ctx.close());

    it('POST /members → 403', async () => {
      const { status } = await req(ctx.baseUrl, '/members', {
        method: 'POST',
        body: JSON.stringify({ user_id: USER_ID2, role: 'student' }),
      });
      assert.strictEqual(status, 403);
    });

    it('DELETE /members/:id → 403', async () => {
      const { status } = await req(ctx.baseUrl, `/members/${MEMBER_ID}`, { method: 'DELETE' });
      assert.strictEqual(status, 403);
    });

    it('POST /classes → 403', async () => {
      const { status } = await req(ctx.baseUrl, '/classes', {
        method: 'POST',
        body: JSON.stringify({ name: 'Trieda', school_year: '2024/2025' }),
      });
      assert.strictEqual(status, 403);
    });
  });

  describe('No school membership → 403', () => {
    let ctx;

    before(async () => {
      ctx = await buildServer({ pool: makePool({ role: null }) });
    });

    after(() => ctx.close());

    // GET /classes intentionally returns 200 + empty array (not 403) when the user
    // has no school membership. This is the designed graceful-degradation path.
    // GET /members returns 403 — that route is the authoritative 403-for-no-school test.
    it('GET /classes → 200 with empty list when user has no school', async () => {
      const { status, body } = await req(ctx.baseUrl, '/classes', { method: 'GET' });
      assert.strictEqual(status, 200);
      assert.deepStrictEqual(body.classes, []);
    });

    it('GET /members → 403 when user has no school', async () => {
      const { status } = await req(ctx.baseUrl, '/members', { method: 'GET' });
      assert.strictEqual(status, 403);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// INPUT VALIDATION — admin role, malformed inputs → 400
// ═══════════════════════════════════════════════════════════════════
describe('Input validation', () => {
  let ctx;

  before(async () => {
    ctx = await buildServer({ pool: makePool({ role: 'admin' }) });
  });

  after(() => ctx.close());

  describe('POST /members — bad inputs', () => {
    it('missing user_id → 400', async () => {
      const { status } = await req(ctx.baseUrl, '/members', {
        method: 'POST',
        body: JSON.stringify({ role: 'student' }),
      });
      assert.strictEqual(status, 400);
    });

    it('invalid user_id (not a UUID) → 400', async () => {
      const { status } = await req(ctx.baseUrl, '/members', {
        method: 'POST',
        body: JSON.stringify({ user_id: 'not-a-uuid', role: 'student' }),
      });
      assert.strictEqual(status, 400);
    });

    it('role = parent (Sprint 2 deferred) → 400', async () => {
      const { status, body } = await req(ctx.baseUrl, '/members', {
        method: 'POST',
        body: JSON.stringify({ user_id: USER_ID2, role: 'parent' }),
      });
      assert.strictEqual(status, 400);
      assert.ok(body?.error, 'error message should be present');
    });

    it('role = superadmin (unknown) → 400', async () => {
      const { status } = await req(ctx.baseUrl, '/members', {
        method: 'POST',
        body: JSON.stringify({ user_id: USER_ID2, role: 'superadmin' }),
      });
      assert.strictEqual(status, 400);
    });

    it('SQL injection in user_id → 400', async () => {
      const { status } = await req(ctx.baseUrl, '/members', {
        method: 'POST',
        body: JSON.stringify({ user_id: "' OR 1=1 --", role: 'student' }),
      });
      assert.strictEqual(status, 400);
    });

    it('extra unknown fields are ignored — does not crash (must not 500)', async () => {
      // Keep payload well under body-parser limit (100kb default); route ignores unknown fields
      const { status } = await req(ctx.baseUrl, '/members', {
        method: 'POST',
        body: JSON.stringify({ user_id: USER_ID2, role: 'student', junk: 'x'.repeat(1_000) }),
      });
      assert.notStrictEqual(status, 500);
    });
  });

  describe('PATCH /members/:id — bad inputs', () => {
    it('malformed member id in path → 400', async () => {
      const { status } = await req(ctx.baseUrl, '/members/not-a-uuid', {
        method: 'PATCH',
        body: JSON.stringify({ role: 'teacher' }),
      });
      assert.strictEqual(status, 400);
    });

    it('invalid role → 400', async () => {
      const { status } = await req(ctx.baseUrl, `/members/${MEMBER_ID}`, {
        method: 'PATCH',
        body: JSON.stringify({ role: 'superadmin' }),
      });
      assert.strictEqual(status, 400);
    });

    it('role = parent → 400', async () => {
      const { status } = await req(ctx.baseUrl, `/members/${MEMBER_ID}`, {
        method: 'PATCH',
        body: JSON.stringify({ role: 'parent' }),
      });
      assert.strictEqual(status, 400);
    });
  });

  describe('DELETE /members/:id — bad inputs', () => {
    it('malformed member id in path → 400', async () => {
      const { status } = await req(ctx.baseUrl, '/members/not-a-uuid', { method: 'DELETE' });
      assert.strictEqual(status, 400);
    });
  });

  describe('POST /classes — bad inputs', () => {
    it('missing name → 400', async () => {
      const { status } = await req(ctx.baseUrl, '/classes', {
        method: 'POST',
        body: JSON.stringify({ school_year: '2024/2025' }),
      });
      assert.strictEqual(status, 400);
    });

    it('invalid school_year format (dash separator) → 400', async () => {
      const { status } = await req(ctx.baseUrl, '/classes', {
        method: 'POST',
        body: JSON.stringify({ name: 'Trieda 1A', school_year: '2024-2025' }),
      });
      assert.strictEqual(status, 400);
    });

    it('SQL injection in school_year → 400', async () => {
      const { status } = await req(ctx.baseUrl, '/classes', {
        method: 'POST',
        body: JSON.stringify({ name: 'X', school_year: "2024/2025' OR '1'='1" }),
      });
      assert.strictEqual(status, 400);
    });
  });

  describe('POST /gradebook/entries — bad inputs', () => {
    it('missing entries → 400', async () => {
      const { status } = await req(ctx.baseUrl, '/gradebook/entries', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      assert.strictEqual(status, 400);
    });

    it('entries not an array → 400', async () => {
      const { status } = await req(ctx.baseUrl, '/gradebook/entries', {
        method: 'POST',
        body: JSON.stringify({ entries: 'not-an-array' }),
      });
      assert.strictEqual(status, 400);
    });

    it('invalid grade_item_id UUID in entries → 400', async () => {
      const { status } = await req(ctx.baseUrl, '/gradebook/entries', {
        method: 'POST',
        body: JSON.stringify({
          entries: [{ grade_item_id: 'bad-id', student_id: USER_ID, value: '5' }],
        }),
      });
      assert.strictEqual(status, 400);
    });

    it('entries array over route limit (151 items) → 400', async () => {
      // Route enforces max 150 entries per request (line ~769 in edu-routes.js).
      // Use 151 entries — well under body-parser 100kb limit, exercises route validation.
      const entries = Array.from({ length: 151 }, () => ({
        grade_item_id: ITEM_ID,
        student_id: USER_ID2,
        value: '5',
      }));
      const { status } = await req(ctx.baseUrl, '/gradebook/entries', {
        method: 'POST',
        body: JSON.stringify({ entries }),
      });
      assert.strictEqual(status, 400);
    });
  });

  describe('POST /attendance — bad inputs', () => {
    it('invalid date format → 400', async () => {
      const { status } = await req(ctx.baseUrl, '/attendance', {
        method: 'POST',
        body: JSON.stringify({ class_id: CLASS_ID, date: '01-09-2024', records: [] }),
      });
      assert.strictEqual(status, 400);
    });

    it('invalid class_id UUID → 400', async () => {
      const { status } = await req(ctx.baseUrl, '/attendance', {
        method: 'POST',
        body: JSON.stringify({ class_id: 'bad-id', date: '2024-09-01', records: [] }),
      });
      assert.strictEqual(status, 400);
    });

    it('invalid attendance status enum → 400', async () => {
      const { status } = await req(ctx.baseUrl, '/attendance', {
        method: 'POST',
        body: JSON.stringify({
          class_id: CLASS_ID,
          date: '2024-09-01',
          records: [{ student_id: USER_ID2, status: 'skipped' }],
        }),
      });
      assert.strictEqual(status, 400);
    });

    it('must not 500 on any input', async () => {
      const { status } = await req(ctx.baseUrl, '/attendance', {
        method: 'POST',
        body: JSON.stringify({ class_id: 'evil', date: 'evil', records: 'evil' }),
      });
      assert.notStrictEqual(status, 500);
    });
  });

  describe('GET /gradebook — bad query params', () => {
    it('missing class_id → 400', async () => {
      const { status } = await req(ctx.baseUrl, '/gradebook', { method: 'GET' });
      assert.strictEqual(status, 400);
    });

    it('invalid class_id UUID → 400', async () => {
      const { status } = await req(ctx.baseUrl, '/gradebook?class_id=not-a-uuid', { method: 'GET' });
      assert.strictEqual(status, 400);
    });

    it('invalid subject_id UUID → 400', async () => {
      const { status } = await req(ctx.baseUrl, `/gradebook?class_id=${CLASS_ID}&subject_id=bad`, { method: 'GET' });
      assert.strictEqual(status, 400);
    });
  });

  describe('GET /users/by-email — bad inputs', () => {
    it('missing email param → 400', async () => {
      const { status } = await req(ctx.baseUrl, '/users/by-email', { method: 'GET' });
      assert.strictEqual(status, 400);
    });

    it('teacher cannot access (admin only) → 403', async () => {
      const teacherCtx = await buildServer({ pool: makePool({ role: 'teacher' }) });
      try {
        const { status } = await req(teacherCtx.baseUrl, '/users/by-email?email=x@x.sk', { method: 'GET' });
        assert.strictEqual(status, 403);
      } finally {
        await teacherCtx.close();
      }
    });

    it('student cannot access → 403', async () => {
      const studentCtx = await buildServer({ pool: makePool({ role: 'student' }) });
      try {
        const { status } = await req(studentCtx.baseUrl, '/users/by-email?email=x@x.sk', { method: 'GET' });
        assert.strictEqual(status, 403);
      } finally {
        await studentCtx.close();
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// RATE LIMITING — 429 when bucket is pre-filled to the limit
// Rate limit keys: `<prefix>:${user.id}` — see lib/edu-routes.js
// ═══════════════════════════════════════════════════════════════════
describe('Rate limiting', () => {
  let ctx;

  before(async () => {
    ctx = await buildServer({ pool: makePool({ role: 'admin' }) });
  });

  after(() => ctx.close());

  beforeEach(() => {
    _testHelpers.resetRateBuckets();
  });

  it('POST /members → 429 (members:add limit = 20/15min)', async () => {
    _testHelpers.simulateRateLimit(`members:add:${USER_ID}`, 20, 15 * 60 * 1000);
    const { status } = await req(ctx.baseUrl, '/members', {
      method: 'POST',
      body: JSON.stringify({ user_id: USER_ID2, role: 'student' }),
    });
    assert.strictEqual(status, 429);
  });

  it('PATCH /members/:id → 429 (members:patch limit = 30/15min)', async () => {
    _testHelpers.simulateRateLimit(`members:patch:${USER_ID}`, 30, 15 * 60 * 1000);
    const { status } = await req(ctx.baseUrl, `/members/${MEMBER_ID}`, {
      method: 'PATCH',
      body: JSON.stringify({ role: 'teacher' }),
    });
    assert.strictEqual(status, 429);
  });

  it('DELETE /members/:id → 429 (members:delete limit = 20/15min)', async () => {
    _testHelpers.simulateRateLimit(`members:delete:${USER_ID}`, 20, 15 * 60 * 1000);
    const { status } = await req(ctx.baseUrl, `/members/${MEMBER_ID}`, { method: 'DELETE' });
    assert.strictEqual(status, 429);
  });

  it('POST /gradebook/entries → 429 (gb:entries limit = 200/5min)', async () => {
    _testHelpers.simulateRateLimit(`gb:entries:${USER_ID}`, 200, 5 * 60 * 1000);
    const { status } = await req(ctx.baseUrl, '/gradebook/entries', {
      method: 'POST',
      body: JSON.stringify({
        entries: [{ grade_item_id: ITEM_ID, student_id: USER_ID2, value: '5' }],
      }),
    });
    assert.strictEqual(status, 429);
  });

  it('POST /attendance → 429 (attendance limit = 100/10min)', async () => {
    _testHelpers.simulateRateLimit(`attendance:${USER_ID}`, 100, 10 * 60 * 1000);
    const { status } = await req(ctx.baseUrl, '/attendance', {
      method: 'POST',
      body: JSON.stringify({ class_id: CLASS_ID, date: '2024-09-01', records: [] }),
    });
    assert.strictEqual(status, 429);
  });

  it('GET /users/by-email → 429 (email:lookup limit = 30/10min)', async () => {
    _testHelpers.simulateRateLimit(`email:lookup:${USER_ID}`, 30, 10 * 60 * 1000);
    const { status } = await req(ctx.baseUrl, '/users/by-email?email=x@x.sk', { method: 'GET' });
    assert.strictEqual(status, 429);
  });

  it('POST /gradebook/items → 429 (gb:items limit = 60/10min)', async () => {
    _testHelpers.simulateRateLimit(`gb:items:${USER_ID}`, 60, 10 * 60 * 1000);
    const { status } = await req(ctx.baseUrl, '/gradebook/items', {
      method: 'POST',
      body: JSON.stringify({ class_id: CLASS_ID, subject_id: SUBJECT_ID, title: 'Test' }),
    });
    assert.strictEqual(status, 429);
  });

  it('rate limit independent per user — different user not blocked', async () => {
    // Fill the bucket for USER_ID
    _testHelpers.simulateRateLimit(`members:add:${USER_ID}`, 20, 15 * 60 * 1000);

    // A different user (USER_ID2) with their own bucket should NOT be blocked
    // Build a second server with USER_ID2 as the auth user
    const ctx2 = await buildServer({
      pool: makePool({ role: 'admin' }),
      auth: makeAuth({ id: USER_ID2, email: 'other@skola.sk' }),
    });
    try {
      const { status } = await req(ctx2.baseUrl, '/members', {
        method: 'POST',
        body: JSON.stringify({ user_id: USER_ID, role: 'student' }),
      });
      // Should NOT be 429 (may be 400 if validation fails, or 404/200 from DB, but not rate limited)
      assert.notStrictEqual(status, 429);
    } finally {
      await ctx2.close();
    }
  });

  it('rate limit resets after resetRateBuckets()', async () => {
    _testHelpers.simulateRateLimit(`attendance:${USER_ID}`, 100, 10 * 60 * 1000);
    _testHelpers.resetRateBuckets();
    const { status } = await req(ctx.baseUrl, '/attendance', {
      method: 'POST',
      body: JSON.stringify({ class_id: CLASS_ID, date: '2024-09-01', records: [] }),
    });
    // Not 429 after reset — may be 403/404 from DB mock but not rate-limited
    assert.notStrictEqual(status, 429);
  });
});

// ═══════════════════════════════════════════════════════════════════
// TENANT ISOLATION — school_id must appear in SQL query parameters
// Verifies that the Sprint 1.6 SQL refactors embed school_id directly
// in the main query (not just in a pre-check round-trip).
// ═══════════════════════════════════════════════════════════════════
describe('Tenant isolation — school_id in SQL', () => {
  it('GET /classes includes school_id as a query parameter', async () => {
    const queries = [];
    const ctx = await buildServer({ pool: makePool({ role: 'teacher', queryCapture: queries }) });
    try {
      await req(ctx.baseUrl, '/classes', { method: 'GET' });
    } finally {
      await ctx.close();
    }

    // At least one SELECT query on edu_classes must carry SCHOOL_ID as a param
    const classQuery = queries.find(q =>
      q.sql.includes('edu_classes') &&
      !q.sql.includes('edu_school_memberships') &&
      q.params.includes(SCHOOL_ID)
    );
    assert.ok(classQuery,
      `Expected a classes SELECT with school_id param. Queries: ${JSON.stringify(queries.map(q => ({ sql: q.sql.slice(0, 80), params: q.params })))}`
    );
  });

  it('GET /members includes school_id as a query parameter', async () => {
    const queries = [];
    const ctx = await buildServer({ pool: makePool({ role: 'admin', queryCapture: queries }) });
    try {
      await req(ctx.baseUrl, '/members', { method: 'GET' });
    } finally {
      await ctx.close();
    }

    const membersQuery = queries.find(q =>
      q.sql.includes('edu_school_memberships') &&
      q.sql.toUpperCase().trimStart().startsWith('SELECT') &&
      q.params.includes(SCHOOL_ID)
    );
    assert.ok(membersQuery,
      `Expected members SELECT with school_id param. Queries: ${JSON.stringify(queries.map(q => ({ sql: q.sql.slice(0, 80), params: q.params })))}`
    );
  });

  it('GET /gradebook includes school_id as a query parameter', async () => {
    const queries = [];
    const ctx = await buildServer({ pool: makePool({ role: 'admin', queryCapture: queries }) });
    try {
      await req(ctx.baseUrl, `/gradebook?class_id=${CLASS_ID}`, { method: 'GET' });
    } finally {
      await ctx.close();
    }

    const gradeQuery = queries.find(q =>
      q.sql.includes('edu_grade_items') &&
      q.params.includes(SCHOOL_ID)
    );
    assert.ok(gradeQuery,
      `Expected grade_items SELECT with school_id param. Queries: ${JSON.stringify(queries.map(q => ({ sql: q.sql.slice(0, 80), params: q.params })))}`
    );
  });

  it('GET /attendance includes school_id as a query parameter', async () => {
    const queries = [];
    const ctx = await buildServer({ pool: makePool({ role: 'admin', queryCapture: queries }) });
    try {
      await req(ctx.baseUrl, `/attendance?class_id=${CLASS_ID}&date=2024-09-01`, { method: 'GET' });
    } finally {
      await ctx.close();
    }

    const attQuery = queries.find(q =>
      q.sql.includes('edu_attendance') &&
      q.params.includes(SCHOOL_ID)
    );
    assert.ok(attQuery,
      `Expected attendance SELECT with school_id param. Queries: ${JSON.stringify(queries.map(q => ({ sql: q.sql.slice(0, 80), params: q.params })))}`
    );
  });
});
