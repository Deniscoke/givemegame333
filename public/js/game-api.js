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
				const { data: { session } } = await supabaseClient.auth.getSession();
				if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`;
			}
		} catch (e) { /* ignore */ }
		return headers;
	}

	async function generateGame(filters) {
		// Vždy skúsime AI prvý; ak server neodpovie, fallback na local
		try {
			return await generateWithAI(filters);
		} catch (err) {
			console.warn('[GameAPI] AI zlyhalo, fallback na lokálny engine:', err.message);
			// Upozornenie: používame lokálne hry, API nebolo použité
			const msg = err.message || '';
			if (msg.includes('NO_API_KEY') || msg.includes('OPENAI_API_KEY')) {
				GameUI.toast('⚠️ AI nie je nakonfigurované — použité lokálne hry. Nastav OPENAI_API_KEY v .env');
			} else if (msg.includes('fetch') || msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
				GameUI.toast('⚠️ Server nedostupný — otvor http://localhost:3000 namiesto súboru');
			}
			return generateLocally(filters);
		}
	}

	async function generateWithAI(filters) {
		console.log('[GameAPI] Generujem cez AI...', filters);

		try {
			const res = await fetch('/api/generate-game', {
				method: 'POST',
				headers: await getAuthHeaders(),
				body: JSON.stringify({ filters })
			});

			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				throw new Error(err.error || `Server vrátil ${res.status}`);
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
			const res = await fetch('/api/generate-game', {
				method: 'POST',
				headers: await getAuthHeaders(),
				body: JSON.stringify({ filters, remix: sourceGame })
			});
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				throw new Error(err.error || `Server vrátil ${res.status}`);
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
		setMode, getMode, checkServer
	};
})();

// Expose globally so scripts loaded after this one can reference window.GameAPI
window.GameAPI = GameAPI;
