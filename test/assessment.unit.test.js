/**
 * Unit tests for lib/assessment.js — pure scoring + validation logic.
 * Run: node --test test/assessment.unit.test.js
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  MODULE_KEYS,
  ASSESSMENT_TYPES,
  QUESTION_TYPES,
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
} = require('../lib/assessment');
const { _testHelpers } = require('../lib/assessment-routes');

// ─── Validators ──────────────────────────────────────────────────────
describe('validators', () => {
  test('MODULE_KEYS reflects INVOK 4 modules', () => {
    assert.strictEqual(MODULE_KEYS.length, 4);
    assert.deepStrictEqual([...MODULE_KEYS], [
      'entrepreneurship',
      'critical_media_thinking',
      'teamwork_digital_tools',
      'presentation_communication',
    ]);
  });

  test('isValidModuleKey', () => {
    assert.ok(isValidModuleKey('entrepreneurship'));
    assert.ok(isValidModuleKey('critical_media_thinking'));
    assert.ok(!isValidModuleKey('random'));
    assert.ok(!isValidModuleKey(null));
    assert.ok(!isValidModuleKey(undefined));
    assert.ok(!isValidModuleKey(42));
  });

  test('isValidAssessmentType', () => {
    assert.ok(isValidAssessmentType('pre'));
    assert.ok(isValidAssessmentType('post'));
    assert.ok(isValidAssessmentType('generic'));
    assert.ok(!isValidAssessmentType('xyz'));
    assert.ok(!isValidAssessmentType(''));
  });

  test('isValidQuestionType', () => {
    assert.ok(isValidQuestionType('multiple_choice'));
    assert.ok(isValidQuestionType('scale_1_5'));
    assert.ok(isValidQuestionType('text'));
    assert.ok(!isValidQuestionType('audio'));
  });

  test('ASSESSMENT_TYPES and QUESTION_TYPES are frozen', () => {
    assert.throws(() => { ASSESSMENT_TYPES.push('foo'); });
    assert.throws(() => { QUESTION_TYPES.push('foo'); });
  });
});

// ─── scoreAnswer ─────────────────────────────────────────────────────
describe('scoreAnswer — multiple_choice', () => {
  test('correct answer earns full points', () => {
    const q = { question_type: 'multiple_choice', correct_answer: ['A'], max_points: 2 };
    const r = scoreAnswer(q, { value: 'A' });
    assert.strictEqual(r.score, 2);
    assert.strictEqual(r.maxPoints, 2);
    assert.strictEqual(r.needsManualReview, false);
  });

  test('wrong answer earns 0', () => {
    const q = { question_type: 'multiple_choice', correct_answer: ['A'], max_points: 2 };
    const r = scoreAnswer(q, { value: 'B' });
    assert.strictEqual(r.score, 0);
    assert.strictEqual(r.maxPoints, 2);
  });

  test('multiple correct answers — any one earns full points', () => {
    const q = { question_type: 'multiple_choice', correct_answer: ['A', 'C'], max_points: 1 };
    assert.strictEqual(scoreAnswer(q, { value: 'A' }).score, 1);
    assert.strictEqual(scoreAnswer(q, { value: 'C' }).score, 1);
    assert.strictEqual(scoreAnswer(q, { value: 'B' }).score, 0);
  });

  test('no correct_answer defined → 0 points (cannot grade)', () => {
    const q = { question_type: 'multiple_choice', correct_answer: null, max_points: 1 };
    assert.strictEqual(scoreAnswer(q, { value: 'A' }).score, 0);
  });

  test('null answer → 0 points', () => {
    const q = { question_type: 'multiple_choice', correct_answer: ['A'], max_points: 1 };
    assert.strictEqual(scoreAnswer(q, null).score, 0);
  });
});

describe('scoreAnswer — scale_1_5', () => {
  test('exact target earns full points', () => {
    const q = { question_type: 'scale_1_5', correct_answer: { target: 5 }, max_points: 4 };
    assert.strictEqual(scoreAnswer(q, { value: 5 }).score, 4);
  });

  test('distance 2 from target → half points', () => {
    const q = { question_type: 'scale_1_5', correct_answer: { target: 5 }, max_points: 4 };
    // 4 * (1 - 2*0.25) = 4 * 0.5 = 2
    assert.strictEqual(scoreAnswer(q, { value: 3 }).score, 2);
  });

  test('max distance (4) → 0 points', () => {
    const q = { question_type: 'scale_1_5', correct_answer: { target: 5 }, max_points: 4 };
    assert.strictEqual(scoreAnswer(q, { value: 1 }).score, 0);
  });

  test('out-of-range value → 0 points', () => {
    const q = { question_type: 'scale_1_5', correct_answer: { target: 5 }, max_points: 4 };
    assert.strictEqual(scoreAnswer(q, { value: 99 }).score, 0);
    assert.strictEqual(scoreAnswer(q, { value: 0 }).score, 0);
  });

  test('likert mode (no target) → full points for any valid scale', () => {
    const q = { question_type: 'scale_1_5', max_points: 1 };
    assert.strictEqual(scoreAnswer(q, { value: 3 }).score, 1);
    assert.strictEqual(scoreAnswer(q, { value: 1 }).score, 1);
    assert.strictEqual(scoreAnswer(q, { value: 5 }).score, 1);
  });

  test('likert mode rejects out-of-range', () => {
    const q = { question_type: 'scale_1_5', max_points: 1 };
    assert.strictEqual(scoreAnswer(q, { value: 6 }).score, 0);
  });
});

describe('scoreAnswer — text', () => {
  test('text answer → 0 points + manual review flag', () => {
    const q = { question_type: 'text', max_points: 5 };
    const r = scoreAnswer(q, { value: 'My thoughtful answer' });
    assert.strictEqual(r.score, 0);
    assert.strictEqual(r.maxPoints, 5);
    assert.strictEqual(r.needsManualReview, true);
  });

  test('null text answer → 0 points, no manual review needed', () => {
    const q = { question_type: 'text', max_points: 5 };
    const r = scoreAnswer(q, null);
    assert.strictEqual(r.score, 0);
    assert.strictEqual(r.needsManualReview, false);
  });
});

describe('scoreAnswer — robustness', () => {
  test('invalid max_points falls back to 1', () => {
    const q = { question_type: 'multiple_choice', correct_answer: ['A'], max_points: 'banana' };
    const r = scoreAnswer(q, { value: 'A' });
    assert.strictEqual(r.maxPoints, 1);
    assert.strictEqual(r.score, 1);
  });

  test('negative max_points clamped to 1', () => {
    const q = { question_type: 'multiple_choice', correct_answer: ['A'], max_points: -5 };
    const r = scoreAnswer(q, { value: 'A' });
    assert.strictEqual(r.maxPoints, 1);
  });

  test('unknown question type → 0/0', () => {
    const q = { question_type: 'video_upload', max_points: 1 };
    const r = scoreAnswer(q, { value: 'x' });
    assert.strictEqual(r.score, 0);
  });
});

// ─── computeAttemptScore ─────────────────────────────────────────────
describe('computeAttemptScore', () => {
  test('basic totals + percent', () => {
    const r = computeAttemptScore([
      { score: 2, maxPoints: 2 },
      { score: 1, maxPoints: 2 },
      { score: 0, maxPoints: 1 },
    ]);
    assert.strictEqual(r.total, 3);
    assert.strictEqual(r.max, 5);
    assert.strictEqual(r.percent, 60);
  });

  test('100% case', () => {
    const r = computeAttemptScore([
      { score: 1, maxPoints: 1 },
      { score: 1, maxPoints: 1 },
    ]);
    assert.strictEqual(r.percent, 100);
  });

  test('empty answers → 0%', () => {
    const r = computeAttemptScore([]);
    assert.strictEqual(r.total, 0);
    assert.strictEqual(r.max, 0);
    assert.strictEqual(r.percent, 0);
  });

  test('zero max guarded (no NaN/Infinity)', () => {
    const r = computeAttemptScore([{ score: 0, maxPoints: 0 }]);
    assert.strictEqual(r.percent, 0);
    assert.ok(Number.isFinite(r.percent));
  });

  test('percent rounded to 2 decimals', () => {
    const r = computeAttemptScore([
      { score: 1, maxPoints: 3 },
    ]);
    // 1/3 = 33.333...% → 33.33
    assert.strictEqual(r.percent, 33.33);
  });
});

// ─── computeDelta ────────────────────────────────────────────────────
describe('computeDelta', () => {
  test('improvement', () => {
    const d = computeDelta({ percent_score: 40 }, { percent_score: 75 });
    assert.strictEqual(d.delta_percent, 35);
    assert.strictEqual(d.improved, true);
    assert.strictEqual(d.pre_percent, 40);
    assert.strictEqual(d.post_percent, 75);
  });

  test('no improvement (equal)', () => {
    const d = computeDelta({ percent_score: 80 }, { percent_score: 80 });
    assert.strictEqual(d.delta_percent, 0);
    assert.strictEqual(d.improved, false);
  });

  test('regression', () => {
    const d = computeDelta({ percent_score: 80 }, { percent_score: 60 });
    assert.strictEqual(d.delta_percent, -20);
    assert.strictEqual(d.improved, false);
  });

  test('null pre → null', () => {
    assert.strictEqual(computeDelta(null, { percent_score: 50 }), null);
  });

  test('null post → null', () => {
    assert.strictEqual(computeDelta({ percent_score: 50 }, null), null);
  });

  test('both null → null', () => {
    assert.strictEqual(computeDelta(null, null), null);
  });
});

// ─── validateAnswerShape ─────────────────────────────────────────────
describe('validateAnswerShape', () => {
  test('null answer accepted (no submission)', () => {
    const q = { question_type: 'multiple_choice' };
    assert.strictEqual(validateAnswerShape(q, null), null);
    assert.strictEqual(validateAnswerShape(q, undefined), null);
  });

  test('missing question throws INVALID_QUESTION', () => {
    assert.throws(() => validateAnswerShape(null, { value: 'A' }), /INVALID_QUESTION/);
  });

  test('non-object answer throws INVALID_ANSWER_SHAPE', () => {
    const q = { question_type: 'multiple_choice' };
    assert.throws(() => validateAnswerShape(q, 'hello'), /INVALID_ANSWER_SHAPE/);
    assert.throws(() => validateAnswerShape(q, 42), /INVALID_ANSWER_SHAPE/);
  });

  test('multiple_choice requires string value', () => {
    const q = { question_type: 'multiple_choice' };
    assert.throws(() => validateAnswerShape(q, { value: 123 }), /MC_REQUIRES_STRING_VALUE/);
    assert.throws(() => validateAnswerShape(q, {}), /MC_REQUIRES_STRING_VALUE/);
  });

  test('multiple_choice rejects oversized value (XSS / DoS guard)', () => {
    const q = { question_type: 'multiple_choice' };
    assert.throws(
      () => validateAnswerShape(q, { value: 'x'.repeat(300) }),
      /MC_VALUE_TOO_LONG/
    );
  });

  test('multiple_choice strips extra fields', () => {
    const q = { question_type: 'multiple_choice' };
    const r = validateAnswerShape(q, { value: 'A', evil: '<script>' });
    assert.deepStrictEqual(r, { value: 'A' });
  });

  test('scale_1_5 rejects out-of-range', () => {
    const q = { question_type: 'scale_1_5' };
    assert.throws(() => validateAnswerShape(q, { value: 7 }), /SCALE_OUT_OF_RANGE/);
    assert.throws(() => validateAnswerShape(q, { value: 0 }), /SCALE_OUT_OF_RANGE/);
    assert.throws(() => validateAnswerShape(q, { value: 'three' }), /SCALE_OUT_OF_RANGE/);
  });

  test('scale_1_5 accepts edges 1 and 5', () => {
    const q = { question_type: 'scale_1_5' };
    assert.deepStrictEqual(validateAnswerShape(q, { value: 1 }), { value: 1 });
    assert.deepStrictEqual(validateAnswerShape(q, { value: 5 }), { value: 5 });
  });

  test('text requires string', () => {
    const q = { question_type: 'text' };
    assert.throws(() => validateAnswerShape(q, { value: 123 }), /TEXT_REQUIRES_STRING/);
  });

  test('text rejects oversized (DoS guard)', () => {
    const q = { question_type: 'text' };
    assert.throws(
      () => validateAnswerShape(q, { value: 'x'.repeat(6000) }),
      /TEXT_TOO_LONG/
    );
  });

  test('unknown type throws', () => {
    const q = { question_type: 'video_upload' };
    assert.throws(() => validateAnswerShape(q, { value: 'x' }), /UNKNOWN_QUESTION_TYPE/);
  });
});

// ─── Access control helpers ─────────────────────────────────────────
describe('canCreateAssessment', () => {
  test('teacher with active membership → true', () => {
    const m = [{ role: 'teacher', school_id: 'A', archived_at: null }];
    assert.ok(canCreateAssessment(m));
  });

  test('admin with active membership → true', () => {
    const m = [{ role: 'admin', school_id: 'A', archived_at: null }];
    assert.ok(canCreateAssessment(m));
  });

  test('student-only → false', () => {
    const m = [{ role: 'student', school_id: 'A', archived_at: null }];
    assert.ok(!canCreateAssessment(m));
  });

  test('no memberships → false', () => {
    assert.ok(!canCreateAssessment([]));
  });

  test('archived teacher membership → false', () => {
    const m = [{ role: 'teacher', school_id: 'A', archived_at: new Date() }];
    assert.ok(!canCreateAssessment(m));
  });

  test('mixed: archived teacher + active student → false', () => {
    const m = [
      { role: 'teacher', school_id: 'A', archived_at: new Date() },
      { role: 'student', school_id: 'B', archived_at: null },
    ];
    assert.ok(!canCreateAssessment(m));
  });

  test('mixed: active teacher in one school + student in another → true', () => {
    const m = [
      { role: 'teacher', school_id: 'A', archived_at: null },
      { role: 'student', school_id: 'B', archived_at: null },
    ];
    assert.ok(canCreateAssessment(m));
  });

  test('null / undefined / non-array → false', () => {
    assert.ok(!canCreateAssessment(null));
    assert.ok(!canCreateAssessment(undefined));
    assert.ok(!canCreateAssessment('teacher'));
    assert.ok(!canCreateAssessment({ role: 'teacher' }));
  });

  test('EDUCATOR_ROLES is frozen', () => {
    assert.throws(() => { EDUCATOR_ROLES.push('foo'); });
    assert.deepStrictEqual([...EDUCATOR_ROLES], ['admin', 'teacher']);
  });
});

describe('canSeeCorrectAnswer', () => {
  test('owner sees correct_answer', () => {
    assert.ok(canSeeCorrectAnswer({ created_by: 'u1' }, 'u1'));
  });

  test('non-owner does not', () => {
    assert.ok(!canSeeCorrectAnswer({ created_by: 'u1' }, 'u2'));
  });

  test('missing inputs → false', () => {
    assert.ok(!canSeeCorrectAnswer(null, 'u1'));
    assert.ok(!canSeeCorrectAnswer({ created_by: 'u1' }, null));
  });
});

describe('canSubmitAttempt', () => {
  test('owner with in_progress attempt → ok', () => {
    const a = { user_id: 'u1', status: 'in_progress' };
    const r = canSubmitAttempt(a, 'u1');
    assert.strictEqual(r.ok, true);
  });

  test('non-owner → NOT_OWNER', () => {
    const a = { user_id: 'u1', status: 'in_progress' };
    const r = canSubmitAttempt(a, 'u2');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'NOT_OWNER');
  });

  test('already submitted → ALREADY_SUBMITTED', () => {
    const a = { user_id: 'u1', status: 'submitted' };
    const r = canSubmitAttempt(a, 'u1');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'ALREADY_SUBMITTED');
  });

  test('abandoned → ALREADY_SUBMITTED (cannot resubmit)', () => {
    const a = { user_id: 'u1', status: 'abandoned' };
    const r = canSubmitAttempt(a, 'u1');
    assert.strictEqual(r.reason, 'ALREADY_SUBMITTED');
  });

  test('null attempt → NOT_FOUND', () => {
    const r = canSubmitAttempt(null, 'u1');
    assert.strictEqual(r.reason, 'NOT_FOUND');
  });

  test('null userId → NOT_FOUND', () => {
    const r = canSubmitAttempt({ user_id: 'u1', status: 'in_progress' }, null);
    assert.strictEqual(r.reason, 'NOT_FOUND');
  });
});

describe('canStartAttempt', () => {
  test('active assessment → ok', () => {
    const r = canStartAttempt({ id: 'a1', is_active: true });
    assert.strictEqual(r.ok, true);
  });

  test('inactive assessment → NOT_ACTIVE', () => {
    const r = canStartAttempt({ id: 'a1', is_active: false });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'NOT_ACTIVE');
  });

  test('null assessment → NOT_FOUND', () => {
    const r = canStartAttempt(null);
    assert.strictEqual(r.reason, 'NOT_FOUND');
  });
});

describe('canViewAttempt', () => {
  test('owner can view own attempt', () => {
    const att = { user_id: 'u1', assessment_id: 'a1' };
    assert.ok(canViewAttempt(att, { created_by: 'u9' }, 'u1'));
  });

  test('assessment creator can view student attempt', () => {
    const att = { user_id: 'student1', assessment_id: 'a1' };
    assert.ok(canViewAttempt(att, { created_by: 'teacher1' }, 'teacher1'));
  });

  test('random user cannot view someone elseʼs attempt', () => {
    const att = { user_id: 'student1', assessment_id: 'a1' };
    assert.ok(!canViewAttempt(att, { created_by: 'teacher1' }, 'random_user'));
  });

  test('no assessment context, non-owner → false', () => {
    const att = { user_id: 'u1', assessment_id: 'a1' };
    assert.ok(!canViewAttempt(att, null, 'u2'));
  });
});

// ─── Rate limiter (in-process MVP) ───────────────────────────────────
describe('rateLimit helper', () => {
  test('allows up to maxRequests in window', () => {
    const rl = _testHelpers.rateLimit;
    const key = 'unit:rl:test:' + Math.random();
    for (let i = 0; i < 3; i++) {
      assert.strictEqual(rl(key, 3, 60000), true, 'request ' + (i + 1));
    }
  });

  test('blocks when over the cap', () => {
    const rl = _testHelpers.rateLimit;
    const key = 'unit:rl:cap:' + Math.random();
    rl(key, 2, 60000);
    rl(key, 2, 60000);
    assert.strictEqual(rl(key, 2, 60000), false);
  });

  test('refills after window', async () => {
    const rl = _testHelpers.rateLimit;
    const key = 'unit:rl:refill:' + Math.random();
    rl(key, 1, 50);     // 50 ms window
    assert.strictEqual(rl(key, 1, 50), false);
    await new Promise((r) => setTimeout(r, 70));
    assert.strictEqual(rl(key, 1, 50), true);
  });

  test('separate keys are independent (per-user isolation)', () => {
    const rl = _testHelpers.rateLimit;
    const k1 = 'unit:rl:userA:' + Math.random();
    const k2 = 'unit:rl:userB:' + Math.random();
    rl(k1, 1, 60000);
    assert.strictEqual(rl(k1, 1, 60000), false); // userA capped
    assert.strictEqual(rl(k2, 1, 60000), true);  // userB independent
  });
});

// ─── Integration scenario: full pre→post flow ────────────────────────
describe('Integration scenario — full pre/post flow', () => {
  test('a student scores 40% on pre and 75% on post → 35 pt improvement', () => {
    const questions = [
      { question_type: 'multiple_choice', correct_answer: ['A'], max_points: 1 },
      { question_type: 'multiple_choice', correct_answer: ['B'], max_points: 1 },
      { question_type: 'scale_1_5', correct_answer: { target: 5 }, max_points: 2 },
    ];

    // Pre-test answers — 1 correct MC + scale way off
    const preScored = [
      scoreAnswer(questions[0], { value: 'A' }),     // correct → 1
      scoreAnswer(questions[1], { value: 'C' }),     // wrong → 0
      scoreAnswer(questions[2], { value: 2 }),       // dist 3 → 2*0.25 = 0.5
    ];
    const pre = computeAttemptScore(preScored);
    // total = 1.5, max = 4 → 37.5%
    assert.strictEqual(pre.percent, 37.5);

    // Post-test answers — better
    const postScored = [
      scoreAnswer(questions[0], { value: 'A' }),     // correct → 1
      scoreAnswer(questions[1], { value: 'B' }),     // correct → 1
      scoreAnswer(questions[2], { value: 4 }),       // dist 1 → 2*0.75 = 1.5
    ];
    const post = computeAttemptScore(postScored);
    // total = 3.5, max = 4 → 87.5%
    assert.strictEqual(post.percent, 87.5);

    const delta = computeDelta(
      { percent_score: pre.percent },
      { percent_score: post.percent }
    );
    assert.strictEqual(delta.improved, true);
    assert.strictEqual(delta.delta_percent, 50);
  });
});
