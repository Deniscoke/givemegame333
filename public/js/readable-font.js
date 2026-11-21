/* ═══════════════════════════════════════════════════════════════════
   gIVEMEGAME.IO — Readable font toggle (Phase 7)

   Zapne/vypne triedu html.readable-font (px-tokens.css): pixelové
   písmo sa nahradí čitateľným Atkinson a text je aspoň 16 px.
   Stav sa ukladá do localStorage (givemegame_readable_font); pred
   prvým vykreslením ho nastaví malý inline skript v <head>.
   ═══════════════════════════════════════════════════════════════════ */
(function (root) {
	'use strict';

	const STORAGE_KEY = 'givemegame_readable_font';
	const CLASS_NAME = 'readable-font';

	function isOn() {
		try { return root.localStorage.getItem(STORAGE_KEY) === '1'; } catch (_) { return false; }
	}

	function sync(on) {
		const doc = root.document;
		if (!doc) return;
		if (doc.documentElement && doc.documentElement.classList) doc.documentElement.classList.toggle(CLASS_NAME, on);
		if (doc.querySelectorAll) {
			doc.querySelectorAll('[data-readable-font-toggle]').forEach((b) => {
				b.setAttribute('aria-pressed', on ? 'true' : 'false');
				b.classList.toggle('is-on', on);
			});
		}
	}

	function set(on) {
		try { root.localStorage.setItem(STORAGE_KEY, on ? '1' : '0'); } catch (_) { /* private mode */ }
		sync(on);
		return on;
	}

	function toggle() { return set(!isOn()); }

	function init() { sync(isOn()); }

	const api = { isOn, set, toggle, init, STORAGE_KEY, CLASS_NAME };
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	if (root && typeof root === 'object') root.ReadableFont = api;
	if (root.document) {
		if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', init);
		else init();
	}
})(typeof window !== 'undefined' ? window : globalThis);
