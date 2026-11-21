'use strict';

// M15: game content (title, verification challenge, competency keys) must not
// reach innerHTML unescaped in public/js/game-ui.js and public/js/reflection.js.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const PAYLOAD = '<img src=x onerror=alert(1)>';

function fakeElement() {
	const el = {
		innerHTML: '', textContent: '', className: '', style: {}, dataset: {}, children: [],
		classList: { add() {}, remove() {}, toggle() {} },
		appendChild(c) { el.children.push(c); return c; },
		insertBefore(c) { el.children.unshift(c); return c; },
		addEventListener() {},
		querySelector: () => null,
		querySelectorAll: () => [],
		remove() {},
	};
	return el;
}

function sandboxWith(elements) {
	const sb = {
		console: { log() {}, warn() {}, error() {} },
		document: {
			getElementById: (id) => elements[id] || (elements[id] = fakeElement()),
			createElement: () => fakeElement(),
			querySelector: () => null,
			querySelectorAll: () => [],
			addEventListener() {},
		},
		localStorage: { getItem: () => null, setItem() {} },
		window: {},
		setTimeout, clearTimeout,
	};
	sb.window.givemegame_t = (k, f) => f || k;
	vm.createContext(sb);
	return sb;
}

describe('game-ui.js escapes game content (M15)', () => {
	const src = read('public/js/game-ui.js');

	it('history items escape the title', () => {
		const elements = { 'history-list': fakeElement() };
		const sb = sandboxWith(elements);
		vm.runInContext(src, sb);
		sb.window.GameUI.addToHistory({
			title: PAYLOAD, setting: 'indoor',
			playerCount: { min: 1, max: 2 }, duration: { min: 5, max: 10 },
		});
		const item = elements['history-list'].children[0];
		assert.ok(item, 'history item rendered');
		assert.ok(!item.innerHTML.includes('<img'), item.innerHTML);
		assert.ok(item.innerHTML.includes('&lt;img src=x onerror=alert(1)&gt;'));
	});

	it('quick view escapes the title', () => {
		const elements = { 'quick-view': fakeElement() };
		const sb = sandboxWith(elements);
		sb.GameData = { getRvp: () => null };
		vm.runInContext(src, sb);
		sb.window.GameUI.renderQuickView({
			title: PAYLOAD, setting: 'outdoor',
			playerCount: { min: 1, max: 2 }, duration: { min: 5, max: 10 },
		});
		assert.ok(!elements['quick-view'].innerHTML.includes('<img'));
	});

	it('the verification card escapes description and hint', () => {
		assert.match(src, /<p>\$\{_esc\(vc\.description\)\}<\/p>/);
		assert.match(src, /\$\{_esc\(vc\.hint\)\}/);
		assert.doesNotMatch(src, /\$\{vc\.(description|hint)\}/);
		assert.doesNotMatch(src, /\$\{game\.title\}/);
	});
});

describe('reflection.js escapes game content (M15)', () => {
	const src = read('public/js/reflection.js');

	it('does not interpolate challenge text or labels raw', () => {
		assert.doesNotMatch(src, /\$\{vc\.(description|hint)\}/);
		assert.doesNotMatch(src, /\$\{q\.label\}/);
		assert.match(src, /\$\{_esc\(vc\.description\)\}/);
		assert.match(src, /\$\{_esc\(q\.label\)\}/);
	});

	it('drops competency keys that are not plain identifiers', () => {
		const sb = sandboxWith({});
		vm.runInContext(src, sb);
		const qs = sb.window.Reflection.buildQuestions({
			rvp: { kompetence: ['komunikativni', `x"><img src=x>`, 'k-uceni'] },
		});
		const ids = qs.map((q) => q.id);
		assert.ok(ids.includes('komunikativni'));
		assert.ok(!ids.some((id) => id.includes('<') || id.includes('"')));
	});
});
