/* ═══════════════════════════════════════════════════════════════════
   gIVEMEGAME.IO — gIVEMEGOCHI bridge (Phase 9)

   Parent side of the postMessage link with the embedded tamagochi
   (#tamagochi-iframe, tamagochi/index.html?embed=1).

   Child -> parent
     { type: 'tamagochi_coin', action: 'levelup' | 'minigame' }
         a milestone, never a tap. Awards Coins.award('tamagochi_coin'),
         which goes through POST /api/coins/log where the server applies its
         daily cap (lib/coin-log-policy.js DAILY_REWARD_CAP.tamagochi_coin).
         Accepted only when event.origin === location.origin AND
         event.source is the iframe's own window; at most one per 2 s.
     { type: 'pet_requestSync' }  -> the parent answers with pet_syncUser.
   Parent -> child
     { type: 'pet_syncUser', user: { uid, name } | null, rpgLevel, avatarId }
         sent with the exact origin as targetOrigin, never '*'.

   Exposes: window.TamagochiBridge (browser) / module.exports (tests)
   ═══════════════════════════════════════════════════════════════════ */
(function (root) {
	'use strict';

	const MILESTONES = Object.freeze(['levelup', 'minigame']);
	const MIN_GAP_MS = 2000;

	/** True only for a message from the same origin AND from the given iframe window. */
	function isTrustedMessage(event, iframeWindow, origin) {
		return !!event && !!iframeWindow && typeof origin === 'string' && origin !== '' && origin !== 'null'
			&& event.origin === origin && event.source === iframeWindow;
	}

	/** @returns {'levelup'|'minigame'|null} */
	function parseMilestone(data) {
		if (!data || typeof data !== 'object' || data.type !== 'tamagochi_coin') return null;
		return MILESTONES.includes(data.action) ? data.action : null;
	}

	function cleanName(name) {
		return typeof name === 'string' ? name.replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 24) : '';
	}

	function buildSync({ user, rpgLevel, avatarId }) {
		const uid = user && typeof user.uid === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(user.uid) ? user.uid : null;
		const level = Math.min(10, Math.max(1, Math.floor(Number(rpgLevel)) || 1));
		return {
			type: 'pet_syncUser',
			user: uid ? { uid, name: cleanName(user.name || user.displayName || user.email || '') } : null,
			rpgLevel: level,
			avatarId: typeof avatarId === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(avatarId) ? avatarId : null
		};
	}

	/**
	 * @param {{ getIframe: () => any, origin: string, award: (source: string) => void, now?: () => number,
	 *           sync?: () => void }} deps
	 * @returns {(event: any) => boolean} true when a coin milestone was accepted
	 */
	/** Link of the full-screen tab: only the uid, so both copies use the same save slot. */
	function fullScreenHref(uid) {
		return 'tamagochi/index.html' + (typeof uid === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(uid) ? '?uid=' + encodeURIComponent(uid) : '');
	}

	function createMessageHandler(deps) {
		const now = deps.now || Date.now;
		let lastAt = -Infinity;
		return function onMessage(event) {
			const iframe = deps.getIframe();
			const win = iframe && iframe.contentWindow;
			if (!isTrustedMessage(event, win, deps.origin)) return false;
			if (event.data && event.data.type === 'pet_requestSync') {
				if (deps.sync) deps.sync();
				return false;
			}
			if (!parseMilestone(event.data)) return false;
			const t = now();
			if (t - lastAt < MIN_GAP_MS) return false;
			lastAt = t;
			deps.award('tamagochi_coin');
			return true;
		};
	}

	const api = { isTrustedMessage, parseMilestone, buildSync, fullScreenHref, createMessageHandler, MIN_GAP_MS, MILESTONES };

	if (typeof root.document === 'undefined') { module.exports = api; return; }

	function iframeEl() { return root.document.getElementById('tamagochi-iframe'); }

	async function sync() {
		const iframe = iframeEl();
		if (!iframe || !iframe.contentWindow) return;
		let user = null;
		try { user = typeof root.getCurrentUser === 'function' ? root.getCurrentUser() : null; } catch (e) {}
		let rpgLevel = 1;
		let avatarId = null;
		try {
			const talents = user && root.RpgTalents && root.RpgTalents.load ? await root.RpgTalents.load() : null;
			rpgLevel = talents && talents.progression ? talents.progression.level : 1;
			const av = user && root.RpgAvatar && root.RpgAvatar.load ? await root.RpgAvatar.load() : null;
			avatarId = av && av.current_avatar_id ? String(av.current_avatar_id) : null;
		} catch (e) {}
		const msg = buildSync({ user, rpgLevel, avatarId });
		// The full-screen tab has no parent to sync from: give it the uid (nothing else).
		const full = root.document.querySelector('.tamagochi-fullscreen');
		if (full) full.setAttribute('href', fullScreenHref(msg.user && msg.user.uid));
		try { iframe.contentWindow.postMessage(msg, root.location.origin); } catch (e) {}
	}

	const handler = createMessageHandler({
		getIframe: iframeEl,
		origin: root.location.origin,
		award: (source) => { if (root.Coins && root.Coins.award) root.Coins.award(source); },
		sync
	});
	root.addEventListener('message', handler);
	api.sync = sync;
	root.TamagochiBridge = api;
	const frame = iframeEl();
	if (frame) frame.addEventListener('load', () => { sync(); setTimeout(sync, 1500); });
})(typeof window !== 'undefined' ? window : globalThis);
