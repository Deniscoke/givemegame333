/**
 * lib/institution.js — INVOK Institution reporting helpers (pure)
 *
 * Pure functions, no DB. Used by lib/institution-routes.js.
 * Testable with node --test without Express or pg.
 *
 * Access model (mirrors edu_school_memberships roles):
 *   admin   — full school access: summary, export, class reports
 *   teacher — same as admin for MVP (class scope comes in T2c)
 *   student — can view own school/class, NOT summary/export/delta
 */

'use strict';

const { isValidModuleKey, ASSESSMENT_TYPES } = require('./assessment');

const EDUCATOR_ROLES = Object.freeze(['admin', 'teacher']);
const ALL_ROLES      = Object.freeze(['admin', 'teacher', 'student']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Returns true for a non-null, non-archived school membership object. */
function isMember(membership) {
  return !!(membership && !membership.archived_at);
}

/** Returns true if the user is an active educator (admin or teacher). */
function isEducator(membership) {
  return isMember(membership) && EDUCATOR_ROLES.includes(membership.role);
}

/**
 * Can the user view the school at all (any role)?
 * @param {object|null} membership — row from edu_school_memberships for this user+school
 */
function canViewSchool(membership) {
  return isMember(membership);
}

/**
 * Can the user view the school-level assessment summary?
 * Only admin/teacher — students see their own data only.
 */
function canViewSchoolSummary(membership) {
  return isEducator(membership);
}

/**
 * Can the user view a class?
 * Admins/teachers always yes. Students only if they are enrolled.
 * @param {object|null} membership  — edu_school_memberships row
 * @param {object|null} enrollment  — edu_class_enrollments row (for students)
 */
function canViewClass(membership, enrollment) {
  if (!isMember(membership)) return false;
  if (isEducator(membership)) return true;
  // Student: must be actively enrolled (archived_at IS NULL)
  return !!(enrollment && !enrollment.archived_at);
}

/**
 * Can the user export school data for INVOK reporting?
 * Only educators.
 */
function canExportInstitutionData(membership) {
  return isEducator(membership);
}

/**
 * Validate and normalise query filter params.
 * Returns { valid: true, filters } or { valid: false, error }.
 * All values are clean — safe to embed as SQL parameters.
 */
function normalizeReportFilters(query) {
  const filters = {};

  if (query.module_key !== undefined) {
    if (!isValidModuleKey(query.module_key)) {
      return { valid: false, error: 'invalid module_key', code: 'BAD_MODULE_KEY' };
    }
    filters.module_key = query.module_key;
  }

  if (query.assessment_type !== undefined) {
    if (!ASSESSMENT_TYPES.includes(query.assessment_type)) {
      return { valid: false, error: 'invalid assessment_type', code: 'BAD_ASSESS_TYPE' };
    }
    filters.assessment_type = query.assessment_type;
  }

  if (query.class_id !== undefined) {
    if (!UUID_RE.test(query.class_id)) {
      return { valid: false, error: 'invalid class_id', code: 'BAD_CLASS_ID' };
    }
    filters.class_id = query.class_id;
  }

  if (query.from !== undefined) {
    if (!ISO_DATE_RE.test(query.from) || isNaN(Date.parse(query.from))) {
      return { valid: false, error: 'invalid from date (YYYY-MM-DD)', code: 'BAD_DATE_FROM' };
    }
    filters.from = query.from;
  }

  if (query.to !== undefined) {
    if (!ISO_DATE_RE.test(query.to) || isNaN(Date.parse(query.to))) {
      return { valid: false, error: 'invalid to date (YYYY-MM-DD)', code: 'BAD_DATE_TO' };
    }
    filters.to = query.to;
  }

  if (query.scope !== undefined) {
    if (!['summary', 'deltas'].includes(query.scope)) {
      return { valid: false, error: 'scope must be summary or deltas', code: 'BAD_SCOPE' };
    }
    filters.scope = query.scope;
  }

  // Reject reverse date range
  if (filters.from && filters.to && filters.from > filters.to) {
    return { valid: false, error: 'from must be before to', code: 'DATE_RANGE_REVERSED' };
  }

  return { valid: true, filters };
}

/**
 * Compute aggregate summary from an array of delta rows.
 * Each row: { user_id, module_key, pre_percent, post_percent }
 * Returns summary with avg_pre, avg_post, avg_delta, count.
 * Safe for empty arrays — returns zeros, never NaN.
 */
function computeDeltaSummary(deltas) {
  if (!Array.isArray(deltas) || deltas.length === 0) {
    return {
      students_with_pairs: 0,
      avg_pre_percent: 0,
      avg_post_percent: 0,
      avg_delta_percent_points: 0,
    };
  }

  const n = deltas.length;
  const sumPre   = deltas.reduce((s, d) => s + (Number(d.pre_percent)  || 0), 0);
  const sumPost  = deltas.reduce((s, d) => s + (Number(d.post_percent) || 0), 0);
  const sumDelta = deltas.reduce((s, d) => {
    const pre  = Number(d.pre_percent)  || 0;
    const post = Number(d.post_percent) || 0;
    return s + (post - pre);
  }, 0);

  const round2 = (v) => Math.round(v * 100) / 100;

  return {
    students_with_pairs: n,
    avg_pre_percent:           round2(sumPre   / n),
    avg_post_percent:          round2(sumPost  / n),
    avg_delta_percent_points:  round2(sumDelta / n),
  };
}

/**
 * Strip personal identifiers from a delta row for export.
 * Keeps user_id (UUID = pseudonymised), drops display_name, email, etc.
 * If caller later needs a display label, they should generate a sequence
 * number (Student 1, Student 2…) outside of this function.
 */
function sanitizeDeltaForExport(row) {
  return {
    user_id:             row.user_id        || '',
    class_id:            row.class_id       || '',
    module_key:          row.module_key     || '',
    assessment_type_pre: 'pre',
    assessment_type_post:'post',
    pre_percent:         row.pre_percent    ?? '',
    post_percent:        row.post_percent   ?? '',
    delta_percent_points:row.delta_percent_points ?? '',
    pre_submitted_at:    row.pre_submitted_at  || '',
    post_submitted_at:   row.post_submitted_at || '',
    // Never include: display_name, email, phone, address
  };
}

module.exports = {
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
};
