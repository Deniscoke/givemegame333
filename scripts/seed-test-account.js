#!/usr/bin/env node
'use strict';
/* ═══════════════════════════════════════════════════════════════════
   gIVEMEGAME.IO — Seed ONE test account with everything unlocked (Phase 10)
   Použitie: npm run db:local:seed-test [-- --dry-run]

   The account gets: Pro teacher plan (SMARTA Pro), RPG XP 55000 (level 10,
   so every pet and every perk is unlocked), every talent row, an avatar,
   plenty of coins, a school membership as teacher AND (in a second school)
   as student, and profiles.is_test_account = true (excluded from reports).

   Guard rails
   - Local (127.0.0.1 / localhost API + DB): allowed. Password is the shared
     LOCAL_TEST_PASSWORD mechanism from seed-local.js (env, .env.local, or
     generated into the git-ignored .env.local). Never printed.
   - Anything else: refused unless ALLOW_TEST_SEED=1 AND the account email is
     in TEST_ACCOUNT_EMAILS (comma separated) AND TEST_ACCOUNT_PASSWORD is set.
     Remote target comes from SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and
     SUPABASE_DB_URL.
   - --dry-run prints the plan and writes nothing (no user, no DB, no file).
   - Idempotent: every write is an upsert / ON CONFLICT.
   ═══════════════════════════════════════════════════════════════════ */

const { isLocalUrl, resolveConfig, getLocalTestPassword } = require('./seed-local');
const { VALID_TALENT_IDS } = require('../lib/rpg-talents');
const { PLAN_PRO } = require('../lib/plan-entitlements');

const DEFAULT_EMAIL = 'tester@givemegame.local';
const DISPLAY_NAME = 'Tester Všetko Odomknuté';
const TARGET_XP = 55000; // level 10 (lib/rpg-progression.js XP_THRESHOLDS)
const TARGET_COINS = 50000;
const AVATAR_ID = 2;
const MIN_REMOTE_PASSWORD_LENGTH = 12;

const IDS = Object.freeze({
	teacherSchool: '6a1e0000-0000-4000-8000-0000000000a1',
	teacherClass: '6a1e0000-0000-4000-8000-0000000000a2',
	subject: '6a1e0000-0000-4000-8000-0000000000a3',
	studentSchool: '6a1e0000-0000-4000-8000-0000000000b1',
	studentClass: '6a1e0000-0000-4000-8000-0000000000b2'
});

/** @param {string[]} argv */
function parseArgs(argv) {
	const out = { dryRun: false };
	for (const arg of argv) {
		if (arg === '--dry-run') out.dryRun = true;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	return out;
}

/** @param {string} value @returns {string[]} */
function parseAllowlist(value) {
	return String(value || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * Decide whether the seed may run. Pure: no I/O.
 * @param {{ apiUrl: string, dbUrl: string }} target
 * @param {string} email
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ ok: true, mode: 'local'|'remote' } | { ok: false, reason: string }}
 */
function evaluateGuards(target, email, env = process.env) {
	if (isLocalUrl(target.apiUrl) && isLocalUrl(target.dbUrl)) return { ok: true, mode: 'local' };
	if (env.ALLOW_TEST_SEED !== '1') {
		return { ok: false, reason: 'Refusing to seed a non-local target: set ALLOW_TEST_SEED=1.' };
	}
	if (!parseAllowlist(env.TEST_ACCOUNT_EMAILS).includes(String(email).toLowerCase())) {
		return { ok: false, reason: 'Refusing to seed a non-local target: the account email is not in TEST_ACCOUNT_EMAILS.' };
	}
	if (!env.TEST_ACCOUNT_PASSWORD || env.TEST_ACCOUNT_PASSWORD.length < MIN_REMOTE_PASSWORD_LENGTH) {
		return { ok: false, reason: `Remote seed needs TEST_ACCOUNT_PASSWORD (min ${MIN_REMOTE_PASSWORD_LENGTH} characters) in the environment.` };
	}
	return { ok: true, mode: 'remote' };
}

/** Where the seed will write. Local default; remote only via explicit env. */
function resolveTarget(env = process.env) {
	if (env.ALLOW_TEST_SEED === '1' && (env.SUPABASE_URL && !isLocalUrl(env.SUPABASE_URL))) {
		if (!env.SUPABASE_SERVICE_ROLE_KEY || !env.SUPABASE_DB_URL) {
			throw new Error('Remote seed needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_DB_URL.');
		}
		return {
			apiUrl: env.SUPABASE_URL.replace(/\/+$/, ''),
			serviceKey: env.SUPABASE_SERVICE_ROLE_KEY,
			dbUrl: env.SUPABASE_DB_URL
		};
	}
	return resolveConfig(env);
}

/** Human-readable list of what a run does (no secrets). */
function buildPlan(email) {
	return [
		`auth user ${email} (create, or re-set password; email confirmed)`,
		`profile: tier=teacher, rpg_xp>=${TARGET_XP} (level 10), coins>=${TARGET_COINS}, avatar ${AVATAR_ID}, is_test_account=true`,
		`billing: user_billing plan ${PLAN_PRO} (paid_access_enabled) + billing_subscriptions teacher/active`,
		`talents: ${VALID_TALENT_IDS.length} rows in rpg_user_talents`,
		'school A: teacher membership + class + subject + teaching assignment',
		'school B: student membership + class enrollment',
		'pets and perks: unlocked by level 10 (no rows needed)'
	];
}

/**
 * All DB writes, in one transaction. Every statement is an upsert.
 * @param {{ query: Function }} client
 * @param {string} userId
 * @param {string} email
 */
async function seedTestAccountDb(client, userId, email) {
	await client.query('BEGIN');
	try {
		await client.query(
			`INSERT INTO public.profiles (id, display_name, email, tier, coins, rpg_xp, rpg_avatar_id, is_test_account)
			 VALUES ($1, $2, $3, 'teacher', $4, $5, $6, true)
			 ON CONFLICT (id) DO UPDATE SET
			   display_name = EXCLUDED.display_name,
			   email = EXCLUDED.email,
			   tier = 'teacher',
			   coins = GREATEST(COALESCE(public.profiles.coins, 0), EXCLUDED.coins),
			   rpg_xp = GREATEST(COALESCE(public.profiles.rpg_xp, 0), EXCLUDED.rpg_xp),
			   rpg_avatar_id = EXCLUDED.rpg_avatar_id,
			   is_test_account = true,
			   updated_at = now()`,
			[userId, DISPLAY_NAME, email, TARGET_COINS, TARGET_XP, AVATAR_ID]
		);

		await client.query(
			`INSERT INTO public.user_billing (user_id, plan_code, subscription_status, paid_access_enabled, billing_note)
			 VALUES ($1, $2, 'active', true, 'test account (seed-test-account)')
			 ON CONFLICT (user_id) DO UPDATE SET
			   plan_code = EXCLUDED.plan_code,
			   subscription_status = 'active',
			   paid_access_enabled = true,
			   billing_note = EXCLUDED.billing_note,
			   updated_at = now()`,
			[userId, PLAN_PRO]
		);

		await client.query(
			`INSERT INTO public.billing_subscriptions
			   (user_id, tier, stripe_customer_id, stripe_subscription_id, status, current_period_end)
			 VALUES ($1, 'teacher', $2, $3, 'active', now() + interval '10 years')
			 ON CONFLICT (stripe_subscription_id) DO UPDATE SET
			   status = 'active',
			   tier = 'teacher',
			   current_period_end = EXCLUDED.current_period_end,
			   updated_at = now()`,
			[userId, `cus_test_${userId}`, `sub_test_${userId}`]
		);

		for (const talentId of VALID_TALENT_IDS) {
			await client.query(
				`INSERT INTO public.rpg_user_talents (user_id, talent_id)
				 VALUES ($1, $2)
				 ON CONFLICT (user_id, talent_id) DO NOTHING`,
				[userId, talentId]
			);
		}

		await client.query(
			`INSERT INTO public.edu_schools (id, name, address, type)
			 VALUES ($1, 'ZŠ Testovacia A (učiteľ)', 'Testovacia 1, Bratislava', 'basic_school'),
			        ($2, 'ZŠ Testovacia B (žiak)', 'Testovacia 2, Bratislava', 'basic_school')
			 ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, archived_at = NULL`,
			[IDS.teacherSchool, IDS.studentSchool]
		);
		await client.query(
			`INSERT INTO public.edu_school_memberships (school_id, user_id, role)
			 VALUES ($1, $3, 'teacher'), ($2, $3, 'student')
			 ON CONFLICT (school_id, user_id) DO UPDATE SET role = EXCLUDED.role, archived_at = NULL`,
			[IDS.teacherSchool, IDS.studentSchool, userId]
		);
		await client.query(
			`INSERT INTO public.edu_classes (id, school_id, name, grade_level, school_year)
			 VALUES ($1, $3, '9.T', 9, '2026/2027'), ($2, $4, '9.Z', 9, '2026/2027')
			 ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, archived_at = NULL`,
			[IDS.teacherClass, IDS.studentClass, IDS.teacherSchool, IDS.studentSchool]
		);
		await client.query(
			`INSERT INTO public.edu_subjects (id, school_id, name, abbreviation)
			 VALUES ($1, $2, 'Podnikavosť (test)', 'POT')
			 ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
			[IDS.subject, IDS.teacherSchool]
		);
		await client.query(
			`INSERT INTO public.edu_teaching_assignments (class_id, subject_id, teacher_id)
			 VALUES ($1, $2, $3)
			 ON CONFLICT (class_id, subject_id, teacher_id) DO NOTHING`,
			[IDS.teacherClass, IDS.subject, userId]
		);
		await client.query(
			`INSERT INTO public.edu_class_enrollments (class_id, student_id)
			 VALUES ($1, $2)
			 ON CONFLICT (class_id, student_id) DO UPDATE SET archived_at = NULL`,
			[IDS.studentClass, userId]
		);

		await client.query('COMMIT');
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	}
}

async function adminFetch(cfg, method, route, body) {
	const res = await fetch(`${cfg.apiUrl}/auth/v1${route}`, {
		method,
		headers: {
			apikey: cfg.serviceKey,
			Authorization: `Bearer ${cfg.serviceKey}`,
			'Content-Type': 'application/json'
		},
		body: body ? JSON.stringify(body) : undefined
	});
	const text = await res.text();
	let json = null;
	try { json = text ? JSON.parse(text) : null; } catch { json = null; }
	if (!res.ok) {
		const msg = (json && (json.msg || json.message || json.error_description || json.error)) || `HTTP ${res.status}`;
		throw new Error(`GoTrue admin ${method} ${route.split('?')[0]} failed: ${msg}`);
	}
	return json;
}

/** Create the auth user or re-set its password. Returns the user id. */
async function ensureUser(cfg, email, password) {
	const list = await adminFetch(cfg, 'GET', '/admin/users?page=1&per_page=1000');
	const found = (list.users || []).find((u) => String(u.email).toLowerCase() === email.toLowerCase());
	const meta = { full_name: DISPLAY_NAME };
	if (found) {
		await adminFetch(cfg, 'PUT', `/admin/users/${found.id}`, { password, email_confirm: true, user_metadata: meta });
		return found.id;
	}
	const created = await adminFetch(cfg, 'POST', '/admin/users', { email, password, email_confirm: true, user_metadata: meta });
	return created.id;
}

async function connectDb(dbUrl) {
	const { Client } = require('pg');
	const client = new Client({ connectionString: dbUrl });
	await client.connect();
	return client;
}

/**
 * Orchestrator. Dependencies are injectable so tests never touch a network.
 * @returns {Promise<{ dryRun: boolean, mode: string, userId?: string }>}
 */
async function run({ argv = [], env = process.env, deps = {}, log = console.log } = {}) {
	const d = { resolveTarget, ensureUser, connectDb, getLocalPassword: getLocalTestPassword, ...deps };
	const { dryRun } = parseArgs(argv);
	const email = (env.TEST_ACCOUNT_EMAIL || DEFAULT_EMAIL).trim().toLowerCase();

	const target = d.resolveTarget(env);
	const guard = evaluateGuards(target, email, env);
	if (!guard.ok) throw new Error(guard.reason);

	if (dryRun) {
		log(`[dry-run] mode=${guard.mode} email=${email}. Nothing will be written. Plan:`);
		for (const line of buildPlan(email)) log(`  - ${line}`);
		return { dryRun: true, mode: guard.mode };
	}

	const password = guard.mode === 'remote' ? env.TEST_ACCOUNT_PASSWORD : d.getLocalPassword();
	const userId = await d.ensureUser(target, email, password);
	const client = await d.connectDb(target.dbUrl);
	try {
		await seedTestAccountDb(client, userId, email);
	} finally {
		await client.end();
	}

	const passwordVar = guard.mode === 'remote' ? 'TEST_ACCOUNT_PASSWORD' : 'LOCAL_TEST_PASSWORD (.env.local)';
	log(`Test account ready (${guard.mode}): ${email}`);
	log(`Password: value of ${passwordVar} (not printed).`);
	return { dryRun: false, mode: guard.mode, userId };
}

if (require.main === module) {
	run({ argv: process.argv.slice(2) }).catch((error) => {
		console.error(`[seed-test-account] ${error.message}`);
		process.exitCode = 1;
	});
}

module.exports = {
	run, parseArgs, parseAllowlist, evaluateGuards, resolveTarget, buildPlan, seedTestAccountDb,
	DEFAULT_EMAIL, TARGET_XP, TARGET_COINS, IDS
};
