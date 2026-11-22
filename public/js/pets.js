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
	const BUBBLE_W = 240;
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
		pet_name_frog: 'Žabka', pet_name_cat: 'Mačka', pet_name_bunny: 'Zajko', pet_name_owl: 'Sova', pet_name_dragon: 'Drak',
		pet_xp_gain: 'Správne! {name} dostáva +{n} XP.',
		pet_care_title: 'Starostlivosť', pet_care_food: 'Sýtosť', pet_care_clean: 'Čistota', pet_care_fun: 'Zábava',
		pet_care_feed: 'Nakŕmiť', pet_care_wash: 'Umyť', pet_care_scoop: 'Upratať', pet_care_play: 'Zabaviť',
		pet_care_poop: 'Kôpky: {n}', pet_care_full: '{name} to teraz nepotrebuje.', pet_care_thanks: '{name} ďakuje!',
		pet_care_hint: 'Zvieratká potrebujú jedlo, čistotu a zábavu. Keď sa o ne nikto nestará, odídu.',
		pet_care_gone: '{name} odišlo, lebo sa oň nikto nestaral.', pet_care_recall: 'Zavolať späť',
		pet_care_none: 'Zvieratká sa odomykajú s RPG levelom.',
		pet_need_food: 'Mám hlad!', pet_need_clean: 'Potrebujem sa umyť.', pet_need_fun: 'Nudím sa. Zahráš sa so mnou?',
		pet_need_poop: 'Uprac po mne, prosím.', pet_poop_aria: 'Kôpka. Klikni a uprac ju.',
		pet_level: 'Lv {n}'
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

	// ─── Care (needs, poop, pet XP) — pure, unit-tested ──────────────
	// Needs fall in real time, also while the page is closed (computed from
	// the last timestamp, no timer). From full to empty: food ~60 h,
	// cleanliness ~80 h, fun ~50 h. A pet whose needs are all at zero leaves;
	// it can be called back but loses half of its XP.
	const HOUR = 3600 * 1000;
	const DECAY = Object.freeze({ food: 1.7, clean: 1.25, fun: 2 });   // points per hour
	const POOP_EVERY_H = 5;
	const MAX_POOP = 3;
	const CARE_GAIN = 35;
	const CARE_XP = 2;
	const RIDDLE_XP = 10;
	const XP_PER_LEVEL = 40;
	const CARE_ACTIONS = ['feed', 'wash', 'scoop', 'play'];

	const clamp100 = (n) => Math.max(0, Math.min(100, Number(n) || 0));

	function defaultCare(now) {
		return { xp: 0, food: 80, clean: 80, fun: 80, poop: 0, poopH: 0, t: now, gone: false };
	}

	function normalizeCare(raw, now) {
		const o = raw && typeof raw === 'object' ? raw : null;
		if (!o) return defaultCare(now);
		const t0 = Number(o.t);
		return {
			xp: Math.max(0, Math.min(100000, Math.floor(Number(o.xp) || 0))),
			food: clamp100(o.food), clean: clamp100(o.clean), fun: clamp100(o.fun),
			poop: Math.max(0, Math.min(MAX_POOP, Math.floor(Number(o.poop) || 0))),
			poopH: Math.max(0, Number(o.poopH) || 0),
			t: Number.isFinite(t0) && t0 > 0 && t0 <= now ? t0 : now,
			gone: o.gone === true
		};
	}

	/** Needs after the time since c.t; returns a new object. */
	function decayCare(c, now) {
		if (c.gone) return { ...c, t: now };
		const h = Math.max(0, (now - c.t) / HOUR);
		if (h <= 0) return c;
		const poopH = c.poopH + h;
		const newPoop = Math.floor(poopH / POOP_EVERY_H);
		const poop = Math.min(MAX_POOP, c.poop + newPoop);
		const next = {
			...c,
			food: clamp100(c.food - DECAY.food * h),
			// every poop on the floor makes the pet dirty faster
			clean: clamp100(c.clean - (DECAY.clean + poop * 0.5) * h),
			fun: clamp100(c.fun - DECAY.fun * h),
			poop,
			poopH: poopH - newPoop * POOP_EVERY_H,
			t: now
		};
		if (next.food === 0 && next.clean === 0 && next.fun === 0) next.gone = true;
		return next;
	}

	/** 0..100, how well the pet is doing. */
	function moodOf(c) {
		if (c.gone) return 0;
		return Math.max(0, Math.round((c.food + c.clean + c.fun) / 3 - c.poop * 5));
	}

	function petLevel(xp) { return Math.min(MAX_LEVEL, 1 + Math.floor((Number(xp) || 0) / XP_PER_LEVEL)); }

	/** One care action: { care, ok }. ok=false when the pet did not need it (no XP then). */
	function applyCare(c, action, now) {
		const cur = decayCare(c, now);
		if (cur.gone || !CARE_ACTIONS.includes(action)) return { care: cur, ok: false };
		const field = { feed: 'food', wash: 'clean', play: 'fun' }[action];
		if (action === 'scoop') {
			if (!cur.poop) return { care: cur, ok: false };
			return { care: { ...cur, poop: 0, clean: clamp100(cur.clean + 10), xp: cur.xp + CARE_XP }, ok: true };
		}
		if (cur[field] >= 95) return { care: cur, ok: false };
		return { care: { ...cur, [field]: clamp100(cur[field] + CARE_GAIN), xp: cur.xp + CARE_XP }, ok: true };
	}

	function addXp(c, n) { return { ...c, xp: c.xp + Math.max(0, Math.floor(n)) }; }

	/** Bring a pet back: needs at 60, half of the XP is lost. */
	function recall(c, now) { return { ...defaultCare(now), food: 60, clean: 60, fun: 60, xp: Math.floor(c.xp / 2) }; }

	/** The most urgent need as a string key, or null. */
	function urgentNeed(c) {
		if (c.gone) return null;
		if (c.poop >= 2) return 'poop';
		const low = [['food', c.food], ['clean', c.clean], ['fun', c.fun]].filter(([, v]) => v < 30).sort((a, b) => a[1] - b[1]);
		return low.length ? low[0][0] : null;
	}

	// ─── Browser part ────────────────────────────────────────────────
	const api = { normalizeSettings, clampLevel, unlockedSpecies, visibleSpecies, langFile, pickNext, pickIndex,
		defaultCare, normalizeCare, decayCare, moodOf, petLevel, applyCare, addXp, recall, urgentNeed,
		STORAGE_KEY, TICK_MS, INACTIVITY_MS, MAX_VISIBLE, DEFAULTS, RIDDLE_XP, XP_PER_LEVEL, MAX_POOP };

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
	const CARE_KEY = 'givemegame_pet_care';
	let care = {};            // speciesId -> care state (normalizeCare)
	let careSel = null;       // species shown in the care panel
	let careTimer = null;
	let poopEls = [];

	function loadCare() {
		let raw = null;
		try { raw = JSON.parse(root.localStorage.getItem(CARE_KEY)); } catch (e) { raw = null; }
		const now = Date.now();
		care = {};
		if (raw && typeof raw === 'object') {
			for (const [id, c] of Object.entries(raw)) if (/^[a-z]{2,20}$/.test(id)) care[id] = decayCare(normalizeCare(c, now), now);
		}
	}
	function saveCare() { try { root.localStorage.setItem(CARE_KEY, JSON.stringify(care)); } catch (e) {} }
	function careOf(id) {
		const now = Date.now();
		care[id] = care[id] ? decayCare(care[id], now) : defaultCare(now);
		return care[id];
	}

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

	/** x from the left edge, y = height above the floor (0 = on the floor). */
	function place(p, x, y) {
		p.x = x;
		if (y !== undefined) p.y = Math.max(0, y);
		p.el.style.transform = `translate3d(${Math.round(x)}px,${-Math.round(p.y || 0)}px,0)`;
	}

	// ─── Drag and drop: pick a pet up, it falls onto a button or the floor ──
	const FLOOR_GAP = 8;   // .px-pet { bottom: 8px }
	function floorTop() { return (root.innerHeight || 768) - FLOOR_GAP; }

	/** Height above the floor of the first button top under (cx, fromBottom), or 0. */
	function findPerch(cx, fromBottom) {
		let best = null;
		const vh = root.innerHeight || 768;
		doc.querySelectorAll('button, .btn, a.px-btn').forEach((b) => {
			if (b.closest('.px-pets')) return;
			const r = b.getBoundingClientRect();
			if (r.width < 40 || r.height < 16 || cx < r.left + 6 || cx > r.right - 6) return;
			if (r.top < fromBottom - 4 || r.top > vh - 40) return;
			// only a button that is really visible at that spot (not under a panel or modal)
			const hit = doc.elementFromPoint(cx, r.top + 2);
			if (!hit || !(hit === b || b.contains(hit))) return;
			if (!best || r.top < best) best = r.top;
		});
		return best === null ? 0 : Math.max(0, floorTop() - best);
	}

	function fall(p, cx) {
		const bottom = floorTop() - p.y;
		const target = findPerch(cx, bottom);
		const dist = Math.max(0, p.y - target);
		p.perch = target > 0;
		p.el.setAttribute('data-state', 'fall');
		p.el.style.transitionDuration = isStatic() ? '0ms' : `${Math.round(Math.min(700, 120 + Math.sqrt(dist) * 22))}ms`;
		place(p, p.x, target);
		const land = () => {
			p.el.style.transitionDuration = '';
			p.held = false;
			setState(p, 'idle', 15 + Math.floor(Math.random() * 20));
			p.el.setAttribute('data-land', '1');
			root.setTimeout(() => p.el.removeAttribute('data-land'), 260);
			syncTop();
		};
		root.setTimeout(land, parseInt(p.el.style.transitionDuration, 10) + 20);
	}

	/** While a pet is held or sits on a button it is drawn above the side panels. */
	function syncTop() {
		if (overlay) overlay.classList.toggle('px-pets--top', pets.some((q) => q.held || q.perch));
	}

	function attachDrag(p) {
		let start = null;
		p.el.addEventListener('pointerdown', (e) => {
			if (e.button !== 0) return;
			start = { x: e.clientX, y: e.clientY, id: e.pointerId };
			// capture right away: a fast drag leaves the pet before the first move
			try { p.el.setPointerCapture(e.pointerId); } catch (err) {}
		});
		p.el.addEventListener('pointermove', (e) => {
			if (!start || e.pointerId !== start.id) return;
			if (!p.held && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 6) return;
			if (!p.held) {
				p.held = true; p.perch = false;
				hideBubble();
				p.el.setAttribute('data-state', 'held');
				p.el.style.transitionDuration = '0ms';
				syncTop();
			}
			const w = bounds.width;
			const x = Math.max(0, Math.min((root.innerWidth || 1024) - w, e.clientX - w / 2));
			place(p, x, floorTop() - e.clientY - w / 2);
		});
		const end = (e) => {
			if (!start || e.pointerId !== start.id) return;
			start = null;
			if (!p.held) return;
			p.dragged = true;   // swallow the click that follows
			root.setTimeout(() => { p.dragged = false; }, 0);
			fall(p, p.x + bounds.width / 2);
			onActivity();
		};
		p.el.addEventListener('pointerup', end);
		p.el.addEventListener('pointercancel', end);
	}

	/** Scrolling or resizing moves the buttons away: perched pets drop to the floor. */
	function dropPerched() {
		pets.forEach((p) => { if (p.perch && !p.held) { p.perch = false; place(p, p.x, 0); } });
		syncTop();
	}

	// ─── Poop on the floor (click to clean) ──────────────────────────
	function renderPoop() {
		poopEls.forEach((n) => n.remove());
		poopEls = [];
		if (!overlay || !data) return;
		const range = Math.max(40, bounds.max - bounds.min);
		pets.forEach((p, pi) => {
			const c = careOf(p.spec.id);
			for (let k = 0; k < c.poop; k++) {
				const b = el('button', { type: 'button', class: 'px-pets__poop', 'aria-label': t('pet_poop_aria') });
				const frac = ((pi * 37 + k * 23 + 11) % 97) / 97;
				b.style.left = `${Math.round(bounds.min + frac * range)}px`;
				b.addEventListener('click', () => doCare(p.spec.id, 'scoop'));
				overlay.appendChild(b);
				poopEls.push(b);
			}
		});
	}

	function syncMood(p) {
		const c = careOf(p.spec.id);
		const m = moodOf(c);
		p.el.setAttribute('data-mood', m < 30 ? 'sad' : 'ok');
		p.el.setAttribute('data-lv', String(petLevel(c.xp)));
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
			p.perch = false;
			place(p, toRight ? bounds.edgeMax - bounds.width * 0.45 : bounds.edgeMin - bounds.width * 0.55, 0);
			syncTop();
		}
		// flyers take off when they start walking and land when they stop
		if (p.spec.move === 'fly' && !p.held) {
			if (state === 'walk') { p.perch = false; place(p, p.x, 40 + Math.random() * 140); syncTop(); }
			else if (!p.perch && state !== 'peek') place(p, p.x, 0);
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
		poopEls.forEach((n) => n.remove());
		poopEls = [];
		// a pet that left because nobody cared for it is not on screen
		const list = visibleSpecies(data.species, level, settings).filter((s) => !careOf(s.id).gone);
		if (!list.length) { if (overlay) overlay.hidden = true; return; }
		ensureOverlay();
		overlay.hidden = false;
		list.forEach((spec, i) => {
			const name = t(spec.nameKey);
			const btn = el('button', {
				type: 'button', class: 'px-pet', 'data-species': spec.id, 'data-state': 'idle', 'data-frame': '0', 'data-dir': 'r',
				'data-move': spec.move || 'walk', 'aria-label': t('pet_aria', { name }), tabindex: i === 0 ? '0' : '-1'
			});
			btn.appendChild(spriteSvg(spec, data.grid || 10));
			const p = { spec, el: btn, x: 0, y: 0, dir: 1, state: 'idle', ticks: 0, frame: 0, held: false, perch: false, dragged: false };
			btn.addEventListener('click', () => { if (!p.dragged) onPetClick(p); });
			attachDrag(p);
			overlay.appendChild(btn);
			pets.push(p);
			syncMood(p);
		});
		measure();
		renderPoop();
		syncTop();
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
			if (p.held || p.el.getAttribute('data-state') === 'fall') continue;
			if (p.state === 'walk' && p.perch && p.spec.move !== 'fly') {
				// sitting on a button: hop down to the floor first
				p.perch = false;
				place(p, p.x, 0);
				syncTop();
			}
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
			// a pet that needs something says so instead of a tip
			const needy = pets.find((q) => urgentNeed(careOf(q.spec.id)));
			if (needy) showTip(needy, t(`pet_need_${urgentNeed(careOf(needy.spec.id))}`));
			else showTip(pets[Math.floor(Math.random() * pets.length)]);
			pets.forEach(syncMood);
			renderPoop();
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
		const e = panelEdges();
		const room = Math.max(120, e.max - e.min - 16);
		const w = Math.min(BUBBLE_W, room);
		bubble.style.width = `${w}px`;
		// between the side panels (they sit above the overlay), never under one
		const left = Math.min(e.max - w - 8, Math.max(e.min + 8, rect.left - 100));
		bubble.style.left = `${Math.max(0, left)}px`;
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
		const need = urgentNeed(careOf(p.spec.id));
		showTip(p, need ? t(`pet_need_${need}`) : undefined);
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

	// The answers are public in pet-tips.*.json; the server-side daily cap (PET_REWARD.dailyLimit)
	// is the real protection against farming, not secrecy.
	async function answer(p, c, i) {
		if (i !== c.correct) { showTip(p, t('pet_challenge_wrong')); return; }
		// every correct answer trains the pet (local XP, no coins involved)
		care[p.spec.id] = addXp(careOf(p.spec.id), RIDDLE_XP);
		saveCare();
		syncMood(p);
		renderCare();
		const xpMsg = t('pet_xp_gain', { name: t(p.spec.nameKey), n: RIDDLE_XP });
		if (!signedIn() || !root.RpgNet) { showTip(p, xpMsg); return; }
		showTip(p, xpMsg);
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

	/** Settings form shared by the bubble and the always-available panel section. */
	function buildSettingsForm(prefix, afterChange) {
		const form = el('div', { class: 'px-pets__form' });
		const apply = () => { save(); buildPets(); if (afterChange) afterChange(); };
		MODES.forEach((m) => {
			const id = `${prefix}-mode-${m}`;
			const lab = el('label', { for: id, class: 'px-pets__opt' });
			const inp = el('input', { type: 'radio', name: `${prefix}-mode`, id, value: m });
			if (settings.mode === m) inp.checked = true;
			inp.addEventListener('change', () => { settings.mode = m; apply(); });
			lab.appendChild(inp); lab.appendChild(el('span', {}, t(`pet_mode_${m}`)));
			form.appendChild(lab);
		});
		if (settings.mode === 'one' && data) {
			const open = unlockedSpecies(data.species, level);
			const shown = (visibleSpecies(data.species, level, settings)[0] || {}).id;
			const sel = el('select', { class: 'px-pets__select', 'aria-label': t('pet_choose') });
			open.forEach((sp) => {
				const o = el('option', { value: sp.id }, t(sp.nameKey));
				if (shown === sp.id) o.selected = true;
				sel.appendChild(o);
			});
			sel.addEventListener('change', () => { settings.chosen = sel.value; apply(); });
			form.appendChild(sel);
		}
		const qLab = el('label', { for: `${prefix}-quiet`, class: 'px-pets__opt' });
		const q = el('input', { type: 'checkbox', id: `${prefix}-quiet` });
		q.checked = settings.quiet;
		q.addEventListener('change', () => { settings.quiet = q.checked; apply(); });
		qLab.appendChild(q); qLab.appendChild(el('span', {}, t('pet_quiet')));
		form.appendChild(qLab);
		return form;
	}

	function showSettings(p) {
		const b = openBubble(p, true);
		b.appendChild(el('p', { class: 'px-pets__text px-pets__title' }, t('pet_settings_title')));
		b.appendChild(buildSettingsForm('px-pets-b'));
		const x = el('button', { type: 'button', class: 'px-pets__btn' }, t('pet_close'));
		x.addEventListener('click', hideBubble);
		b.appendChild(x);
	}

	/**
	 * Settings that never disappear: a "Zvieratká" section in the gIVEMEGOCHI tab of
	 * the right panel (#pets-panel-settings). With every pet turned off there is
	 * still a way back on.
	 */
	function renderPanelSettings() {
		const host = doc.getElementById('pets-panel-settings');
		if (!host) return;
		host.textContent = '';
		host.appendChild(el('p', { class: 'px-pets__title' }, t('pet_settings_title')));
		host.appendChild(buildSettingsForm('px-pets-p', renderPanelSettings));
	}

	// ─── Care panel (gIVEMEGOCHI tab, #pets-care) ────────────────────
	function doCare(id, action) {
		const name = t((data.species.find((s) => s.id === id) || {}).nameKey || id);
		const res = applyCare(careOf(id), action, Date.now());
		care[id] = res.care;
		saveCare();
		const p = pets.find((q) => q.spec.id === id);
		if (p) {
			syncMood(p);
			if (res.ok && !p.held) {
				// a happy jump; under reduced motion the CSS animation is off
				p.el.setAttribute('data-happy', '1');
				root.setTimeout(() => p.el.removeAttribute('data-happy'), 700);
			}
			if (overlay && !overlay.hidden) showTip(p, t(res.ok ? 'pet_care_thanks' : 'pet_care_full', { name }));
		}
		renderPoop();
		renderCare();
		onActivity();
	}

	function bar(label, value) {
		const row = el('div', { class: 'px-care__stat' });
		row.appendChild(el('span', { class: 'px-care__label' }, label));
		const track = el('span', { class: 'px-care__bar', role: 'meter', 'aria-label': label,
			'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(value)) });
		const fill = el('span', { class: 'px-care__fill' });
		fill.style.width = `${Math.round(value)}%`;
		if (value < 30) fill.classList.add('px-care__fill--low');
		track.appendChild(fill);
		row.appendChild(track);
		return row;
	}

	function renderCare() {
		const host = doc.getElementById('pets-care');
		if (!host || !data) return;
		host.textContent = '';
		const open = unlockedSpecies(data.species, level);
		host.appendChild(el('p', { class: 'px-care__hint' }, t('pet_care_hint')));
		if (!open.length) { host.appendChild(el('p', {}, t('pet_care_none'))); return; }
		if (!open.some((s) => s.id === careSel)) careSel = open[0].id;
		const tabs = el('div', { class: 'px-care__tabs', role: 'group', 'aria-label': t('pet_choose') });
		open.forEach((s) => {
			const b = el('button', { type: 'button', class: 'px-care__tab', 'aria-pressed': String(s.id === careSel), title: t(s.nameKey) });
			b.appendChild(spriteSvg({ ...s, frames: [s.frames[0]] }, data.grid || 10));
			b.addEventListener('click', () => { careSel = s.id; renderCare(); });
			tabs.appendChild(b);
		});
		host.appendChild(tabs);

		const spec = open.find((s) => s.id === careSel);
		const c = careOf(spec.id);
		const name = t(spec.nameKey);
		const lv = petLevel(c.xp);
		const head = el('p', { class: 'px-care__name' }, `${name} · ${t('pet_level', { n: lv })}`);
		host.appendChild(head);
		const xpInLevel = lv >= MAX_LEVEL ? XP_PER_LEVEL : c.xp % XP_PER_LEVEL;
		host.appendChild(bar(`XP ${c.xp}`, (xpInLevel / XP_PER_LEVEL) * 100));

		if (c.gone) {
			host.appendChild(el('p', { class: 'px-care__gone' }, t('pet_care_gone', { name })));
			const r = el('button', { type: 'button', class: 'px-pets__btn' }, t('pet_care_recall'));
			r.addEventListener('click', () => { care[spec.id] = recall(c, Date.now()); saveCare(); buildPets(); renderCare(); });
			host.appendChild(r);
			return;
		}
		host.appendChild(bar(t('pet_care_food'), c.food));
		host.appendChild(bar(t('pet_care_clean'), c.clean));
		host.appendChild(bar(t('pet_care_fun'), c.fun));
		host.appendChild(el('p', { class: 'px-care__poop' }, t('pet_care_poop', { n: c.poop })));
		const row = el('div', { class: 'px-care__actions' });
		CARE_ACTIONS.forEach((a) => {
			const b = el('button', { type: 'button', class: 'px-pets__btn' }, t(`pet_care_${a}`));
			if (a === 'scoop' && !c.poop) b.disabled = true;
			b.addEventListener('click', () => doCare(spec.id, a));
			row.appendChild(b);
		});
		host.appendChild(row);
		saveCare();
	}

	/** Needs change slowly: refresh the panel once a minute, only while it is visible. */
	function careLoop() {
		careTimer = root.setTimeout(careLoop, 60 * 1000);
		if (doc.hidden) return;
		const host = doc.getElementById('pets-care');
		const wasGone = pets.length;
		if (host && !host.closest('[hidden]')) renderCare();
		pets.forEach(syncMood);
		// a pet may have left in the meantime
		if (data && visibleSpecies(data.species, level, settings).filter((s) => !careOf(s.id).gone).length !== wasGone) buildPets();
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
			renderPanelSettings();
			renderCare();
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
		renderPanelSettings();
		renderCare();
		loadTips().then(() => { pets.forEach((p) => p.el.setAttribute('aria-label', t('pet_aria', { name: t(p.spec.nameKey) }))); });
	}

	async function init() {
		if (root.__petsStarted) return;
		root.__petsStarted = true;
		settings = loadSettings();
		// before any await: setLevel() may run meanwhile and must not save default needs over the stored ones
		loadCare();
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
		renderPanelSettings();
		renderCare();
		careTimer = root.setTimeout(careLoop, 60 * 1000);
		for (const ev of ['pointerdown', 'keydown', 'wheel', 'pointermove']) root.addEventListener(ev, onActivity, { passive: true });
		doc.addEventListener('visibilitychange', onVisibility);
		root.addEventListener('resize', () => { dropPerched(); onResize(); }, { passive: true });
		root.addEventListener('scroll', dropPerched, { passive: true, capture: true });
		// the care panel is redrawn whenever its tab is opened
		const tab = doc.getElementById('tool-tab-tamagochi');
		if (tab) tab.addEventListener('click', () => root.setTimeout(renderCare, 0));
	}

	Object.assign(api, { init, setLevel, refresh, _state: () => ({ level, settings, pets: pets.length, timer: !!timer, asleepAll }) });
	root.Pets = api;
	if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
	else init();
})(typeof window !== 'undefined' ? window : globalThis);
