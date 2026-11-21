'use strict';

/**
 * PxModal (public/js/px-modal.js): focus trap, Escape, focus restore and
 * dialog labelling (M19). Runs the browser script in a vm context with a
 * tiny DOM fake: enough structure for querySelectorAll / contains / focus.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'px-modal.js'), 'utf8');

function makeDom() {
	const listeners = { keydown: [], click: [] };
	const doc = {
		activeElement: null,
		body: null,
		addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
		getElementById(id) { return all.find((n) => n.id === id) || null; },
	};
	const all = [];
	function el(tag, { id = '', cls = [], attrs = {}, focusable = false, hidden = false } = {}) {
		const node = {
			tagName: tag.toUpperCase(), id, hidden, children: [], parent: null, style: {},
			attrs: { ...attrs }, _focusable: focusable, isConnected: true,
			classList: {
				set: new Set(cls),
				add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, contains(c) { return this.set.has(c); },
			},
			offsetParent: {},
			getClientRects() { return [1]; },
			append(...kids) { kids.forEach((k) => { k.parent = node; node.children.push(k); }); return node; },
			getAttribute(n) { return n in node.attrs ? node.attrs[n] : null; },
			setAttribute(n, v) { node.attrs[n] = String(v); },
			removeAttribute(n) { delete node.attrs[n]; },
			hasAttribute(n) { return n in node.attrs; },
			focus() { doc.activeElement = node; },
			contains(other) { for (let n = other; n; n = n.parent) if (n === node) return true; return false; },
			closest(sel) {
				for (let n = node; n; n = n.parent) if (sel === '[hidden]' && n.hidden) return n;
				return null;
			},
			descendants() { return node.children.flatMap((c) => [c, ...c.descendants()]); },
			querySelectorAll(sel) {
				const d = node.descendants();
				if (sel.includes('button:not([disabled])')) return d.filter((n) => n._focusable);
				return d.filter((n) => sel.split(',').some((s) => s.trim().startsWith('.') ? n.classList.contains(s.trim().slice(1)) : n.tagName === s.trim().toUpperCase()));
			},
			querySelector(sel) { return node.querySelectorAll(sel)[0] || null; },
		};
		all.push(node);
		return node;
	}
	doc.body = el('body');
	return { doc, el, listeners };
}

function load(dom) {
	const ctx = vm.createContext({ document: dom.doc, console });
	ctx.window = ctx;
	vm.runInContext(SRC, ctx, { filename: 'px-modal.js' });
	return ctx.PxModal;
}

function buildModal(dom) {
	const overlay = dom.el('div', { id: 'help-modal', cls: ['modal-overlay'] });
	const box = dom.el('div', { cls: ['modal-box'] });
	const title = dom.el('h2', { cls: ['modal-title'] });
	const closeBtn = dom.el('button', { cls: ['modal-close'], focusable: true });
	const first = dom.el('button', { id: 'first', focusable: true });
	const last = dom.el('button', { id: 'last', focusable: true });
	box.append(title, closeBtn, first, last);
	overlay.append(box);
	dom.doc.body.append(overlay);
	const opener = dom.el('button', { id: 'opener', focusable: true });
	dom.doc.body.append(opener);
	return { overlay, box, title, closeBtn, first, last, opener };
}

const key = (k, shift = false) => {
	const ev = { key: k, shiftKey: shift, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {} };
	return ev;
};

test('open labels the dialog, shows it and focuses the first non-close control', () => {
	const dom = makeDom();
	const M = load(dom);
	const m = buildModal(dom);
	m.opener.focus();
	assert.equal(M.open('help-modal'), true);
	assert.equal(m.overlay.style.display, 'flex');
	assert.equal(m.box.getAttribute('role'), 'dialog');
	assert.equal(m.box.getAttribute('aria-modal'), 'true');
	assert.equal(m.box.getAttribute('aria-labelledby'), m.title.id);
	assert.ok(m.title.id, 'title got an id');
	assert.equal(dom.doc.activeElement, m.first);
	assert.equal(M.isOpen('help-modal'), true);
});

test('Tab on the last control wraps to the first, Shift+Tab on the first wraps to the last', () => {
	const dom = makeDom();
	const M = load(dom);
	const m = buildModal(dom);
	M.open(m.overlay);
	const handler = dom.listeners.keydown[0];

	m.last.focus();
	let ev = key('Tab');
	handler(ev);
	assert.equal(ev.prevented, true);
	assert.equal(dom.doc.activeElement, m.closeBtn, 'wrapped to the first focusable (the close button)');

	m.closeBtn.focus();
	ev = key('Tab', true);
	handler(ev);
	assert.equal(dom.doc.activeElement, m.last);

	m.first.focus();
	ev = key('Tab');
	handler(ev);
	assert.equal(ev.prevented, false, 'Tab in the middle is left to the browser');
});

test('focus that escaped the dialog is pulled back in on Tab', () => {
	const dom = makeDom();
	const M = load(dom);
	const m = buildModal(dom);
	M.open(m.overlay);
	m.opener.focus();
	dom.listeners.keydown[0](key('Tab'));
	assert.equal(dom.doc.activeElement, m.closeBtn);
});

test('Escape closes the top-most modal and restores focus to the opener', () => {
	const dom = makeDom();
	const M = load(dom);
	const m = buildModal(dom);
	let closed = 0;
	m.opener.focus();
	M.open('help-modal', { onClose: () => { closed += 1; } });
	dom.listeners.keydown[0](key('Escape'));
	assert.equal(m.overlay.style.display, 'none');
	assert.equal(M.isOpen('help-modal'), false);
	assert.equal(closed, 1);
	assert.equal(dom.doc.activeElement, m.opener);
});

test('backdrop click closes, a click inside the box does not', () => {
	const dom = makeDom();
	const M = load(dom);
	const m = buildModal(dom);
	M.open(m.overlay);
	dom.listeners.click[0]({ target: m.box });
	assert.equal(M.isOpen(m.overlay), true);
	dom.listeners.click[0]({ target: m.overlay });
	assert.equal(M.isOpen(m.overlay), false);
});

test('nextTrapTarget handles an empty dialog by focusing the container', () => {
	const dom = makeDom();
	const M = load(dom);
	const box = dom.el('div');
	assert.equal(M.nextTrapTarget([], null, false, box), box);
});

test('getFocusable skips hidden controls', () => {
	const dom = makeDom();
	const M = load(dom);
	const box = dom.el('div');
	const visible = dom.el('button', { focusable: true });
	const hiddenBtn = dom.el('button', { focusable: true, hidden: true });
	box.append(visible, hiddenBtn);
	const found = M.getFocusable(box);
	assert.equal(found.length, 1);
	assert.equal(found[0], visible);
});

test('game-ui openModal/closeModal delegate to PxModal (M19)', () => {
	const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'game-ui.js'), 'utf8');
	assert.match(src, /PxModal\.open\(/);
	assert.match(src, /PxModal\.close\(/);
	const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
	assert.ok(html.indexOf('js/px-modal.js') !== -1 && html.indexOf('js/px-modal.js') < html.indexOf('js/game-ui.js'),
		'px-modal.js loads before game-ui.js');
});
