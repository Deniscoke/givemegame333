/**
 * Unit tests for lib/institution.js — pure access-control + helpers.
 * Run: node --test test/institution.unit.test.js
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  EDUCATOR_ROLES,
  ALL_ROLES,
  isMember,
  isEducator,
  canViewSchool,
  canViewSchoolSummary,
  canViewClass,
  canExportInstitutionData,
  normalizeReportFilters,
  computeDeltaSummary,
  sanitizeDeltaForExport,
} = require('../lib/institution');

// ─── isMember / isEducator helpers ───────────────────────────────────
describe('isMember', () => {
  test('active membership → true', () => {
    assert.ok(isMember({ role: 'student', archived_at: null }));
    assert.ok(isMember({ role: 'teacher', archived_at: null }));
    assert.ok(isMember({ role: 'admin',   archived_at: null }));
  });

  test('archived membership → false', () => {
    assert.ok(!isMember({ role: 'teacher', archived_at: new Date() }));
  });

  test('null / undefined → false', () => {
    assert.ok(!isMember(null));
    assert.ok(!isMember(undefined));
  });

  test('EDUCATOR_ROLES is frozen and contains admin + teacher', () => {
    assert.throws(() => { EDUCATOR_ROLES.push('superuser'); });
    assert.deepStrictEqual([...EDUCATOR_ROLES], ['admin', 'teacher']);
  });

  test('ALL_ROLES is frozen and has 3 entries', () => {
    assert.throws(() => { ALL_ROLES.push('god'); });
    assert.strictEqual(ALL_ROLES.length, 3);
  });
});

describe('isEducator', () => {
  test('active admin → true', () => {
    assert.ok(isEducator({ role: 'admin', archived_at: null }));
  });

  test('active teacher → true', () => {
    assert.ok(isEducator({ role: 'teacher', archived_at: null }));
  });

  test('active student → false', () => {
    assert.ok(!isEducator({ role: 'student', archived_at: null }));
  });

  test('archived teacher → false', () => {
    assert.ok(!isEducator({ role: 'teacher', archived_at: new Date() }));
  });
});

// ─── canViewSchool ────────────────────────────────────────────────────
describe('canViewSchool', () => {
  test('any active member can view school', () => {
    assert.ok(canViewSchool({ role: 'student', archived_at: null }));
    assert.ok(canViewSchool({ role: 'teacher', archived_at: null }));
    assert.ok(canViewSchool({ role: 'admin',   archived_at: null }));
  });

  test('non-member (null) cannot view school', () => {
    assert.ok(!canViewSchool(null));
    assert.ok(!canViewSchool(undefined));
  });

  test('archived membership → cannot view', () => {
    assert.ok(!canViewSchool({ role: 'admin', archived_at: new Date() }));
  });
});

// ─── canViewSchoolSummary ─────────────────────────────────────────────
describe('canViewSchoolSummary', () => {
  test('admin can view summary', () => {
    assert.ok(canViewSchoolSummary({ role: 'admin', archived_at: null }));
  });

  test('teacher can view summary', () => {
    assert.ok(canViewSchoolSummary({ role: 'teacher', archived_at: null }));
  });

  test('student CANNOT view summary', () => {
    assert.ok(!canViewSchoolSummary({ role: 'student', archived_at: null }));
  });

  test('non-member CANNOT view summary', () => {
    assert.ok(!canViewSchoolSummary(null));
  });

  test('archived educator cannot view summary', () => {
    assert.ok(!canViewSchoolSummary({ role: 'teacher', archived_at: new Date() }));
  });
});

// ─── canViewClass ─────────────────────────────────────────────────────
describe('canViewClass', () => {
  const teacherM = { role: 'teacher', archived_at: null };
  const adminM   = { role: 'admin',   archived_at: null };
  const studentM = { role: 'student', archived_at: null };
  const activeEnroll   = { archived_at: null };
  const archivedEnroll = { archived_at: new Date() };

  test('teacher can view any class (no enrollment check needed)', () => {
    assert.ok(canViewClass(teacherM, null));
    assert.ok(canViewClass(teacherM, activeEnroll));
  });

  test('admin can view any class', () => {
    assert.ok(canViewClass(adminM, null));
  });

  test('student with active enrollment can view class', () => {
    assert.ok(canViewClass(studentM, activeEnroll));
  });

  test('student with archived enrollment CANNOT view class', () => {
    assert.ok(!canViewClass(studentM, archivedEnroll));
  });

  test('student with no enrollment CANNOT view class', () => {
    assert.ok(!canViewClass(studentM, null));
  });

  test('non-member with enrollment → still cannot view (membership check first)', () => {
    assert.ok(!canViewClass(null, activeEnroll));
  });
});

// ─── canExportInstitutionData ─────────────────────────────────────────
describe('canExportInstitutionData', () => {
  test('admin can export', () => {
    assert.ok(canExportInstitutionData({ role: 'admin', archived_at: null }));
  });

  test('teacher can export', () => {
    assert.ok(canExportInstitutionData({ role: 'teacher', archived_at: null }));
  });

  test('student CANNOT export', () => {
    assert.ok(!canExportInstitutionData({ role: 'student', archived_at: null }));
  });

  test('non-member CANNOT export', () => {
    assert.ok(!canExportInstitutionData(null));
  });
});

// ─── normalizeReportFilters ───────────────────────────────────────────
describe('normalizeReportFilters', () => {
  test('empty query → valid, no filters', () => {
    const r = normalizeReportFilters({});
    assert.ok(r.valid);
    assert.deepStrictEqual(r.filters, {});
  });

  test('valid module_key passes', () => {
    const r = normalizeReportFilters({ module_key: 'entrepreneurship' });
    assert.ok(r.valid);
    assert.strictEqual(r.filters.module_key, 'entrepreneurship');
  });

  test('invalid module_key rejected', () => {
    const r = normalizeReportFilters({ module_key: 'hacking' });
    assert.ok(!r.valid);
    assert.strictEqual(r.code, 'BAD_MODULE_KEY');
  });

  test('valid ISO date range passes', () => {
    const r = normalizeReportFilters({ from: '2025-01-01', to: '2025-12-31' });
    assert.ok(r.valid);
    assert.strictEqual(r.filters.from, '2025-01-01');
    assert.strictEqual(r.filters.to,   '2025-12-31');
  });

  test('invalid from date rejected', () => {
    const r = normalizeReportFilters({ from: '01-01-2025' });
    assert.ok(!r.valid);
    assert.strictEqual(r.code, 'BAD_DATE_FROM');
  });

  test('invalid to date rejected', () => {
    const r = normalizeReportFilters({ to: 'yesterday' });
    assert.ok(!r.valid);
    assert.strictEqual(r.code, 'BAD_DATE_TO');
  });

  test('reversed date range rejected', () => {
    const r = normalizeReportFilters({ from: '2025-12-01', to: '2025-01-01' });
    assert.ok(!r.valid);
    assert.strictEqual(r.code, 'DATE_RANGE_REVERSED');
  });

  test('invalid class_id rejected', () => {
    const r = normalizeReportFilters({ class_id: 'not-a-uuid' });
    assert.ok(!r.valid);
    assert.strictEqual(r.code, 'BAD_CLASS_ID');
  });

  test('valid class_id (UUID) passes', () => {
    const r = normalizeReportFilters({ class_id: '550e8400-e29b-41d4-a716-446655440000' });
    assert.ok(r.valid);
  });

  test('invalid scope rejected', () => {
    const r = normalizeReportFilters({ scope: 'everything' });
    assert.ok(!r.valid);
    assert.strictEqual(r.code, 'BAD_SCOPE');
  });

  test('valid scopes pass', () => {
    assert.ok(normalizeReportFilters({ scope: 'summary' }).valid);
    assert.ok(normalizeReportFilters({ scope: 'deltas' }).valid);
  });

  test('all valid filters together', () => {
    const r = normalizeReportFilters({
      module_key: 'critical_media_thinking',
      assessment_type: 'post',
      from: '2025-09-01',
      to: '2025-12-31',
      scope: 'deltas',
    });
    assert.ok(r.valid);
    assert.strictEqual(r.filters.module_key, 'critical_media_thinking');
    assert.strictEqual(r.filters.assessment_type, 'post');
  });
});

// ─── computeDeltaSummary ──────────────────────────────────────────────
describe('computeDeltaSummary', () => {
  test('empty array → zeros', () => {
    const s = computeDeltaSummary([]);
    assert.strictEqual(s.students_with_pairs, 0);
    assert.strictEqual(s.avg_pre_percent, 0);
    assert.strictEqual(s.avg_post_percent, 0);
    assert.strictEqual(s.avg_delta_percent_points, 0);
    // Must be finite (never NaN or Infinity)
    assert.ok(Number.isFinite(s.avg_delta_percent_points));
  });

  test('null → zeros (same as empty)', () => {
    const s = computeDeltaSummary(null);
    assert.strictEqual(s.students_with_pairs, 0);
  });

  test('single student improvement', () => {
    const s = computeDeltaSummary([{ pre_percent: 40, post_percent: 75 }]);
    assert.strictEqual(s.students_with_pairs, 1);
    assert.strictEqual(s.avg_pre_percent, 40);
    assert.strictEqual(s.avg_post_percent, 75);
    assert.strictEqual(s.avg_delta_percent_points, 35);
  });

  test('multiple students, mixed results', () => {
    const deltas = [
      { pre_percent: 40, post_percent: 60 },  // +20
      { pre_percent: 50, post_percent: 70 },  // +20
      { pre_percent: 80, post_percent: 60 },  // -20 (regression)
    ];
    const s = computeDeltaSummary(deltas);
    assert.strictEqual(s.students_with_pairs, 3);
    assert.strictEqual(s.avg_pre_percent,   Math.round((40+50+80)/3*100)/100);
    assert.strictEqual(s.avg_post_percent,  Math.round((60+70+60)/3*100)/100);
    assert.strictEqual(s.avg_delta_percent_points, Math.round((20+20-20)/3*100)/100);
  });

  test('percent values are rounded to 2 decimals', () => {
    const s = computeDeltaSummary([
      { pre_percent: 10, post_percent: 40 },
      { pre_percent: 20, post_percent: 50 },
      { pre_percent: 30, post_percent: 60 },
    ]);
    // avg_pre = (10+20+30)/3 = 20.00 exactly, avg_post = 50.00
    assert.strictEqual(s.avg_pre_percent, 20);
    assert.strictEqual(s.avg_post_percent, 50);
  });

  test('zero improvement → delta = 0, not NaN', () => {
    const s = computeDeltaSummary([{ pre_percent: 80, post_percent: 80 }]);
    assert.strictEqual(s.avg_delta_percent_points, 0);
    assert.ok(Number.isFinite(s.avg_delta_percent_points));
  });
});

// ─── sanitizeDeltaForExport ───────────────────────────────────────────
describe('sanitizeDeltaForExport', () => {
  const sampleRow = {
    user_id:               'uuid-student-1',
    class_id:              'uuid-class-1',
    module_key:            'entrepreneurship',
    pre_percent:           40,
    post_percent:          75,
    delta_percent_points:  35,
    pre_submitted_at:      '2025-10-01T10:00:00Z',
    post_submitted_at:     '2025-12-01T10:00:00Z',
    // These should NOT appear in the export:
    display_name:          'Ján Novák',
    email:                 'jan@school.sk',
    phone:                 '+421 900 000 000',
    secret_field:          'SENSITIVE',
  };

  test('output does not contain display_name', () => {
    const out = sanitizeDeltaForExport(sampleRow);
    assert.ok(!Object.prototype.hasOwnProperty.call(out, 'display_name'));
  });

  test('output does not contain email', () => {
    const out = sanitizeDeltaForExport(sampleRow);
    assert.ok(!Object.prototype.hasOwnProperty.call(out, 'email'));
  });

  test('output does not contain phone', () => {
    const out = sanitizeDeltaForExport(sampleRow);
    assert.ok(!Object.prototype.hasOwnProperty.call(out, 'phone'));
  });

  test('output does not contain arbitrary extra fields', () => {
    const out = sanitizeDeltaForExport(sampleRow);
    assert.ok(!Object.prototype.hasOwnProperty.call(out, 'secret_field'));
  });

  test('output preserves user_id (UUID = pseudonymised identifier)', () => {
    const out = sanitizeDeltaForExport(sampleRow);
    assert.strictEqual(out.user_id, 'uuid-student-1');
  });

  test('output preserves delta_percent_points', () => {
    const out = sanitizeDeltaForExport(sampleRow);
    assert.strictEqual(out.delta_percent_points, 35);
  });

  test('output preserves module_key', () => {
    const out = sanitizeDeltaForExport(sampleRow);
    assert.strictEqual(out.module_key, 'entrepreneurship');
  });

  test('null row fields become empty string (no undefined in CSV)', () => {
    const out = sanitizeDeltaForExport({ user_id: null, class_id: undefined });
    assert.strictEqual(out.user_id, '');
    assert.strictEqual(out.class_id, '');
  });

  test('export row keys are exactly the expected whitelist', () => {
    const out = sanitizeDeltaForExport(sampleRow);
    const expectedKeys = new Set([
      'user_id', 'class_id', 'module_key',
      'assessment_type_pre', 'assessment_type_post',
      'pre_percent', 'post_percent', 'delta_percent_points',
      'pre_submitted_at', 'post_submitted_at',
    ]);
    for (const k of Object.keys(out)) {
      assert.ok(expectedKeys.has(k), `Unexpected key in export: ${k}`);
    }
  });
});
