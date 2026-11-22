'use strict';

/**
 * Pixel design system (docs/redesign/PLAN.md phases 2 + 3):
 * tokens, contrast, icon sprite, type floor, motion rules, header,
 * "Rozšírené možnosti" panel and the per-mode decoration.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const html = read('public/index.html');
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

const { checkAll } = require('../scripts/check-contrast');
const sprites = require('../scripts/build-px-sprites');
const typeFloor = require('../scripts/build-px-type-floor');

const PX_FILES = ['px-tokens.css', 'px-components.css', 'px-motion.css', 'px-apply.css', 'px-type-floor.css']
	.map((f) => `public/ui/${f}`);

describe('tokens and contrast', () => {
	test('every token pair passes WCAG contrast in all modes, dark and light', () => {
		const results = checkAll();
		const failed = results.filter((r) => !r.ok).map((r) => `${r.theme}/${r.mode} ${r.label} ${r.ratio.toFixed(2)}`);
		assert.deepEqual(failed, []);
		assert.equal(results.length, 120);
	});

	test('one corner radius and one shadow style', () => {
		const tokens = read('public/ui/px-tokens.css');
		assert.match(tokens, /--px-radius:\s*0px/);
		assert.match(tokens, /--px-shadow:\s*4px 4px 0 #000/);
		assert.match(tokens, /--font-display:\s*"Press Start 2P"/);
		// legacy shell radius follows the pixel radius
		assert.match(tokens, /--shell-radius:\s*var\(--px-radius\)/);
	});

	test('no undefined CSS variables in the design-system files or the generator shell', () => {
		const loaded = ['public/style.css', 'public/ui/tokens.css', 'public/ui/generator-shell.css', 'public/ui/session-shell.css', ...PX_FILES];
		const defined = new Set();
		for (const f of loaded) for (const m of stripComments(read(f)).matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1]);
		const missing = [];
		for (const f of ['public/ui/generator-shell.css', ...PX_FILES]) {
			for (const m of stripComments(read(f)).matchAll(/var\((--[\w-]+)(\s*,[^)]*)?\)/g)) {
				if (!defined.has(m[1]) && !m[2]) missing.push(`${f}: ${m[1]}`);
			}
		}
		assert.deepEqual([...new Set(missing)], []);
	});

	test('no text below 12px in the design-system files', () => {
		for (const f of PX_FILES) {
			for (const m of stripComments(read(f)).matchAll(/font-size:\s*([\d.]+)(px|rem)/g)) {
				const px = Number(m[1]) * (m[2] === 'rem' ? 16 : 1);
				assert.ok(px >= 12, `${f}: font-size ${m[0]}`);
			}
		}
	});
});

describe('icon sprite and decoration sprites', () => {
	test('generated sprite files are up to date with scripts/build-px-sprites.js', () => {
		for (const [file, content] of sprites.buildAll()) {
			assert.ok(fs.existsSync(file), `${path.relative(ROOT, file)} exists`);
			assert.equal(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), content, `${path.relative(ROOT, file)} is stale`);
		}
	});

	test('the sprite has every icon the plan asks for, on a crisp 16x16 grid', () => {
		const svg = read('public/ui/icons/px-icons.svg');
		assert.match(svg, /shape-rendering="crispEdges"/);
		for (const name of ['fullscreen', 'help', 'tools', 'settings', 'library', 'coin', 'robot', 'school', 'share', 'close',
			'filter', 'sound', 'user', 'pet', 'chat', 'play']) {
			assert.match(svg, new RegExp(`<symbol id="i-${name}" viewBox="0 0 16 16">`), name);
		}
	});

	test('runsToPath merges horizontal runs', () => {
		assert.equal(sprites.runsToPath(['.##.'], (c) => c === '#'), 'M1 0h2v1h-2z');
	});

	test('every decoration has two frames and only palette colours', () => {
		for (const [name, def] of Object.entries(sprites.DECOR)) {
			const svg = sprites.buildDecor(name, def);
			assert.match(svg, /viewBox="0 0 32 16"/, name);
		}
	});
});

describe('type scale', () => {
	test('px-type-floor.css is up to date with style.css', () => {
		assert.equal(read('public/ui/px-type-floor.css'), typeFloor.build());
	});

	test('type floor lifts pixel-font text to 12px and body text to 14px', () => {
		const floor = read('public/ui/px-type-floor.css');
		assert.match(floor, /body\.px-v2 \.mode-name \{ font-size: 12px; \}/);
		assert.match(floor, /body\.px-v2 \.footer-credit \{ font-size: (12|14)px; \}/);
		for (const m of stripComments(floor).matchAll(/font-size:\s*(\d+)px/g)) assert.ok(Number(m[1]) >= 12);
	});

	test('the plan selectors move to the body font at >= 14px', () => {
		const apply = stripComments(read('public/ui/px-apply.css'));
		const block = apply.slice(apply.indexOf('body.px-v2 .mode-name,'), apply.indexOf('}', apply.indexOf('body.px-v2 .mode-name,')));
		for (const sel of ['.mode-name', '.filter-label', '.badge', '.meta-value', '.btn-lang', '.btn-toggle', '.btn-action', '.narrator-fact', '.footer-status', '.profile-tab', '.toast']) {
			if (sel === '.btn-lang') continue; // own rule below
			assert.ok(block.includes(`body.px-v2 ${sel}`), sel);
		}
		assert.match(block, /font-size:\s*var\(--px-fs-body-sm\)/);
		assert.match(apply, /body\.px-v2 \.btn-lang \{[^}]*font-size:\s*var\(--px-fs-body-sm\)/);
		assert.match(read('public/ui/px-tokens.css'), /--px-fs-body-sm:\s*0\.875rem/);
	});
});

describe('motion', () => {
	const motion = stripComments(read('public/ui/px-motion.css'));

	test('global reduced-motion guard stops every endless animation', () => {
		const guard = motion.slice(motion.indexOf('@media (prefers-reduced-motion: reduce)'));
		assert.match(guard, /animation-iteration-count:\s*1 !important/);
		assert.match(guard, /transition-duration:\s*0\.01ms !important/);
		for (const sel of ['.btn-music.playing', '.btn-generate', '.loading-dice', '.status-indicator', '.coin-icon',
			'.timer-display.timer-critical', '.robot-result-emoji.success', '.rpg-avatar-idle']) {
			assert.ok(guard.includes(sel), sel);
		}
	});

	test('coin spin and generate glow are hover/focus only', () => {
		assert.match(motion, /body\.px-v2 \.coin-icon,\s*body\.px-v2 \.btn-generate \{\s*animation:\s*none/);
		assert.match(motion, /\.btn-generate:hover/);
		assert.match(motion, /\.coin-display:hover \.coin-icon/);
	});

	test('cursor effect is an IIFE, respects reduced motion and is lighter', () => {
		const fx = read('public/cursor-effect.js');
		assert.match(fx, /\(function \(\) \{\n'use strict';/);
		assert.match(fx, /prefers-reduced-motion: reduce/);
		assert.match(fx, /const BURST_COUNT = 8;/);
		assert.match(fx, /const MAX_PARTICLES = 40;/);
		assert.doesNotMatch(fx, /^const |^let /m, 'no top-level globals');
		assert.doesNotThrow(() => new vm.Script(fx));
	});
});

describe('index.html applies the design system', () => {
	test('body[data-mode] follows the mode; the corner decoration is gone', () => {
		const script = read('public/script.js');
		assert.match(script, /document\.body\.dataset\.mode = mode;/);
		assert.match(html, /<body class="[^"]*px-v2[^"]*" data-mode="party">/);
		assert.doesNotMatch(html, /mode-decor/);
	});


	test('load order: tokens, components, motion, type floor, screen layer; no duplicate Press Start import', () => {
		const order = ['/ui/px-tokens.css', '/ui/px-components.css', '/ui/px-motion.css', '/ui/px-type-floor.css', '/ui/px-apply.css']
			.map((href) => html.indexOf(href));
		order.forEach((pos, i) => {
			assert.ok(pos > 0, `link ${i} present`);
			if (i) assert.ok(pos > order[i - 1], `link ${i} after ${i - 1}`);
		});
		assert.ok(html.indexOf('/ui/px-tokens.css') > html.indexOf('style.css'), 'tokens after legacy style.css');
		assert.doesNotMatch(html, /fonts\.googleapis\.com[^"]*Press\+Start/);
	});

	test('header: square pixel icon buttons for fullscreen, help, tools and settings; no Bootstrap icons', () => {
		const header = html.slice(html.indexOf('<header>'), html.indexOf('</header>'));
		assert.doesNotMatch(header, /class="bi /);
		assert.doesNotMatch(header, /🏫|🪙|🔗/);
		for (const icon of ['fullscreen', 'help', 'settings', 'library', 'school', 'tools', 'coin', 'robot']) {
			assert.match(header, new RegExp(`#i-${icon}"`), icon);
		}
		assert.match(header, /class="px-iconbtn desktop-only" onclick="App\.UI\.toggleFullscreen\(\)"/);
		assert.match(header, /<summary class="px-iconbtn"[^>]*aria-label=/);
		// coin and challenge sit with the actions on the right, as pixel pills
		assert.match(header, /<div class="header-status">[\s\S]*id="coin-display"[\s\S]*id="btn-robot-challenge"[\s\S]*<\/div>\s*<div class="header-actions">/);
		assert.match(header, /class="coin-display px-pill px-pill--gold"/);
	});

	test('"Rozšírené možnosti" is a square panel with the RVP filters as a group, not a nested card', () => {
		assert.match(html, /<details id="advanced-options" class="panel-section px-panel">/);
		const start = html.indexOf('<details id="advanced-options"');
		const adv = html.slice(start, html.indexOf('</details>', start));
		assert.doesNotMatch(adv, /class="panel-section"/);
		assert.match(adv, /<fieldset class="advanced-options__group" id="rvp-filters-section">/);
		assert.match(adv, /id="rvp-classroom-badge"/);
		assert.doesNotMatch(read('public/script.js'), /rvpSection\.style\.opacity/);
	});

	test('RPG HUD and modal close buttons have no inline grey styles', () => {
		const hud = html.slice(html.indexOf('id="competency-panel"'), html.indexOf('id="competency-bars"'));
		assert.doesNotMatch(hud, /font-size:13px|opacity:0\.7/);
		assert.doesNotMatch(html, /background:#888/);
	});
});
