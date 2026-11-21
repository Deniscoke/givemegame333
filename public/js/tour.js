/* ═══════════════════════════════════════════════════════════════════
   gIVEMEGAME.IO — First-run tour (Phase 7)

   Zatemnené pozadie s "svetlom" okolo cieľa, karta v pixel štýle,
   tlačidlá Preskočiť / Späť / Ďalej / Hotovo. Escape návod preskočí.
   Bez animačných slučiek; pri zmene veľkosti okna sa karta
   prepočíta (throttle). Fade sa vypne pri prefers-reduced-motion.
   Stav: localStorage givemegame_tour_done. Štýly: ui/px-tour.css
   ═══════════════════════════════════════════════════════════════════ */
(function (root) {
	'use strict';

	const STORAGE_KEY = 'givemegame_tour_done';
	const FADE_MS = 180;
	const RESIZE_THROTTLE_MS = 150;
	const SPOT_PAD = 6;

	/** Kroky nad skutočným UI. Chýbajúci / skrytý cieľ sa preskočí. */
	const STEPS = [
		{ sel: '#mode-grid', key: 'tour_modes' },
		{ sel: '#creation-basics', key: 'tour_filters' },
		{ sel: '#btn-generate', key: 'tour_generate' },
		{ sel: '#btn-game-tools', key: 'tour_tools' },
		{ sel: '.preferences-menu > summary', key: 'tour_profile' },
		{ sel: '#btn-help', key: 'tour_help' },
	];

	const FALLBACKS = {
		tour_aria: 'Návod na prvé použitie',
		tour_skip: 'Preskočiť', tour_back: 'Späť', tour_next: 'Ďalej', tour_done: 'Hotovo',
		tour_step_counter: 'Krok {n} z {total}',
		tour_modes_title: 'Vyber si mód', tour_modes_text: 'Tu si vyberieš, aká hra ťa čaká: párty, trieda, varenie a ďalšie.',
		tour_filters_title: 'Nastav hru', tour_filters_text: 'Povedz, koľko je vás, koľko máte rokov a ako dlho chcete hrať.',
		tour_generate_title: 'Vytvor hru', tour_generate_text: 'Stlač toto tlačidlo a hra je na svete.',
		tour_tools_title: 'Nástroje a SMARTA', tour_tools_text: 'Tu nájdeš pomocníka SMARTA, úlohy a svoj postup.',
		tour_profile_title: 'Tvoj profil', tour_profile_text: 'V nastaveniach nájdeš účet, jazyk a RPG profil svojho hrdinu.',
		tour_help_title: 'Pomoc', tour_help_text: 'Keď si nebudeš vedieť rady, klikni sem. Návod môžeš spustiť znova.',
	};

	let state = null;

	function t(key) {
		const fb = FALLBACKS[key] || key;
		return typeof root.givemegame_t === 'function' ? root.givemegame_t(key, fb) : fb;
	}

	function readDone() {
		try { return root.localStorage.getItem(STORAGE_KEY) === '1'; } catch (_) { return false; }
	}
	function markDone() {
		try { root.localStorage.setItem(STORAGE_KEY, '1'); } catch (_) { /* private mode */ }
	}

	function isVisible(el) {
		if (!el) return false;
		if (typeof el.closest === 'function' && el.closest('[hidden]')) return false;
		const rects = typeof el.getClientRects === 'function' ? el.getClientRects() : [1];
		return Boolean(rects && rects.length) && el.offsetParent !== null;
	}

	/** Index najbližšieho kroku v smere dir (1 / -1) s viditeľným cieľom, alebo -1. */
	function findStep(from, dir) {
		const doc = root.document;
		for (let i = from; i >= 0 && i < STEPS.length; i += dir) {
			if (isVisible(doc.querySelector(STEPS[i].sel))) return i;
		}
		return -1;
	}

	function reducedMotion() {
		try { return Boolean(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (_) { return false; }
	}

	function make(tag, cls, attrs) {
		const el = root.document.createElement(tag);
		if (cls) el.className = cls;
		Object.keys(attrs || {}).forEach((k) => el.setAttribute(k, attrs[k]));
		return el;
	}

	function buildDom() {
		const doc = root.document;
		const overlay = make('div', 'px-tour');
		const spot = make('div', 'px-tour__spot', { 'aria-hidden': 'true' });
		const card = make('div', 'px-tour__card', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'px-tour-title', 'aria-describedby': 'px-tour-text', tabindex: '-1' });
		const counter = make('p', 'px-tour__counter', { 'aria-live': 'polite' });
		const title = make('h2', 'px-tour__title', { id: 'px-tour-title' });
		const text = make('p', 'px-tour__text', { id: 'px-tour-text' });
		const actions = make('div', 'px-tour__actions');
		const skip = make('button', 'px-btn px-tour__skip', { type: 'button' });
		const back = make('button', 'px-btn px-tour__back', { type: 'button' });
		const next = make('button', 'px-btn px-btn--primary px-tour__next', { type: 'button' });
		actions.append(skip, back, next);
		card.append(counter, title, text, actions);
		overlay.append(spot, card);
		doc.body.append(overlay);
		return { overlay, spot, card, counter, title, text, skip, back, next };
	}

	function place() {
		if (!state) return;
		const step = STEPS[state.index];
		const target = root.document.querySelector(step.sel);
		const { spot, card } = state.dom;
		if (!target || !isVisible(target)) return;
		const r = target.getBoundingClientRect();
		const vw = root.innerWidth || 1024;
		const vh = root.innerHeight || 768;
		spot.style.left = Math.max(0, r.left - SPOT_PAD) + 'px';
		spot.style.top = Math.max(0, r.top - SPOT_PAD) + 'px';
		spot.style.width = (r.width + SPOT_PAD * 2) + 'px';
		spot.style.height = (r.height + SPOT_PAD * 2) + 'px';
		const cardH = card.offsetHeight || 180;
		const cardW = Math.min(card.offsetWidth || 340, vw - 16);
		const below = r.bottom + 12 + cardH <= vh;
		const top = below ? r.bottom + 12 : Math.max(8, r.top - 12 - cardH);
		const left = Math.min(Math.max(8, r.left), Math.max(8, vw - cardW - 8));
		card.style.top = top + 'px';
		card.style.left = left + 'px';
	}

	function render() {
		const { dom } = state;
		const step = STEPS[state.index];
		const shown = state.visible;
		const pos = shown.indexOf(state.index);
		dom.counter.textContent = t('tour_step_counter').replace('{n}', String(pos + 1)).replace('{total}', String(shown.length));
		dom.title.textContent = t(step.key + '_title');
		dom.text.textContent = t(step.key + '_text');
		dom.skip.textContent = t('tour_skip');
		dom.back.textContent = t('tour_back');
		dom.back.hidden = pos <= 0;
		dom.next.textContent = t(pos >= shown.length - 1 ? 'tour_done' : 'tour_next');
		const target = root.document.querySelector(step.sel);
		if (target && target.scrollIntoView) target.scrollIntoView({ block: 'center', behavior: 'auto' });
		place();
	}

	function goTo(index) {
		if (!state) return;
		state.index = index;
		const { card } = state.dom;
		const apply = () => {
			if (!state) return;
			render();
			card.classList.add('is-visible');
			state.dom.spot.classList.add('is-visible');
			card.focus();
		};
		clearTimeout(state.fadeTimer);
		if (reducedMotion()) { apply(); return; }
		card.classList.remove('is-visible');
		state.fadeTimer = setTimeout(apply, FADE_MS);
	}

	function next() {
		if (!state) return;
		const i = findStep(state.index + 1, 1);
		if (i === -1) finish(); else goTo(i);
	}
	function back() {
		if (!state) return;
		const i = findStep(state.index - 1, -1);
		if (i !== -1) goTo(i);
	}

	function finish() {
		if (!state) return;
		const s = state;
		state = null;
		clearTimeout(s.fadeTimer);
		clearTimeout(s.resizeTimer);
		root.document.removeEventListener('keydown', s.onKey, true);
		root.removeEventListener('resize', s.onResize);
		s.dom.overlay.classList.remove('is-visible');
		const remove = () => { if (s.dom.overlay.parentNode && s.dom.overlay.parentNode.removeChild) s.dom.overlay.parentNode.removeChild(s.dom.overlay); };
		if (reducedMotion()) remove(); else setTimeout(remove, FADE_MS);
		markDone();
		const back = s.returnFocus;
		if (back && back.isConnected !== false && typeof back.focus === 'function') back.focus();
	}

	function onKey(e) {
		if (!state) return;
		if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(); return; }
		if (e.key === 'Tab') {
			const { card, skip, back: backBtn, next: nextBtn } = state.dom;
			const items = [skip, backBtn, nextBtn].filter((b) => !b.hidden);
			const active = root.document.activeElement;
			const idx = items.indexOf(active);
			let target;
			if (e.shiftKey) target = idx <= 0 ? items[items.length - 1] : items[idx - 1];
			else target = idx === -1 || idx === items.length - 1 ? items[0] : items[idx + 1];
			e.preventDefault();
			(target || card).focus();
			return;
		}
		if (e.key === 'ArrowRight') { e.preventDefault(); next(); return; }
		if (e.key === 'ArrowLeft') { e.preventDefault(); back(); return; }
		// Skratky aplikácie (Alt+Shift+S/T/M, Ctrl+C...) počas návodu nesmú konať.
		if (e.altKey && e.shiftKey) e.stopPropagation();
	}

	/**
	 * @returns {boolean} true when the tour started
	 */
	function start() {
		if (state || !root.document || !root.document.body) return false;
		const first = findStep(0, 1);
		if (first === -1) return false;
		const visible = STEPS.map((_, i) => i).filter((i) => findStep(i, 1) === i);
		const doc = root.document;
		const dom = buildDom();
		const onResize = () => {
			if (!state || state.resizeTimer) return;
			state.resizeTimer = setTimeout(() => { if (state) { state.resizeTimer = null; place(); } }, RESIZE_THROTTLE_MS);
		};
		state = {
			index: first, visible, dom, fadeTimer: null, resizeTimer: null,
			returnFocus: doc.activeElement && doc.activeElement !== doc.body ? doc.activeElement : null,
			onKey, onResize,
		};
		dom.overlay.setAttribute('aria-label', t('tour_aria'));
		dom.skip.addEventListener('click', finish);
		dom.back.addEventListener('click', back);
		dom.next.addEventListener('click', next);
		doc.addEventListener('keydown', onKey, true);
		root.addEventListener('resize', onResize);
		dom.overlay.classList.add('is-visible');
		goTo(first);
		return true;
	}

	/** Spustí návod raz pri prvej návšteve (po načítaní prekladov). */
	function maybeAutoStart() {
		if (readDone()) return false;
		const modals = root.PxModal && root.PxModal._stack;
		if (modals && modals.length) return false;
		return start();
	}

	function isActive() { return Boolean(state); }

	const api = { start, finish, next, back, maybeAutoStart, isActive, STEPS, STORAGE_KEY };
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	if (root && typeof root === 'object') root.Tour = api;
})(typeof window !== 'undefined' ? window : globalThis);
