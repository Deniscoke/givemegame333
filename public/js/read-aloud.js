/* ═══════════════════════════════════════════════════════════════════
   gIVEMEGAME.IO — Read aloud (Phase 7)

   Ctrl/⌘ + klik na text ho prečíta nahlas cez prehliadačový
   speechSynthesis (zadarmo, bez servera). Jazyk podľa jazyka aplikácie.
   Prepínač sa ukladá do localStorage (givemegame_read_aloud).
   ═══════════════════════════════════════════════════════════════════ */
(function (root) {
	'use strict';

	const STORAGE_KEY = 'givemegame_read_aloud';
	const READABLE_SELECTOR = '[data-i18n], p, li, h1, h2, h3, h4, .game-pitch, .toast, .help-item, .help-title';
	const SKIP_SELECTOR = 'input, textarea, select, [contenteditable="true"]';
	const MAX_CHARS = 1500;
	const BCP47 = { sk: 'sk-SK', cs: 'cs-CZ', en: 'en-US', de: 'de-DE', es: 'es-ES', tr: 'tr-TR' };

	function langToBcp47(lang) {
		return BCP47[String(lang || '').toLowerCase()] || 'en-US';
	}

	function readStored() {
		try { return root.localStorage.getItem(STORAGE_KEY); } catch (_) { return null; }
	}
	let enabled = readStored() !== '0'; // zapnuté predvolene

	function isEnabled() { return enabled; }

	/** Najbližší čitateľný prvok pod kurzorom; formulárové polia sa nečítajú. */
	function pickReadable(target) {
		if (!target || typeof target.closest !== 'function') return null;
		if (target.closest(SKIP_SELECTOR)) return null;
		return target.closest(READABLE_SELECTOR);
	}

	function cleanText(raw) {
		const text = String(raw || '').replace(/\s+/g, ' ').trim();
		return text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;
	}

	function textOf(el) {
		return cleanText(el && (el.innerText !== undefined ? el.innerText : el.textContent));
	}

	function currentLang() {
		return root.givemegame_currentLang || (root.document && root.document.documentElement && root.document.documentElement.lang) || 'sk';
	}

	function pickVoice(synth, bcp) {
		const voices = (synth.getVoices && synth.getVoices()) || [];
		const code = bcp.split('-')[0].toLowerCase();
		return voices.find((v) => v.lang && v.lang.toLowerCase() === bcp.toLowerCase())
			|| voices.find((v) => v.lang && v.lang.toLowerCase().startsWith(code))
			|| null;
	}

	function stop() {
		const synth = root.speechSynthesis;
		if (synth && synth.cancel) synth.cancel();
	}

	/** @returns {boolean} true when speech was started */
	function speak(text, lang) {
		const synth = root.speechSynthesis;
		const Utter = root.SpeechSynthesisUtterance;
		const clean = cleanText(text);
		if (!synth || !Utter || !clean) return false;
		synth.cancel();
		const bcp = langToBcp47(lang || currentLang());
		const u = new Utter(clean);
		u.lang = bcp;
		const voice = pickVoice(synth, bcp);
		if (voice) u.voice = voice;
		u.rate = 0.95;
		synth.speak(u);
		return true;
	}

	function readElement(el) {
		return speak(textOf(el));
	}

	/** Prečíta aktuálnu hru: názov, popis, postup. */
	function readGame() {
		const doc = root.document;
		const part = (id) => { const n = doc.getElementById(id); return n ? textOf(n) : ''; };
		const text = [part('game-title'), part('game-pitch'), part('game-instructions')].filter(Boolean).join('. ');
		return speak(text);
	}

	function onClick(event) {
		if (!enabled || !(event.ctrlKey || event.metaKey)) return;
		const el = pickReadable(event.target);
		if (!el || !textOf(el)) return;
		// Ctrl+klik na odkaz by inak otvoril novú kartu / spustil onclick.
		event.preventDefault();
		event.stopPropagation();
		readElement(el);
	}

	function syncButtons() {
		const doc = root.document;
		if (!doc || !doc.querySelectorAll) return;
		doc.querySelectorAll('[data-read-aloud-toggle]').forEach((b) => {
			b.setAttribute('aria-pressed', enabled ? 'true' : 'false');
			b.classList.toggle('is-on', enabled);
		});
		doc.querySelectorAll('[data-read-aloud-game]').forEach((b) => { b.hidden = !enabled || !root.speechSynthesis; });
	}

	function setEnabled(on) {
		enabled = Boolean(on);
		try { root.localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0'); } catch (_) { /* private mode */ }
		if (!enabled) stop();
		syncButtons();
		return enabled;
	}

	function toggle() { return setEnabled(!enabled); }

	function init() {
		const doc = root.document;
		if (!doc) return;
		doc.addEventListener('click', onClick, true);
		syncButtons();
	}

	const api = { langToBcp47, pickReadable, textOf, speak, stop, readElement, readGame, isEnabled, setEnabled, toggle, init, onClick, STORAGE_KEY };
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	if (root && typeof root === 'object') root.ReadAloud = api;
	if (root.document) {
		if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', init);
		else init();
	}
})(typeof window !== 'undefined' ? window : globalThis);
