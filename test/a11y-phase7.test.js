'use strict';

/**
 * Phase 7 accessibility: read-aloud (element selection, language mapping,
 * Ctrl+click), readable-font toggle persistence and the first-run tour
 * (step skipping, Escape, focus). Browser scripts run in a vm context with
 * a tiny DOM fake, same approach as test/px-modal.test.js.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8').replace(/\r\n/g, '\n');

function makeStorage(initial = {}, broken = false) {
	const data = { ...initial };
	return {
		data,
		getItem(k) { if (broken) throw new Error('blocked'); return k in data ? data[k] : null; },
		setItem(k, v) { if (broken) throw new Error('blocked'); data[k] = String(v); },
	};
}

function makeNode(tag, matches = []) {
	const handlers = {};
	const node = {
		tagName: tag.toUpperCase(), className: '', attrs: {}, children: [], parentNode: null, style: {}, hidden: false,
		textContent: '', isConnected: true, offsetParent: {}, offsetHeight: 150, offsetWidth: 300, matches,
		classList: {
			set: new Set(),
			add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, contains(c) { return this.set.has(c); },
			toggle(c, on) { if (on) this.set.add(c); else this.set.delete(c); },
		},
		setAttribute(n, v) { node.attrs[n] = String(v); },
		getAttribute(n) { return n in node.attrs ? node.attrs[n] : null; },
		append(...kids) { kids.forEach((k) => { k.parentNode = node; node.children.push(k); }); },
		removeChild(k) { node.children = node.children.filter((c) => c !== k); k.parentNode = null; },
		addEventListener(t, fn) { (handlers[t] = handlers[t] || []).push(fn); },
		click() { (handlers.click || []).forEach((fn) => fn({})); },
		getClientRects() { return [1]; },
		getBoundingClientRect() { return { left: 10, top: 10, right: 110, bottom: 50, width: 100, height: 40 }; },
		scrollIntoView() {},
		focus() { node.ownerDoc.activeElement = node; },
		// closest(): walks this fake's own ancestors, matching on the `matches` list
		closest(sel) {
			const parts = sel.split(',').map((s) => s.trim());
			for (let n = node; n; n = n.parentNode) if (parts.some((p) => n.matches.includes(p) || (p === '[hidden]' && n.hidden))) return n;
			return null;
		},
		querySelectorAll(sel) {
			const out = [];
			const walk = (n) => n.children.forEach((c) => { if (c.className.split(' ').includes(sel.replace('.', '')) || c.matches.includes(sel)) out.push(c); walk(c); });
			walk(node);
			return out;
		},
	};
	return node;
}

function makeContext({ storage = makeStorage(), reduced = true, targets = {} } = {}) {
	const docHandlers = {};
	const winHandlers = {};
	const spoken = [];
	const doc = {
		activeElement: null,
		documentElement: makeNode('html'),
		body: null,
		readyState: 'complete',
		createElement(tag) { const n = makeNode(tag); n.ownerDoc = doc; return n; },
		querySelector(sel) { return targets[sel] || null; },
		querySelectorAll() { return []; },
		getElementById() { return null; },
		addEventListener(t, fn) { (docHandlers[t] = docHandlers[t] || []).push(fn); },
		removeEventListener(t, fn) { docHandlers[t] = (docHandlers[t] || []).filter((f) => f !== fn); },
	};
	doc.documentElement.ownerDoc = doc;
	doc.body = makeNode('body'); doc.body.ownerDoc = doc;
	const ctx = {
		document: doc, localStorage: storage, console, setTimeout, clearTimeout, innerWidth: 1024, innerHeight: 768,
		matchMedia: () => ({ matches: reduced }),
		addEventListener(t, fn) { (winHandlers[t] = winHandlers[t] || []).push(fn); },
		removeEventListener(t, fn) { winHandlers[t] = (winHandlers[t] || []).filter((f) => f !== fn); },
		speechSynthesis: { cancel() { spoken.push('cancel'); }, speak(u) { spoken.push(u); }, getVoices() { return [{ lang: 'sk-SK' }, { lang: 'en-US' }]; } },
		SpeechSynthesisUtterance: function (text) { this.text = text; },
	};
	vm.createContext(ctx);
	const run = (file) => vm.runInContext(read(file), ctx, { filename: file });
	const key = (k, extra = {}) => {
		const ev = { key: k, shiftKey: false, altKey: false, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...extra };
		(docHandlers.keydown || []).forEach((fn) => fn(ev));
		return ev;
	};
	return { ctx, doc, run, key, spoken, docHandlers, winHandlers };
}

describe('read-aloud', () => {
	test('maps the six app languages to BCP-47, unknown falls back to en-US', () => {
		const { ctx, run } = makeContext();
		run('js/read-aloud.js');
		const m = (l) => ctx.ReadAloud.langToBcp47(l);
		assert.deepEqual(['sk', 'cs', 'en', 'de', 'es', 'tr'].map(m), ['sk-SK', 'cs-CZ', 'en-US', 'de-DE', 'es-ES', 'tr-TR']);
		assert.equal(m('xx'), 'en-US');
		assert.equal(m(undefined), 'en-US');
	});

	test('picks the closest readable element and ignores form fields', () => {
		const { ctx, run } = makeContext();
		run('js/read-aloud.js');
		const li = makeNode('li', ['li']);
		const span = makeNode('span');
		li.append(span);
		assert.equal(ctx.ReadAloud.pickReadable(span), li);
		const input = makeNode('input', ['input']);
		const holder = makeNode('p', ['p']);
		holder.append(input);
		assert.equal(ctx.ReadAloud.pickReadable(input), null);
		assert.equal(ctx.ReadAloud.pickReadable(makeNode('div')), null);
		assert.equal(ctx.ReadAloud.pickReadable(null), null);
	});

	test('Ctrl+click reads in the app language and does not follow the link', () => {
		const { ctx, run, spoken } = makeContext();
		ctx.givemegame_currentLang = 'tr';
		run('js/read-aloud.js');
		const p = makeNode('p', ['p']);
		p.textContent = '  Merhaba   dünya ';
		const ev = { ctrlKey: true, target: p, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
		ctx.ReadAloud.onClick(ev);
		assert.equal(ev.prevented, true);
		assert.equal(ev.stopped, true);
		const u = spoken.find((s) => typeof s === 'object');
		assert.equal(u.text, 'Merhaba dünya');
		assert.equal(u.lang, 'tr-TR');
	});

	test('plain click, disabled state and text-less targets are left alone; toggle persists', () => {
		const storage = makeStorage();
		const { ctx, run, spoken } = makeContext({ storage });
		run('js/read-aloud.js');
		const p = makeNode('p', ['p']);
		p.textContent = 'Ahoj';
		const click = (extra) => { const ev = { target: p, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {}, ...extra }; ctx.ReadAloud.onClick(ev); return ev; };
		assert.equal(click({}).prevented, false);
		const empty = makeNode('p', ['p']);
		const ev = { ctrlKey: true, target: empty, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {} };
		ctx.ReadAloud.onClick(ev);
		assert.equal(ev.prevented, false);
		ctx.ReadAloud.setEnabled(false);
		assert.equal(storage.data.givemegame_read_aloud, '0');
		spoken.length = 0;
		assert.equal(click({ ctrlKey: true }).prevented, false);
		assert.equal(spoken.filter((s) => typeof s === 'object').length, 0);
	});

	test('defaults to on, restores "off" from storage and survives blocked storage', () => {
		assert.equal(vm.runInContext('1', makeContext().ctx), 1);
		let c = makeContext(); c.run('js/read-aloud.js');
		assert.equal(c.ctx.ReadAloud.isEnabled(), true);
		c = makeContext({ storage: makeStorage({ givemegame_read_aloud: '0' }) }); c.run('js/read-aloud.js');
		assert.equal(c.ctx.ReadAloud.isEnabled(), false);
		c = makeContext({ storage: makeStorage({}, true) }); c.run('js/read-aloud.js');
		assert.doesNotThrow(() => c.ctx.ReadAloud.setEnabled(false));
	});
});

describe('readable font toggle', () => {
	test('persists the choice and toggles html.readable-font', () => {
		const storage = makeStorage();
		const { ctx, doc, run } = makeContext({ storage });
		run('js/readable-font.js');
		assert.equal(ctx.ReadableFont.isOn(), false);
		ctx.ReadableFont.toggle();
		assert.equal(storage.data.givemegame_readable_font, '1');
		assert.ok(doc.documentElement.classList.contains('readable-font'));
		ctx.ReadableFont.toggle();
		assert.equal(storage.data.givemegame_readable_font, '0');
		assert.ok(!doc.documentElement.classList.contains('readable-font'));
	});

	test('applies the stored choice on load and tolerates blocked storage', () => {
		const on = makeContext({ storage: makeStorage({ givemegame_readable_font: '1' }) });
		on.run('js/readable-font.js');
		assert.ok(on.doc.documentElement.classList.contains('readable-font'));
		const blocked = makeContext({ storage: makeStorage({}, true) });
		assert.doesNotThrow(() => blocked.run('js/readable-font.js'));
		assert.equal(blocked.ctx.ReadableFont.isOn(), false);
		assert.doesNotThrow(() => blocked.ctx.ReadableFont.toggle());
	});

	test('CSS defines the readable-font rules and the head script runs before first paint', () => {
		assert.match(read('ui/px-tokens.css'), /html\.readable-font body\.px-v2/);
		const html = read('index.html');
		assert.match(html, /<script>try\{if\(localStorage\.getItem\("givemegame_readable_font"\)==="1"\)/);
		assert.ok(html.indexOf('givemegame_readable_font') < html.indexOf('<body'));
	});
});

describe('tour', () => {
	function setup(targetNames, opts = {}) {
		const targets = {};
		const wanted = new Set(targetNames);
		const sels = ['#mode-grid', '#creation-basics', '#btn-generate', '#btn-game-tools', '.preferences-menu > summary', '#btn-help'];
		sels.forEach((s) => { if (wanted.has(s)) targets[s] = makeNode('div'); });
		const c = makeContext({ targets, ...opts });
		const opener = makeNode('button'); opener.ownerDoc = c.doc;
		c.doc.activeElement = opener;
		c.run('js/tour.js');
		c.targets = targets; c.opener = opener;
		return c;
	}
	const card = (c) => c.doc.body.children[0].children[1];
	const title = (c) => card(c).children[1].textContent;
	const buttons = (c) => card(c).children[3].children; // skip, back, next
	const ALL = ['#mode-grid', '#creation-basics', '#btn-generate', '#btn-game-tools', '.preferences-menu > summary', '#btn-help'];

	test('walks all steps with Next, last button reads Hotovo, finish stores the flag and restores focus', () => {
		const storage = makeStorage();
		const c = setup(ALL, { storage });
		assert.equal(c.ctx.Tour.start(), true);
		assert.equal(c.doc.activeElement, card(c));
		assert.equal(buttons(c)[1].hidden, true, 'no Back on first step');
		assert.equal(title(c), 'Vyber si mód');
		for (let i = 0; i < 5; i++) buttons(c)[2].click();
		assert.equal(title(c), 'Pomoc');
		assert.equal(buttons(c)[2].textContent, 'Hotovo');
		buttons(c)[2].click();
		assert.equal(c.ctx.Tour.isActive(), false);
		assert.equal(storage.data.givemegame_tour_done, '1');
		assert.equal(c.doc.activeElement, c.opener);
		assert.equal(c.doc.body.children.length, 0, 'overlay removed');
	});

	test('skips steps whose target is missing or hidden', () => {
		const c = setup(['#mode-grid', '#btn-generate', '#btn-help']);
		c.targets['#btn-generate'].hidden = true;
		c.ctx.Tour.start();
		assert.equal(title(c), 'Vyber si mód');
		buttons(c)[2].click();
		assert.equal(title(c), 'Pomoc', 'hidden generate step skipped');
		assert.match(card(c).children[0].textContent, /2 z 2/);
		buttons(c)[1].click();
		assert.equal(title(c), 'Vyber si mód');
	});

	test('does not start when no target is visible', () => {
		const c = setup([]);
		assert.equal(c.ctx.Tour.start(), false);
		assert.equal(c.doc.body.children.length, 0);
	});

	test('Escape skips, marks done and restores focus', () => {
		const storage = makeStorage();
		const c = setup(ALL, { storage });
		c.ctx.Tour.start();
		const ev = c.key('Escape');
		assert.equal(ev.prevented, true);
		assert.equal(c.ctx.Tour.isActive(), false);
		assert.equal(storage.data.givemegame_tour_done, '1');
		assert.equal(c.doc.activeElement, c.opener);
	});

	test('Preskočiť button skips; Tab stays inside the card; app shortcuts are suspended', () => {
		const c = setup(ALL);
		c.ctx.Tour.start();
		const [skip, , next] = buttons(c);
		c.doc.activeElement = next;
		c.key('Tab');
		assert.equal(c.doc.activeElement, skip, 'Tab wraps to first button (Back hidden)');
		c.key('Tab', { shiftKey: true });
		assert.equal(c.doc.activeElement, next, 'Shift+Tab wraps backwards');
		const altS = c.key('s', { altKey: true, shiftKey: true });
		assert.equal(altS.stopped, true);
		skip.click();
		assert.equal(c.ctx.Tour.isActive(), false);
	});

	test('maybeAutoStart runs once: not after the done flag, not over an open modal', () => {
		let c = setup(ALL, { storage: makeStorage({ givemegame_tour_done: '1' }) });
		assert.equal(c.ctx.Tour.maybeAutoStart(), false);
		c = setup(ALL);
		c.ctx.PxModal = { _stack: [{}] };
		assert.equal(c.ctx.Tour.maybeAutoStart(), false);
		c.ctx.PxModal = { _stack: [] };
		assert.equal(c.ctx.Tour.maybeAutoStart(), true);
	});

	test('blocked localStorage does not break the tour', () => {
		const c = setup(ALL, { storage: makeStorage({}, true) });
		assert.equal(c.ctx.Tour.start(), true);
		assert.doesNotThrow(() => c.key('Escape'));
	});

	test('markup: help button id, replay entry and CSS fade guard exist', () => {
		const html = read('index.html');
		assert.match(html, /id="btn-help"/);
		assert.match(html, /id="btn-start-tour"[^>]*Tour\.start\(\)/);
		const css = read('ui/px-tour.css');
		assert.match(css, /z-index:\s*30000/);
		assert.match(css, /prefers-reduced-motion: reduce[\s\S]*transition: none/);
	});
});
