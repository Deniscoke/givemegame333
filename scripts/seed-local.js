#!/usr/bin/env node
'use strict';
/* ═══════════════════════════════════════════════════════════════════
   gIVEMEGAME.IO — Seed LOCAL Supabase with test accounts and data
   Použitie: npm run db:local:seed   (po db:local:start + db:local:migrate)

   Refuses to run against anything that is not 127.0.0.1 / localhost.
   Safe to run repeatedly: users are created once (password re-set),
   rows use fixed UUIDs / unique keys with ON CONFLICT.

   Reads the local API URL, service_role key and DB URL from
   `supabase status -o env --workdir <repo>` or from the env vars
   LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, LOCAL_SUPABASE_DB_URL.
   The service_role key is never printed or written anywhere.
   ═══════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const LOCAL_ENV_PATH = path.join(REPO_ROOT, '.env.local');

/**
 * Local-only test password shared by every seeded account. It is never
 * committed: it comes from env LOCAL_TEST_PASSWORD, else from the git-ignored
 * .env.local, else a random one is generated and appended to .env.local.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [envFile]
 * @returns {string}
 */
function getLocalTestPassword(env = process.env, envFile = LOCAL_ENV_PATH) {
	if (env.LOCAL_TEST_PASSWORD) return env.LOCAL_TEST_PASSWORD;
	const text = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
	const m = /^LOCAL_TEST_PASSWORD=(.+)$/m.exec(text);
	if (m) return m[1].trim().replace(/^"|"$/g, '');
	const generated = `Gmg-${crypto.randomBytes(12).toString('base64url')}`;
	const prefix = text && !text.endsWith('\n') ? '\n' : '';
	fs.appendFileSync(envFile, `${prefix}# Password for the seeded local test accounts (local only)\nLOCAL_TEST_PASSWORD=${generated}\n`, { encoding: 'utf8', mode: 0o600 });
	return generated;
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

const ACCOUNTS = Object.freeze([
	{ key: 'admin', email: 'admin@givemegame.local', name: 'Admin Lokálny', tier: 'admin', coins: 1000, schoolRole: 'admin' },
	{ key: 'teacher', email: 'teacher@givemegame.local', name: 'Učiteľka Testová', tier: 'teacher', coins: 1000, schoolRole: 'teacher' },
	{ key: 'student', email: 'student@givemegame.local', name: 'Žiak Prvý', tier: 'free', coins: 500, schoolRole: 'student' },
	{ key: 'student2', email: 'student2@givemegame.local', name: 'Žiačka Druhá', tier: 'free', coins: 500, schoolRole: 'student' }
]);

const IDS = Object.freeze({
	school: '6a1e0000-0000-4000-8000-000000000001',
	class: '6a1e0000-0000-4000-8000-000000000002',
	subject: '6a1e0000-0000-4000-8000-000000000003',
	preAssessment: '6a1e0000-0000-4000-8000-000000000010',
	postAssessment: '6a1e0000-0000-4000-8000-000000000020'
});

const QUESTIONS = Object.freeze([
	{
		suffix: '1', type: 'multiple_choice',
		prompt: 'Čo je hlavným cieľom podnikateľského plánu?',
		options: ['Opísať nápad, zákazníkov a financie', 'Vyzdobiť kanceláriu', 'Vybrať farbu loga'],
		correct: ['Opísať nápad, zákazníkov a financie'], points: 2
	},
	{
		suffix: '2', type: 'multiple_choice',
		prompt: 'Kto je zákazník?',
		options: ['Človek, ktorý platí za produkt alebo službu', 'Konkurent', 'Dodávateľ'],
		correct: ['Človek, ktorý platí za produkt alebo službu'], points: 1
	},
	{
		suffix: '3', type: 'scale_1_5',
		prompt: 'Nakoľko si veríš, že vieš predstaviť svoj nápad spolužiakom? (1–5)',
		options: null, correct: null, points: 1
	},
	{
		suffix: '4', type: 'text',
		prompt: 'Opíš jedným-dvomi vetami svoj podnikateľský nápad.',
		options: null, correct: null, points: 3
	}
]);

/** @param {string} value @returns {boolean} */
function isLocalUrl(value) {
	try {
		return LOCAL_HOSTS.has(new URL(value).hostname);
	} catch {
		return false;
	}
}

/** @param {string} text @returns {Record<string,string>} */
function parseEnvOutput(text) {
	const out = {};
	for (const line of String(text).split(/\r?\n/)) {
		const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
		if (!m) continue;
		out[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
	}
	return out;
}

function readLocalStatus() {
	const cmd = `npx --yes supabase@3.2.0 status -o env --workdir "${REPO_ROOT}"`;
	try {
		return parseEnvOutput(execSync(cmd, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }));
	} catch {
		throw new Error('Could not read `supabase status`. Is the local stack running? (npm run db:local:start)');
	}
}

function resolveConfig(env = process.env) {
	let apiUrl = env.LOCAL_SUPABASE_URL || '';
	let serviceKey = env.LOCAL_SUPABASE_SERVICE_ROLE_KEY || '';
	let dbUrl = env.LOCAL_SUPABASE_DB_URL || '';
	if (!apiUrl || !serviceKey || !dbUrl) {
		const status = readLocalStatus();
		apiUrl = apiUrl || status.API_URL || '';
		serviceKey = serviceKey || status.SERVICE_ROLE_KEY || '';
		dbUrl = dbUrl || status.DB_URL || '';
	}
	if (!apiUrl || !serviceKey || !dbUrl) {
		throw new Error('Local Supabase URL, service_role key or DB URL is missing.');
	}
	if (!isLocalUrl(apiUrl) || !isLocalUrl(dbUrl)) {
		throw new Error('Refusing to seed: the target is not 127.0.0.1/localhost.');
	}
	return { apiUrl: apiUrl.replace(/\/+$/, ''), serviceKey, dbUrl };
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

async function ensureUsers(cfg) {
	const list = await adminFetch(cfg, 'GET', '/admin/users?page=1&per_page=1000');
	const existing = new Map((list.users || []).map((u) => [String(u.email).toLowerCase(), u]));
	const password = getLocalTestPassword();
	const ids = {};
	for (const acc of ACCOUNTS) {
		const found = existing.get(acc.email);
		if (found) {
			await adminFetch(cfg, 'PUT', `/admin/users/${found.id}`, {
				password,
				email_confirm: true,
				user_metadata: { full_name: acc.name }
			});
			ids[acc.key] = found.id;
			console.log(`User exists (password reset): ${acc.email}`);
		} else {
			const created = await adminFetch(cfg, 'POST', '/admin/users', {
				email: acc.email,
				password,
				email_confirm: true,
				user_metadata: { full_name: acc.name }
			});
			ids[acc.key] = created.id;
			console.log(`User created: ${acc.email}`);
		}
	}
	return ids;
}

async function seedDatabase(client, ids) {
	await client.query('BEGIN');
	try {
		for (const acc of ACCOUNTS) {
			await client.query(
				`INSERT INTO public.profiles (id, display_name, email, tier, coins)
				 VALUES ($1, $2, $3, $4, $5)
				 ON CONFLICT (id) DO UPDATE SET
				   display_name = EXCLUDED.display_name,
				   email = EXCLUDED.email,
				   tier = EXCLUDED.tier,
				   coins = GREATEST(COALESCE(public.profiles.coins, 0), EXCLUDED.coins),
				   updated_at = now()`,
				[ids[acc.key], acc.name, acc.email, acc.tier, acc.coins]
			);
		}

		await client.query(
			`INSERT INTO public.edu_schools (id, name, address, type)
			 VALUES ($1, 'ZŠ Lokálna (test)', 'Testovacia 1, Bratislava', 'basic_school')
			 ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, archived_at = NULL`,
			[IDS.school]
		);

		for (const acc of ACCOUNTS) {
			await client.query(
				`INSERT INTO public.edu_school_memberships (school_id, user_id, role)
				 VALUES ($1, $2, $3)
				 ON CONFLICT (school_id, user_id) DO UPDATE SET role = EXCLUDED.role, archived_at = NULL`,
				[IDS.school, ids[acc.key], acc.schoolRole]
			);
		}

		await client.query(
			`INSERT INTO public.edu_classes (id, school_id, name, grade_level, school_year)
			 VALUES ($1, $2, '7.A', 7, '2026/2027')
			 ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, archived_at = NULL`,
			[IDS.class, IDS.school]
		);

		await client.query(
			`INSERT INTO public.edu_subjects (id, school_id, name, abbreviation)
			 VALUES ($1, $2, 'Podnikavosť', 'POD')
			 ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
			[IDS.subject, IDS.school]
		);

		await client.query(
			`INSERT INTO public.edu_teaching_assignments (class_id, subject_id, teacher_id)
			 VALUES ($1, $2, $3)
			 ON CONFLICT (class_id, subject_id, teacher_id) DO NOTHING`,
			[IDS.class, IDS.subject, ids.teacher]
		);

		for (const key of ['student', 'student2']) {
			await client.query(
				`INSERT INTO public.edu_class_enrollments (class_id, student_id)
				 VALUES ($1, $2)
				 ON CONFLICT (class_id, student_id) DO UPDATE SET archived_at = NULL`,
				[IDS.class, ids[key]]
			);
		}

		const assessments = [
			{ id: IDS.preAssessment, type: 'pre', title: 'INVOK Podnikavosť — vstupný test', prefix: '6a1e0000-0000-4000-8000-0000000001' },
			{ id: IDS.postAssessment, type: 'post', title: 'INVOK Podnikavosť — výstupný test', prefix: '6a1e0000-0000-4000-8000-0000000002' }
		];
		for (const a of assessments) {
			await client.query(
				`INSERT INTO public.assessments (id, title, description, module_key, assessment_type, created_by, is_active)
				 VALUES ($1, $2, 'Ukážkový test pre lokálne testovanie.', 'entrepreneurship', $3, $4, true)
				 ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, is_active = true`,
				[a.id, a.title, a.type, ids.teacher]
			);
			for (const [index, q] of QUESTIONS.entries()) {
				await client.query(
					`INSERT INTO public.assessment_questions
					   (id, assessment_id, question_order, question_type, prompt, options, correct_answer, max_points)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
					 ON CONFLICT (id) DO UPDATE SET
					   question_order = EXCLUDED.question_order,
					   question_type = EXCLUDED.question_type,
					   prompt = EXCLUDED.prompt,
					   options = EXCLUDED.options,
					   correct_answer = EXCLUDED.correct_answer,
					   max_points = EXCLUDED.max_points`,
					[
						`${a.prefix}0${q.suffix}`, a.id, index, q.type, q.prompt,
						q.options ? JSON.stringify(q.options) : null,
						q.correct ? JSON.stringify(q.correct) : null,
						q.points
					]
				);
			}
		}

		await client.query('COMMIT');
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	}
}

async function main() {
	const cfg = resolveConfig();
	const ids = await ensureUsers(cfg);

	const { Client } = require('pg');
	const client = new Client({ connectionString: cfg.dbUrl });
	await client.connect();
	try {
		await seedDatabase(client, ids);
	} finally {
		await client.end();
	}

	console.log('\nLocal seed complete. Test accounts (password = LOCAL_TEST_PASSWORD in .env.local):');
	for (const acc of ACCOUNTS) console.log(`  ${acc.schoolRole.padEnd(8)} ${acc.email}`);
}

if (require.main === module) {
	main().catch((error) => {
		console.error(`[seed-local] ${error.message}`);
		process.exitCode = 1;
	});
}

module.exports = { isLocalUrl, parseEnvOutput, resolveConfig, ACCOUNTS, getLocalTestPassword };
