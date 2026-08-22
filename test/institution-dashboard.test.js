'use strict';

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
  InstitutionApiError,
  createInstitutionApi,
  exportForContext,
  summarizeModules,
} = require('../public/institution/institution.js');

let server;
let origin;

before(async () => {
  process.env.VERCEL = '1';
  const app = require('../server');
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

test('serves the institution dashboard at both canonical entry routes', async () => {
  for (const route of ['/institution', '/institution/']) {
    const response = await fetch(`${origin}${route}`, { redirect: 'manual' });
    assert.equal(response.status, 200, `${route} should be directly available`);
    assert.match(response.headers.get('content-type') || '', /^text\/html/);
  }
});

test('dashboard response exposes the accessible evidence-review landmarks', async () => {
  const response = await fetch(`${origin}/institution/`);
  const html = await response.text();

  assert.match(html, /\bdata-edu-shell(?:\s|=|>)/i);
  assert.match(html, /<main\b/i);
  assert.match(html, /<form\b[^>]*aria-label=/i);
  assert.match(html, /<label\b[^>]*for="school-filter"/i);
  assert.match(html, /<select\b[^>]*id="school-filter"/i);
  assert.match(html, /<label\b[^>]*for="class-filter"/i);
  assert.match(html, /<select\b[^>]*id="class-filter"/i);
  assert.match(html, /aria-live="polite"/i);
  assert.match(html, /<section\b[^>]*aria-labelledby="impact-trail-title"/i);
  assert.match(html, /<button\b[^>]*id="export-evidence"/i);
  assert.match(html, /<table\b/i);
  assert.match(html, /<caption\b/i);
  assert.match(html, /<link\b[^>]*href="\/institution\/institution\.css"/i);
  assert.match(html, /<script\b[^>]*src="\/edu\/js\/edu-auth\.js"/i);
  assert.match(html, /<script\b[^>]*src="\/edu\/js\/edu-shell\.js"/i);
  assert.match(html, /<script\b[^>]*src="\/institution\/institution\.js"/i);
});

test('serves the institution stylesheet and dashboard script', async () => {
  const [css, js] = await Promise.all([
    fetch(`${origin}/institution/institution.css`),
    fetch(`${origin}/institution/institution.js`),
  ]);

  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type') || '', /^text\/css/);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type') || '', /javascript/);
});

test('shared educator navigation links teachers to institution evidence', () => {
  const shell = require('../public/edu/js/edu-shell.js');
  const evidence = shell.itemsForRole('teacher').find((item) => item.label === 'Výsledky INVOK');

  assert.deepEqual(evidence, {
    href: '/institution/',
    label: 'Výsledky INVOK',
    group: 'primary',
  });
});

test('institution API helper maps all seven reporting endpoints and keeps their schemas intact', async () => {
  const schoolId = '550e8400-e29b-41d4-a716-446655440000';
  const classId = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
  const fixtures = [
    { schools: [{ id: schoolId, name: 'Škola <Sever>', type: 'primary', role: 'teacher', created_at: '2026-01-01T00:00:00Z', stats: { classes_count: 2, members_count: 48, submitted_attempts_count: 30 } }] },
    { school: { id: schoolId, name: 'Škola <Sever>', type: 'primary', user_role: 'teacher', stats: { classes_count: 2, members_count: 48, assessments_count: 8, submitted_attempts_count: 30, avg_percent_score: 71.5 } } },
    { classes: [{ id: classId, name: '8.A & hostia', grade_level: 8, school_year: '2026/27', students_count: 24, submitted_attempts_count: 16, avg_percent_score: 73 } ] },
    { summary: { school_id: schoolId, attempts_count: 30, students_count: 18, avg_percent_score: 71.5, modules: [{ module_key: 'entrepreneurship', attempts_count: 8, students_count: 6, avg_percent_score: 74 }] } },
    { deltas: [{ user_id: 'u1', class_id: classId, module_key: 'entrepreneurship', pre_percent: 44, post_percent: 76, delta_percent_points: 32, pre_submitted_at: '2026-01-01T10:00:00Z', post_submitted_at: '2026-02-01T10:00:00Z' }], summary: { students_with_pairs: 1, avg_pre_percent: 44, avg_post_percent: 76, avg_delta_percent_points: 32 } },
    { class_id: classId, deltas: [{ user_id: 'u1', class_id: classId, module_key: 'entrepreneurship', pre_percent: 44, post_percent: 76, delta_percent_points: 32, pre_submitted_at: '2026-01-01T10:00:00Z', post_submitted_at: '2026-02-01T10:00:00Z' }], summary: { students_with_pairs: 1, avg_pre_percent: 44, avg_post_percent: 76, avg_delta_percent_points: 32 } },
  ];
  const calls = [];
  const api = createInstitutionApi({
    getAccessToken: async () => 'session-token',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify(fixtures[calls.length - 1]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  assert.deepEqual(await api.listSchools(), fixtures[0]);
  assert.deepEqual(await api.getSchool(schoolId), fixtures[1]);
  assert.deepEqual(await api.listClasses(schoolId), fixtures[2]);
  assert.deepEqual(await api.getAssessmentSummary(schoolId, { class_id: classId }), fixtures[3]);
  assert.deepEqual(await api.getSchoolDeltas(schoolId, { module_key: 'entrepreneurship' }), fixtures[4]);
  assert.deepEqual(await api.getClassDeltas(schoolId, classId, { from: '2026-01-01' }), fixtures[5]);

  assert.deepEqual(calls.map((call) => call.url), [
    '/api/institution/me/schools',
    `/api/institution/schools/${schoolId}`,
    `/api/institution/schools/${schoolId}/classes`,
    `/api/institution/schools/${schoolId}/assessment-summary?class_id=${classId}`,
    `/api/institution/schools/${schoolId}/pre-post-deltas?module_key=entrepreneurship`,
    `/api/institution/schools/${schoolId}/classes/${classId}/pre-post-deltas?from=2026-01-01`,
  ]);
  assert.ok(calls.every((call) => call.options.headers.Authorization === 'Bearer session-token'));
});

test('institution API helper returns authenticated CSV evidence with server filename', async () => {
  const schoolId = '550e8400-e29b-41d4-a716-446655440000';
  const classId = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
  let request;
  const api = createInstitutionApi({
    getAccessToken: async () => 'session-token',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response('module_key,attempts_count\nentrepreneurship,8', {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="invok-report-550e8400.csv"',
        },
      });
    },
  });

  const exportFile = await api.exportCsv(schoolId, { class_id: classId, scope: 'summary' });

  assert.equal(request.url, `/api/institution/schools/${schoolId}/export.csv?class_id=${classId}&scope=summary`);
  assert.equal(request.options.headers.Accept, 'text/csv');
  assert.equal(exportFile.filename, 'invok-report-550e8400.csv');
  assert.equal(await exportFile.blob.text(), 'module_key,attempts_count\nentrepreneurship,8');
});

test('institution API helper preserves educator access denial for a clear UI state', async () => {
  const api = createInstitutionApi({
    getAccessToken: async () => 'student-token',
    fetchImpl: async () => new Response(JSON.stringify({
      error: 'Only teachers/admins can view school summary',
      code: 'NOT_EDUCATOR',
    }), { status: 403, headers: { 'Content-Type': 'application/json' } }),
  });

  await assert.rejects(
    api.getAssessmentSummary('550e8400-e29b-41d4-a716-446655440000'),
    (error) => error instanceof InstitutionApiError
      && error.status === 403
      && error.code === 'NOT_EDUCATOR'
      && error.message === 'Only teachers/admins can view school summary'
  );
});

test('institution API helper stops before fetch when the Supabase session is missing', async () => {
  let fetched = false;
  const api = createInstitutionApi({
    getAccessToken: async () => null,
    fetchImpl: async () => { fetched = true; },
  });

  await assert.rejects(
    api.listSchools(),
    (error) => error instanceof InstitutionApiError
      && error.status === 401
      && error.code === 'AUTH_REQUIRED'
  );
  assert.equal(fetched, false);
});

test('Impact Trail derives one rounded presentation summary per module in canonical order', () => {
  const rows = [
    { module_key: 'critical_media_thinking', pre_percent: 52.125, post_percent: 68.555 },
    { module_key: 'entrepreneurship', pre_percent: 40, post_percent: 75 },
    { module_key: 'critical_media_thinking', pre_percent: 60.125, post_percent: 64.555 },
    { module_key: 'presentation_communication', pre_percent: 80, post_percent: 70 },
  ];

  assert.deepEqual(summarizeModules(rows), [
    { module_key: 'entrepreneurship', pairs: 1, avg_pre_percent: 40, avg_post_percent: 75, avg_delta_percent_points: 35 },
    { module_key: 'critical_media_thinking', pairs: 2, avg_pre_percent: 56.13, avg_post_percent: 66.56, avg_delta_percent_points: 10.43 },
    { module_key: 'presentation_communication', pairs: 1, avg_pre_percent: 80, avg_post_percent: 70, avg_delta_percent_points: -10 },
  ]);
  assert.deepEqual(summarizeModules([]), []);
});

test('browser scripts expose EduAuth on window and boot the dashboard with its Supabase session', async () => {
  let onReady;
  const elements = new Map();
  const element = () => ({
    disabled: false,
    hidden: false,
    textContent: '',
    value: '',
    addEventListener() {},
    append() {},
    replaceChildren() {},
    setAttribute() {},
  });
  const document = {
    readyState: 'loading',
    body: element(),
    addEventListener(type, handler) {
      if (type === 'DOMContentLoaded') onReady = handler;
    },
    createElement: element,
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
  };
  const requests = [];
  const windowObject = {
    document,
    location: { href: '' },
    supabase: {
      createClient: () => ({
        auth: {
          getSession: async () => ({ data: { session: { access_token: 'browser-session-token' } } }),
          signOut: async () => {},
        },
      }),
    },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ schools: [] }),
      };
    },
  };
  windowObject.window = windowObject;
  const context = vm.createContext({
    URLSearchParams,
    console,
    fetch: windowObject.fetch,
    sessionStorage: { removeItem() {} },
    window: windowObject,
  });
  const authSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'edu', 'js', 'edu-auth.js'), 'utf8');
  const dashboardSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'institution', 'institution.js'), 'utf8');

  vm.runInContext(authSource, context, { filename: 'edu-auth.js' });
  assert.equal(typeof windowObject.EduAuth?.getAccessToken, 'function');
  vm.runInContext(dashboardSource, context, { filename: 'institution.js' });
  assert.equal(typeof onReady, 'function');

  onReady();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/institution/me/schools');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer browser-session-token');
  assert.equal(elements.get('status').textContent, 'Nenašla sa žiadna priradená škola.');
});

test('an export success from an obsolete school/class context is discarded', async () => {
  let resolveExport;
  let current = { version: 7, schoolId: 'school-a', classId: 'class-a' };
  const pending = exportForContext({
    api: { exportCsv: () => new Promise((resolve) => { resolveExport = resolve; }) },
    context: { ...current },
    getCurrentContext: () => current,
  });

  current = { version: 8, schoolId: 'school-b', classId: '' };
  resolveExport({ filename: 'stale.csv', blob: new Blob(['stale']) });

  assert.deepEqual(await pending, { status: 'stale' });
});

test('an export failure from an obsolete school/class context cannot replace the current report', async () => {
  let rejectExport;
  let current = { version: 11, schoolId: 'school-a', classId: '' };
  const pending = exportForContext({
    api: { exportCsv: () => new Promise((_resolve, reject) => { rejectExport = reject; }) },
    context: { ...current },
    getCurrentContext: () => current,
  });

  current = { version: 12, schoolId: 'school-a', classId: 'class-b' };
  rejectExport(new InstitutionApiError('old failure', { status: 500, code: 'EXPORT_ERROR' }));

  assert.deepEqual(await pending, { status: 'stale' });
});

test('an export from the current context returns the matching file', async () => {
  const context = { version: 14, schoolId: 'school-current', classId: 'class-current' };
  const file = { filename: 'current.csv', blob: new Blob(['current']) };
  let requested;
  const result = await exportForContext({
    api: {
      exportCsv: async (schoolId, filters) => {
        requested = { schoolId, filters };
        return file;
      },
    },
    context,
    getCurrentContext: () => ({ ...context }),
  });

  assert.deepEqual(requested, {
    schoolId: 'school-current',
    filters: { scope: 'summary', class_id: 'class-current' },
  });
  assert.deepEqual(result, { status: 'ready', file });
});

test('contrast-critical violet tokens meet WCAG AA in their actual text usages', async () => {
  const response = await fetch(`${origin}/institution/institution.css`);
  const css = await response.text();
  const token = (name) => {
    const match = css.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'));
    assert.ok(match, `missing --${name}`);
    return match[1];
  };
  const luminance = (hex) => {
    const channels = hex.slice(1).match(/.{2}/g).map((pair) => parseInt(pair, 16) / 255);
    const linear = channels.map((channel) => channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4);
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };
  const contrast = (foreground, background) => {
    const lighter = Math.max(luminance(foreground), luminance(background));
    const darker = Math.min(luminance(foreground), luminance(background));
    return (lighter + 0.05) / (darker + 0.05);
  };

  assert.ok(contrast(token('signal-text'), token('archive')) >= 4.5);
  assert.ok(contrast('#ffffff', token('signal-action')) >= 4.5);
  assert.match(css, /\.edu-sidebar-brand \.brand-badge\s*\{[^}]*color:\s*var\(--signal-text\)/i);
  assert.match(css, /\.eyebrow\s*\{[^}]*color:\s*var\(--signal-text\)/i);
  assert.match(css, /\nbutton\s*\{[^}]*background:\s*var\(--signal-action\)[^}]*color:\s*#fff/i);
});
