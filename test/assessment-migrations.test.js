'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const scopeMigration = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'migrations', '031_assessment_scope_security.sql'),
  'utf8'
);

test('additive 031 attempt RLS accepts solo scope and limits class scope to active students', () => {
  assert.match(scopeMigration,
    /CREATE OR REPLACE FUNCTION public\.fn_can_scope_assessment_attempt\s*\(/i);
  assert.match(scopeMigration, /SECURITY DEFINER[\s\S]*SET search_path = ''/i);
  assert.match(scopeMigration,
    /target_school_id IS NULL[\s\S]*target_class_id IS NULL/i);
  assert.match(scopeMigration,
    /c\.id = target_class_id[\s\S]*c\.school_id = target_school_id/i);
  assert.match(scopeMigration,
    /c\.archived_at IS NULL[\s\S]*s\.archived_at IS NULL/i);
  assert.match(scopeMigration,
    /ce\.class_id = c\.id[\s\S]*ce\.student_id = auth\.uid\(\)[\s\S]*ce\.archived_at IS NULL/i);
  assert.match(scopeMigration,
    /sm\.school_id = c\.school_id[\s\S]*sm\.user_id = auth\.uid\(\)[\s\S]*sm\.archived_at IS NULL/i);
  assert.match(scopeMigration, /sm\.role = 'student'/i);
  assert.doesNotMatch(scopeMigration, /sm\.role = 'admin'/i);
  assert.doesNotMatch(scopeMigration, /sm\.role = 'teacher'/i);
  assert.doesNotMatch(scopeMigration, /public\.edu_teaching_assignments/i);

  const scopeChecks = scopeMigration.match(
    /public\.fn_can_scope_assessment_attempt\s*\(\s*institution_id\s*,\s*class_id\s*\)/gi
  ) || [];
  assert.equal(scopeChecks.length, 2,
    'both assessment_attempts INSERT and UPDATE checks must validate scope');
  assert.match(scopeMigration,
    /REVOKE ALL ON FUNCTION public\.fn_can_scope_assessment_attempt\(UUID, UUID\) FROM PUBLIC/i);
  assert.match(scopeMigration,
    /GRANT EXECUTE ON FUNCTION public\.fn_can_scope_assessment_attempt\(UUID, UUID\) TO authenticated/i);
});

test('032 stamps immutable student scope evidence and leaves legacy scope unverified', () => {
  const migrationPath = path.join(
    __dirname,
    '..',
    'supabase',
    'migrations',
    '032_assessment_scope_evidence.sql'
  );
  assert.equal(fs.existsSync(migrationPath), true,
    'immutable scope evidence must ship as additive migration 032');
  const evidenceMigration = fs.readFileSync(migrationPath, 'utf8');

  assert.match(evidenceMigration,
    /ADD COLUMN IF NOT EXISTS scope_verified_at\s+TIMESTAMPTZ/i);
  assert.match(evidenceMigration,
    /ADD COLUMN IF NOT EXISTS scope_verified_role\s+TEXT/i);
  assert.match(evidenceMigration,
    /ADD COLUMN IF NOT EXISTS scope_membership_id\s+UUID/i);
  assert.match(evidenceMigration,
    /ADD COLUMN IF NOT EXISTS scope_enrollment_id\s+UUID/i);
  assert.match(evidenceMigration,
    /scope_verified_role = 'student'[\s\S]*scope_verified_at = started_at/i);

  assert.match(evidenceMigration,
    /CREATE OR REPLACE FUNCTION public\.fn_enforce_assessment_scope_evidence\(\)/i);
  assert.match(evidenceMigration,
    /LANGUAGE plpgsql[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = ''/i);
  assert.match(evidenceMigration,
    /NEW\.started_at := v_verified_at/i);
  assert.match(evidenceMigration,
    /c\.id = NEW\.class_id[\s\S]*c\.school_id = NEW\.institution_id/i);
  assert.match(evidenceMigration,
    /sm\.user_id = NEW\.user_id[\s\S]*sm\.role = 'student'[\s\S]*sm\.archived_at IS NULL/i);
  assert.match(evidenceMigration,
    /ce\.student_id = NEW\.user_id[\s\S]*ce\.archived_at IS NULL/i);
  assert.match(evidenceMigration,
    /NEW\.scope_membership_id := v_membership_id[\s\S]*NEW\.scope_enrollment_id := v_enrollment_id/i);
  assert.match(evidenceMigration, /FOR SHARE OF c, s, sm, ce/i,
    'evidence verification must block concurrent role/archive updates');

  for (const column of [
    'user_id',
    'institution_id',
    'class_id',
    'started_at',
    'scope_verified_at',
    'scope_verified_role',
    'scope_membership_id',
    'scope_enrollment_id',
  ]) {
    assert.match(evidenceMigration,
      new RegExp('NEW\\.' + column + ' IS DISTINCT FROM OLD\\.' + column, 'i'),
      column + ' must be immutable after insert');
  }
  assert.match(evidenceMigration,
    /CREATE TRIGGER trg_assessment_scope_evidence[\s\S]*BEFORE INSERT OR UPDATE[\s\S]*fn_enforce_assessment_scope_evidence/i);
  assert.match(evidenceMigration,
    /REVOKE ALL ON FUNCTION public\.fn_enforce_assessment_scope_evidence\(\)\s+FROM PUBLIC, anon, authenticated/i);

  assert.match(evidenceMigration,
    /REVOKE INSERT, UPDATE ON public\.assessment_attempts\s+FROM PUBLIC, anon, authenticated/i);
  assert.match(evidenceMigration,
    /GRANT INSERT \(\s*assessment_id,\s*user_id,\s*institution_id,\s*class_id,\s*module_key,\s*assessment_type,\s*status\s*\)[\s\S]*TO authenticated/i);
  assert.match(evidenceMigration,
    /GRANT UPDATE \(\s*submitted_at,\s*status,\s*total_score,\s*max_score,\s*percent_score\s*\)[\s\S]*TO authenticated/i);
  assert.doesNotMatch(evidenceMigration,
    /GRANT (?:INSERT|UPDATE)[^;]*scope_verified_/i);

  assert.doesNotMatch(evidenceMigration,
    /UPDATE\s+public\.assessment_attempts\s+SET\s+scope_/i,
    'mutable roster history must not be used to certify legacy attempts');
  assert.match(evidenceMigration,
    /legacy class-scoped rows remain unverified/i);
  assert.match(evidenceMigration,
    /CREATE INDEX IF NOT EXISTS idx_assess_att_verified_scope/i);
});
