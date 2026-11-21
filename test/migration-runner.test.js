'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, test } = require('node:test');

const runnerPath = path.join(__dirname, '..', 'scripts', 'run-supabase-migrations.js');
const migrationsDir = path.join(__dirname, '..', 'supabase', 'migrations');
const WRITE_SQL = /\b(?:CREATE|ALTER|GRANT|REVOKE|BEGIN|INSERT|UPDATE|DELETE|DROP|TRUNCATE|COMMENT)\b/i;
const {
  SUPPORTED_MIGRATION_ORDER,
  applyMigration,
  checksumSql,
  inspectBootstrapState,
  loadMigrationEntries,
  parseCliArgs,
  runMigrations,
  selectMigrations,
  validateExecutionMode,
  validateMigrationCatalog,
  verifyAppliedChecksums
} = require(runnerPath);

test('requiring the migration runner does not start the CLI', () => {
  const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(runnerPath)})`], {
    encoding: 'utf8',
    env: { ...process.env, SUPABASE_DB_URL: '' }
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

describe('supported migration catalog', () => {
  test('covers every active SQL migration through 040 in deterministic order', () => {
    const filesOnDisk = fs.readdirSync(migrationsDir);
    const plan = validateMigrationCatalog(SUPPORTED_MIGRATION_ORDER, filesOnDisk);

    assert.equal(plan[0], '001_profiles_and_follows.sql');
    assert.equal(plan.at(-1), '040_session_state_machine.sql');
    assert.deepEqual(
      plan.filter((name) => name.startsWith('018_')),
      ['018_edu_core.sql', '018_plan_usage_daily.sql']
    );
    assert.equal(plan.some((name) => name.startsWith('019_')), false);
    assert.deepEqual(plan.filter((name) => name.startsWith('023_')), ['023_rpg_talents.sql']);
    assert.equal(plan.length, 40);
  });

  test('--from 026 selects the 026-040 release without replaying older migrations', () => {
    const options = parseCliArgs(['--from', '026']);
    const selected = selectMigrations(SUPPORTED_MIGRATION_ORDER, options);

    assert.deepEqual(selected, [
      '026_billing.sql',
      '027_billing_consent.sql',
      '028_assessments.sql',
      '029_assessment_security.sql',
      '030_billing_security.sql',
      '031_assessment_scope_security.sql',
      '032_assessment_scope_evidence.sql',
      '033_security_lockdown.sql',
      '034_assessment_writes_and_tier_scope.sql',
      '035_session_realtime.sql',
      '036_revoke_client_economy_writes.sql',
      '037_giveme_donations_server_only.sql',
      '038_reconcile_browser_only_balances.sql',
      '039_play_tickets_and_stat_xp.sql',
      '040_session_state_machine.sql'
    ]);
  });

  test('--files applies only exact filenames supplied in supported order', () => {
    const requested = [
      '026_billing.sql',
      '027_billing_consent.sql',
      '030_billing_security.sql'
    ];
    const options = parseCliArgs(['--files', requested.join(',')]);

    assert.deepEqual(selectMigrations(SUPPORTED_MIGRATION_ORDER, options), requested);
  });

  test('exact file selection rejects unknown, duplicate, and out-of-order names', () => {
    assert.throws(
      () => selectMigrations(SUPPORTED_MIGRATION_ORDER, { files: ['999_unknown.sql'] }),
      /Unknown migration filename/
    );
    assert.throws(
      () => selectMigrations(SUPPORTED_MIGRATION_ORDER, {
        files: ['026_billing.sql', '026_billing.sql']
      }),
      /must not contain duplicates/
    );
    assert.throws(
      () => selectMigrations(SUPPORTED_MIGRATION_ORDER, {
        files: ['030_billing_security.sql', '029_assessment_security.sql']
      }),
      /supported migration order/
    );
  });

  test('selection modes are mutually exclusive', () => {
    assert.throws(
      () => parseCliArgs(['--from', '026', '--files', '030_billing_security.sql']),
      /cannot be used together/
    );
  });

  test('rejects automated adoption instead of recording checksums for an existing schema', () => {
    assert.throws(
      () => parseCliArgs(['--adopt-existing']),
      /Unknown argument: --adopt-existing/
    );
  });

  test('uses a legacy-specific confirmation flag and rejects the removed adoption confirmation', () => {
    assert.throws(
      () => parseCliArgs(['--confirm-adoption', 'legacy-016-to-040']),
      /Unknown argument: --confirm-adoption/
    );

    const options = parseCliArgs([
      '--upgrade-legacy-016', '--from', '026',
      '--confirm-legacy-upgrade', 'legacy-016-to-040'
    ]);
    assert.equal(options.confirmation, 'legacy-016-to-040');
  });

  test('requires the complete release selector and confirmation for a legacy 016 upgrade', () => {
    const options = parseCliArgs([
      '--upgrade-legacy-016', '--from', '026',
      '--confirm-legacy-upgrade', 'legacy-016-to-040'
    ]);
    const selected = selectMigrations(SUPPORTED_MIGRATION_ORDER, options);

    assert.deepEqual(validateExecutionMode(options, selected), { mode: 'legacy-016' });
    assert.throws(
      () => validateExecutionMode({ ...options, from: '027' }, selected.slice(1)),
      /requires --from 026/
    );
  });

  test('rejects unsafe or ambiguous legacy bootstrap mode combinations', () => {
    const release = SUPPORTED_MIGRATION_ORDER.slice(-8);
    assert.throws(
      () => validateExecutionMode({
        upgradeLegacy016: true,
        from: '026',
        confirmation: 'legacy-016-to-040',
        dryRun: true
      }, release),
      /cannot be combined with --dry-run or --list/
    );
    assert.throws(
      () => validateExecutionMode({ upgradeLegacy016: true, from: '026' }, release),
      /requires --confirm-legacy-upgrade/
    );
    assert.throws(
      () => validateExecutionMode({ confirmation: '026-033' }, release),
      /--confirm-legacy-upgrade is only valid with --upgrade-legacy-016/
    );
  });

  test('rejects repeated, partial, or empty migration selectors', () => {
    assert.throws(
      () => parseCliArgs(['--from', '026', '--from', '030']),
      /--from may be specified only once/
    );
    assert.throws(
      () => parseCliArgs(['--files', '026_billing.sql,,030_billing_security.sql']),
      /empty migration filename/
    );
    assert.throws(
      () => selectMigrations(SUPPORTED_MIGRATION_ORDER, { from: '018_plan' }),
      /three-digit prefix or exact migration filename/
    );
  });

  test('dry-run lists the 026-033 release without requiring database credentials', () => {
    const result = spawnSync(
      process.execPath,
      [runnerPath, '--dry-run', '--from', '026'],
      {
        encoding: 'utf8',
        env: { ...process.env, SUPABASE_DB_URL: '' }
      }
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /026_billing\.sql/);
    assert.match(result.stdout, /030_billing_security\.sql/);
    assert.match(result.stdout, /031_assessment_scope_security\.sql/);
    assert.match(result.stdout, /032_assessment_scope_evidence\.sql/);
    assert.match(result.stdout, /033_security_lockdown\.sql/);
    assert.doesNotMatch(result.stdout, /025_level_perks\.sql/);
    assert.doesNotMatch(result.stdout, /postgres(?:ql)?:\/\//i);
    assert.equal(result.stderr, '');
  });

  test('--list reports the supported catalog and skips the disabled 019 file without database credentials', () => {
    const result = spawnSync(process.execPath, [runnerPath, '--list'], {
      encoding: 'utf8',
      env: { ...process.env, SUPABASE_DB_URL: '' }
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /018_edu_core\.sql/);
    assert.match(result.stdout, /018_plan_usage_daily\.sql/);
    assert.match(result.stdout, /030_billing_security\.sql/);
    assert.match(result.stdout, /031_assessment_scope_security\.sql/);
    assert.match(result.stdout, /032_assessment_scope_evidence\.sql/);
    assert.doesNotMatch(result.stdout, /019_edu_add_parent_role\.sql\.DISABLED/);
    assert.doesNotMatch(result.stdout, /postgres(?:ql)?:\/\//i);
    assert.equal(result.stderr, '');
  });
});

describe('migration checksums', () => {
  test('uses the standard SHA-256 digest of CRLF-normalized SQL text', () => {
    assert.equal(
      checksumSql('abc'),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });

  test('treats CRLF and LF SQL line endings as equivalent', () => {
    assert.equal(checksumSql('SELECT 1;\r\n'), checksumSql('SELECT 1;\n'));
  });

  test('loads exact SQL text with its full filename and checksum', (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'givemegame-migrations-'));
    t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(tempDir, '001_example.sql'), 'abc', 'utf8');

    assert.deepEqual(loadMigrationEntries(tempDir, ['001_example.sql']), [{
      filename: '001_example.sql',
      sql: 'abc',
      checksum: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    }]);
  });

  test('stops when a tracked filename has a different checksum', () => {
    const entry = {
      filename: '026_billing.sql',
      checksum: 'a'.repeat(64),
      sql: '-- current migration'
    };

    assert.throws(
      () => verifyAppliedChecksums([entry], [
        { filename: entry.filename, checksum: 'b'.repeat(64) }
      ]),
      /Checksum mismatch for 026_billing\.sql/
    );
  });

  test('refuses to replay untracked history before a later tracked migration', () => {
    const entries = [
      { filename: '025_level_perks.sql', checksum: 'a'.repeat(64), sql: '-- old history' },
      { filename: '026_billing.sql', checksum: 'b'.repeat(64), sql: '-- later tracked release' }
    ];

    assert.throws(
      () => verifyAppliedChecksums(entries, [{
        filename: entries[1].filename,
        checksum: entries[1].checksum
      }]),
      /Untracked migration 025_level_perks\.sql precedes a tracked migration.*unsafe historical replay/i
    );
  });
});

describe('transactional migration tracking', () => {
  test('derives the legacy-016 signature only from exact legacy columns without later artifacts', async () => {
    const exactLegacy = {
      tracking_table_exists: false,
      known_schema_exists: true,
      legacy_user_billing_exists: true,
      legacy_billing_events_exists: true,
      user_billing_columns: [
        'billing_state_updated_at', 'created_at', 'current_period_end', 'id', 'plan_code',
        'stripe_customer_id', 'stripe_price_id', 'stripe_subscription_id',
        'subscription_status', 'updated_at', 'user_id'
      ],
      billing_event_columns: ['event_type', 'id', 'processed_at', 'stripe_event_id'],
      later_schema_artifacts_exist: false,
      legacy_016_verified: true
    };
    const inspect = async (overrides) => inspectBootstrapState({
      async query() {
        return { rows: [{ ...exactLegacy, ...overrides }] };
      }
    });

    assert.equal((await inspect({})).legacy_016_verified, true);
    assert.equal((await inspect({
      user_billing_columns: [...exactLegacy.user_billing_columns, 'billing_note', 'paid_access_enabled'].sort()
    })).legacy_016_verified, true, 'atomic legacy 017 columns remain compatible with a 016 upgrade');
    assert.equal((await inspect({
      billing_event_columns: [...exactLegacy.billing_event_columns, 'type']
    })).legacy_016_verified, false);
    assert.equal((await inspect({
      billing_event_columns: ['event_type', 'id', 'stripe_event_id']
    })).legacy_016_verified, false);
    assert.equal((await inspect({ later_schema_artifacts_exist: true })).legacy_016_verified, false);
  });

  test('keeps the fresh database path working with an empty schema and tracker', async () => {
    const entry = {
      filename: '001_profiles_and_follows.sql',
      checksum: '0'.repeat(64),
      sql: '-- fresh schema migration'
    };
    const calls = [];
    const client = {
      async query(text) {
        calls.push(text);
        if (/known_schema_exists/.test(text)) {
          return {
            rows: [{ tracking_table_exists: false, known_schema_exists: false, legacy_016_verified: false }]
          };
        }
        if (/SELECT filename, checksum/.test(text)) return { rows: [] };
        return { rows: [] };
      }
    };

    const result = await runMigrations(client, [entry], () => {});

    assert.deepEqual(result, { applied: 1, skipped: 0 });
    assert.equal(calls.includes(entry.sql), true);
    assert.equal(WRITE_SQL.test(calls[0]), false, 'bootstrap inspection must be read-only and first');
  });

  test('refuses unsafe replay when tracking is empty but known application schema exists', async () => {
    const entry = {
      filename: '026_billing.sql',
      checksum: '1'.repeat(64),
      sql: '-- must not replay'
    };
    const calls = [];
    const client = {
      async query(text) {
        calls.push(text);
        if (/known_schema_exists/.test(text)) {
          return {
            rows: [{
              tracking_table_exists: false,
              known_schema_exists: true,
              legacy_user_billing_exists: true,
              legacy_billing_events_exists: true,
              user_billing_columns: [
                'billing_state_updated_at', 'created_at', 'current_period_end', 'id', 'plan_code',
                'stripe_customer_id', 'stripe_price_id', 'stripe_subscription_id',
                'subscription_status', 'updated_at', 'user_id'
              ],
              billing_event_columns: ['event_type', 'id', 'processed_at', 'stripe_event_id'],
              later_schema_artifacts_exist: false
            }]
          };
        }
        if (/SELECT filename, checksum/.test(text)) return { rows: [] };
        return { rows: [] };
      }
    };

    await assert.rejects(
      () => runMigrations(client, [entry], () => {}),
      (error) => {
        assert.match(
          error.message,
          /refusing unsafe replay.*controlled DBA baseline.*outside this runner.*upgrade-legacy-016/i
        );
        assert.doesNotMatch(error.message, /postgres(?:ql)?:\/\//i);
        return true;
      }
    );
    assert.equal(calls.includes('BEGIN'), false);
    assert.equal(calls.includes(entry.sql), false);
    assert.equal(
      calls.some((text) => /INSERT INTO public\.givemegame_schema_migrations/.test(text)),
      false
    );
    assert.deepEqual(
      calls.filter((text) => WRITE_SQL.test(text)),
      [],
      'unsafe existing schema must be refused before any write statement'
    );
    assert.equal(
      calls.some((text) => /COUNT\(\*\)::int AS tracked_count/.test(text)),
      false,
      'missing tracker must not be counted'
    );
  });

  test('refuses an empty existing tracker before writes after a separate read-only count', async () => {
    const calls = [];
    const client = {
      async query(text) {
        calls.push(text);
        if (/known_schema_exists/.test(text)) {
          return {
            rows: [{
              tracking_table_exists: true,
              known_schema_exists: true,
              legacy_user_billing_exists: true,
              legacy_billing_events_exists: true,
              user_billing_columns: ['id', 'user_id'],
              billing_event_columns: ['event_type', 'id', 'processed_at', 'stripe_event_id', 'type'],
              later_schema_artifacts_exist: true
            }]
          };
        }
        if (/COUNT\(\*\)::int AS tracked_count/.test(text)) {
          return { rows: [{ tracked_count: 0 }] };
        }
        return { rows: [] };
      }
    };

    await assert.rejects(
      () => runMigrations(client, [{
        filename: '026_billing.sql', checksum: '1'.repeat(64), sql: '-- must not replay'
      }], () => {}),
      /controlled DBA baseline/
    );
    assert.equal(calls.length, 2, 'inspection and tracker count are the only queries');
    assert.equal(calls.every((text) => !WRITE_SQL.test(text)), true);
  });

  test('allows a verified legacy 016 upgrade only through the explicit upgrade mode', async () => {
    const entry = {
      filename: '026_billing.sql',
      checksum: '1'.repeat(64),
      sql: '-- reconcile legacy 016'
    };
    const calls = [];
    const client = {
      async query(text) {
        calls.push(text);
        if (/known_schema_exists/.test(text)) {
          return {
            rows: [{
              tracking_table_exists: false,
              known_schema_exists: true,
              legacy_user_billing_exists: true,
              legacy_billing_events_exists: true,
              user_billing_columns: [
                'billing_state_updated_at', 'created_at', 'current_period_end', 'id', 'plan_code',
                'stripe_customer_id', 'stripe_price_id', 'stripe_subscription_id',
                'subscription_status', 'updated_at', 'user_id'
              ],
              billing_event_columns: ['event_type', 'id', 'processed_at', 'stripe_event_id'],
              later_schema_artifacts_exist: false
            }]
          };
        }
        if (/SELECT filename, checksum/.test(text)) return { rows: [] };
        return { rows: [] };
      }
    };

    const result = await runMigrations(client, [entry], () => {}, { allowLegacy016: true });

    assert.deepEqual(result, { applied: 1, skipped: 0 });
    assert.equal(calls.includes(entry.sql), true);
  });

  test('legacy upgrade mode fails closed when the 016 schema cannot be verified', async () => {
    const entry = {
      filename: '026_billing.sql',
      checksum: '1'.repeat(64),
      sql: '-- must not apply'
    };
    const calls = [];
    const client = {
      async query(text) {
        calls.push(text);
        if (/known_schema_exists/.test(text)) {
          return {
            rows: [{
              tracking_table_exists: false,
              known_schema_exists: true,
              legacy_user_billing_exists: true,
              legacy_billing_events_exists: true,
              user_billing_columns: [
                'billing_state_updated_at', 'created_at', 'current_period_end', 'id', 'plan_code',
                'stripe_customer_id', 'stripe_price_id', 'stripe_subscription_id',
                'subscription_status', 'updated_at', 'user_id'
              ],
              billing_event_columns: [
                'event_type', 'id', 'payload', 'processed_at', 'stripe_event_created_at',
                'stripe_event_id', 'subscription_id', 'type', 'user_id'
              ],
              later_schema_artifacts_exist: true
            }]
          };
        }
        return { rows: [] };
      }
    };

    await assert.rejects(
      () => runMigrations(client, [entry], () => {}, { allowLegacy016: true }),
      /Legacy 016 schema verification failed/
    );
    assert.deepEqual(
      calls.filter((text) => WRITE_SQL.test(text)),
      [],
      'partial or later schemas must fail legacy override before any write statement'
    );
  });

  test('skips matching tracked migrations and applies only pending entries in order', async () => {
    const entries = [
      { filename: '026_billing.sql', checksum: '1'.repeat(64), sql: '-- already applied' },
      { filename: '027_billing_consent.sql', checksum: '2'.repeat(64), sql: '-- pending' }
    ];
    const calls = [];
    const messages = [];
    const client = {
      async query(text, params) {
        calls.push({ text, params });
        if (/known_schema_exists/.test(text)) {
          return {
            rows: [{ tracking_table_exists: true, known_schema_exists: true, legacy_016_verified: false }]
          };
        }
        if (/COUNT\(\*\)::int AS tracked_count/.test(text)) {
          return { rows: [{ tracked_count: 1 }] };
        }
        if (/SELECT filename, checksum/.test(text)) {
          return {
            rows: [{ filename: entries[0].filename, checksum: entries[0].checksum }]
          };
        }
        return { rows: [] };
      }
    };

    const result = await runMigrations(client, entries, (message) => messages.push(message));

    assert.deepEqual(result, { applied: 1, skipped: 1 });
    assert.equal(calls.some((call) => call.text === entries[0].sql), false);
    assert.equal(calls.some((call) => call.text === entries[1].sql), true);
    assert.deepEqual(messages, [
      `Already applied: ${entries[0].filename}`,
      `Applied: ${entries[1].filename}`
    ]);
  });

  test('preflights every selected checksum before applying any pending migration', async () => {
    const entries = [
      { filename: '026_billing.sql', checksum: '1'.repeat(64), sql: '-- pending' },
      { filename: '027_billing_consent.sql', checksum: '2'.repeat(64), sql: '-- changed' }
    ];
    const calls = [];
    const client = {
      async query(text) {
        calls.push(text);
        if (/known_schema_exists/.test(text)) {
          return {
            rows: [{ tracking_table_exists: true, known_schema_exists: true, legacy_016_verified: false }]
          };
        }
        if (/COUNT\(\*\)::int AS tracked_count/.test(text)) {
          return { rows: [{ tracked_count: 1 }] };
        }
        if (/SELECT filename, checksum/.test(text)) {
          return {
            rows: [{ filename: entries[1].filename, checksum: '9'.repeat(64) }]
          };
        }
        return { rows: [] };
      }
    };

    await assert.rejects(
      () => runMigrations(client, entries, () => {}),
      /Checksum mismatch for 027_billing_consent\.sql/
    );
    assert.equal(calls.includes('BEGIN'), false);
    assert.equal(calls.includes(entries[0].sql), false);
  });

  test('records the full filename and checksum in the same successful transaction', async () => {
    const entry = {
      filename: '018_plan_usage_daily.sql',
      checksum: 'd'.repeat(64),
      sql: 'ALTER TABLE profiles ADD COLUMN daily_usage integer;'
    };
    const calls = [];
    const client = {
      async query(text, params) {
        calls.push({ text, params });
        return { rows: [] };
      }
    };

    await applyMigration(client, entry);

    assert.equal(calls.length, 4);
    assert.deepEqual(
      [calls[0].text, calls[1].text, calls[3].text],
      ['BEGIN', entry.sql, 'COMMIT']
    );
    assert.match(
      calls[2].text,
      /INSERT INTO public\.givemegame_schema_migrations \(filename, checksum\)/
    );
    assert.deepEqual(calls[2].params, [entry.filename, entry.checksum]);
  });

  test('rolls back and never tracks a partially applied migration, including already-exists failures', async () => {
    const entry = {
      filename: '026_billing.sql',
      checksum: 'c'.repeat(64),
      sql: 'CREATE TABLE billing_subscriptions (...);'
    };
    const calls = [];
    const client = {
      async query(text, params) {
        calls.push({ text, params });
        if (text === entry.sql) {
          const error = new Error('relation "billing_subscriptions" already exists');
          error.code = '42P07';
          throw error;
        }
        return { rows: [] };
      }
    };

    await assert.rejects(
      () => applyMigration(client, entry),
      /026_billing\.sql failed.*42P07.*no tracking record was written/i
    );
    assert.deepEqual(calls.map((call) => call.text), ['BEGIN', entry.sql, 'ROLLBACK']);
    assert.equal(
      calls.some((call) => call.text.includes('givemegame_schema_migrations')),
      false
    );
  });
});
