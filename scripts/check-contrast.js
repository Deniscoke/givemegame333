#!/usr/bin/env node
'use strict';
/* ═══════════════════════════════════════════════════════════════════
   gIVEMEGAME.IO — design-token contrast check (CI)
   Použitie: node scripts/check-contrast.js

   Reads public/ui/px-tokens.css, resolves the tokens for every mode in
   dark and light theme, and checks WCAG 2.1 contrast for the pairs the
   components actually use (see docs/design-system.md):
     text pairs  >= 4.5:1  (on-surface / surface, on-accent / accent-strong …)
     UI pairs    >= 3:1    (mode-accent borders/icons on the surface)
   Exit 1 when any pair fails.
   ═══════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');

const TOKENS_PATH = path.join(__dirname, '..', 'public', 'ui', 'px-tokens.css');
const MODES = ['party', 'classroom', 'reflection', 'circus', 'cooking', 'meditation'];
const THEMES = ['dark', 'light'];

/** [foreground token, background token, minimum ratio, what it is] */
const PAIRS = [
	['--on-surface', '--surface', 4.5, 'panel text'],
	['--on-surface', '--surface-raised', 4.5, 'raised panel / tab text'],
	['--on-surface', '--surface-sunken', 4.5, 'inset field text'],
	['--on-surface', '--page-bg', 4.5, 'page text'],
	['--on-surface-muted', '--surface', 4.5, 'secondary text'],
	['--on-surface-muted', '--surface-raised', 4.5, 'secondary text on raised'],
	['--on-accent', '--mode-accent-strong', 4.5, 'active button / selected tab'],
	['--mode-accent', '--surface', 3, 'accent border / icon on panel'],
	['--px-on-gold', '--px-gold', 4.5, 'coin pill'],
	['--px-on-warning', '--px-warning', 4.5, 'warning badge']
];

/**
 * Parse `selector { --a: #fff; … }` blocks (comments stripped).
 * @param {string} css
 * @returns {{ selectors: string[], decls: Record<string, string> }[]}
 */
function parseBlocks(css) {
	const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
	const out = [];
	const re = /([^{}]+)\{([^{}]*)\}/g;
	let m;
	while ((m = re.exec(clean)) !== null) {
		const selectors = m[1].split(',').map((s) => s.trim()).filter(Boolean);
		const decls = {};
		for (const part of m[2].split(';')) {
			const i = part.indexOf(':');
			if (i < 0) continue;
			const name = part.slice(0, i).trim();
			if (name.startsWith('--')) decls[name] = part.slice(i + 1).trim();
		}
		out.push({ selectors, decls });
	}
	return out;
}

/**
 * Does a selector apply to <body class="px-v2 mode-X [light-mode]">?
 * Only the selector shapes used in px-tokens.css are understood.
 * @param {string} sel
 * @param {string} mode
 * @param {string} theme
 */
function selectorMatches(sel, mode, theme) {
	if (sel === ':root') return true;
	const light = theme === 'light';
	if (/data-theme="light"/.test(sel)) {
		if (!light) return false;
		sel = sel.replace(/html\[data-theme="light"\]\s*/, '');
	}
	if (!sel.startsWith('body')) return false;
	const classes = sel.replace(/^body/, '').split('.').filter(Boolean);
	if (classes.some((c) => c.includes(':') || c.includes(' '))) return false;
	return classes.every((c) => c === 'px-v2'
		|| c === `mode-${mode}`
		|| (c === 'light-mode' && light));
}

/**
 * Tokens for one mode/theme, in cascade order (later blocks win; the
 * selectors in px-tokens.css are ordered by specificity on purpose).
 * @param {string} css
 * @param {string} mode
 * @param {string} theme
 * @returns {Record<string, string>}
 */
function resolveTokens(css, mode, theme) {
	const tokens = {};
	for (const block of parseBlocks(css)) {
		if (block.selectors.some((s) => selectorMatches(s, mode, theme))) Object.assign(tokens, block.decls);
	}
	// Follow var(--x) aliases.
	for (let pass = 0; pass < 5; pass++) {
		for (const [k, v] of Object.entries(tokens)) {
			const ref = /^var\((--[\w-]+)\)$/.exec(v);
			if (ref && tokens[ref[1]]) tokens[k] = tokens[ref[1]];
		}
	}
	return tokens;
}

/** @param {string} hex */
function parseHex(hex) {
	const h = String(hex).trim().replace('#', '');
	if (!/^([0-9a-f]{3}|[0-9a-f]{6})$/i.test(h)) return null;
	const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
	return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}

/** @param {number[]} rgb */
function luminance(rgb) {
	const [r, g, b] = rgb.map((v) => {
		const c = v / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * WCAG contrast ratio of two hex colours.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function contrastRatio(a, b) {
	const ca = parseHex(a);
	const cb = parseHex(b);
	if (!ca || !cb) return NaN;
	const la = luminance(ca);
	const lb = luminance(cb);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * @param {string} [css]
 * @returns {{ mode: string, theme: string, fg: string, bg: string, ratio: number, min: number, label: string, ok: boolean }[]}
 */
function checkAll(css = fs.readFileSync(TOKENS_PATH, 'utf8')) {
	const results = [];
	for (const theme of THEMES) {
		for (const mode of MODES) {
			const t = resolveTokens(css, mode, theme);
			for (const [fg, bg, min, label] of PAIRS) {
				const ratio = contrastRatio(t[fg], t[bg]);
				results.push({ mode, theme, fg: `${fg}=${t[fg]}`, bg: `${bg}=${t[bg]}`, ratio, min, label, ok: ratio >= min });
			}
		}
	}
	return results;
}

if (require.main === module) {
	const results = checkAll();
	const failed = results.filter((r) => !r.ok);
	for (const r of failed) {
		console.error(`FAIL ${r.theme}/${r.mode} ${r.label}: ${r.fg} on ${r.bg} = ${Number.isNaN(r.ratio) ? 'n/a' : r.ratio.toFixed(2)} (min ${r.min})`);
	}
	if (failed.length) {
		console.error(`contrast check failed: ${failed.length} of ${results.length} pairs`);
		process.exit(1);
	}
	const worst = results.reduce((a, b) => (a.ratio / a.min < b.ratio / b.min ? a : b));
	console.log(`contrast OK: ${results.length} pairs across ${MODES.length} modes x ${THEMES.length} themes (tightest: ${worst.theme}/${worst.mode} ${worst.label} ${worst.ratio.toFixed(2)})`);
}

module.exports = { parseBlocks, resolveTokens, contrastRatio, checkAll, PAIRS, MODES, THEMES };
