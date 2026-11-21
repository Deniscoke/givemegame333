/* ═══════════════════════════════════════════════════════════════════
   gIVEMEGAME.IO — GameAPI module (extracted from script.js Phase 3.2)

   Dependencies (globals resolved at call-time, not load-time):
     • GameData       — declared in game-data.js (shared global scope)
     • GameUI.toast() — declared in game-ui.js   (shared global scope)
     • ngrokHeaders() — declared in script.js     (shared global scope)
     • supabaseClient — declared in script.js     (shared global scope, for auth token)
     • fetch()        — browser built-in

   Exposes: window.GameAPI  (also visible as global `const GameAPI`)
   ═══════════════════════════════════════════════════════════════════ */

// ─────────────────────────────────────────────────
// GameAPI — Směrovač generování
// ─────────────────────────────────────────────────
const GameAPI = (() => {
	let engineMode = 'ai'; // default: vždy AI

	async function getAuthHeaders() {
		const headers = { ...(typeof ngrokHeaders === 'function' ? ngrokHeaders() : {}), 'Content-Type': 'application/json' };
		try {
			if (typeof supabaseClient !== 'undefined' && supabaseClient?.auth) {
				const { data: { session } } = await Promise.race([
					supabaseClient.auth.getSession(),
					new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 8000))
				]);
				if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`;
			}
		} catch (e) { /* ignore — no auth header on timeout */ }
		return headers;
	}

	async function fetchApi(url, opts = {}, ms = 15000) {
		const ctrl = new AbortController();
		const t = setTimeout(() => ctrl.abort(), ms);
		try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
		finally { clearTimeout(t); }
	}

	// ─── Klasifikácia AI chýb (čistá funkcia, testovaná v test/frontend-ux.test.js) ───
	// Vracia jednu z: 'daily_limit' | 'busy' | 'network' | 'generic'.
	// 'network' pokrýva aj timeout (AbortError) — pre používateľa je to rovnaká situácia.
	const DAILY_LIMIT_CODES = ['PLAN_AI_DAILY_LIMIT', 'GUEST_AI_DAILY_LIMIT'];
	function classifyAiError(err) {
		const code = String((err && err.code) || '');
		const status = Number(err && err.status) || 0;
		const name = String((err && err.name) || '');
		const msg = String((err && err.message) || '');
		if (DAILY_LIMIT_CODES.includes(code)) return 'daily_limit';
		if (code === 'AI_DAILY_CAPACITY' || status === 503) return 'busy';
		if (name === 'AbortError' || name === 'TimeoutError' || code === 'TIMEOUT' || status === 504) return 'network';
		if (!status && (name === 'TypeError' || /failed to fetch|networkerror|load failed|network request failed|timeout|aborted/i.test(msg))) return 'network';
		return 'generic';
	}

	const AI_ERROR_TEXT = {
		fallback: {
			daily_limit: ['ai_fallback_daily_limit', 'Dnešný limit AI hier je vyčerpaný, zobrazujem hru z knižnice.'],
			busy:        ['ai_fallback_busy',        'AI je teraz preťažená, zobrazujem hru z knižnice.'],
			network:     ['ai_fallback_network',     'AI neodpovedá (pomalé alebo žiadne pripojenie), zobrazujem hru z knižnice.'],
			generic:     ['ai_fallback_generic',     'AI hru sa nepodarilo vytvoriť, zobrazujem hru z knižnice.']
		},
		remix: {
			daily_limit: ['ai_remix_daily_limit', 'Dnešný limit AI hier je vyčerpaný. Remix skús zajtra.'],
			busy:        ['ai_remix_busy',        'AI je teraz preťažená. Remix skús o chvíľu.'],
			network:     ['ai_remix_network',     'AI neodpovedá (pomalé alebo žiadne pripojenie). Skús remix znova.'],
			generic:     ['ai_remix_generic',     'Remix sa nepodaril. Skús to znova.']
		}
	};

	// Priateľská, preložená správa pre používateľa. context: 'fallback' | 'remix'
	function describeAiError(err, context) {
		const table = AI_ERROR_TEXT[context] || AI_ERROR_TEXT.fallback;
		const [key, fallback] = table[classifyAiError(err)];
		const t = (typeof window !== 'undefined' && window.givemegame_t) || ((k, f) => f || k);
		return t(key, fallback);
	}

	function notify(message) {
		try {
			if (typeof GameUI !== 'undefined' && GameUI.toast) GameUI.toast('⚠️ ' + message);
		} catch (e) { /* toast nie je kritický */ }
	}

	function buildHttpError(res, body) {
		const e = new Error(body.error || `HTTP ${res.status}`);
		e.status = res.status;
		if (body.code) e.code = body.code;
		if (body.resetsAtUtc) e.resetsAtUtc = body.resetsAtUtc;
		return e;
	}

	async function generateGame(filters) {
		// Vždy skúsime AI prvý; ak zlyhá, fallback na hru z knižnice + vysvetlenie prečo
		try {
			return await generateWithAI(filters);
		} catch (err) {
			console.warn('[GameAPI] AI zlyhalo, fallback na lokálny engine:', err.code || err.status || '', err.message);
			notify(describeAiError(err, 'fallback'));
			return generateLocally(filters);
		}
	}

	async function generateWithAI(filters) {
		console.log('[GameAPI] Generujem cez AI...', filters);

		try {
			// 65s — matches Vercel maxDuration:60 + buffer for auth header
		const res = await fetchApi('/api/generate-game', {
				method: 'POST',
				headers: await getAuthHeaders(),
				body: JSON.stringify({ filters })
			}, 65000);

			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw buildHttpError(res, body);
			}

			const game = await res.json();
			console.log(`[GameAPI] AI hra: "${game.title}"`, game);
			return game;

		} catch (err) {
			console.error('[GameAPI] AI generovanie zlyhalo:', err.message);
			throw err;
		}
	}

	function generateLocally(filters) {
		return GameData.generate(filters);
	}

	// Remix: same endpoint, same schema — adds remix context block server-side
	async function remixGame(sourceGame, filters) {
		console.log('[GameAPI] Remixujem hru:', sourceGame?.title, filters);
		try {
			const res = await fetchApi('/api/generate-game', {
				method: 'POST',
				headers: await getAuthHeaders(),
				body: JSON.stringify({ filters, remix: sourceGame })
			}, 65000);
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw buildHttpError(res, body);
			}
			const game = await res.json();
			console.log(`[GameAPI] REMIX: "${game.title}"`, game);
			return game;
		} catch (err) {
			console.error('[GameAPI] Remix zlyhalo:', err.message);
			throw err;
		}
	}

	function setMode(mode) {
		engineMode = mode;
		console.log(`[GameAPI] Režim enginu: ${mode}`);

		// Aktualizácia UI indikátora
		const indicator = document.getElementById('engine-indicator');
		if (indicator) {
			indicator.className = 'engine-indicator ' + (mode === 'ai' ? 'engine-ai' : 'engine-local');
		}
	}

	function getMode() {
		return engineMode;
	}

	// Kontrola dostupnosti servera
	async function checkServer() {
		try {
			const res = await fetch('/api/status', { headers: ngrokHeaders() });
			if (res.ok) {
				const data = await res.json();
				return data;
			}
		} catch (e) {
			// Server nebeží
		}
		return null;
	}

	return {
		generateGame, generateWithAI, generateLocally, remixGame,
		setMode, getMode, checkServer, classifyAiError, describeAiError
	};
})();

// Expose globally so scripts loaded after this one can reference window.GameAPI
window.GameAPI = GameAPI;
