/* ═══════════════════════════════════════════════════════════════════
   gIVEMEGAME.IO — SMARTA dock (Phase 8)

   A small pixel portrait docked bottom-right of the game area
   (#game-viewport) with a collapsible, non-blocking chat and settings
   (position, size, mute, voice, style). Voice and facts come from
   window.Narrator (js/narrator.js); chat from POST /api/smarta/chat.

   • Sprite: 3 hand-drawn 16x16 frames (idle, blink, talk) in one SVG strip,
     animated with CSS steps() at <= 4 fps; static under reduced motion,
     paused while the tab is hidden. Styles: ui/px-smarta.css
   • Strings: window.givemegame_t(key, fallback); the dock re-translates on
     SmartaDock.refresh() (called from App.setLang).
   • No dependency on #narrator-bot. Settings live in localStorage
     (givemegame_smarta_dock).

   Exposes: window.SmartaDock (browser) / module.exports (tests)
   ═══════════════════════════════════════════════════════════════════ */
(function (root) {
	'use strict';

	const STORAGE_KEY = 'givemegame_smarta_dock';
	const MAX_CHARS = 300;
	const HISTORY_SENT = 5;
	const SVG_NS = 'http://www.w3.org/2000/svg';
	const STYLE_IDS = ['genz', 'sangvinik', 'flegmatik', 'cholerik', 'melancholik'];

	const DEFAULTS = Object.freeze({ pos: 'right', size: 'm', muted: false, voice: 'auto', state: 'collapsed' });
	const POS = ['right', 'left'];
	const SIZES = ['s', 'm', 'l'];
	const VOICES = ['auto', 'browser'];
	const STATES = ['collapsed', 'open', 'hidden'];

	// Fallback texts (Slovak); the real ones come from public/data/i18n/*.json.
	const FB = {
		smarta_dock_open: 'Otvoriť chat so SMARTOU', smarta_dock_close: 'Zavrieť chat',
		smarta_dock_hide: 'Skryť SMARTU', smarta_dock_show: 'Zobraziť SMARTU',
		smarta_chat_label: 'Rozhovor so SMARTOU',
		smarta_chat_greeting: 'Ahoj! Som SMARTA. Opýtaj sa ma, ako hra funguje, alebo si nechaj povedať zaujímavosť.',
		smarta_chat_placeholder: 'Napíš otázku…', smarta_chat_send: 'Poslať', smarta_chat_fact: 'Zaujímavosť',
		smarta_chat_thinking: 'Premýšľam…',
		smarta_chat_error: 'Teraz sa mi nepodarilo odpovedať. Skús to o chvíľu.',
		smarta_chat_rate: 'Píšeš príliš rýchlo. Chvíľu počkaj.',
		smarta_chat_too_long: 'Správa je príliš dlhá.',
		smarta_chat_daily: 'Na dnes som povedala dosť. Skúsime zajtra!',
		smarta_chat_pro_note: 'Odpovedám z pripravených odpovedí. Chat s umelou inteligenciou je v pláne Pro.',
		smarta_chat_you: 'Ty', smarta_chat_bot: 'SMARTA',
		smarta_settings_open: 'Nastavenia SMARTY', smarta_settings_title: 'Nastavenia',
		smarta_set_position: 'Miesto', smarta_pos_right: 'Vpravo', smarta_pos_left: 'Vľavo',
		smarta_set_size: 'Veľkosť', smarta_size_s: 'Malá', smarta_size_m: 'Stredná', smarta_size_l: 'Veľká',
		smarta_set_mute: 'Stíšiť hlas', smarta_set_voice: 'Hlas',
		smarta_voice_auto: 'Najlepší dostupný', smarta_voice_browser: 'Hlas prehliadača (zadarmo)',
		smarta_set_style: 'Štýl rozprávania', smarta_style_none: 'Bez štýlu',
		smarta_style_genz: 'Gen Z štýl', smarta_style_sangvinik: 'Sangvinik', smarta_style_flegmatik: 'Flegmatik',
		smarta_style_cholerik: 'Cholerik', smarta_style_melancholik: 'Melancholik',
	};

	function t(key) {
		const fb = FB[key] !== undefined ? FB[key] : key;
		return typeof root.givemegame_t === 'function' ? root.givemegame_t(key, fb) : fb;
	}

	// ─── Sprite ──────────────────────────────────────────────────────
	// h hair, f face, e eye, m mouth, M open mouth, b body, . empty. 16 columns x 16 rows.
	const BASE = [
		'....hhhhhhhh....',
		'...hhhhhhhhhh...',
		'..hhhhhhhhhhhh..',
		'..hhhhhhhhhhhh..',
		'..hhffffffffhh..',
		'..hffffffffffh..',
		'..hffeffffeffh..',
		'..hffeffffeffh..',
		'..hffffffffffh..',
		'..hfffmmmmfffh..',
		'...hffffffffh...',
		'....hhffffhh....',
		'....bbbbbbbb....',
		'..bbbbbbbbbbbb..',
		'..bbbbbbbbbbbb..',
		'..bbbbbbbbbbbb..',
	];
	const FRAMES = [
		BASE,
		BASE.map((r, i) => (i === 6 || i === 7 ? '..hffffffffffh..' : r)), // blink
		BASE.map((r, i) => (i === 9 ? '..hfffMMMMfffh..' : r)),            // talk
	];

	/** Merge horizontal runs of one colour into path commands for one frame. */
	function framePaths(rows, offsetX) {
		const byColour = {};
		rows.forEach((row, y) => {
			let x = 0;
			while (x < row.length) {
				const c = row[x];
				if (c === '.') { x += 1; continue; }
				let w = 1;
				while (x + w < row.length && row[x + w] === c) w += 1;
				(byColour[c] = byColour[c] || []).push(`M${offsetX + x} ${y}h${w}v1h-${w}z`);
				x += w;
			}
		});
		return byColour;
	}

	/** @returns {string} SVG markup of the 3-frame strip (48 x 16 units). */
	function spriteMarkup() {
		const merged = {};
		FRAMES.forEach((rows, i) => {
			const p = framePaths(rows, i * 16);
			for (const c of Object.keys(p)) merged[c] = (merged[c] || []).concat(p[c]);
		});
		const paths = Object.keys(merged).map((c) => `<path class="px-smarta__c-${c}" d="${merged[c].join('')}"/>`).join('');
		return `<svg class="px-smarta__strip" viewBox="0 0 48 16" preserveAspectRatio="xMinYMin meet" shape-rendering="crispEdges" focusable="false" aria-hidden="true" xmlns="${SVG_NS}">${paths}</svg>`;
	}

	// ─── Settings ────────────────────────────────────────────────────
	/** Validate stored settings; unknown values fall back to the defaults. */
	function normalizeSettings(raw) {
		const o = raw && typeof raw === 'object' ? raw : {};
		return {
			pos: POS.includes(o.pos) ? o.pos : DEFAULTS.pos,
			size: SIZES.includes(o.size) ? o.size : DEFAULTS.size,
			muted: o.muted === true,
			voice: VOICES.includes(o.voice) ? o.voice : DEFAULTS.voice,
			// an open chat is never restored on load; hidden stays hidden
			state: o.state === 'hidden' ? 'hidden' : 'collapsed',
		};
	}

	function loadSettings() {
		try { return normalizeSettings(JSON.parse(root.localStorage.getItem(STORAGE_KEY))); } catch (e) { return normalizeSettings(null); }
	}

	// ─── Dock ────────────────────────────────────────────────────────
	let dock = null;
	let settings = normalizeSettings(null);
	const history = [];
	let busy = false;
	// A fact being read aloud must not block the chat (speech can take 20 s+).
	let factBusy = false;
	let proNoteShown = false;
	let resizeObs = null;

	function save() {
		try { root.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (e) {}
	}

	function el(tag, attrs = {}, children = []) {
		const n = root.document.createElement(tag);
		for (const [k, v] of Object.entries(attrs)) {
			if (v === undefined || v === null || v === false) continue;
			if (k === 'text') n.textContent = v;
			else n.setAttribute(k, v === true ? '' : v);
		}
		for (const c of children) n.appendChild(c);
		return n;
	}

	/** i18n-aware label: remembers the key so refresh() can re-translate. */
	function i18n(node, key, kind = 'text') {
		if (kind === 'text') { node.setAttribute('data-i18n', key); node.textContent = t(key); }
		else { node.setAttribute(`data-i18n-${kind}`, key); node.setAttribute(kind, t(key)); }
		return node;
	}

	function icon(id) {
		const svg = root.document.createElementNS(SVG_NS, 'svg');
		svg.setAttribute('class', 'px-icon');
		svg.setAttribute('aria-hidden', 'true');
		svg.setAttribute('focusable', 'false');
		const use = root.document.createElementNS(SVG_NS, 'use');
		use.setAttribute('href', `/ui/icons/px-icons.svg#${id}`);
		svg.appendChild(use);
		return svg;
	}

	function iconButton(id, key, extra = {}) {
		const b = el('button', { type: 'button', class: 'px-iconbtn', ...extra }, [icon(id)]);
		i18n(b, key, 'aria-label');
		i18n(b, key, 'title');
		return b;
	}

	function q(sel) { return dock.querySelector(sel); }

	function build() {
		const portrait = el('button', { type: 'button', class: 'px-smarta__portrait', id: 'smarta-portrait', 'aria-controls': 'smarta-chat', 'aria-expanded': 'false' });
		const sprite = el('span', { class: 'px-smarta__sprite', 'aria-hidden': 'true' });
		sprite.innerHTML = spriteMarkup(); // static markup built above, no user data
		portrait.appendChild(sprite);
		i18n(portrait, 'smarta_dock_open', 'aria-label');

		const restore = iconButton('i-chat', 'smarta_dock_show', { class: 'px-iconbtn px-smarta__restore', id: 'smarta-restore' });

		// header
		const title = i18n(el('h2', { class: 'px-modal__title', id: 'smarta-title' }), 'smarta_chat_bot');
		const muteBtn = iconButton('i-sound', 'smarta_set_mute', { id: 'smarta-mute', 'aria-pressed': 'false' });
		const setBtn = iconButton('i-settings', 'smarta_settings_open', { id: 'smarta-settings-btn', 'aria-expanded': 'false', 'aria-controls': 'smarta-settings' });
		const hideBtn = iconButton('i-lock', 'smarta_dock_hide', { id: 'smarta-hide' });
		const closeBtn = iconButton('i-close', 'smarta_dock_close', { id: 'smarta-close', class: 'px-iconbtn px-modal__close' });
		const header = el('div', { class: 'px-modal__header' }, [title, el('div', { class: 'px-smarta__tools' }, [muteBtn, setBtn, hideBtn, closeBtn])]);

		// body: log + settings
		const log = el('div', { class: 'px-smarta__log', id: 'smarta-log', role: 'log', 'aria-live': 'polite' });
		const settingsPanel = buildSettings();
		const body = el('div', { class: 'px-modal__body px-smarta__body' }, [log, settingsPanel]);

		// footer: form
		const input = el('input', { type: 'text', class: 'px-smarta__input', id: 'smarta-input', maxlength: String(MAX_CHARS), autocomplete: 'off', enterkeyhint: 'send' });
		i18n(input, 'smarta_chat_placeholder', 'placeholder');
		i18n(input, 'smarta_chat_label', 'aria-label');
		const send = i18n(el('button', { type: 'submit', class: 'px-btn px-btn--primary px-smarta__send', id: 'smarta-send' }), 'smarta_chat_send');
		const fact = i18n(el('button', { type: 'button', class: 'px-btn px-smarta__fact', id: 'smarta-fact' }), 'smarta_chat_fact');
		const form = el('form', { class: 'px-smarta__form', id: 'smarta-form' }, [input, send]);
		const footer = el('div', { class: 'px-modal__footer px-smarta__footer' }, [form, fact]);

		const chat = el('section', { class: 'px-modal px-smarta__chat', id: 'smarta-chat', 'aria-labelledby': 'smarta-title', hidden: true, 'data-speechify-ignore': '' }, [header, body, footer]);

		const wrap = el('div', { class: 'px-smarta', id: 'smarta-dock', 'data-speechify-ignore': '' }, [chat, portrait, restore]);
		return wrap;
	}

	function field(labelKey, control) {
		const lab = i18n(el('label', { class: 'px-smarta__label' }), labelKey);
		lab.appendChild(root.document.createElement('br'));
		lab.appendChild(control);
		return el('div', { class: 'px-smarta__field' }, [lab]);
	}

	function select(id, options) {
		const s = el('select', { class: 'px-smarta__select', id });
		for (const [value, key] of options) {
			const o = el('option', { value });
			i18n(o, key);
			s.appendChild(o);
		}
		return s;
	}

	function buildSettings() {
		const wrap = el('div', { class: 'px-smarta__settings', id: 'smarta-settings', hidden: true });
		wrap.appendChild(i18n(el('h3', { class: 'px-smarta__settings-title' }), 'smarta_settings_title'));
		wrap.appendChild(field('smarta_set_position', select('smarta-pos', [['right', 'smarta_pos_right'], ['left', 'smarta_pos_left']])));
		wrap.appendChild(field('smarta_set_size', select('smarta-size', [['s', 'smarta_size_s'], ['m', 'smarta_size_m'], ['l', 'smarta_size_l']])));
		wrap.appendChild(field('smarta_set_voice', select('smarta-voice', [['auto', 'smarta_voice_auto'], ['browser', 'smarta_voice_browser']])));
		wrap.appendChild(field('smarta_set_style', select('smarta-style', [['', 'smarta_style_none'], ...STYLE_IDS.map((s) => [s, `smarta_style_${s}`])])));
		return wrap;
	}

	/** Position the dock inside the game area: CSS reads these offsets (see px-smarta.css). */
	function syncAnchor() {
		const vp = root.document.getElementById('game-viewport');
		if (!vp || !dock) return;
		const r = vp.getBoundingClientRect();
		const w = root.innerWidth || root.document.documentElement.clientWidth;
		const h = root.innerHeight || root.document.documentElement.clientHeight;
		dock.style.setProperty('--smarta-vp-r', `${Math.max(0, Math.round(w - r.right))}px`);
		dock.style.setProperty('--smarta-vp-l', `${Math.max(0, Math.round(r.left))}px`);
		dock.style.setProperty('--smarta-vp-b', `${Math.max(0, Math.round(h - r.bottom))}px`);
	}

	function applyState() {
		dock.dataset.pos = settings.pos;
		dock.dataset.size = settings.size;
		dock.dataset.state = settings.state;
		const open = settings.state === 'open';
		q('#smarta-chat').hidden = !open;
		q('#smarta-portrait').setAttribute('aria-expanded', String(open));
		q('#smarta-portrait').hidden = settings.state === 'hidden';
		q('#smarta-restore').hidden = settings.state !== 'hidden';
		const mute = q('#smarta-mute');
		mute.setAttribute('aria-pressed', String(settings.muted));
		mute.classList.toggle('is-muted', settings.muted);
		q('#smarta-pos').value = settings.pos;
		q('#smarta-size').value = settings.size;
		q('#smarta-voice').value = settings.voice;
		const styles = root.Narrator?.getStyles?.() || [];
		q('#smarta-style').value = styles[0] || '';
		root.document.body.classList.toggle('has-smarta-dock', settings.state !== 'hidden');
	}

	function setState(state, opts = {}) {
		settings.state = STATES.includes(state) ? state : 'collapsed';
		applyState();
		if (!opts.silent) save();
		if (settings.state === 'open') {
			ensureGreeting();
			if (opts.focus !== false) q('#smarta-input').focus();
		} else if (opts.focusPortrait) {
			(settings.state === 'hidden' ? q('#smarta-restore') : q('#smarta-portrait')).focus();
		}
	}

	function addMessage(who, text, extraClass = '') {
		const log = q('#smarta-log');
		const name = el('span', { class: 'px-smarta__who', text: who === 'user' ? t('smarta_chat_you') : t('smarta_chat_bot') });
		const body = el('p', { class: 'px-smarta__text', text });
		const row = el('div', { class: `px-smarta__msg px-smarta__msg--${who} ${extraClass}`.trim() }, [name, body]);
		log.appendChild(row);
		log.scrollTop = log.scrollHeight;
		return row;
	}

	function ensureGreeting() {
		const log = q('#smarta-log');
		if (!log.childElementCount) addMessage('bot', t('smarta_chat_greeting'));
	}

	function speakReply(text) {
		if (!root.Narrator?.speak) return;
		root.Narrator.speak(text, { styles: root.Narrator.getStyles?.() || [], voice: settings.voice, muted: settings.muted });
	}

	function currentLang() {
		return root.givemegame_currentLang || root.document.documentElement.lang || 'sk';
	}

	async function authHeaders() {
		if (typeof root.narratorAuthHeaders === 'function') return root.narratorAuthHeaders();
		return { 'Content-Type': 'application/json' };
	}

	async function send(rawText) {
		const text = String(rawText || '').trim();
		if (!text || busy) return;
		if (text.length > MAX_CHARS) { addMessage('bot', t('smarta_chat_too_long'), 'is-error'); return; }
		busy = true;
		q('#smarta-send').disabled = true;
		addMessage('user', text);
		const pending = addMessage('bot', t('smarta_chat_thinking'), 'is-pending');
		try {
			const res = await root.fetch('/api/smarta/chat', {
				method: 'POST',
				headers: await authHeaders(),
				body: JSON.stringify({ message: text, lang: currentLang(), history: history.slice(-HISTORY_SENT) }),
			});
			const data = await res.json().catch(() => ({}));
			let reply = '';
			let isError = false;
			if (res.status === 429) { reply = t('smarta_chat_rate'); isError = true; }
			else if (res.status === 400 && data.code === 'MESSAGE_TOO_LONG') { reply = t('smarta_chat_too_long'); isError = true; }
			else if (!res.ok || !data.reply) { reply = t('smarta_chat_error'); isError = true; }
			else {
				reply = data.reply;
				history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
				if (history.length > 12) history.splice(0, history.length - 12);
			}
			pending.classList.remove('is-pending');
			pending.querySelector('.px-smarta__text').textContent = reply;
			if (isError) pending.classList.add('is-error');
			else speakReply(reply);
			if (data.limit === 'daily') addMessage('bot', t('smarta_chat_daily'));
			if (data.planGate === 'smarta_pro_only' && !proNoteShown) {
				proNoteShown = true;
				addMessage('bot', t('smarta_chat_pro_note'));
			}
		} catch (e) {
			pending.classList.remove('is-pending');
			pending.classList.add('is-error');
			pending.querySelector('.px-smarta__text').textContent = t('smarta_chat_error');
		} finally {
			busy = false;
			q('#smarta-send').disabled = false;
			q('#smarta-log').scrollTop = q('#smarta-log').scrollHeight;
		}
	}

	async function tellFact() {
		if (factBusy || !root.Narrator?.tellFact) return;
		factBusy = true;
		const btn = q('#smarta-fact');
		btn.disabled = true;
		const pending = addMessage('bot', t('smarta_chat_thinking'), 'is-pending');
		let shown = false;
		try {
			const r = await root.Narrator.tellFact({
				voice: settings.voice,
				muted: settings.muted,
				onFact: (f) => {
					shown = true;
					pending.classList.remove('is-pending');
					pending.querySelector('.px-smarta__text').textContent = f.fact;
				},
			});
			if (r?.limited) pending.remove();
			else if (!shown) pending.remove();
		} catch (e) {
			pending.classList.remove('is-pending');
			pending.classList.add('is-error');
			pending.querySelector('.px-smarta__text').textContent = t('smarta_chat_error');
		} finally {
			factBusy = false;
			btn.disabled = false;
		}
	}

	function onSpeaking(e) {
		if (!dock) return;
		if (e.detail?.speaking) dock.setAttribute('data-speaking', ''); else dock.removeAttribute('data-speaking');
	}

	function bind() {
		q('#smarta-portrait').addEventListener('click', () => setState(settings.state === 'open' ? 'collapsed' : 'open'));
		q('#smarta-close').addEventListener('click', () => setState('collapsed', { focusPortrait: true }));
		q('#smarta-hide').addEventListener('click', () => { root.Narrator?.stop?.(); setState('hidden', { focusPortrait: true }); });
		q('#smarta-restore').addEventListener('click', () => setState('collapsed', { focusPortrait: true }));
		q('#smarta-mute').addEventListener('click', () => {
			settings.muted = !settings.muted;
			if (settings.muted) root.Narrator?.stop?.();
			save();
			applyState();
		});
		q('#smarta-settings-btn').addEventListener('click', () => {
			const panel = q('#smarta-settings');
			panel.hidden = !panel.hidden;
			q('#smarta-settings-btn').setAttribute('aria-expanded', String(!panel.hidden));
			q('#smarta-log').hidden = !panel.hidden;
		});
		q('#smarta-pos').addEventListener('change', (e) => { settings.pos = normalizeSettings({ pos: e.target.value }).pos; save(); applyState(); });
		q('#smarta-size').addEventListener('change', (e) => { settings.size = normalizeSettings({ size: e.target.value }).size; save(); applyState(); });
		q('#smarta-voice').addEventListener('change', (e) => { settings.voice = normalizeSettings({ voice: e.target.value }).voice; save(); });
		q('#smarta-style').addEventListener('change', (e) => {
			// Same checkboxes as the right-panel SMARTA tab (one source of truth for Narrator).
			const val = e.target.value;
			root.document.querySelectorAll('input[name="narrator-style"]').forEach((cb) => {
				const want = cb.value === val;
				if (cb.checked !== want) { cb.checked = want; cb.dispatchEvent(new root.Event('change', { bubbles: true })); }
			});
		});
		q('#smarta-form').addEventListener('submit', (e) => {
			e.preventDefault();
			const input = q('#smarta-input');
			// Keep the typed question while an answer is still on its way.
			if (busy || !input.value.trim()) return;
			const text = input.value;
			input.value = '';
			send(text);
		});
		q('#smarta-fact').addEventListener('click', tellFact);
		q('#smarta-chat').addEventListener('keydown', (e) => {
			if (e.key === 'Escape') { e.stopPropagation(); setState('collapsed', { focusPortrait: true }); }
		});
		root.addEventListener('givemegame:smarta-speaking', onSpeaking);
		root.addEventListener('givemegame:smarta-styles', () => applyState());
		root.document.addEventListener('visibilitychange', () => dock.classList.toggle('is-paused', root.document.hidden));
		root.addEventListener('resize', syncAnchor);
		if (root.ResizeObserver) {
			const vp = root.document.getElementById('game-viewport');
			if (vp) { resizeObs = new root.ResizeObserver(syncAnchor); resizeObs.observe(vp); }
		}
		// The tab in the right panel can bring a hidden dock back.
		root.document.addEventListener('click', (e) => {
			const opener = e.target.closest?.('[data-smarta-open]');
			if (opener) {
				e.preventDefault();
				// On narrow screens the tools drawer and its backdrop sit above the
				// dock; close them first so the chat is visible and focusable.
				try { root.GameUI?.closeTools?.(false); } catch (err) { /* drawer optional */ }
				setState('open');
			}
		});
	}

	/** Re-translate the dock after a language change. */
	function refresh() {
		if (!dock) return;
		dock.querySelectorAll('[data-i18n]').forEach((n) => { n.textContent = t(n.getAttribute('data-i18n')); });
		for (const attr of ['aria-label', 'title', 'placeholder']) {
			dock.querySelectorAll(`[data-i18n-${attr}]`).forEach((n) => n.setAttribute(attr, t(n.getAttribute(`data-i18n-${attr}`))));
		}
		dock.querySelectorAll('.px-smarta__msg--bot .px-smarta__who').forEach((n) => { n.textContent = t('smarta_chat_bot'); });
		dock.querySelectorAll('.px-smarta__msg--user .px-smarta__who').forEach((n) => { n.textContent = t('smarta_chat_you'); });
	}

	function init() {
		if (dock || !root.document) return;
		const host = root.document.getElementById('game-viewport');
		if (!host) return;
		settings = loadSettings();
		dock = build();
		host.appendChild(dock);
		bind();
		applyState();
		syncAnchor();
	}

	const api = { init, refresh, normalizeSettings, spriteMarkup, FRAMES, STORAGE_KEY, setState: (s) => dock && setState(s), _dock: () => dock };
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	else {
		root.SmartaDock = api;
		if (root.document) {
			if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', init);
			else init();
		}
	}
})(typeof window !== 'undefined' ? window : globalThis);
