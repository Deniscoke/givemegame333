/**
 * lib/assessment.js — INVOK pre/post assessment business logic
 *
 * Pure functions only — no DB, no I/O. Designed for unit testing via
 * node --test. The router layer (lib/assessment-routes.js) wires these
 * into HTTP handlers + pg.Pool transactions.
 *
 * Scoring model (MVP):
 *   - multiple_choice: full max_points if answer.value ∈ correct_answer[],
 *                      else 0.
 *   - scale_1_5: if correct_answer.target is set, partial credit based on
 *                distance (0 = full, 1 = 0.75, 2 = 0.5, 3 = 0.25, 4 = 0).
 *                If no target, full points for any valid 1–5 (likert mode).
 *   - text: 0 points + needs_manual_review flag (teacher reviews later).
 *
 * Future: IRT (Item Response Theory) — Phase 2.
 */

'use strict';

const MODULE_KEYS = Object.freeze([
  'entrepreneurship',
  'critical_media_thinking',
  'teamwork_digital_tools',
  'presentation_communication',
]);

const ASSESSMENT_TYPES = Object.freeze(['pre', 'post', 'generic']);

const QUESTION_TYPES = Object.freeze(['multiple_choice', 'text', 'scale_1_5']);

const MC_VALUE_MAX = 200;
const TEXT_VALUE_MAX = 5000;

function isValidModuleKey(k) {
  return typeof k === 'string' && MODULE_KEYS.includes(k);
}

function isValidAssessmentType(t) {
  return typeof t === 'string' && ASSESSMENT_TYPES.includes(t);
}

function isValidQuestionType(t) {
  return typeof t === 'string' && QUESTION_TYPES.includes(t);
}

/**
 * Score a single answer against its question.
 * @param {object} question — { question_type, correct_answer, max_points }
 * @param {object|null} answer — { value: ... } or null
 * @returns {{score: number, maxPoints: number, needsManualReview: boolean}}
 */
function scoreAnswer(question, answer) {
  const max = Number(question.max_points);
  const maxPoints = Number.isFinite(max) && max >= 0 ? max : 1;

  if (!answer || typeof answer !== 'object') {
    // No answer submitted — 0 points, not flagged for review.
    return { score: 0, maxPoints, needsManualReview: false };
  }

  if (question.question_type === 'multiple_choice') {
    const correct = question.correct_answer;
    if (!Array.isArray(correct) || correct.length === 0) {
      return { score: 0, maxPoints, needsManualReview: false };
    }
    return correct.includes(answer.value)
      ? { score: maxPoints, maxPoints, needsManualReview: false }
      : { score: 0, maxPoints, needsManualReview: false };
  }

  if (question.question_type === 'scale_1_5') {
    const val = Number(answer.value);
    if (!Number.isFinite(val) || val < 1 || val > 5) {
      return { score: 0, maxPoints, needsManualReview: false };
    }
    const target = question.correct_answer && Number(question.correct_answer.target);
    if (!Number.isFinite(target)) {
      // Likert mode — any valid scale answer earns full credit.
      return { score: maxPoints, maxPoints, needsManualReview: false };
    }
    // Distance-based partial credit. distance ∈ {0,1,2,3,4}.
    const distance = Math.abs(val - target);
    const ratio = Math.max(0, 1 - distance * 0.25);
    return { score: maxPoints * ratio, maxPoints, needsManualReview: false };
  }

  if (question.question_type === 'text') {
    // No autoscoring — flagged for teacher review.
    return { score: 0, maxPoints, needsManualReview: true };
  }

  return { score: 0, maxPoints, needsManualReview: false };
}

/**
 * Aggregate scored answers into a total / max / percent.
 * Percent rounded to 2 decimals. Guards against division by zero.
 */
function computeAttemptScore(scoredAnswers) {
  const total = scoredAnswers.reduce((sum, a) => sum + (Number(a.score) || 0), 0);
  const max = scoredAnswers.reduce((sum, a) => sum + (Number(a.maxPoints) || 0), 0);
  const percent = max > 0 ? Math.round((total / max) * 10000) / 100 : 0;
  return { total, max, percent };
}

/**
 * Compute the pre/post delta for a single module.
 * Returns null if either side is missing.
 */
function computeDelta(pre, post) {
  if (!pre || !post) return null;
  const preP = Number(pre.percent_score) || 0;
  const postP = Number(post.percent_score) || 0;
  return {
    pre_percent: preP,
    post_percent: postP,
    delta_percent: Math.round((postP - preP) * 100) / 100,
    improved: postP > preP,
  };
}

/**
 * Throws on invalid answer shape (defense-in-depth before DB write).
 * Returns the normalised answer object (or null for empty).
 */
function validateAnswerShape(question, rawAnswer) {
  if (!question || !question.question_type) {
    throw new Error('INVALID_QUESTION');
  }
  if (rawAnswer === undefined || rawAnswer === null) {
    return null;
  }
  if (typeof rawAnswer !== 'object') {
    throw new Error('INVALID_ANSWER_SHAPE');
  }

  if (question.question_type === 'multiple_choice') {
    if (typeof rawAnswer.value !== 'string') {
      throw new Error('MC_REQUIRES_STRING_VALUE');
    }
    if (rawAnswer.value.length > MC_VALUE_MAX) {
      throw new Error('MC_VALUE_TOO_LONG');
    }
    return { value: rawAnswer.value };
  }

  if (question.question_type === 'scale_1_5') {
    const v = Number(rawAnswer.value);
    if (!Number.isFinite(v) || v < 1 || v > 5) {
      throw new Error('SCALE_OUT_OF_RANGE');
    }
    return { value: v };
  }

  if (question.question_type === 'text') {
    if (typeof rawAnswer.value !== 'string') {
      throw new Error('TEXT_REQUIRES_STRING');
    }
    if (rawAnswer.value.length > TEXT_VALUE_MAX) {
      throw new Error('TEXT_TOO_LONG');
    }
    return { value: rawAnswer.value };
  }

  throw new Error('UNKNOWN_QUESTION_TYPE');
}

// ─── Access-control helpers (pure) ───────────────────────────────────
// These mirror the SQL policies in migration 029. The router calls them
// to decide whether to permit/deny an action. Pure → easy to unit-test.
//
// Membership shape (from edu_school_memberships):
//   { school_id, user_id, role: 'admin'|'teacher'|'student', archived_at }

const EDUCATOR_ROLES = Object.freeze(['admin', 'teacher']);

/**
 * Can the user create a new assessment?
 * Yes iff they have ≥1 active membership with role admin or teacher.
 */
function canCreateAssessment(memberships) {
  if (!Array.isArray(memberships)) return false;
  return memberships.some(
    (m) => m && !m.archived_at && EDUCATOR_ROLES.includes(m.role)
  );
}

/**
 * May this user see the correct_answer values for the questions of this
 * assessment? Currently only the creator. Future: teachers in the same
 * institution as the assessment could be allowed, but only after we model
 * institution ownership of assessments (out of scope for T1.1).
 */
function canSeeCorrectAnswer(assessment, userId) {
  if (!assessment || !userId) return false;
  return assessment.created_by === userId;
}

/**
 * Can the user submit answers for this attempt?
 * Only the attempt owner, and only while it is in_progress.
 */
function canSubmitAttempt(attempt, userId) {
  if (!attempt || !userId) {
    return { ok: false, reason: 'NOT_FOUND' };
  }
  if (attempt.user_id !== userId) {
    return { ok: false, reason: 'NOT_OWNER' };
  }
  if (attempt.status !== 'in_progress') {
    return { ok: false, reason: 'ALREADY_SUBMITTED' };
  }
  return { ok: true };
}

/**
 * Can the user start a new attempt for this assessment?
 * Currently: any authenticated user, provided the assessment is active.
 * Future (T2): restrict to students enrolled in a class the assessment
 * is assigned to.
 */
function canStartAttempt(assessment) {
  if (!assessment) return { ok: false, reason: 'NOT_FOUND' };
  if (assessment.is_active === false) {
    return { ok: false, reason: 'NOT_ACTIVE' };
  }
  return { ok: true };
}

/**
 * Can the user view an attempt's full details (answers, scores)?
 * Either the attempt owner, or the creator of the parent assessment.
 */
function canViewAttempt(attempt, assessment, userId) {
  if (!attempt || !userId) return false;
  if (attempt.user_id === userId) return true;
  if (assessment && assessment.created_by === userId) return true;
  return false;
}

module.exports = {
  MODULE_KEYS,
  ASSESSMENT_TYPES,
  QUESTION_TYPES,
  MC_VALUE_MAX,
  TEXT_VALUE_MAX,
  EDUCATOR_ROLES,
  isValidModuleKey,
  isValidAssessmentType,
  isValidQuestionType,
  scoreAnswer,
  computeAttemptScore,
  computeDelta,
  validateAnswerShape,
  canCreateAssessment,
  canSeeCorrectAnswer,
  canSubmitAttempt,
  canStartAttempt,
  canViewAttempt,
};
