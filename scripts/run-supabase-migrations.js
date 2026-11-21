#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
   gIVEMEGAME.IO — Spustenie Supabase migrácií
   Použitie: node scripts/run-supabase-migrations.js [--list | --dry-run]
             [--from 026 | --files 026_billing.sql,027_billing_consent.sql]
             [--upgrade-legacy-016] [--confirm-legacy-upgrade TOKEN]
   Skutočné spustenie potrebuje SUPABASE_DB_URL v lokálnom prostredí.
   ═══════════════════════════════════════════════════════════════════ */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const migrationsDir = path.join(__dirname, '..', 'supabase', 'migrations');
const TRACKING_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS public.givemegame_schema_migrations (
    filename TEXT PRIMARY KEY,
    checksum TEXT NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  REVOKE ALL ON public.givemegame_schema_migrations FROM PUBLIC, anon, authenticated;
  GRANT SELECT, INSERT ON public.givemegame_schema_migrations TO service_role;
`;
const SUPPORTED_MIGRATION_ORDER = Object.freeze([
  '001_profiles_and_follows.sql',
  '002_add_coins_to_profiles.sql',
  '003_giveme_social.sql',
  '004_add_prompt_to_posts.sql',
  '005_quest_log.sql',
  '006_coin_transactions.sql',
  '007_add_scoreboard_to_profiles.sql',
  '008_smarta_styles.sql',
  '009_saved_games.sql',
  '010_narrator_preferences.sql',
  '011_sessions_and_progression.sql',
  '012_reward_validation.sql',
  '013_game_feedback.sql',
  '014_public_token.sql',
  '015_mode_click_daily_cap.sql',
  '016_billing.sql',
  '017_payment_link_manual_billing.sql',
  '018_edu_core.sql',
  '018_plan_usage_daily.sql',
  '020_profiles_add_email.sql',
  '021_audit_append_only.sql',
  '022_rpg_avatar.sql',
  '023_rpg_talents.sql',
  '024_rpg_progression.sql',
  '025_level_perks.sql',
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
  '038_reconcile_browser_only_balances.sql'
]);

const LEGACY_016_RELEASE_ORDER = Object.freeze([
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
  '038_reconcile_browser_only_balances.sql'
]);
const LEGACY_016_USER_BILLING_COLUMNS = Object.freeze([
  'billing_state_updated_at',
  'created_at',
  'current_period_end',
  'id',
  'plan_code',
  'stripe_customer_id',
  'stripe_price_id',
  'stripe_subscription_id',
  'subscription_status',
  'updated_at',
  'user_id'
]);
const LEGACY_017_OPTIONAL_COLUMNS = Object.freeze(['billing_note', 'paid_access_enabled']);
const LEGACY_016_BILLING_EVENT_COLUMNS = Object.freeze([
  'event_type',
  'id',
  'processed_at',
  'stripe_event_id'
]);

function sameColumns(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((column, index) => column === expected[index]);
}

function isExclusiveLegacy016State(state) {
  if (!state.legacy_user_billing_exists || !state.legacy_billing_events_exists) return false;
  const baseUserBilling = [...LEGACY_016_USER_BILLING_COLUMNS];
  const withLegacy017 = [...baseUserBilling, ...LEGACY_017_OPTIONAL_COLUMNS].sort();
  const exactUserBilling = sameColumns(state.user_billing_columns, baseUserBilling)
    || sameColumns(state.user_billing_columns, withLegacy017);
  return exactUserBilling
    && sameColumns(state.billing_event_columns, LEGACY_016_BILLING_EVENT_COLUMNS)
    && state.later_schema_artifacts_exist === false;
}

function checksumSql(sql) {
  return crypto.createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

function loadMigrationEntries(directory, filenames) {
  return filenames.map((filename) => {
    const sql = fs.readFileSync(path.join(directory, filename), 'utf8');
    return {
      filename,
      sql,
      checksum: checksumSql(sql)
    };
  });
}

function validateMigrationCatalog(supportedOrder, filesOnDisk) {
  const configured = [...supportedOrder];
  const active = filesOnDisk.filter((name) => name.endsWith('.sql'));
  const duplicates = configured.filter((name, index) => configured.indexOf(name) !== index);
  const missing = configured.filter((name) => !active.includes(name));
  const unsupported = active.filter((name) => !configured.includes(name));

  if (duplicates.length > 0) {
    throw new Error(`Duplicate migrations in supported order: ${duplicates.join(', ')}`);
  }
  if (missing.length > 0) {
    throw new Error(`Configured migrations missing from disk: ${missing.join(', ')}`);
  }
  if (unsupported.length > 0) {
    throw new Error(`Active migrations missing from supported order: ${unsupported.join(', ')}`);
  }

  for (let index = 1; index < configured.length; index += 1) {
    const previous = Number(configured[index - 1].slice(0, 3));
    const current = Number(configured[index].slice(0, 3));
    if (!Number.isInteger(previous) || !Number.isInteger(current) || current < previous) {
      throw new Error('Supported migration order is not deterministic by numeric prefix.');
    }
  }

  return configured;
}

function parseCliArgs(argv) {
  const options = {
    dryRun: false,
    list: false,
    from: null,
    files: null,
    upgradeLegacy016: false,
    confirmation: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--list') {
      options.list = true;
    } else if (arg === '--upgrade-legacy-016') {
      if (options.upgradeLegacy016) {
        throw new Error('--upgrade-legacy-016 may be specified only once.');
      }
      options.upgradeLegacy016 = true;
    } else if (arg === '--confirm-legacy-upgrade') {
      if (options.confirmation !== null) {
        throw new Error('--confirm-legacy-upgrade may be specified only once.');
      }
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--confirm-legacy-upgrade requires the documented confirmation token.');
      }
      options.confirmation = value;
      index += 1;
    } else if (arg === '--from') {
      if (options.from !== null) {
        throw new Error('--from may be specified only once.');
      }
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--from requires a three-digit prefix or exact migration filename.');
      }
      options.from = value;
      index += 1;
    } else if (arg === '--files') {
      if (options.files !== null) {
        throw new Error('--files may be specified only once.');
      }
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--files requires a comma-separated list of exact migration filenames.');
      }
      options.files = value.split(',').map((name) => name.trim());
      if (options.files.some((name) => name.length === 0)) {
        throw new Error('--files contains an empty migration filename.');
      }
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.from && options.files) {
    throw new Error('--from and --files cannot be used together.');
  }
  return options;
}

function selectMigrations(supportedOrder, options = {}) {
  if (options.files) {
    const indexes = options.files.map((name) => supportedOrder.indexOf(name));
    const unknownIndex = indexes.indexOf(-1);
    if (unknownIndex >= 0) {
      throw new Error(`Unknown migration filename: ${options.files[unknownIndex]}`);
    }
    if (new Set(options.files).size !== options.files.length) {
      throw new Error('Exact migration filenames must not contain duplicates.');
    }
    for (let index = 1; index < indexes.length; index += 1) {
      if (indexes[index] <= indexes[index - 1]) {
        throw new Error('Exact migration filenames must follow the supported migration order.');
      }
    }
    return [...options.files];
  }

  if (!options.from) return [...supportedOrder];

  const exactIndex = supportedOrder.indexOf(options.from);
  if (exactIndex < 0 && !/^\d{3}$/.test(options.from)) {
    throw new Error('--from requires a three-digit prefix or exact migration filename.');
  }
  const startIndex = exactIndex >= 0
    ? exactIndex
    : supportedOrder.findIndex((name) => name.startsWith(`${options.from}_`));

  if (startIndex < 0) {
    throw new Error(`Unknown migration selector: ${options.from}`);
  }

  return supportedOrder.slice(startIndex);
}

function validateExecutionMode(options, selected) {
  if (!options.upgradeLegacy016) {
    if (options.confirmation) {
      throw new Error('--confirm-legacy-upgrade is only valid with --upgrade-legacy-016.');
    }
    return { mode: 'migrate' };
  }
  if (options.dryRun || options.list) {
    throw new Error('Bootstrap modes cannot be combined with --dry-run or --list.');
  }
  if (!options.confirmation) {
    throw new Error('The selected bootstrap mode requires --confirm-legacy-upgrade.');
  }

  if (options.from !== '026' || options.files) {
    throw new Error('Legacy 016 upgrade requires --from 026.');
  }
  if (selected.length !== LEGACY_016_RELEASE_ORDER.length
    || selected.some((filename, index) => filename !== LEGACY_016_RELEASE_ORDER[index])) {
    throw new Error('Legacy 016 upgrade requires the complete 026-038 release.');
  }
  if (options.confirmation !== 'legacy-016-to-038') {
    throw new Error('Legacy 016 upgrade confirmation must exactly match legacy-016-to-038.');
  }
  return { mode: 'legacy-016' };
}

function verifyAppliedChecksums(entries, appliedRows) {
  const tracked = new Map(appliedRows.map((row) => [row.filename, row.checksum]));
  const applied = [];
  const pending = [];
  let firstTrackedIndex = -1;

  for (const [index, entry] of entries.entries()) {
    if (!tracked.has(entry.filename)) {
      pending.push(entry);
      continue;
    }
    if (tracked.get(entry.filename) !== entry.checksum) {
      throw new Error(`Checksum mismatch for ${entry.filename}; migration contents changed after being applied.`);
    }
    if (firstTrackedIndex < 0) firstTrackedIndex = index;
    applied.push(entry);
  }

  if (firstTrackedIndex > 0) {
    const historicalGap = entries.slice(0, firstTrackedIndex).find((entry) => !tracked.has(entry.filename));
    if (historicalGap) {
      throw new Error(
        `Untracked migration ${historicalGap.filename} precedes a tracked migration; `
        + 'refusing unsafe historical replay. Select the supported release with --from or --files.'
      );
    }
  }

  return { applied, pending };
}

async function applyMigration(client, entry) {
  await client.query('BEGIN');
  try {
    await client.query(entry.sql);
    await client.query(
      `INSERT INTO public.givemegame_schema_migrations (filename, checksum)
       VALUES ($1, $2)`,
      [entry.filename, entry.checksum]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    const code = typeof error?.code === 'string' ? ` (PostgreSQL ${error.code})` : '';
    const wrapped = new Error(
      `Migration ${entry.filename} failed${code}; transaction rolled back and no tracking record was written.`
    );
    wrapped.cause = error;
    throw wrapped;
  }
}

async function inspectBootstrapState(client) {
  const result = await client.query(`
    SELECT
      to_regclass('public.givemegame_schema_migrations') IS NOT NULL AS tracking_table_exists,
      EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN (
            'profiles', 'user_billing', 'billing_events', 'billing_subscriptions',
            'edu_schools', 'edu_classes', 'assessments', 'assessment_attempts'
          )
      ) AS known_schema_exists,
      to_regclass('public.user_billing') IS NOT NULL AS legacy_user_billing_exists,
      to_regclass('public.billing_events') IS NOT NULL AS legacy_billing_events_exists,
      COALESCE((
        SELECT array_agg(column_name::text ORDER BY column_name)
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'user_billing'
      ), ARRAY[]::text[]) AS user_billing_columns,
      COALESCE((
        SELECT array_agg(column_name::text ORDER BY column_name)
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'billing_events'
      ), ARRAY[]::text[]) AS billing_event_columns,
      (
        to_regclass('public.billing_subscriptions') IS NOT NULL
        OR to_regclass('public.v_billing_consent_audit') IS NOT NULL
        OR to_regclass('public.assessments') IS NOT NULL
        OR to_regclass('public.assessment_attempts') IS NOT NULL
        OR to_regprocedure('public.effective_tier(uuid)') IS NOT NULL
        OR to_regprocedure('public.protect_profile_billing_fields()') IS NOT NULL
        OR to_regprocedure('public.fn_is_educator(uuid)') IS NOT NULL
        OR to_regprocedure('public.fn_can_scope_assessment_attempt(uuid,uuid)') IS NOT NULL
        OR EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'profiles'
            AND column_name IN (
              'tier', 'daily_games_count', 'daily_games_day',
              'withdrawal_consent_at', 'withdrawal_consent_ip', 'withdrawal_consent_text',
              'tos_version', 'privacy_version'
            )
        )
      ) AS later_schema_artifacts_exist
  `);
  const inspected = result.rows[0];
  const state = {
    ...inspected,
    legacy_016_verified: isExclusiveLegacy016State(inspected)
  };
  let trackedCount = 0;
  if (state.tracking_table_exists) {
    const countResult = await client.query(
      'SELECT COUNT(*)::int AS tracked_count FROM public.givemegame_schema_migrations'
    );
    trackedCount = Number(countResult.rows[0]?.tracked_count || 0);
  }
  return { ...state, tracked_count: trackedCount };
}

async function ensureTrackingTable(client) {
  await client.query(TRACKING_TABLE_SQL);
}

function assertSafeBootstrap(state, options = {}) {
  if (Number(state.tracked_count) > 0) return 'tracked';
  if (!state.known_schema_exists) return 'fresh';
  if (options.allowLegacy016 && state.legacy_016_verified) return 'legacy-016';
  if (options.allowLegacy016) {
    throw new Error('Legacy 016 schema verification failed; no migration was applied or tracked.');
  }
  throw new Error(
    'Tracking is empty but known application schema exists; refusing unsafe replay. '
    + 'A controlled DBA baseline or manual reconciliation outside this runner is required; '
    + 'the runner will not record checksums for unverified pre-existing migrations. '
    + 'Use --upgrade-legacy-016 only for a verified legacy 016 schema.'
  );
}

async function runMigrations(client, entries, log = console.log, options = {}) {
  const bootstrapState = await inspectBootstrapState(client);
  assertSafeBootstrap(bootstrapState, options);
  if (!bootstrapState.tracking_table_exists) await ensureTrackingTable(client);

  const trackedResult = await client.query(
    `SELECT filename, checksum
       FROM public.givemegame_schema_migrations
      WHERE filename = ANY($1::text[])`,
    [entries.map((entry) => entry.filename)]
  );
  const state = verifyAppliedChecksums(entries, trackedResult.rows);

  for (const entry of state.applied) log(`Already applied: ${entry.filename}`);
  for (const entry of state.pending) {
    await applyMigration(client, entry);
    log(`Applied: ${entry.filename}`);
  }

  return {
    applied: state.pending.length,
    skipped: state.applied.length
  };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseCliArgs(argv);
  const supportedOrder = validateMigrationCatalog(
    SUPPORTED_MIGRATION_ORDER,
    fs.readdirSync(migrationsDir)
  );
  const selected = selectMigrations(supportedOrder, options);
  const execution = validateExecutionMode(options, selected);

  if (options.list) {
    console.log(`Supported migration order (${supportedOrder.length} active SQL files):`);
    for (const filename of supportedOrder) console.log(filename);
    console.log('Both 018 files are active; disabled 019 files are excluded.');
    return;
  }

  if (options.dryRun) {
    const entries = loadMigrationEntries(migrationsDir, selected);
    console.log(`Dry run: ${entries.length} migration(s) selected; no database connection was opened.`);
    for (const entry of entries) console.log(`${entry.filename}  sha256:${entry.checksum}`);
    return;
  }

  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const url = process.env.SUPABASE_DB_URL;
  if (!url || url.includes('your-')) {
    throw new Error(
      'SUPABASE_DB_URL is not configured. Set it in the local .env file or the current environment.'
    );
  }

  let pg;
  try {
    pg = require('pg');
  } catch {
    throw new Error('The pg runtime dependency is unavailable. Run npm install before migrating.');
  }

  const entries = loadMigrationEntries(migrationsDir, selected);
  const client = new pg.Client({ connectionString: url });
  let connected = false;
  try {
    await client.connect();
    connected = true;
  } catch (error) {
    const code = typeof error?.code === 'string' ? ` (${error.code})` : '';
    throw new Error(`Database connection failed${code}; connection details were not logged.`);
  }

  try {
    console.log(`Connected to the configured database; applying ${entries.length} migration(s).`);
    const result = await runMigrations(client, entries, console.log, {
      allowLegacy016: execution.mode === 'legacy-016'
    });
    console.log(`Migration run complete: ${result.applied} applied, ${result.skipped} already tracked.`);
  } catch (error) {
    if (/^(Checksum mismatch for|Migration \S+ failed|Tracking is empty|Legacy 016|Untracked migration)/
      .test(error?.message || '')) throw error;
    const code = typeof error?.code === 'string' ? ` (${error.code})` : '';
    throw new Error(`Database migration operation failed${code}; connection details were not logged.`);
  } finally {
    if (connected) await client.end();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`Migration runner error: ${e.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  SUPPORTED_MIGRATION_ORDER,
  applyMigration,
  assertSafeBootstrap,
  checksumSql,
  inspectBootstrapState,
  loadMigrationEntries,
  parseCliArgs,
  runMigrations,
  selectMigrations,
  validateExecutionMode,
  validateMigrationCatalog,
  verifyAppliedChecksums
};
