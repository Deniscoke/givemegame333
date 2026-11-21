'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const migrationsDir = path.join(__dirname, '..', 'supabase', 'migrations');

function migration(name) {
  return fs.readFileSync(path.join(migrationsDir, name), 'utf8');
}

function uniqueOffset(sql, pattern, label) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const matches = [...sql.matchAll(new RegExp(pattern.source, flags))];
  assert.equal(matches.length, 1, `${label} must appear exactly once`);
  return matches[0].index;
}

// PostgreSQL is unavailable in this workspace. This constrained harness models
// the published 016 billing_events schema and executes the compatibility
// operations recognized in 026 in their actual textual order. Missing or
// duplicated required operations fail closed; the model is deliberately
// limited to this compatibility contract and is not a PostgreSQL substitute.
function apply026BillingEventsContract(sql, state) {
  const operations = [
    ['add:type', /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+type\s+TEXT\b/i],
    ['add:user_id', /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+user_id\s+UUID\b/i],
    ['add:subscription_id', /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+subscription_id\s+UUID\b/i],
    ['add:payload', /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+payload\s+JSONB\b/i],
    ['backfill:type', /UPDATE\s+public\.billing_events\s+SET\s+type\s*=\s*event_type\s+WHERE\s+type\s+IS\s+NULL/i],
    ['nullable:event_type', /ALTER\s+TABLE\s+public\.billing_events\s+ALTER\s+COLUMN\s+event_type\s+DROP\s+NOT\s+NULL/i],
    ['backfill:payload', /UPDATE\s+public\.billing_events\s+SET\s+payload\s*=\s*'\{\}'::jsonb\s+WHERE\s+payload\s+IS\s+NULL/i],
    ['default:payload', /ALTER\s+TABLE\s+public\.billing_events\s+ALTER\s+COLUMN\s+payload\s+SET\s+DEFAULT\s+'\{\}'::jsonb/i],
    ['not-null:type', /ALTER\s+TABLE\s+public\.billing_events\s+ALTER\s+COLUMN\s+type\s+SET\s+NOT\s+NULL/i],
    ['not-null:payload', /ALTER\s+TABLE\s+public\.billing_events\s+ALTER\s+COLUMN\s+payload\s+SET\s+NOT\s+NULL/i],
    ['fk:user_id', /ADD\s+CONSTRAINT\s+billing_events_user_id_fkey\s+FOREIGN\s+KEY\s*\(user_id\)\s+REFERENCES\s+auth\.users\s*\(id\)\s+ON\s+DELETE\s+SET\s+NULL\s+NOT\s+VALID/i],
    ['fk:subscription_id', /ADD\s+CONSTRAINT\s+billing_events_subscription_id_fkey\s+FOREIGN\s+KEY\s*\(subscription_id\)\s+REFERENCES\s+public\.billing_subscriptions\s*\(id\)\s+ON\s+DELETE\s+SET\s+NULL\s+NOT\s+VALID/i],
    ['validate:user_id', /VALIDATE\s+CONSTRAINT\s+billing_events_user_id_fkey/i],
    ['validate:subscription_id', /VALIDATE\s+CONSTRAINT\s+billing_events_subscription_id_fkey/i],
    ['index:type', /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_billing_events_type\s+ON\s+public\.billing_events\s*\(type,\s*processed_at\s+DESC\)/i]
  ].map(([kind, pattern]) => ({ kind, offset: uniqueOffset(sql, pattern, kind) }))
    .sort((left, right) => left.offset - right.offset);

  for (const operation of operations) {
    const [kind, name] = operation.kind.split(':');
    if (kind === 'add') {
      if (!state.columns[name]) {
        state.columns[name] = { notNull: false, defaultValue: null };
        for (const row of state.rows) row[name] = null;
      }
    } else if (operation.kind === 'backfill:type') {
      assert.ok(state.columns.type, 'type must exist before its backfill');
      for (const row of state.rows) {
        if (row.type === null) row.type = row.event_type;
      }
    } else if (operation.kind === 'nullable:event_type') {
      state.columns.event_type.notNull = false;
    } else if (operation.kind === 'backfill:payload') {
      assert.ok(state.columns.payload, 'payload must exist before its backfill');
      for (const row of state.rows) {
        if (row.payload === null) row.payload = {};
      }
    } else if (operation.kind === 'default:payload') {
      state.columns.payload.defaultValue = {};
    } else if (kind === 'not-null') {
      assert.ok(state.columns[name], `${name} must exist before NOT NULL`);
      assert.equal(state.rows.some((row) => row[name] === null), false, `${name} must be backfilled first`);
      state.columns[name].notNull = true;
    } else if (kind === 'fk') {
      assert.ok(state.columns[name], `${name} must exist before its foreign key`);
      state.constraints.add(`${name}:not-valid`);
    } else if (kind === 'validate') {
      assert.ok(state.constraints.has(`${name}:not-valid`), `${name} FK must exist before validation`);
      state.constraints.delete(`${name}:not-valid`);
      state.constraints.add(`${name}:validated`);
    } else if (operation.kind === 'index:type') {
      assert.ok(state.columns.type, 'type must exist before idx_billing_events_type');
      state.indexes.add('idx_billing_events_type');
    }
  }

  return state;
}

function legacy016State() {
  return {
    columns: {
      id: { notNull: true },
      stripe_event_id: { notNull: true },
      event_type: { notNull: true },
      processed_at: { notNull: false }
    },
    constraints: new Set(),
    indexes: new Set(['idx_billing_events_stripe_id']),
    rows: [{
      id: 'legacy-event-id',
      stripe_event_id: 'evt_legacy',
      event_type: 'invoice.payment_succeeded',
      processed_at: '2026-08-20T12:00:00.000Z'
    }]
  };
}

test('published migration 029 keeps its adoption checksum unchanged', () => {
  const sql = migration('029_assessment_security.sql');
  assert.equal(
    crypto.createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex'),
    '7125f80ea6c279a0249f54133b7fb7ed758612bc8d4a1d856ea9deab2b6157dc'
  );
});

test('031 adds scoped assessment-attempt enforcement without rewriting 029', () => {
  const filename = '031_assessment_scope_security.sql';
  assert.equal(
    fs.existsSync(path.join(migrationsDir, filename)),
    true,
    'scope hardening must ship as additive migration 031'
  );
  const sql = migration(filename);

  assert.match(sql, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.fn_can_scope_assessment_attempt/i);
  assert.match(sql, /SECURITY\s+DEFINER[\s\S]*SET\s+search_path\s*=\s*''/i);
  assert.match(sql, /REVOKE\s+ALL\s+ON\s+FUNCTION[\s\S]*FROM\s+PUBLIC/i);
  assert.match(sql, /GRANT\s+EXECUTE\s+ON\s+FUNCTION[\s\S]*TO\s+authenticated/i);
  assert.match(sql, /CREATE\s+POLICY\s+"assessment_attempts_insert"[\s\S]*fn_can_scope_assessment_attempt\(institution_id,\s*class_id\)/i);
  assert.match(sql, /CREATE\s+POLICY\s+"assessment_attempts_update"[\s\S]*fn_can_scope_assessment_attempt\(institution_id,\s*class_id\)/i);
});

test('026 upgrades the non-empty 016 billing_events schema without losing legacy data', () => {
  const state = apply026BillingEventsContract(migration('026_billing.sql'), legacy016State());
  const row = state.rows[0];

  assert.deepEqual(row, {
    id: 'legacy-event-id',
    stripe_event_id: 'evt_legacy',
    event_type: 'invoice.payment_succeeded',
    processed_at: '2026-08-20T12:00:00.000Z',
    type: 'invoice.payment_succeeded',
    user_id: null,
    subscription_id: null,
    payload: {}
  });
  assert.equal(state.columns.type.notNull, true);
  assert.equal(state.columns.payload.notNull, true);
  assert.deepEqual(state.columns.payload.defaultValue, {});
  assert.equal(state.columns.event_type.notNull, false);
  assert.deepEqual(
    [...state.constraints].sort(),
    ['subscription_id:validated', 'user_id:validated']
  );
  assert.equal(state.indexes.has('idx_billing_events_type'), true);
});

test('026 billing_events reconciliation is idempotent in the legacy schema model', () => {
  const sql = migration('026_billing.sql');
  const once = apply026BillingEventsContract(sql, legacy016State());
  const snapshot = JSON.stringify({
    columns: once.columns,
    constraints: [...once.constraints].sort(),
    indexes: [...once.indexes].sort(),
    rows: once.rows
  });

  const twice = apply026BillingEventsContract(sql, once);

  assert.equal(JSON.stringify({
    columns: twice.columns,
    constraints: [...twice.constraints].sort(),
    indexes: [...twice.indexes].sort(),
    rows: twice.rows
  }), snapshot);
});
