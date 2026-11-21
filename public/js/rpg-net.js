/* ═══════════════════════════════════════════════════════════════════
   gIVEMEGAME.IO — RpgNet: shared request helper for the RPG profile

   One place that turns "what happened on the network" into one of a
   few states the RPG screens can show honestly:
     ok       the server answered 2xx         → show the data
     login    no session, or the server said 401 → "Prihlás sa"
     offline  5xx, timeout or no network      → "Server nedostupný, skúsiť znova"
     error    any other answer (400, 403, 404…) → generic error
   "Nie si členom školy" is NOT a network state: it comes only from
   the server flag is_school_member in an ok answer.

   Exposes: window.RpgNet (and module.exports for tests)
   ═══════════════════════════════════════════════════════════════════ */

(function (root) {
	'use strict';

	const TOKEN_TIMEOUT_MS = 8000;
	const FETCH_TIMEOUT_MS = 12000;

	/** @param {number} status @returns {'ok'|'login'|'offline'|'error'} */
	function classifyStatus(status) {
		if (status >= 200 && status < 300) return 'ok';
		if (status === 401) return 'login';
		if (status >= 500 || status === 0) return 'offline';
		return 'error';
	}

	/** Resolve with the promise, or reject after ms; the timer is always cleared. */
	function withTimeout(promise, ms) {
		let timer = null;
		const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); });
		return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
	}

	/**
	 * @returns {Promise<{ token: string|null, kind: 'ok'|'login'|'offline' }>}
	 *   login = no session; offline = the auth client did not answer in time
	 */
	async function getToken() {
		const client = root.supabaseClient;
		if (!client || !client.auth) return { token: null, kind: 'login' };
		try {
			const result = await withTimeout(client.auth.getSession(), TOKEN_TIMEOUT_MS);
			const token = result?.data?.session?.access_token || null;
			return { token, kind: token ? 'ok' : 'login' };
		} catch (_) {
			return { token: null, kind: 'offline' };
		}
	}

	/**
	 * Authenticated GET/POST with a timeout.
	 * @param {string} url
	 * @param {RequestInit} [opts]
	 * @returns {Promise<{ kind: 'ok'|'login'|'offline'|'error', status: number, data: any }>}
	 */
	async function request(url, opts = {}) {
		const auth = await getToken();
		if (!auth.token) return { kind: auth.kind, status: 0, data: null };
		const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
		const timer = ctrl ? setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS) : null;
		// A caller signal (e.g. the RPG screen closing) also cancels the request.
		if (ctrl && opts.signal) {
			if (opts.signal.aborted) ctrl.abort();
			else opts.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
		}
		try {
			const res = await root.fetch(url, {
				...opts,
				headers: { ...(opts.headers || {}), Authorization: `Bearer ${auth.token}` },
				signal: ctrl ? ctrl.signal : undefined,
			});
			const kind = classifyStatus(res.status);
			let data = null;
			try { data = await res.json(); } catch (_) { data = null; }
			if (kind === 'ok' && (data === null || typeof data !== 'object')) {
				return { kind: 'offline', status: res.status, data: null };
			}
			return { kind, status: res.status, data };
		} catch (_) {
			return { kind: 'offline', status: 0, data: null };
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	/** @param {string} key @param {string} fallback */
	function t(key, fallback) {
		const fn = root.givemegame_t;
		return typeof fn === 'function' ? fn(key, fallback) : fallback;
	}

	function esc(s) {
		return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
	}

	const ICON = (name) => `<svg class="px-icon px-state__icon" aria-hidden="true" focusable="false"><use href="/ui/icons/px-icons.svg#i-${name}"></use></svg>`;

	/**
	 * Render one honest state into el. Buttons get handlers from opts.
	 * @param {HTMLElement|null} el
	 * @param {'loading'|'offline'|'login'|'error'} kind
	 * @param {{ onRetry?: () => void, onLogin?: () => void, text?: string }} [opts]
	 * @returns {boolean} true when something was rendered
	 */
	function renderState(el, kind, opts = {}) {
		if (!el) return false;
		let html;
		if (kind === 'loading') {
			html = `<div class="px-state rpg-state rpg-state--loading" role="status" aria-live="polite">
				<p class="px-state__title">${esc(opts.text || t('rpg_state_loading', 'Načítavam RPG profil…'))}</p></div>`;
		} else if (kind === 'login') {
			html = `<div class="px-state rpg-state rpg-state--login" role="status">
				${ICON('lock')}
				<p class="px-state__title">${esc(t('rpg_state_login_title', 'Prihlás sa'))}</p>
				<p class="px-state__text">${esc(t('rpg_state_login_text', 'Po prihlásení uvidíš svoj RPG profil.'))}</p>
				<button type="button" class="px-btn px-btn--primary" data-rpg-action="login">${esc(t('rpg_login_btn', 'Prihlásiť sa'))}</button></div>`;
		} else {
			// offline and any other error: the user can always try again
			html = `<div class="px-state rpg-state rpg-state--offline" role="alert">
				${ICON('warning')}
				<p class="px-state__title">${esc(t('rpg_state_offline_title', 'Server nedostupný'))}</p>
				<p class="px-state__text">${esc(opts.text || t('rpg_state_offline_text', 'Nepodarilo sa načítať tvoj profil. Tvoje body sú v bezpečí.'))}</p>
				<button type="button" class="px-btn px-btn--primary" data-rpg-action="retry">${ICON('retry')} <span>${esc(t('rpg_retry', 'Skúsiť znova'))}</span></button></div>`;
		}
		el.innerHTML = html;
		const retry = el.querySelector && el.querySelector('[data-rpg-action="retry"]');
		if (retry && opts.onRetry) retry.addEventListener('click', opts.onRetry);
		const login = el.querySelector && el.querySelector('[data-rpg-action="login"]');
		if (login && opts.onLogin) login.addEventListener('click', opts.onLogin);
		return true;
	}

	const ROLE_FALLBACK = { player: 'Hráč', student: 'Žiak', teacher: 'Učiteľ', admin: 'Admin' };

	/** @param {string|null|undefined} role @returns {string} translated role; unknown roles read as "player" */
	function roleLabel(role) {
		const key = Object.prototype.hasOwnProperty.call(ROLE_FALLBACK, role) ? role : 'player';
		return t(`rpg_role_${key}`, ROLE_FALLBACK[key]);
	}

	const api = { classifyStatus, withTimeout, getToken, request, renderState, roleLabel, t, esc, TOKEN_TIMEOUT_MS, FETCH_TIMEOUT_MS };
	root.RpgNet = api;
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
