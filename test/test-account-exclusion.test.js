'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');

test('migration 041 adds an idempotent is_test_account column', () => {
	const sql = read('supabase/migrations/041_test_accounts.sql');
	assert.match(sql, /ADD COLUMN IF NOT EXISTS is_test_account BOOLEAN NOT NULL DEFAULT false/);
	assert.match(sql, /CREATE INDEX IF NOT EXISTS/);
});

test('institution reports exclude test accounts everywhere they count people or attempts', () => {
	const src = read('lib/institution-routes.js');
	const fn = src.slice(src.indexOf('function eligibleStudentAttempt'), src.indexOf('function createInstitutionRouter'));
	assert.match(fn, /NOT EXISTS[\s\S]*is_test_account/, 'attempt filter excludes test accounts');
	for (const alias of ['sm2.user_id', 'sm.user_id', 'e2.student_id', 'e.student_id']) {
		assert.ok(
			src.includes(`tp.id = ${alias} AND tp.is_test_account`),
			`member/student count for ${alias} excludes test accounts`
		);
	}
});

test('the eligibleStudentAttempt SQL fragment filters on the attempt user', () => {
	const src = read('lib/institution-routes.js');
	assert.match(src, /tp\.id = \$\{alias\}\.user_id AND tp\.is_test_account/);
});
