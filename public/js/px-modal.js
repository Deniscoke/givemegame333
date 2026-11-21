/* ═══════════════════════════════════════════════════════════════════
   gIVEMEGAME.IO — PxModal: one shared modal behaviour (fixes M19)

   PxModal.open(elOrId, { initialFocus, onClose, closeOnBackdrop })
   PxModal.close(elOrId)
   PxModal.isOpen(elOrId)

   On open:  role="dialog", aria-modal="true", aria-labelledby (first
             .px-modal__title / .modal-title / h2 / h3 inside, an id is
             added when missing), focus moves into the dialog.
   While open: Tab / Shift+Tab stay inside the dialog (focus trap),
             Escape closes the top-most dialog, backdrop click closes.
   On close: focus goes back to the element that opened it.

   The overlay is shown with style.display (legacy modals) and the
   .is-open class (px-modal-overlay). No dependencies.
   Exposes: window.PxModal (browser) / module.exports (tests)
   ═══════════════════════════════════════════════════════════════════ */

(function (root) {
	'use strict';

	const FOCUSABLE = [
		'a[href]', 'area[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
		'select:not([disabled])', 'textarea:not([disabled])', 'iframe', 'summary',
		'[contenteditable="true"]', '[tabindex]:not([tabindex="-1"])',
	].join(',');

	/** @type {{ el: HTMLElement, returnFocus: HTMLElement|null, onClose?: Function, display: string }[]} */
	const stack = [];
	let listening = false;

	/**
	 * Elements inside `container` that can take keyboard focus, in DOM order.
	 * Hidden elements (hidden attribute, display:none ancestors via
	 * offsetParent, aria-hidden) are skipped.
	 * @param {HTMLElement} container
	 * @returns {HTMLElement[]}
	 */
	function getFocusable(container) {
		if (!container || !container.querySelectorAll) return [];
		return Array.from(container.querySelectorAll(FOCUSABLE)).filter((el) => {
			if (el.hidden || el.getAttribute?.('aria-hidden') === 'true') return false;
			if (el.closest && el.closest('[hidden]')) return false;
			// offsetParent is null for display:none (and for position:fixed, which we allow).
			if (el.offsetParent === null && el.getClientRects && el.getClientRects().length === 0) return false;
			return true;
		});
	}

	/**
	 * Where focus should go for a Tab press, or null when the browser can
	 * handle it (focus stays inside without help).
	 * @param {HTMLElement[]} focusable
	 * @param {Element|null} active document.activeElement
	 * @param {boolean} shift Shift+Tab
	 * @param {HTMLElement} container
	 * @returns {HTMLElement|null}
	 */
	function nextTrapTarget(focusable, active, shift, container) {
		if (!focusable.length) return container;
		const first = focusable[0];
		const last = focusable[focusable.length - 1];
		const inside = active && container.contains && container.contains(active);
		if (!inside || active === container) return shift ? last : first;
		if (shift && active === first) return last;
		if (!shift && active === last) return first;
		return null;
	}

	function resolve(elOrId) {
		if (!elOrId) return null;
		if (typeof elOrId === 'string') return root.document ? root.document.getElementById(elOrId) : null;
		return elOrId;
	}

	/** The dialog box inside an overlay (for focus and labelling). */
	function dialogOf(overlay) {
		return overlay.querySelector?.('.px-modal, .modal-box, [data-px-dialog]') || overlay;
	}

	function labelDialog(overlay) {
		const dialog = dialogOf(overlay);
		dialog.setAttribute('role', dialog.getAttribute('role') || 'dialog');
		dialog.setAttribute('aria-modal', 'true');
		if (!dialog.getAttribute('aria-labelledby') && !dialog.getAttribute('aria-label')) {
			const title = dialog.querySelector?.('.px-modal__title, .modal-title, h2, h3');
			if (title) {
				if (!title.id) title.id = `${overlay.id || 'px-modal'}-title`;
				dialog.setAttribute('aria-labelledby', title.id);
			}
		}
		if (dialog !== overlay && overlay.getAttribute('role') === 'dialog') {
			// Legacy markup put role=dialog on the overlay; keep one dialog only.
			overlay.removeAttribute('role');
			overlay.removeAttribute('aria-modal');
		}
		if (!dialog.hasAttribute('tabindex')) dialog.setAttribute('tabindex', '-1');
		return dialog;
	}

	function onKeydown(event) {
		const top = stack[stack.length - 1];
		if (!top) return;
		if (event.key === 'Escape' || event.key === 'Esc') {
			event.preventDefault?.();
			event.stopPropagation?.();
			close(top.el);
			return;
		}
		if (event.key !== 'Tab') return;
		const dialog = dialogOf(top.el);
		const target = nextTrapTarget(getFocusable(dialog), root.document.activeElement, Boolean(event.shiftKey), dialog);
		if (target) {
			event.preventDefault?.();
			target.focus?.();
		}
	}

	function onBackdrop(event) {
		const top = stack[stack.length - 1];
		if (top && top.closeOnBackdrop && event.target === top.el) close(top.el);
	}

	function ensureListening() {
		if (listening || !root.document) return;
		listening = true;
		root.document.addEventListener('keydown', onKeydown, true);
		root.document.addEventListener('click', onBackdrop, true);
	}

	/**
	 * @param {HTMLElement|string} elOrId overlay element or its id
	 * @param {{ initialFocus?: HTMLElement|string, onClose?: Function, closeOnBackdrop?: boolean, display?: string, returnFocus?: HTMLElement }} [opts]
	 * @returns {boolean} true when the modal was opened
	 */
	function open(elOrId, opts = {}) {
		const el = resolve(elOrId);
		if (!el) return false;
		ensureListening();
		const existing = stack.findIndex((s) => s.el === el);
		if (existing !== -1) stack.splice(existing, 1);
		const doc = root.document;
		const returnFocus = opts.returnFocus || (doc && doc.activeElement && doc.activeElement !== doc.body ? doc.activeElement : null);
		stack.push({
			el,
			returnFocus,
			onClose: opts.onClose,
			closeOnBackdrop: opts.closeOnBackdrop !== false,
		});
		el.style.display = opts.display || 'flex';
		el.classList?.add('is-open');
		el.removeAttribute?.('aria-hidden');
		const dialog = labelDialog(el);
		const initial = resolve(opts.initialFocus);
		const target = initial || getFocusable(dialog).find((f) => !f.classList?.contains('px-modal__close') && !f.classList?.contains('modal-close')) || getFocusable(dialog)[0] || dialog;
		target.focus?.();
		return true;
	}

	/**
	 * @param {HTMLElement|string} elOrId
	 * @returns {boolean} true when a modal was closed
	 */
	function close(elOrId) {
		const el = resolve(elOrId);
		if (!el) return false;
		el.style.display = 'none';
		el.classList?.remove('is-open');
		const i = stack.findIndex((s) => s.el === el);
		if (i === -1) return false;
		const [entry] = stack.splice(i, 1);
		try { entry.onClose?.(); } catch (_) { /* caller bug must not block focus restore */ }
		if (entry.returnFocus && entry.returnFocus.isConnected !== false) entry.returnFocus.focus?.();
		return true;
	}

	/** @param {HTMLElement|string} elOrId */
	function isOpen(elOrId) {
		const el = resolve(elOrId);
		return Boolean(el) && stack.some((s) => s.el === el);
	}

	const api = { open, close, isOpen, getFocusable, nextTrapTarget, _stack: stack };
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	if (root && typeof root === 'object') root.PxModal = api;
})(typeof window !== 'undefined' ? window : globalThis);
