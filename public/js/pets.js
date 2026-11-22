/* ═══════════════════════════════════════════════════════════════════
   gIVEMEGAME.IO — roaming pets (Phase 9)

   Small pixel pets walk along the bottom of the screen, hide behind the
   side panels, sleep, and give tips when clicked. Species unlock by RPG
   level (data/pets.json). Tips and mini-challenges are pre-written
   (data/pet-tips.{sk,en}.json): zero AI tokens. A correct challenge answer
   can pay a small reward through POST /api/pets/interact (server-side
   daily cap); without a login or database the pet just works locally.

   Performance rules (low-end school laptops):
   • one setTimeout scheduler at 200 ms (5 updates/s) for ALL pets; no
     per-frame animation loop; movement is a CSS transform transition
   • nothing runs while document.hidden
   • reduced motion or "do not disturb": static pets, no timer at all
   • after 90 s without input every pet falls asleep and the timer stops;
     the next input wakes them
   • the overlay takes no pointer events; only the pets and the bubble do

   Settings (localStorage givemegame_pets): off / one pet / all, plus
   "do not disturb". Strings: window.givemegame_t(key, fallback).

   Exposes: window.Pets (browser) / module.exports (tests)
   ═══════════════════════════════════════════════════════════════════ */
(function (root) {
	'use strict';

	const STORAGE_KEY = 'givemegame_pets';
	const TICK_MS = 200;               // 5 updates per second
	const STEP_PX = 10;                // 50 px/s while walking
	const INACTIVITY_MS = 90 * 1000;
	const AUTO_TIP_MS = 4 * 60 * 1000;
	const BUBBLE_MS = 9000;
	const MAX_VISIBLE = 3;
	const MAX_LEVEL = 10;
	const SVG_NS = 'http://www.w3.org/2000/svg';
	const MODES = ['all', 'one', 'off'];
	const DEFAULTS = Object.freeze({ mode: 'all', quiet: false, chosen: null, seenLevel: 0 });

	const FB = {
		pet_aria: 'Zvieratko {name}. Klikni pre radu.',
		pet_unlocked: 'Nové zvieratko: {name}!',
		pet_settings_open: 'Nastavenia zvieratiek', pet_settings_title: 'Zvieratká',
		pet_mode_all: 'Všetky odomknuté', pet_mode_one: 'Len jedno', pet_mode_off: 'Vypnuté',
		pet_quiet: 'Nerušiť (zvieratká stoja)', pet_choose: 'Ktoré zvieratko',
		pet_challenge_btn: 'Hádanka', pet_close: 'Zavrieť',
		pet_challenge_correct: 'Správne!', pet_challenge_wrong: 'Skoro. Skús inú hádanku!',
		pet_challenge_reward: 'Správne! +{n} mincí',
		pet_challenge_limit: 'Správne! Na dnes už viac mincí nedám.',
		pet_challenge_login: 'Správne! Prihlás sa a získaš mince.',
		pet_challenge_offline: 'Správne! Mince teraz nejdú, ale pekne.',
		pet_name_slime: 'Slizko', pet_name_cat: 'Mačka', pet_name_robot: 'Robot', pet_name_owl: 'Sova', pet_name_dragon: 'Drak'
	};

	function t(key, vars) {
		const fn = root.givemegame_t;
		let s = typeof fn === 'function' ? fn(key, FB[key] || key) : (FB[key] || key);
		if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, v);
		return s;
	}

	// ─── Pure helpers (unit-tested) ──────────────────────────────────
	function normalizeSettings(raw) {
		const o = raw && typeof raw === 'object' ? raw : {};
		return {
			mode: MODES.includes(o.mode) ? o.mode : DEFAULTS.mode,
			quiet: o.quiet === true,
			chosen: typeof o.chosen === 'string' && /^[a-z]{2,20}$/.test(o.chosen) ? o.chosen : null,
			seenLevel: Number.isInteger(o.seenLevel) && o.seenLevel >= 0 && o.seenLevel <= MAX_LEVEL ? o.seenLevel : 0
		};
	}

	function clampLevel(n) {
		const v = Math.floor(Number(n));
		return Number.isFinite(v) ? Math.min(MAX_LEVEL, Math.max(1, v)) : 1;
	}

	/** Species whose unlock level is reached (data order). */
	function unlockedSpecies(species, level) {
		const lv = clampLevel(level);
		return (species || []).filter((s) => Number(s.unlockLevel) <= lv);
	}

	/** Which pets are shown for these settings (off: none; one: the chosen or newest; all: newest MAX_VISIBLE). */
	function visibleSpecies(species, level, settings) {
		const s = normalizeSettings(settings);
		const open = unlockedSpecies(species, level);
		if (s.mode === 'off' || !open.length) return [];
		if (s.mode === 'one') return [open.find((p) => p.id === s.chosen) || open[open.length - 1]];
		return open.slice(-MAX_VISIBLE);
	}

	/** Tips file language: Czech falls back to Slovak, everything else to English. */
	function langFile(lang) {
		const l = String(lang || '').slice(0, 2).toLowerCase();
		return l === 'sk' || l === 'cs' ? 'sk' : 'en';
	}

	const TRANSITIONS = {
		idle: [['walk', 0.5], ['idle', 0.2], ['sleep', 0.15], ['peek', 0.15]],
		walk: [['idle', 0.6], ['walk', 0.2], ['peek', 0.2]],
		sleep: [['idle', 1]],
		peek: [['walk', 0.7], ['idle', 0.3]]
	};
	const DURATION = { walk: [10, 30], idle: [10, 30], sleep: [60, 150], peek: [20, 40] };

	/** State machine step: { state, ticks } after `cur`; rand() in [0,1). */
	function pickNext(cur, rand) {
		const row = TRANSITIONS[cur] || TRANSITIONS.idle;
		let r = rand();
		let next = row[row.length - 1][0];
		for (const [name, p] of row) { if (r < p) { next = name; break; } r -= p; }
		const [lo, hi] = DURATION[next];
		return { state: next, ticks: lo + Math.floor(rand() * (hi - lo + 1)) };
	}

	function pickIndex(len, rand, avoid) {
		if (len <= 1) return 0;
		let i = Math.floor(rand() * len);
		if (i === avoid) i = (i + 1) % len;
		return i;
	}

	// ─── Browser part ────────────────────────────────────────────────
	const api = { normalizeSettings, clampLevel, unlockedSpecies, visibleSpecies, langFile, pickNext, pickIndex,
		STORAGE_KEY, TICK_MS, INACTIVITY_MS, MAX_VISIBLE, DEFAULTS };

	if (typeof root.document === 'undefined') { module.exports = api; return; }

	const doc = root.document;
	let data = null;          // pets.json
	let tipsData = null;      // pet-tips.{lang}.json
	let tipsLang = null;
	let settings = normalizeSettings(null);
	let level = 1;
	let overlay = null;
	let bubble = null;
	let pets = [];            // { spec, el, x, dir, state, ticks, frame }
	let timer = null;
	let lastActivity = Date.now();
	let asleepAll = false;
	let autoTipAt = Date.now() + AUTO_TIP_MS;
	let bubbleTimer = null;
	let lastTip = -1;
	let lastChallenge = -1;
	let reduced = false;
	let bounds = { min: 0, max: 600, width: 50 };

	function loadSettings() {
		try { return normalizeSettings(JSON.parse(root.localStorage.getItem(STORAGE_KEY))); } catch (e) { return normalizeSettings(null); }
	}
	function save() { try { root.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (e) {} }

	function el(tag, attrs, text) {
		const n = doc.createElement(tag);
		for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
		if (text !== undefined) n.textContent = text;
		return n;
	}

	function spriteSvg(spec, grid) {
		const svg = doc.createElementNS(SVG_NS, 'svg');
		svg.setAttribute('viewBox', `0 0 ${grid} ${grid}`);
		svg.setAttribute('shape-rendering', 'crispEdges');
		svg.setAttribute('aria-hidden', 'true');
		svg.setAttribute('focusable', 'false');
		spec.frames.forEach((rows, fi) => {
			const g = doc.createElementNS(SVG_NS, 'g');
			g.setAttribute('class', 'px-pet__f');
			g.setAttribute('data-f', String(fi));
			rows.forEach((row, y) => {
				for (let x = 0; x < row.length; x++) {
					const color = spec.palette[row[x]];
					if (!color) continue;
					const r = doc.createElementNS(SVG_NS, 'rect');
					r.setAttribute('x', String(x)); r.setAttribute('y', String(y));
					r.setAttribute('width', '1'); r.setAttribute('height', '1');
					r.setAttribute('fill', color);
					g.appendChild(r);
				}
			});
			svg.appendChild(g);
		});
		return svg;
	}

	function ensureOverlay() {
		if (overlay) return;
		overlay = el('div', { class: 'px-pets', 'aria-live': 'off' });
		doc.body.appendChild(overlay);
	}

	function isStatic() { return reduced || settings.quiet; }

	function panelEdges() {
		const vw = root.innerWidth || 1024;
		let min = 0; let max = vw;
		const left = doc.querySelector('aside.left-panel');
		const right = doc.querySelector('aside.right-panel');
		const visible = (a) => a && root.getComputedStyle(a).display !== 'none' && a.getBoundingClientRect().width > 0;
		if (visible(left)) { const r = left.getBoundingClientRect(); if (r.right < vw / 2) min = r.right; }
		if (visible(right)) { const r = right.getBoundingClientRect(); if (r.left > vw / 2) max = r.left; }
		return { min, max, vw };
	}

	function measure() {
		const e = panelEdges();
		const first = pets[0] && pets[0].el;
		const w = first ? first.offsetWidth || 50 : 50;
		bounds = { min: e.min, max: Math.max(e.min, e.max - w), width: w, edgeMin: e.min, edgeMax: e.max };
	}

	function place(p, x) {
		p.x = x;
		p.el.style.transform = `translate3d(${Math.round(x)}px,0,0)`;
	}

	function setState(p, state, ticks) {
		p.state = state; p.ticks = ticks;
		p.el.setAttribute('data-state', state);
		p.el.setAttribute('data-dir', p.dir > 0 ? 'r' : 'l');
		if (state === 'peek') {
			// half hidden behind the nearest side panel (panels sit above the overlay)
			const toRight = p.x > (bounds.min + bounds.max) / 2;
			p.dir = toRight ? 1 : -1;
			p.el.setAttribute('data-dir', toRight ? 'r' : 'l');
			place(p, toRight ? bounds.edgeMax - bounds.width * 0.45 : bounds.edgeMin - bounds.width * 0.55);
		}
		if (state !== 'walk') p.el.setAttribute('data-frame', '0');
	}

	function layoutStatic() {
		measure();
		pets.forEach((p, i) => {
			p.dir = 1;
			setState(p, settings.quiet ? 'sleep' : 'idle', Infinity);
			place(p, Math.min(bounds.max, bounds.min + 16 + i * (bounds.width + 10)));
		});
	}

	function buildPets() {
		stopTimer();
		hideBubble();
		if (overlay) overlay.querySelectorAll('.px-pet').forEach((n) => n.remove());
		pets = [];
		if (!data) return;
		const list = visibleSpecies(data.species, level, settings);
		if (!list.length) { if (overlay) overlay.hidden = true; return; }
		ensureOverlay();
		overlay.hidden = false;
		list.forEach((spec, i) => {
			const name = t(spec.nameKey);
			const btn = el('button', {
				type: 'button', class: 'px-pet', 'data-species': spec.id, 'data-state': 'idle', 'data-frame': '0', 'data-dir': 'r',
				'aria-label': t('pet_aria', { name }), tabindex: i === 0 ? '0' : '-1'
			});
			btn.appendChild(spriteSvg(spec, data.grid || 10));
			btn.addEventListener('click', () => onPetClick(pets.find((q) => q.el === btn)));
			overlay.appendChild(btn);
			pets.push({ spec, el: btn, x: 0, dir: 1, state: 'idle', ticks: 0, frame: 0 });
		});
		measure();
		if (isStatic()) { layoutStatic(); return; }
		pets.forEach((p, i) => {
			p.dir = i % 2 ? -1 : 1;
			place(p, bounds.min + 20 + Math.random() * Math.max(1, bounds.max - bounds.min - 40));
			setState(p, 'idle', 5 + i * 7);
		});
		asleepAll = false;
		lastActivity = Date.now();
		startTimer();
	}

	// ─── Scheduler ───────────────────────────────────────────────────
	function startTimer() {
		if (timer || isStatic() || doc.hidden || asleepAll || !pets.length) return;
		timer = root.setTimeout(tick, TICK_MS);
	}
	function stopTimer() { if (timer) { root.clearTimeout(timer); timer = null; } }

	function tick() {
		timer = null;
		if (doc.hidden || isStatic()) return;
		const now = Date.now();
		if (now - lastActivity > INACTIVITY_MS) {
			asleepAll = true;
			pets.forEach((p) => setState(p, 'sleep', Infinity));
			return; // no timer until the next input
		}
		for (const p of pets) {
			if (p.state === 'walk') {
				let nx = p.x + p.dir * STEP_PX;
				if (nx <= bounds.min || nx >= bounds.max) {
					nx = Math.min(bounds.max, Math.max(bounds.min, nx));
					p.dir = -p.dir;
					p.ticks = 0;
				}
				place(p, nx);
				p.el.setAttribute('data-dir', p.dir > 0 ? 'r' : 'l');
				p.frame ^= 1;
				p.el.setAttribute('data-frame', String(p.frame));
			}
			if (--p.ticks <= 0) {
				const n = pickNext(p.state, Math.random);
				if (n.state === 'walk') p.dir = Math.random() < 0.5 ? -1 : 1;
				setState(p, n.state, n.ticks);
			}
		}
		if (now > autoTipAt && !bubble && pets.length && tipsData) {
			autoTipAt = now + AUTO_TIP_MS;
			showTip(pets[Math.floor(Math.random() * pets.length)]);
		}
		startTimer();
	}

	function onActivity() {
		lastActivity = Date.now();
		if (asleepAll && !doc.hidden && !isStatic()) {
			asleepAll = false;
			pets.forEach((p) => setState(p, 'idle', 5));
			startTimer();
		}
	}

	function onVisibility() {
		if (doc.hidden) { stopTimer(); return; }
		lastActivity = Date.now();
		if (!asleepAll) startTimer();
	}

	function onResize() { if (pets.length) { measure(); if (isStatic()) layoutStatic(); } }

	// ─── Bubble: tip, challenge, settings ────────────────────────────
	function hideBubble() {
		if (bubbleTimer) { root.clearTimeout(bubbleTimer); bubbleTimer = null; }
		if (bubble) { bubble.remove(); bubble = null; }
	}

	function openBubble(p, keepOpen) {
		hideBubble();
		bubble = el('div', { class: 'px-pets__bubble', role: 'status' });
		const rect = p.el.getBoundingClientRect();
		const vw = root.innerWidth || 1024;
		bubble.style.left = `${Math.max(8, Math.min(vw - 260, rect.left - 100))}px`;
		overlay.appendChild(bubble);
		if (!keepOpen) bubbleTimer = root.setTimeout(hideBubble, BUBBLE_MS);
		return bubble;
	}

	function addActions(b, p) {
		const row = el('div', { class: 'px-pets__row' });
		if (tipsData && (tipsData.challenges || []).length) {
			const c = el('button', { type: 'button', class: 'px-pets__btn' }, t('pet_challenge_btn'));
			c.addEventListener('click', () => showChallenge(p));
			row.appendChild(c);
		}
		const s = el('button', { type: 'button', class: 'px-pets__btn', 'aria-label': t('pet_settings_open') }, '⚙');
		s.addEventListener('click', () => showSettings(p));
		const x = el('button', { type: 'button', class: 'px-pets__btn', 'aria-label': t('pet_close') }, '✕');
		x.addEventListener('click', hideBubble);
		row.appendChild(s); row.appendChild(x);
		b.appendChild(row);
	}

	function showTip(p, text) {
		const tips = (tipsData && tipsData.tips) || [];
		if (!text && !tips.length) return;
		const b = openBubble(p);
		if (!text) { lastTip = pickIndex(tips.length, Math.random, lastTip); text = tips[lastTip]; }
		b.appendChild(el('p', { class: 'px-pets__text' }, text));
		addActions(b, p);
	}

	function onPetClick(p) {
		if (!p) return;
		onActivity();
		if (bubble) { hideBubble(); return; }
		p.el.setAttribute('data-frame', '1');
		showTip(p);
	}

	function showChallenge(p) {
		const list = (tipsData && tipsData.challenges) || [];
		if (!list.length) return;
		lastChallenge = pickIndex(list.length, Math.random, lastChallenge);
		const c = list[lastChallenge];
		const b = openBubble(p, true);
		b.appendChild(el('p', { class: 'px-pets__text' }, c.q));
		const row = el('div', { class: 'px-pets__row' });
		c.options.forEach((label, i) => {
			const o = el('button', { type: 'button', class: 'px-pets__btn' }, label);
			o.addEventListener('click', () => answer(p, c, i));
			row.appendChild(o);
		});
		b.appendChild(row);
	}

	function signedIn() {
		try {
			const raw = root.sessionStorage.getItem('givemegame_user') || root.localStorage.getItem('givemegame_user');
			const u = raw ? JSON.parse(raw) : null;
			return !!(u && u.uid && u.uid !== 'guest');
		} catch (e) { return false; }
	}

	async function answer(p, c, i) {
		if (i !== c.correct) { showTip(p, t('pet_challenge_wrong')); return; }
		if (!signedIn() || !root.RpgNet) { showTip(p, t(signedIn() ? 'pet_challenge_offline' : 'pet_challenge_login')); return; }
		showTip(p, t('pet_challenge_correct'));
		const res = await root.RpgNet.request('/api/pets/interact', {
			method: 'POST', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ challenge_id: c.id, answer: i })
		});
		const d = res.data || {};
		let msg = t('pet_challenge_offline');
		if (res.kind === 'ok' && d.rewarded) {
			msg = t('pet_challenge_reward', { n: d.credited });
			try { if (root.Coins && root.Coins.syncServerBalance) root.Coins.syncServerBalance(d.balance); } catch (e) {}
		} else if (res.status === 429) msg = t('pet_challenge_limit');
		showTip(p, msg);
	}

	function showSettings(p) {
		const b = openBubble(p, true);
		b.appendChild(el('p', { class: 'px-pets__text px-pets__title' }, t('pet_settings_title')));
		const form = el('div', { class: 'px-pets__form' });
		MODES.forEach((m) => {
			const id = `px-pets-mode-${m}`;
			const lab = el('label', { for: id, class: 'px-pets__opt' });
			const inp = el('input', { type: 'radio', name: 'px-pets-mode', id, value: m });
			if (settings.mode === m) inp.checked = true;
			inp.addEventListener('change', () => { settings.mode = m; save(); buildPets(); });
			lab.appendChild(inp); lab.appendChild(el('span', {}, t(`pet_mode_${m}`)));
			form.appendChild(lab);
		});
		if (settings.mode === 'one' && data) {
			const sel = el('select', { class: 'px-pets__select', 'aria-label': t('pet_choose') });
			unlockedSpecies(data.species, level).forEach((sp) => {
				const o = el('option', { value: sp.id }, t(sp.nameKey));
				if (pets[0] && pets[0].spec.id === sp.id) o.selected = true;
				sel.appendChild(o);
			});
			sel.addEventListener('change', () => { settings.chosen = sel.value; save(); buildPets(); });
			form.appendChild(sel);
		}
		const qLab = el('label', { for: 'px-pets-quiet', class: 'px-pets__opt' });
		const q = el('input', { type: 'checkbox', id: 'px-pets-quiet' });
		q.checked = settings.quiet;
		q.addEventListener('change', () => { settings.quiet = q.checked; save(); buildPets(); });
		qLab.appendChild(q); qLab.appendChild(el('span', {}, t('pet_quiet')));
		form.appendChild(qLab);
		b.appendChild(form);
		const x = el('button', { type: 'button', class: 'px-pets__btn' }, t('pet_close'));
		x.addEventListener('click', hideBubble);
		b.appendChild(x);
	}

	// ─── Data + public API ───────────────────────────────────────────
	async function getJson(path) {
		const r = await root.fetch(path);
		if (!r.ok) throw new Error(String(r.status));
		return r.json();
	}

	async function loadTips() {
		const lang = langFile(doc.documentElement.lang);
		if (lang === tipsLang && tipsData) return;
		try { tipsData = await getJson(`/data/pet-tips.${lang}.json`); tipsLang = lang; } catch (e) { tipsData = null; }
	}

	/** Called with the RPG level whenever it is known (rpg-talents.js load). */
	function setLevel(n) {
		const lv = clampLevel(n);
		if (lv === level) return;
		const old = level;
		level = lv;
		if (data) {
			const fresh = unlockedSpecies(data.species, lv).filter((s) => Number(s.unlockLevel) > Math.max(old, settings.seenLevel));
			if (settings.seenLevel > 0 && fresh.length) announceUnlock(fresh[fresh.length - 1]);
			settings.seenLevel = Math.max(settings.seenLevel, lv);
			save();
			buildPets();
			if (fresh.length && settings.seenLevel > 0 && pets.length) {
				const p = pets.find((q) => q.spec.id === fresh[fresh.length - 1].id) || pets[pets.length - 1];
				showTip(p, t('pet_unlocked', { name: t(fresh[fresh.length - 1].nameKey) }));
			}
		}
	}

	function announceUnlock(spec) {
		try {
			const gu = root.GameUI || (root.App && root.App.UI);
			if (gu && gu.toast) gu.toast('🐾 ' + t('pet_unlocked', { name: t(spec.nameKey) }));
		} catch (e) {}
	}

	function refresh() {
		loadTips().then(() => { pets.forEach((p) => p.el.setAttribute('aria-label', t('pet_aria', { name: t(p.spec.nameKey) }))); });
	}

	async function init() {
		if (root.__petsStarted) return;
		root.__petsStarted = true;
		settings = loadSettings();
		const mq = root.matchMedia ? root.matchMedia('(prefers-reduced-motion: reduce)') : null;
		reduced = !!(mq && mq.matches);
		if (mq && mq.addEventListener) mq.addEventListener('change', (e) => { reduced = e.matches; buildPets(); });
		try { data = await getJson('/data/pets.json'); } catch (e) { return; }
		await loadTips();
		// the RPG level may have loaded before this script
		try { const known = root.__lastRpgTalentsData; if (known && known.progression) level = clampLevel(known.progression.level); } catch (e) {}
		// first run: remember the current level so existing unlocks are not announced
		if (!settings.seenLevel) { settings.seenLevel = level; save(); }
		buildPets();
		for (const ev of ['pointerdown', 'keydown', 'wheel', 'pointermove']) root.addEventListener(ev, onActivity, { passive: true });
		doc.addEventListener('visibilitychange', onVisibility);
		root.addEventListener('resize', onResize, { passive: true });
	}

	Object.assign(api, { init, setLevel, refresh, _state: () => ({ level, settings, pets: pets.length, timer: !!timer, asleepAll }) });
	root.Pets = api;
	if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
	else init();
})(typeof window !== 'undefined' ? window : globalThis);
