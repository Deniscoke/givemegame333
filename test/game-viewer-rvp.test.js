'use strict';

// public/game.js (public /game/:id viewer) must render RVP badges whether a
// saved game stores rvp.stupen / doporucene_hodnoceni as an array or a string.
// A string used to throw 'forEach is not a function' and show 'Chyba siete'.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'game.js'), 'utf8').replace(/\r\n/g, '\n');

function loadRenderRvpBadges() {
	const start = src.indexOf('function renderRvpBadges(');
	assert.ok(start >= 0, 'renderRvpBadges not found in public/game.js');
	const end = src.indexOf('\n\t}\n', start);
	assert.ok(end > start, 'end of renderRvpBadges not found');
	const fnSrc = src.slice(start, end + 3);
	const containers = {};
	const ctx = vm.createContext({
		document: { createElement: () => ({ className: '', style: {}, innerHTML: '' }) },
		esc: s => String(s ?? ''),
		el: id => (containers[id] = containers[id] || { innerHTML: '', children: [], appendChild(c) { this.children.push(c); } })
	});
	vm.runInContext(fnSrc + '\nthis.renderRvpBadges = renderRvpBadges;', ctx);
	return { render: ctx.renderRvpBadges, containers };
}

describe('public/game.js renderRvpBadges', () => {
	it('renders an array of keys with lookup names', () => {
		const { render, containers } = loadRenderRvpBadges();
		render('rvp-stupen', ['prvni', 'druhy'], { prvni: { nazev: '1. stupeň' } });
		assert.equal(containers['rvp-stupen'].children.length, 2);
		assert.match(containers['rvp-stupen'].children[0].innerHTML, /1\. stupeň/);
	});

	it('accepts a single string without throwing (party game with rvp.stupen: "prvni")', () => {
		const { render, containers } = loadRenderRvpBadges();
		assert.doesNotThrow(() => render('rvp-stupen', 'prvni', null));
		assert.equal(containers['rvp-stupen'].children.length, 1);
		assert.doesNotThrow(() => render('rvp-hodnoceni', 'Formativní hodnocení', null, '#888'));
		assert.equal(containers['rvp-hodnoceni'].children.length, 1);
	});

	it('renders nothing for missing or empty values', () => {
		const { render, containers } = loadRenderRvpBadges();
		render('a', undefined, null);
		render('b', '', null);
		render('c', null, null);
		assert.equal(containers.a.children.length, 0);
		assert.equal(containers.b.children.length, 0);
		assert.equal(containers.c.children.length, 0);
	});
});
