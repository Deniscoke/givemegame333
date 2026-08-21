const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function migration(name) {
	return fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', name), 'utf8');
}

describe('billing migration security invariants', () => {
	it('defines effective_tier with an empty search path and fully qualified objects', () => {
		const sql = migration('026_billing.sql');
		assert.match(sql, /SET\s+search_path\s*=\s*''/i);
		assert.match(sql, /FROM\s+public\.profiles/i);
		assert.match(sql, /FROM\s+public\.edu_class_enrollments/i);
		assert.match(sql, /JOIN\s+public\.edu_teaching_assignments/i);
		assert.match(sql, /auth\.role\(\)[\s\S]*auth\.uid\(\)[\s\S]*p_user/i);
		assert.match(sql, /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.effective_tier\(UUID\)\s+FROM\s+PUBLIC/i);
	});

	it('adds monotonic Stripe event ordering and protects profile billing fields', () => {
		const sql = migration('030_billing_security.sql');
		assert.match(sql, /stripe_event_created_at\s+TIMESTAMPTZ/i);
		assert.match(sql, /CREATE\s+INDEX[\s\S]*stripe_event_created_at/i);
		assert.match(sql, /SECURITY\s+DEFINER[\s\S]*SET\s+search_path\s*=\s*''/i);
		assert.match(sql, /withdrawal_consent_ip/i);
		assert.match(sql, /withdrawal_consent_text/i);
		assert.match(sql, /REVOKE\s+ALL\s+ON\s+public\.profiles\s+FROM\s+anon,\s*authenticated/i);
	});

	it('backfills profiles from the highest active tier across existing subscriptions', () => {
		const sql = migration('030_billing_security.sql');
		assert.match(sql, /UPDATE\s+public\.profiles\s+AS\s+p[\s\S]*bool_or\(bs\.status\s+IN\s*\('active',\s*'trialing'\)\s+AND\s+bs\.tier\s*=\s*'school'\)/i);
		assert.match(sql, /WHEN[\s\S]*'school'[\s\S]*WHEN[\s\S]*'teacher'[\s\S]*ELSE\s+'free'/i);
	});

	it('keeps consent audit data restricted to the service role', () => {
		const sql = migration('027_billing_consent.sql');
		assert.match(sql, /REVOKE\s+ALL\s+ON\s+public\.v_billing_consent_audit\s+FROM\s+PUBLIC,\s*anon,\s*authenticated/i);
		assert.match(sql, /GRANT\s+SELECT\s+ON\s+public\.v_billing_consent_audit\s+TO\s+service_role/i);
	});
});
