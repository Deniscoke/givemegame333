#!/usr/bin/env node
'use strict';
/* ═══════════════════════════════════════════════════════════════════
   gIVEMEGAME.IO — i18n consistency check (CI)
   Použitie: node scripts/check-i18n.js

   Fails (exit 1) when:
     1. a key exists in one public/data/i18n/*.json file but not in another
        (key parity across sk, cs, en, de, es, tr), or a value is empty;
     2. a key used in public/ — t('key'), _t('key'), givemegame_t('key'),
        data-i18n="key", data-i18n-title / -placeholder / -aria-label —
        has no entry in the language files.
   Dynamic keys (template literals such as t(`mode_${m}`) or prefixes
   such as t('assess_type_' + type)) are skipped.
   ═══════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');
const I18N_DIR = path.join(PUBLIC_DIR, 'data', 'i18n');
const LANGS = ['sk', 'cs', 'en', 'de', 'es', 'tr'];
// Keys starting with "_" (e.g. _meta) are metadata, not UI strings.
const isMetaKey = (key) => key.startsWith('_');
// Folders under public/ that are separate apps with their own i18n (or none).
const SKIP_DIRS = new Set(['data', 'avatars', 'node_modules']);

/**
 * @param {string} [dir]
 * @returns {Record<string, Record<string, unknown>>}
 */
function loadDictionaries(dir = I18N_DIR) {
	const out = {};
	for (const lang of LANGS) {
		out[lang] = JSON.parse(fs.readFileSync(path.join(dir, `${lang}.json`), 'utf8'));
	}
	return out;
}

/**
 * Keys missing (or empty) per language, compared with the union of all keys.
 * @param {Record<string, Record<string, unknown>>} dicts
 * @returns {{ missing: Record<string, string[]>, empty: Record<string, string[]> }}
 */
function findParityProblems(dicts) {
	const all = new Set();
	for (const d of Object.values(dicts)) for (const k of Object.keys(d)) if (!isMetaKey(k)) all.add(k);
	const missing = {};
	const empty = {};
	for (const [lang, d] of Object.entries(dicts)) {
		const miss = [...all].filter((k) => !(k in d)).sort();
		const emp = [...all].filter((k) => k in d && (typeof d[k] !== 'string' || d[k].trim() === '')).sort();
		if (miss.length) missing[lang] = miss;
		if (emp.length) empty[lang] = emp;
	}
	return { missing, empty };
}

const KEY = '([A-Za-z0-9_.-]+)';
const USAGE_PATTERNS = [
	// t('key'  _t('key'  givemegame_t('key'
	new RegExp(`(?:^|[^A-Za-z0-9_$])(?:t|_t|givemegame_t)\\(\\s*(['"])${KEY}\\1(?!\\s*\\+)`, 'g'),
	// (window.givemegame_t || ((k,f)=>f||k))('key'
	new RegExp(`\\|\\|\\s*k\\)\\)\\(\\s*(['"])${KEY}\\1(?!\\s*\\+)`, 'g'),
	// data-i18n="key" and friends in HTML (and in HTML strings inside JS)
	new RegExp(`data-i18n(?:-title|-placeholder|-aria-label)?=(['"])${KEY}\\1`, 'g')
];

/**
 * @param {string} source
 * @returns {string[]} keys referenced by the source text
 */
function extractKeys(source) {
	const keys = new Set();
	for (const re of USAGE_PATTERNS) {
		re.lastIndex = 0;
		let m;
		while ((m = re.exec(source)) !== null) keys.add(m[2]);
	}
	return [...keys];
}

/**
 * @param {string} dir
 * @returns {string[]} .js / .html files under dir
 */
function listSourceFiles(dir = PUBLIC_DIR) {
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			out.push(...listSourceFiles(full));
		} else if (/\.(js|html)$/.test(entry.name)) {
			out.push(full);
		}
	}
	return out;
}

/**
 * @param {Record<string, Record<string, unknown>>} dicts
 * @param {string[]} files
 * @returns {Array<{ key: string, file: string, langs: string[] }>}
 */
function findUnknownKeys(dicts, files) {
	const problems = [];
	for (const file of files) {
		const src = fs.readFileSync(file, 'utf8');
		for (const key of extractKeys(src)) {
			const langs = LANGS.filter((l) => !(key in dicts[l]));
			if (langs.length) problems.push({ key, file: path.relative(REPO_ROOT, file).replace(/\\/g, '/'), langs });
		}
	}
	return problems;
}

/**
 * @returns {{ ok: boolean, report: string }}
 */
function run() {
	const dicts = loadDictionaries();
	const lines = [];
	const { missing, empty } = findParityProblems(dicts);
	for (const [lang, keys] of Object.entries(missing)) lines.push(`${lang}.json is missing ${keys.length} key(s): ${keys.join(', ')}`);
	for (const [lang, keys] of Object.entries(empty)) lines.push(`${lang}.json has ${keys.length} empty value(s): ${keys.join(', ')}`);
	for (const p of findUnknownKeys(dicts, listSourceFiles())) {
		lines.push(`${p.file} uses "${p.key}", missing in: ${p.langs.join(', ')}`);
	}
	return { ok: lines.length === 0, report: lines.join('\n') };
}

if (require.main === module) {
	const { ok, report } = run();
	if (ok) {
		process.stdout.write(`i18n OK: ${LANGS.length} languages, keys in parity, every used key exists.\n`);
	} else {
		process.stderr.write(`${report}\n`);
		process.exit(1);
	}
}

module.exports = { LANGS, loadDictionaries, findParityProblems, extractKeys, listSourceFiles, findUnknownKeys, run };
