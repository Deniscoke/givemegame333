/* ═══════════════════════════════════════════════════════════════════
   gIVEMEGAME.IO — ModeDecor: per-mode pixel decoration (Phase 3)

   Adds one aria-hidden container with three sprite elements to the
   game area. Which sprites show is pure CSS (body[data-mode] in
   ui/px-mode-decor.css); the animation is CSS steps(2) at <= 2 fps.
   This script only:
     • creates the container once,
     • keeps body[data-mode] in sync (ModeDecor.set, called by setMode),
     • pauses the animation while the tab is hidden.
   No canvas, no requestAnimationFrame, no timers.
   Exposes: window.ModeDecor
   ═══════════════════════════════════════════════════════════════════ */

(function (root) {
	'use strict';

	const MODES = ['party', 'classroom', 'reflection', 'circus', 'cooking', 'meditation'];
	let container = null;

	/** @param {Document} doc @returns {HTMLElement|null} */
	function mount(doc) {
		if (container && container.isConnected !== false) return container;
		const host = doc.getElementById('game-viewport');
		if (!host) return null;
		container = doc.createElement('div');
		container.className = 'px-decor';
		container.setAttribute('aria-hidden', 'true');
		['a', 'b', 'c'].forEach((slot) => {
			const sprite = doc.createElement('span');
			sprite.className = `px-decor__sprite px-decor__sprite--${slot}`;
			container.appendChild(sprite);
		});
		host.insertBefore(container, host.firstChild);
		syncPaused(doc);
		return container;
	}

	/** @param {Document} doc */
	function syncPaused(doc) {
		if (container) container.classList.toggle('px-decor--paused', Boolean(doc.hidden));
	}

	/**
	 * @param {string} mode one of MODES; anything else is ignored
	 * @returns {boolean} true when the mode was applied
	 */
	function set(mode) {
		if (!MODES.includes(mode)) return false;
		const doc = root.document;
		if (!doc || !doc.body) return false;
		doc.body.dataset.mode = mode;
		mount(doc);
		return true;
	}

	function init() {
		const doc = root.document;
		if (!doc) return;
		mount(doc);
		doc.addEventListener('visibilitychange', () => syncPaused(doc));
	}

	const api = { set, init, MODES };
	root.ModeDecor = api;
	if (typeof module !== 'undefined' && module.exports) module.exports = api;

	if (root.document) {
		if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', init);
		else init();
	}
})(typeof window !== 'undefined' ? window : globalThis);
