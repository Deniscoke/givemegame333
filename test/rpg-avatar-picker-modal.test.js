'use strict';

/**
 * The RPG avatar picker opens on top of the RPG screen. It must go on the
 * PxModal stack, otherwise the RPG screen's focus trap keeps Tab behind the
 * picker and Escape closes the screen underneath (P23 review finding).
 * Runs px-modal.js + rpg-avatar.js in one vm context with a small DOM fake.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const AVATAR_DATA = {
	eligible: true,
	coins: 9000,
	avatar_switch_cost: 5000,
	current_avatar_id: 1,
	available: [
		{ id: 1, label: 'Rytier', src: '/avatars/1.png' },
		{ id: 2, label: 'Mág', src: '/avatars/2.png' },
	],
};

function makeDom() {
	const listeners = {};
	const all = [];
	const doc = {
		activeElement: null,
		addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
		getElementById(id) { return all.find((n) => n.id === id && n.isConnected) || null; },
		querySelectorAll() { return []; },
		createElement(tag) { return el(tag); },
	};

	function matches(node, simple) {
		const s = simple.trim().replace(/:not\([^)]*\)/g, '');
		if (!s) return false;
		if (s.startsWith('.')) return node.classList.contains(s.slice(1));
		const attr = /^\[([\w-]+)="([^"]*)"\]$/.exec(s);
		if (attr) return node.getAttribute(attr[1]) === attr[2];
		const tagAttr = /^(\w+)\[([\w-]+)\]$/.exec(s);
		if (tagAttr) return node.tagName === tagAttr[1].toUpperCase() && node.hasAttribute(tagAttr[2]);
		if (/^\w+$/.test(s)) return node.tagName === s.toUpperCase();
		return false;
	}

	function el(tag, { id = '', cls = [], attrs = {} } = {}) {
		let html = '';
		let text = '';
		const node = {
			tagName: tag.toUpperCase(), id, hidden: false, children: [], parent: null, style: {}, dataset: {},
			attrs: { ...attrs }, listeners: {}, onclick: null,
			get isConnected() { for (let n = node; n; n = n.parent) if (n === doc.body) return true; return false; },
			classList: {
				set: new Set(cls),
				add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, contains(c) { return this.set.has(c); },
			},
			offsetParent: {},
			getClientRects() { return [1]; },
			append(...kids) { kids.forEach((k) => { k.parent = node; node.children.push(k); }); return node; },
			appendChild(k) { node.append(k); return k; },
			getAttribute(n) { return n in node.attrs ? node.attrs[n] : null; },
			setAttribute(n, v) { node.attrs[n] = String(v); },
			removeAttribute(n) { delete node.attrs[n]; },
			hasAttribute(n) { return n in node.attrs; },
			addEventListener(type, fn) { (node.listeners[type] ||= []).push(fn); },
			click() {
				const ev = { target: node };
				(node.listeners.click || []).forEach((f) => f(ev));
				for (let n = node; n; n = n.parent) {
					(n === node ? [] : n.listeners.click || []).forEach((f) => f(ev));
					if (n.onclick) n.onclick(ev);
				}
				(listeners.click || []).forEach((f) => f(ev));
			},
			focus() { doc.activeElement = node; },
			contains(other) { for (let n = other; n; n = n.parent) if (n === node) return true; return false; },
			closest(sel) { for (let n = node; n; n = n.parent) if (sel === '[hidden]' && n.hidden) return n; return null; },
			descendants() { return node.children.flatMap((c) => [c, ...c.descendants()]); },
			querySelectorAll(sel) { return node.descendants().filter((n) => sel.split(',').some((s) => matches(n, s))); },
			querySelector(sel) { return node.querySelectorAll(sel)[0] || null; },
		};
		Object.defineProperty(node, 'textContent', {
			get() { return text; },
			set(v) { text = v == null ? '' : String(v); html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
		});
		// innerHTML builds just enough structure: a .modal-box, its h3 and every <button>.
		Object.defineProperty(node, 'innerHTML', {
			get() { return html; },
			set(v) {
				html = String(v);
				node.children.forEach((c) => { c.parent = null; });
				node.children = [];
				if (!/modal-box/.test(html)) return;
				const box = el('div', { cls: ['modal-box'] });
				box.append(el('h3'));
				for (const m of html.matchAll(/<button([^>]*)>/g)) {
					const a = m[1];
					const btn = el('button', { cls: (/class="([^"]*)"/.exec(a)?.[1] || '').split(/\s+/).filter(Boolean) });
					const action = /data-action="([^"]*)"/.exec(a);
					if (action) btn.setAttribute('data-action', action[1]);
					const avatarId = /data-avatar-id="([^"]*)"/.exec(a);
					if (avatarId) btn.dataset.avatarId = avatarId[1];
					if (/display:none/.test(a)) btn.hidden = true;
					box.append(btn);
				}
				node.append(box);
			},
		});
		all.push(node);
		return node;
	}

	doc.body = el('body');
	doc.body.parent = null;
	// the RPG screen: a full-screen overlay with its own controls
	const screen = el('div', { id: 'rpg-screen', cls: ['rpg-screen'] });
	const screenClose = el('button', { id: 'rpg-screen-close' });
	const pickerBtn = el('button', { id: 'rpg-sidebar-picker-btn' });
	const navBtn = el('button', { id: 'rpg-nav' });
	screen.append(screenClose, pickerBtn, navBtn);
	doc.body.append(screen);
	return { doc, listeners, screen, screenClose, pickerBtn, navBtn };
}

function setup({ withPxModal = true } = {}) {
	const dom = makeDom();
	const ctx = {
		console, setTimeout, clearTimeout, AbortController, Promise,
		document: dom.doc,
		RpgNet: { request: async () => ({ kind: 'ok', status: 200, data: JSON.parse(JSON.stringify(AVATAR_DATA)) }) },
	};
	ctx.window = ctx;
	vm.createContext(ctx);
	if (withPxModal) vm.runInContext(read('public/js/px-modal.js'), ctx, { filename: 'px-modal.js' });
	vm.runInContext(read('public/js/rpg-avatar.js'), ctx, { filename: 'rpg-avatar.js' });
	return { ...dom, ctx, PxModal: ctx.PxModal, RpgAvatar: ctx.RpgAvatar };
}

const key = (k, shift = false) => ({ key: k, shiftKey: shift, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {} });
const press = (env, ev) => { env.listeners.keydown.forEach((f) => f(ev)); return ev; };

async function openScreenThenPicker(env) {
	env.pickerBtn.focus();
	env.PxModal.open(env.screen, { display: 'flex', closeOnBackdrop: false });
	env.pickerBtn.focus(); // the user tabs to the sidebar button and presses Enter
	await env.RpgAvatar.openPicker();
	return env.doc.getElementById('rpg-avatar-picker-modal');
}

test('picker opened from the RPG screen goes on top of the PxModal stack and gets focus', async () => {
	const env = setup();
	const picker = await openScreenThenPicker(env);
	assert.ok(picker, 'picker exists');
	assert.equal(env.PxModal.isOpen(picker), true);
	assert.equal(env.PxModal._stack[env.PxModal._stack.length - 1].el, picker, 'picker is the top-most modal');
	assert.equal(picker.style.display, 'flex');
	assert.ok(picker.contains(env.doc.activeElement), 'focus moved into the picker');
	assert.equal(env.doc.activeElement.classList.contains('rpg-avatar-option'), true, 'first avatar button has focus');
});

test('Tab and Shift+Tab stay inside the picker, not the RPG screen behind it', async () => {
	const env = setup();
	const picker = await openScreenThenPicker(env);
	const focusable = env.PxModal.getFocusable(picker.querySelector('.modal-box'));
	const first = focusable[0];
	const last = focusable[focusable.length - 1];
	assert.ok(focusable.some((b) => b.getAttribute('data-action') === 'deselect-avatar'), '"Zrusit vyber" reachable');
	assert.equal(last.getAttribute('data-action'), 'close-picker', '"Zavriet" reachable');

	last.focus();
	press(env, key('Tab'));
	assert.equal(env.doc.activeElement, first);
	assert.ok(picker.contains(env.doc.activeElement));

	first.focus();
	press(env, key('Tab', true));
	assert.equal(env.doc.activeElement, last);

	// focus that ended up on the screen behind is pulled into the picker
	env.navBtn.focus();
	press(env, key('Tab'));
	assert.ok(picker.contains(env.doc.activeElement));
});

test('Escape closes the picker only; the RPG screen stays open and focus returns to the opener', async () => {
	const env = setup();
	const picker = await openScreenThenPicker(env);
	press(env, key('Escape'));
	assert.equal(env.PxModal.isOpen(picker), false);
	assert.equal(picker.style.display, 'none');
	assert.equal(env.PxModal.isOpen(env.screen), true, 'RPG screen still open');
	assert.equal(env.doc.activeElement, env.pickerBtn);

	press(env, key('Escape'));
	assert.equal(env.PxModal.isOpen(env.screen), false, 'second Escape closes the screen');
});

test('"Zavriet" and backdrop click close through PxModal (stack and focus restored)', async () => {
	const env = setup();
	let picker = await openScreenThenPicker(env);
	picker.querySelectorAll('[data-action="close-picker"]').at(-1).click();
	assert.equal(env.PxModal.isOpen(picker), false);
	assert.equal(picker.style.display, 'none');
	assert.equal(env.doc.activeElement, env.pickerBtn);
	assert.equal(env.PxModal.isOpen(env.screen), true);

	picker = await openScreenThenPicker(env);
	picker.click(); // click on the dark backdrop
	assert.equal(env.PxModal.isOpen(picker), false);
	assert.equal(env.PxModal._stack.length, 1, 'only the RPG screen is left');
});

test('reopening the picker keeps a single stack entry and the original opener', async () => {
	const env = setup();
	const picker = await openScreenThenPicker(env);
	await env.RpgAvatar.openPicker(); // e.g. double activation
	assert.equal(env.PxModal._stack.filter((s) => s.el === picker).length, 1);
	press(env, key('Escape'));
	assert.equal(env.doc.activeElement, env.pickerBtn);
});

test('without PxModal the picker still opens and closes with style.display', async () => {
	const env = setup({ withPxModal: false });
	env.pickerBtn.focus();
	await env.RpgAvatar.openPicker();
	const picker = env.doc.getElementById('rpg-avatar-picker-modal');
	assert.equal(picker.style.display, 'flex');
	picker.querySelectorAll('[data-action="close-picker"]')[0].click();
	assert.equal(picker.style.display, 'none');
});
