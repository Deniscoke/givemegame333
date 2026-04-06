/* ═══════════════════════════════════════════════════════════════════
   gIVEMEGAME.IO — Generátor vzdělávacích her

   Architektura:
   ├── GameAPI      → Přepíná mezi lokálním a budoucím AI generováním
   ├── GameData     → Lokální vzorová data + procedurální generátor
   ├── GameUI       → Veškeré vykreslování DOM a interakce
   └── App          → Veřejný kontrolér, propojuje vše dohromady

   BUDOUCÍ INTEGRACE AI:
   Nahraďte tělo GameAPI.generateWithAI() skutečným fetch()
   voláním na váš /api/generate-game endpoint.
   ═══════════════════════════════════════════════════════════════════ */

// Ngrok/Cloudflare tunel: obísť ngrok interstitial pri fetch (remote používatelia)
const isRemoteTunnel = () => {
	const h = (window.location.host || '').toLowerCase();
	return h.includes('ngrok') || h.includes('trycloudflare.com') || h.includes('loca.lt');
};
const ngrokHeaders = () => (isRemoteTunnel() ? { 'ngrok-skip-browser-warning': '1' } : {});

// ─── Shared Supabase auth state ───────────────────────────────────
// var (= window property) so coins.js can reference these as globals.
// Function bodies in coins.js only execute after DOMContentLoaded,
// by which time this block has run and values are set.
// ─────────────────────────────────────────────────────────────────
var supabaseClient = null;
var supabaseProfilesOk = true;
// Shared game state — var (window property) so library.js + game-edit.js can access it
var currentGame = null;

(function initSupabase() {
	const SUPABASE_URL      = 'https://vhpkkbixshfyytohkruv.supabase.co';
	const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZocGtrYml4c2hmeXl0b2hrcnV2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMxMDAzNzcsImV4cCI6MjA4ODY3NjM3N30.umrrhSqC9LW2Wlcs5y4uCViVfZmqyHcMbaPQaQiMbR0';
	try {
		if (window.supabase) {
			supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
				auth: { detectSessionInUrl: true, persistSession: true }
			});
		}
	} catch (e) { console.warn('[Auth] Supabase init failed:', e); }
})();

function getCurrentUser() {
	try {
		let raw = sessionStorage.getItem('givemegame_user');
		if (!raw) raw = localStorage.getItem('givemegame_user');
		const u = raw ? JSON.parse(raw) : null;
		return u?.uid && u.uid !== 'guest' ? u : null;
	} catch { return null; }
}


// ─── GameData — extracted to public/js/game-data.js ───────────────
// const GameData is declared globally in game-data.js and visible here.

// ─── GameAPI — extracted to public/js/game-api.js ─────────────────
// const GameAPI is declared globally in game-api.js and visible here.

// ─── GameUI — extracted to public/js/game-ui.js ───────────────────
// const GameUI is declared globally in game-ui.js and visible here.

// ─────────────────────────────────────────────────
// App — Veřejný kontrolér
// ─────────────────────────────────────────────────
const App = (() => {
	// currentGame → top-level var (window.currentGame), shared with library.js + game-edit.js
	// Narrator bridge — MUST be inside App IIFE (not global scope) to avoid const re-declaration
	// conflict with narrator.js which also declares `const Narrator` at its top level.
	const Narrator = window.Narrator;
	const Reflection = window.Reflection;
	let stats = { generated: 0, exported: 0 };
	let isGenerating = false;

	// ─── User Preferences (narrator styles + lang, synced to server) ───
	// Defined inside App so it can access supabaseClient, currentLang, and setLang via closure.
	const UserPreferences = (() => {
		let _debounceTimer = null;

		async function _getToken() {
			try {
				const { data: { session } } = await Promise.race([
					supabaseClient.auth.getSession(),
					new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 8000))
				]);
				return session?.access_token || null;
			} catch { return null; }
		}

		// Load from server and apply to UI. Returns false if guest/unauthenticated.
		async function load() {
			const token = await _getToken();
			if (!token) return false;
			try {
				const res = await fetch('/api/user/preferences', {
					headers: { ...ngrokHeaders(), Authorization: `Bearer ${token}` }
				});
				if (!res.ok) {
					console.warn('[Prefs] load failed:', res.status);
					return false;
				}
				const { narrator_styles, narrator_lang } = await res.json();
				// Apply styles to checkboxes + keep localStorage in sync
				if (Array.isArray(narrator_styles)) {
					document.querySelectorAll('input[name="narrator-style"]').forEach(cb => {
						cb.checked = narrator_styles.includes(cb.value);
					});
					try {
						const key = (typeof getSmartaStylesKey === 'function') ? getSmartaStylesKey() : null;
						if (key) localStorage.setItem(key, JSON.stringify(narrator_styles));
					} catch {}
				}
				// Only call setLang if the language actually differs — avoids a spurious toast on every page load
				if (narrator_lang && narrator_lang !== currentLang) {
					await setLang(narrator_lang);
				}
				return true;
			} catch (e) {
				console.warn('[Prefs] load error (continuing with defaults):', e.message);
				return false;
			}
		}

		async function _patch(payload) {
			const token = await _getToken();
			if (!token) return;
			try {
				const res = await fetch('/api/user/preferences', {
					method: 'PATCH',
					headers: { ...ngrokHeaders(), 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
					body: JSON.stringify(payload)
				});
				if (!res.ok) console.warn('[Prefs] patch failed:', res.status);
			} catch (e) {
				console.warn('[Prefs] patch error:', e.message);
			}
		}

		function scheduleSync(payload) {
			clearTimeout(_debounceTimer);
			_debounceTimer = setTimeout(() => _patch(payload), 500);
		}

		// Call once after Narrator.init() to wire up debounced PATCH on changes
		function bindAutoSync() {
			document.querySelectorAll('input[name="narrator-style"]').forEach(cb => {
				cb.addEventListener('change', () => {
					const styles = Array.from(document.querySelectorAll('input[name="narrator-style"]:checked')).map(c => c.value);
					scheduleSync({ narrator_styles: styles });
				});
			});
			document.querySelectorAll('.btn-lang').forEach(btn => {
				btn.addEventListener('click', () => {
					scheduleSync({ narrator_lang: btn.dataset.lang });
				});
			});
		}

		return { load, bindAutoSync };
	})();

	// ─── Inicializace ───
	async function init() {
		try {
			const raw = sessionStorage.getItem('givemegame_user');
			const u = raw ? JSON.parse(raw) : null;
			if (u?.uid === 'guest') sessionStorage.removeItem('givemegame_user');
		} catch (e) {}
		await syncAuthFromSupabase();
		supabaseClient?.auth.onAuthStateChange(async (event, session) => {
			// INITIAL_SESSION is handled by the explicit UserPreferences.load() call below in init().
			// Only react to genuine sign-in so prefs are not loaded twice on startup.
			if (event === 'SIGNED_IN' && session?.user) {
				await syncAuthFromSupabase();
				if (typeof Narrator !== 'undefined' && Narrator.loadSmartaStyles) Narrator.loadSmartaStyles();
				UserPreferences.load().catch(() => {});
			} else if (event === 'SIGNED_OUT') {
				if (typeof Narrator !== 'undefined' && Narrator.loadSmartaStyles) Narrator.loadSmartaStyles();
			}
		});

		await GameData.load();
		await Coins.load();

		// Load competency points on startup
		(async () => {
			try {
				const { data: { session } } = await Promise.race([
					supabaseClient.auth.getSession(),
					new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 8000))
				]);
				if (!session?.access_token) return;
				const res = await fetch('/api/profile/competencies', {
					headers: { 'Authorization': `Bearer ${session.access_token}` }
				});
				if (!res.ok) return;
				const data = await res.json();
				GameUI.renderCompetencies(data.competencies || data.competency_points || {});
			} catch (e) { /* silent — not critical on startup */ }
		})();

		// Wire timer completion → reflection → solo competency award
		Timer.setOnComplete(() => {
			if (window.SFX) SFX.play('complete');
			if (!window.currentGame) return;
			Reflection.open(window.currentGame, null, async (reflectionData) => {
				try {
					const { data: { session } } = await Promise.race([
						supabaseClient.auth.getSession(),
						new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 8000))
					]);
					const token = session?.access_token;
					if (!token) { GameUI.toast(t('sess_no_login_points', 'Prihlás sa pre získanie bodov')); return; }

					const ctrl = new AbortController();
					const _ft = setTimeout(() => ctrl.abort(), 12000);
					try {
						let res;
						try {
							res = await fetch('/api/profile/complete-solo', {
								method: 'POST',
								headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
								signal: ctrl.signal,
								body: JSON.stringify({ game_json: window.currentGame })
							});
						} finally { clearTimeout(_ft); }
						const data = await res.json();
						if (!res.ok) {
							if (data.code === 'SOLO_DAILY_LIMIT') {
								throw new Error(data.error || t('err_solo_daily_limit', 'Denný limit solo hier dosiahnutý'));
							}
							throw new Error(data.error || 'Chyba servera');
						}
						const kompCount = Object.keys(data.awarded || {}).length;
						GameUI.toast(t('solo_comp_awarded', '🧠 +{pts} bodov! 🪙 +{coins} coinov')
							.replace('{pts}', kompCount * 50).replace('{coins}', 100));
						if (window.Coins?.load) window.Coins.load();
						if (GameUI.renderCompetencies) GameUI.renderCompetencies(data.competencies || data.competency_points || {});
						if (GameUI.showLevelUpFeedback && data.level_changes) GameUI.showLevelUpFeedback(data.level_changes);
						// XP celebration — only when server confirmed a real award
						if (data.rpg_xp_gained > 0 && window.RpgXpFx) {
							RpgXpFx.trigger(data.rpg_xp_gained, '📚 Solo hra dokončená');
						}
					} catch (err) {
						GameUI.toast(`❌ ${err.message}`);
					}
				} catch (outerErr) {
					GameUI.toast(`❌ ${outerErr.message}`);
				}
			});
		});

		const loadedStats = await loadStats();
		stats.generated = loadedStats.generated;
		stats.exported = loadedStats.exported;
		GameUI.updateStats(stats.generated, stats.exported);
		await loadQuestLog();
		bindKeyboard();
		bindModalClicks();
		bindLangButtons();
		Narrator.init();
		UserPreferences.bindAutoSync();
		setMode('party'); // Výchozí režim
		// Load persisted narrator prefs from server (overrides localStorage defaults).
		// Falls back silently for guests or if the API is unavailable.
		const prefsLoaded = await UserPreferences.load();
		if (!prefsLoaded) await setLang(currentLang); // guest / offline fallback

		// Vždy AI engine — skontroluj stav servera pre info
		const indicator = document.getElementById('engine-indicator');
		const serverStatus = await GameAPI.checkServer();
		if (serverStatus && serverStatus.hasApiKey) {
			if (indicator) indicator.textContent = `🤖 ${t('engine_label', 'IndieWeb Engine')} ✅`;
			console.log('[App] AI server pripojený — API kľúč OK.');
		} else {
			if (indicator) indicator.textContent = `🤖 ${t('engine_label', 'IndieWeb Engine')} ⚠️`;
			console.warn('[App] AI server nedostupný — pri generovaní sa použije lokálny fallback.');
		}

		// ── Knowledge status ──
		try {
			const knowledgeRes = await fetch('/api/knowledge', { headers: ngrokHeaders() });
			if (knowledgeRes.ok) {
				const kd = await knowledgeRes.json();
				const knowledgeEl = document.getElementById('knowledge-status');
				const countEl = document.getElementById('knowledge-count');
				if (kd.fileCount > 0 && knowledgeEl && countEl) {
					countEl.textContent = kd.fileCount;
					knowledgeEl.style.display = 'flex';
					console.log(`[App] Knowledge base: ${kd.fileCount} súborov (${kd.totalChars} chars).`);
				}
			}
		} catch (e) { /* silently ignore — knowledge is optional */ }

		// — Share link (pri ngrok): zobrazí odkaz pre kamaráta — NIE localhost!
		const host = (window.location.host || '').toLowerCase();
		const isNgrok = host.includes('ngrok') || host.includes('trycloudflare.com') || host.includes('loca.lt');
		const shareWrap = document.getElementById('share-link-wrap');
		const shareBtn = document.getElementById('btn-share-link');
		const shareUrlEl = document.getElementById('share-link-url');
		if (isNgrok && shareWrap && shareBtn) {
			const shareUrl = window.location.origin + '/';
			shareWrap.style.display = 'flex';
			if (shareUrlEl) shareUrlEl.textContent = shareUrl;
			shareBtn.addEventListener('click', async () => {
				try {
					await navigator.clipboard.writeText(shareUrl);
					GameUI.toast('🔗 Odkaz skopírovaný! Pošli kamarátovi túto URL — NIE localhost.');
				} catch (e) {
					GameUI.toast('Skopíruj URL z adresného riadka.');
				}
			});
		}

		isInitializing = false; // Allow coin awards + cursor effects from now on
		GameUI.setStatus(t('status_ready', 'Ready'));
		console.log('[App] gIVEMEGAME.IO inicializováno.');
	}

	// ─── Sběr filtrů ───
	function getFilters() {
		// Získaj ai_language z i18n cache pre AI generovanie
		const tr = translationCache[currentLang];
		const aiLanguage = tr?._meta?.ai_language || 'English';

		return {
			mode: currentMode,
			lang: currentLang,
			aiLanguage: aiLanguage,
			ageMin: document.getElementById('filter-age-min').value,
			ageMax: document.getElementById('filter-age-max').value,
			players: document.getElementById('filter-players').value,
			duration: document.getElementById('filter-duration').value,
			setting: getActiveSetting(),
			energy: document.getElementById('filter-energy').value,
			activity: document.getElementById('filter-activity')?.value || '',
			depth: document.getElementById('filter-depth')?.value || '',
			cuisine: document.getElementById('filter-cuisine')?.value || '',
			focus: document.getElementById('filter-focus')?.value || '',
			stupen: document.getElementById('filter-stupen').value,
			kompetence: document.getElementById('filter-kompetence').value,
			oblast: document.getElementById('filter-oblast').value,
			description: document.getElementById('filter-description')?.value?.trim() || ''
		};
	}

	function getActiveSetting() {
		if (document.getElementById('setting-indoor').classList.contains('active')) return 'indoor';
		if (document.getElementById('setting-outdoor').classList.contains('active')) return 'outdoor';
		return 'any';
	}

	// ─── Generování ───
	async function generate(costAction = 'generate', sourceGame = null) {
		if (isGenerating) return;

		// Check if player can afford the generation cost
		if (!Coins.canAfford(costAction)) {
			GameUI.toast(`🪙 ${t('not_enough_coins', 'Nedostatek coinů!')} (${Coins.getCost(costAction)} potřeba, máš ${Coins.getBalance()})`);
			return;
		}

		isGenerating = true;
		if (window.SFX) SFX.play('generate');

		const btn = document.getElementById('btn-generate');
		const btnText = document.getElementById('generate-text');
		btn.classList.add('generating');
		btnText.textContent = t('status_generating', 'GENERATING...');
		GameUI.setStatus(sourceGame ? t('status_remixing', 'REMIXING...') : t('status_generating', 'GENERATING...'));

		GameUI.showScreen('loading');

		try {
			const filters = getFilters();
			const game = sourceGame
				? await GameAPI.remixGame(sourceGame, filters)
				: await GameAPI.generateGame(filters);

			// Deduct coins ONLY after successful generation
			Coins.spend(costAction);

			currentGame = game;
			const sessionBtn = document.getElementById('btn-create-session');
			if (sessionBtn) sessionBtn.style.display = '';
			stats.generated++;
			saveStats(stats.generated, stats.exported);
			const editBtnGen = document.getElementById('btn-edit-game');
			if (editBtnGen) editBtnGen.style.display = 'none';

			await new Promise(r => setTimeout(r, 1300));

			GameUI.renderGame(game);
			if (window.SFX) SFX.play('ready');
			GameUI.renderQuickView(game);
			GameUI.addToHistory(game);
			GameUI.closeMobileOverlays();
			saveQuestLogEntry(game);
			GameUI.updateStats(stats.generated, stats.exported);
			GameUI.setStatus(sourceGame ? t('status_remix_ready', 'REMIX READY') : t('status_game_ready', 'GAME READY'));

			// Setup timer based on game duration
			Timer.setup(game.duration);
		} catch (err) {
			console.error('[App] Generování selhalo:', err);
			GameUI.showScreen('welcome');

			// Chyba — ale vďaka fallbacku v GameAPI sa sem dostaneme len zriedka
			const errorMsg = t('status_error', 'ERROR') + ' — ' + err.message;
			GameUI.toast(errorMsg);
			GameUI.setStatus(t('status_error', 'ERROR'));
		} finally {
			isGenerating = false;
			btn.classList.remove('generating');
			btnText.textContent = t('generate', 'GENERATE GAME');
		}
	}

	// ─── Remix — variácia aktuálnej hry s novými filtrami ───
	function remixCurrentGame() {
		if (!currentGame) { GameUI.toast('Najprv vygeneruj alebo načítaj hru!'); return; }
		generate('remix', currentGame);
	}

	// ─── Překvapení (náhodné, ignoruje filtry) ───
	async function surprise() {
		document.getElementById('filter-age-min').value = '';
		document.getElementById('filter-age-max').value = '';
		document.getElementById('filter-players').value = '';
		document.getElementById('filter-duration').value = '';
		document.getElementById('filter-stupen').value = '';
		document.getElementById('filter-kompetence').value = '';
		document.getElementById('filter-oblast').value = '';
		Filters.setSetting('any');

		await generate('surprise'); // Uses cheaper "surprise" cost (50 coins)
	}

	// ─── Export ───
	function exportGame() {
		if (!currentGame) return;
		GameUI.openModal('export-modal');
	}

	function exportAs(format) {
		if (!currentGame) return;
		let content, filename, mimeType;

		if (format === 'json') {
			content = JSON.stringify(currentGame, null, 2);
			filename = `${slugify(currentGame.title)}.json`;
			mimeType = 'application/json';
		} else if (format === 'markdown') {
			content = gameToMarkdown(currentGame);
			filename = `${slugify(currentGame.title)}.md`;
			mimeType = 'text/markdown';
		} else {
			content = gameToText(currentGame);
			filename = `${slugify(currentGame.title)}.txt`;
			mimeType = 'text/plain';
		}

		downloadFile(content, filename, mimeType);
		stats.exported++;
		saveStats(stats.generated, stats.exported);
		GameUI.updateStats(stats.generated, stats.exported);
		GameUI.closeModal('export-modal');
		GameUI.toast(t('toast_exported', 'Exported as {format}!').replace('{format}', format.toUpperCase()));
	}

	function copyGame() {
		if (!currentGame) return;
		const text = gameToText(currentGame);
		navigator.clipboard.writeText(text).then(() => {
			GameUI.toast(t('toast_copied', 'Game copied to clipboard!'));
		}).catch(() => {
			GameUI.toast(t('toast_copy_fail', 'Copy failed — try export.'));
		});
	}

	// ─── Filtry ───
	const Filters = {
		setSetting(value) {
			['any', 'indoor', 'outdoor'].forEach(s => {
				document.getElementById(`setting-${s}`).classList.toggle('active', s === value);
			});
		}
	};

	// ─── Pomocné funkce ───
	const diacriticsMap = {
		'á':'a','č':'c','ď':'d','é':'e','ě':'e','í':'i','ň':'n',
		'ó':'o','ř':'r','š':'s','ť':'t','ú':'u','ů':'u','ý':'y','ž':'z'
	};

	function slugify(str) {
		return str
			.toLowerCase()
			.replace(/[áčďéěíňóřšťúůýž]/g, ch => diacriticsMap[ch] || ch)
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/(^-|-$)/g, '');
	}

	function settingLabel(setting) {
		const labels = { indoor: 'Uvnitř', outdoor: 'Venku', any: 'Kdekoli' };
		return labels[setting] || setting;
	}

	function gameToText(game) {
		let t = '';
		t += `═══ ${game.title.toUpperCase()} ═══\n\n`;
		t += `${game.pitch}\n\n`;
		t += `Hráči: ${game.playerCount.min}–${game.playerCount.max}\n`;
		t += `Věk: ${game.ageRange.min}–${game.ageRange.max}\n`;
		t += `Délka: ${game.duration.min}–${game.duration.max} min\n`;
		t += `Prostředí: ${settingLabel(game.setting)}\n\n`;
		t += `─── POMŮCKY ───\n`;
		game.materials.forEach(m => t += `• ${m}\n`);
		t += `\n─── INSTRUKCE ───\n`;
		game.instructions.forEach((inst, i) => t += `${i + 1}. ${inst}\n`);
		t += `\n─── VZDĚLÁVACÍ CÍLE ───\n`;
		game.learningGoals.forEach(g => t += `• ${g}\n`);
		t += `\n─── REFLEXNÍ OTÁZKY ───\n`;
		game.reflectionPrompts.forEach(p => t += `• ${p}\n`);
		t += `\n─── BEZPEČNOSTNÍ POZNÁMKY ───\n`;
		game.safetyNotes.forEach(n => t += `• ${n}\n`);
		t += `\n─── TIPY NA ÚPRAVY ───\n`;
		game.adaptationTips.forEach(a => t += `• ${a}\n`);
		t += `\n─── POZNÁMKY PRO VEDOUCÍHO ───\n`;
		t += game.facilitatorNotes + '\n';

		// RVP sekce v exportu
		if (game.rvp) {
			const rvp = GameData.getRvp();
			t += `\n─── RVP MAPOVÁNÍ ───\n`;
			if (rvp && game.rvp.kompetence) {
				t += `Kompetence: ${game.rvp.kompetence.map(k => rvp.kompetence[k] ? rvp.kompetence[k].nazev : k).join(', ')}\n`;
			}
			if (rvp && game.rvp.oblasti) {
				t += `Oblasti: ${game.rvp.oblasti.map(o => rvp.vzdelavaci_oblasti[o] ? rvp.vzdelavaci_oblasti[o].nazev : o).join(', ')}\n`;
			}
			if (game.rvp.ocekavane_vystupy) {
				t += `Očekávané výstupy:\n`;
				game.rvp.ocekavane_vystupy.forEach(v => t += `  • ${v}\n`);
			}
		}

		t += `\n═══ Vygenerováno pomocí gIVEMEGAME.IO ═══\n`;
		return t;
	}

	function gameToMarkdown(game) {
		let md = '';
		md += `# ${game.title}\n\n`;
		md += `> ${game.pitch}\n\n`;
		md += `| Údaj | Hodnota |\n|------|--------|\n`;
		md += `| Hráči | ${game.playerCount.min}–${game.playerCount.max} |\n`;
		md += `| Věk | ${game.ageRange.min}–${game.ageRange.max} |\n`;
		md += `| Délka | ${game.duration.min}–${game.duration.max} min |\n`;
		md += `| Prostředí | ${settingLabel(game.setting)} |\n\n`;
		md += `## Pomůcky\n`;
		game.materials.forEach(m => md += `- ${m}\n`);
		md += `\n## Instrukce\n`;
		game.instructions.forEach((inst, i) => md += `${i + 1}. ${inst}\n`);
		md += `\n## Vzdělávací cíle\n`;
		game.learningGoals.forEach(g => md += `- ${g}\n`);
		md += `\n## Reflexní otázky\n`;
		game.reflectionPrompts.forEach(p => md += `- ${p}\n`);
		md += `\n## Bezpečnostní poznámky\n`;
		game.safetyNotes.forEach(n => md += `- ${n}\n`);
		md += `\n## Tipy na úpravy\n`;
		game.adaptationTips.forEach(a => md += `- ${a}\n`);
		md += `\n## Poznámky pro vedoucího\n`;
		md += game.facilitatorNotes + '\n';

		// RVP sekce v exportu
		if (game.rvp) {
			const rvp = GameData.getRvp();
			md += `\n## RVP Mapování\n`;
			if (rvp && game.rvp.kompetence) {
				md += `**Kompetence:** ${game.rvp.kompetence.map(k => rvp.kompetence[k] ? rvp.kompetence[k].nazev : k).join(', ')}\n\n`;
			}
			if (rvp && game.rvp.oblasti) {
				md += `**Vzdělávací oblasti:** ${game.rvp.oblasti.map(o => rvp.vzdelavaci_oblasti[o] ? rvp.vzdelavaci_oblasti[o].nazev : o).join(', ')}\n\n`;
			}
			if (game.rvp.ocekavane_vystupy) {
				md += `**Očekávané výstupy:**\n`;
				game.rvp.ocekavane_vystupy.forEach(v => md += `- ${v}\n`);
			}
		}

		md += `\n---\n*Vygenerováno pomocí gIVEMEGAME.IO*\n`;
		return md;
	}

	function downloadFile(content, filename, mimeType) {
		const blob = new Blob([content], { type: mimeType });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = filename;
		a.click();
		URL.revokeObjectURL(url);
	}

	// ─── Klávesové zkratky ───
	function bindKeyboard() {
		document.addEventListener('keydown', (e) => {
			const tag = e.target.tagName;
			if (tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA') return;

			if (e.key === ' ' || e.key === 'Enter') {
				e.preventDefault();
				generate();
			} else if (e.key === 's' || e.key === 'S') {
				surprise();
			} else if (e.key === 't' || e.key === 'T') {
				GameUI.toggleTheme();
			} else if (e.key === 'm' || e.key === 'M') {
				Music.toggle();
			} else if (e.ctrlKey && e.key === 'c') {
				if (currentGame) {
					e.preventDefault();
					copyGame();
				}
			}
		});
	}

	// ─── Zavírání modalů kliknutím na overlay ───
	function bindModalClicks() {
		document.querySelectorAll('.modal-overlay').forEach(modal => {
			modal.addEventListener('click', (e) => {
				if (e.target === modal) modal.style.display = 'none';
			});
		});
	}

	// ─── Režimy aplikace ───
	let currentMode = 'party';
	let isInitializing = true; // Skip coin award + cursor burst on first setMode
	const MODES = ['party', 'classroom', 'reflection', 'circus', 'cooking', 'meditation'];

	function setMode(mode) {
		if (!MODES.includes(mode)) return;
		currentMode = mode;

		// Přepni CSS třídu na body
		MODES.forEach(m => document.body.classList.remove(`mode-${m}`));
		document.body.classList.add(`mode-${mode}`);

		// Přepni aktivní tlačítko
		document.querySelectorAll('.btn-mode').forEach(btn => {
			btn.classList.toggle('active', btn.dataset.mode === mode);
		});

		// Zobraz/skryj specifické filtry
		const filterVisibility = {
			'filter-group-activity': mode === 'circus',
			'filter-group-depth': mode === 'reflection',
			'filter-group-cuisine': mode === 'cooking',
			'filter-group-focus': mode === 'meditation'
		};
		Object.entries(filterVisibility).forEach(([id, show]) => {
			const el = document.getElementById(id);
			if (el) el.style.display = show ? '' : 'none';
		});

		// RVP filtry zvýrazni v classroom režimu
		const rvpSection = document.getElementById('rvp-filters-section');
		if (rvpSection) {
			rvpSection.style.opacity = mode === 'classroom' ? '1' : '0.6';
		}

		// Aktualizuj mode badge na game kartě
		const badge = document.getElementById('game-mode-badge');
		if (badge) {
			const modeEmojis = { party: '🎉', classroom: '📚', reflection: '🪞', circus: '🎪', cooking: '🍳', meditation: '🧘' };
			const modeName = t(`mode_${mode}`, mode);
			badge.innerHTML = `<span class="mode-emoji-badge">${modeEmojis[mode]}</span> ${modeName}`;
			badge.className = `game-mode-badge badge-${mode}`;
		}

		// Restart music with new mode's audio profile
		Music.onModeChange();

		// Award coin for mode click (farming mechanic) — skip during init
		if (!isInitializing) {
			Coins.award('mode_click');
			// Dispatch CustomEvent for cursor effect (ESM module bridge)
			document.dispatchEvent(new CustomEvent('givemegame:modechange', { detail: { mode } }));
		}

		console.log(`[App] Režim: ${mode}`);
		GameUI.toast(`${t('mode', 'Režim')}: ${t(`mode_${mode}`, mode)}`);
	}

	function getMode() { return currentMode; }

	// ─── Hudební modul (Web Audio API) — per-mode audio profiles ───
	const Music = (() => {
		let audioCtx = null;
		let isPlaying = false;
		let gainNode = null;
		let intervalId = null;

		// Per-mode audio profiles: scale, waveType, tempo, noteDuration, volume
		const modeProfiles = {
			party: {
				scale: [329.63, 392.00, 440.00, 523.25, 587.33, 659.25],  // E major — bright & energetic
				wave: 'square',
				interval: [600, 900],      // Fast tempo
				duration: [0.3, 0.6],      // Short punchy notes
				gain: 0.06,
				attack: 0.02,
				detune: 15                  // Slight detuning for rawness
			},
			classroom: {
				scale: [261.63, 293.66, 329.63, 392.00, 440.00],  // C pentatonic — calm & focused
				wave: 'sine',
				interval: [2000, 3000],    // Slow, non-distracting
				duration: [1.5, 3.0],      // Long smooth notes
				gain: 0.06,
				attack: 0.2,
				detune: 0
			},
			reflection: {
				scale: [174.61, 207.65, 220.00, 261.63, 293.66, 329.63],  // Low A minor — ambient & introspective
				wave: 'sine',
				interval: [3000, 5000],    // Very slow, meditative
				duration: [3.0, 5.0],      // Long ambient pads
				gain: 0.05,
				attack: 0.5,               // Very slow attack — dreamy
				detune: 0
			},
			circus: {
				scale: [293.66, 349.23, 392.00, 440.00, 523.25, 587.33],  // D mixolydian — playful & quirky
				wave: 'triangle',
				interval: [800, 1800],     // Irregular, playful timing
				duration: [0.4, 1.2],      // Mixed short & medium
				gain: 0.07,
				attack: 0.05,
				detune: 25                  // More detuning for circus feel
			},
			cooking: {
				scale: [293.66, 329.63, 369.99, 440.00, 493.88, 554.37],  // D major — warm & cheerful
				wave: 'triangle',
				interval: [1200, 2200],    // Medium-paced, kitchen rhythm
				duration: [0.6, 1.4],      // Bouncy moderate notes
				gain: 0.06,
				attack: 0.08,
				detune: 8                   // Slight warmth
			},
			meditation: {
				scale: [130.81, 164.81, 196.00, 220.00, 261.63],  // C minor pentatonic — deep & calming
				wave: 'sine',
				interval: [4000, 7000],    // Very slow, breathing pace
				duration: [4.0, 7.0],      // Ultra-long ambient tones
				gain: 0.04,
				attack: 0.8,               // Extremely slow attack — ethereal
				detune: 0
			}
		};

		function init() {
			if (audioCtx) return;
			audioCtx = new (window.AudioContext || window.webkitAudioContext)();
			gainNode = audioCtx.createGain();
			gainNode.gain.value = 0.06;
			gainNode.connect(audioCtx.destination);
		}

		function playNote(freq, duration, profile) {
			if (!audioCtx || !isPlaying) return;
			const osc = audioCtx.createOscillator();
			const noteGain = audioCtx.createGain();

			osc.type = profile.wave;
			osc.frequency.value = freq;
			if (profile.detune) osc.detune.value = (Math.random() - 0.5) * profile.detune;

			const now = audioCtx.currentTime;
			noteGain.gain.setValueAtTime(0, now);
			noteGain.gain.linearRampToValueAtTime(0.3, now + profile.attack);
			noteGain.gain.exponentialRampToValueAtTime(0.01, now + duration);

			osc.connect(noteGain);
			noteGain.connect(gainNode);

			osc.start();
			osc.stop(now + duration);
		}

		function startLoop() {
			if (intervalId) return;
			const play = () => {
				if (!isPlaying) return;
				const profile = modeProfiles[currentMode] || modeProfiles.party;
				const scale = profile.scale;
				const freq = scale[Math.floor(Math.random() * scale.length)];
				const dur = profile.duration[0] + Math.random() * (profile.duration[1] - profile.duration[0]);

				// Update master gain to match mode
				if (gainNode) gainNode.gain.value = profile.gain;

				playNote(freq, dur, profile);

				// Schedule next note with mode-specific timing
				const nextIn = profile.interval[0] + Math.random() * (profile.interval[1] - profile.interval[0]);
				intervalId = setTimeout(play, nextIn);
			};
			play();
		}

		function stopLoop() {
			if (intervalId) {
				clearTimeout(intervalId);
				intervalId = null;
			}
		}

		// Restart loop when mode changes (if music is playing)
		function onModeChange() {
			if (!isPlaying) return;
			stopLoop();
			startLoop();
		}

		function toggle() {
			init();
			if (audioCtx.state === 'suspended') {
				audioCtx.resume();
			}

			isPlaying = !isPlaying;
			const btn = document.getElementById('btn-music');
			const icon = document.getElementById('music-icon');

			if (isPlaying) {
				btn.classList.add('playing');
				icon.className = 'bi bi-music-note-beamed';
				startLoop();
				GameUI.toast(`🎵 ${t('toast_music_on', 'Music on')}`);
			} else {
				btn.classList.remove('playing');
				icon.className = 'bi bi-music-note';
				stopLoop();
				GameUI.toast(`🔇 ${t('toast_music_off', 'Music off')}`);
			}
		}

		function getPlaying() { return isPlaying; }

		return { toggle, getPlaying, onModeChange };
	})();

	// ─── Timer modul — extracted to public/js/timer.js ───
	const Timer = window.Timer; // bridge to extracted module

	// ─── Supabase + Auth (pre Coins sync + gIVEME account) ───
	// supabaseClient, supabaseProfilesOk, getCurrentUser are now top-level
	// globals (see top of script.js). coins.js references them directly.

	// Sync Supabase session → sessionStorage (každý používateľ má svoj gIVEME účet)
	async function syncAuthFromSupabase() {
		if (!supabaseClient) return;
		try {
			const { data: { session } } = await Promise.race([
				supabaseClient.auth.getSession(),
				new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 8000))
			]);
			if (session?.user) {
				const user = {
					uid: session.user.id,
					name: session.user.user_metadata?.full_name || session.user.email?.split('@')[0] || 'Player',
					email: session.user.email,
					photo: session.user.user_metadata?.avatar_url || null
				};
				sessionStorage.setItem('givemegame_user', JSON.stringify(user));
				localStorage.setItem('givemegame_user', JSON.stringify(user));
				// Ulož/aktualizuj profil v Supabase
				const { error } = await supabaseClient.from('profiles').upsert({
					id: session.user.id,
					display_name: user.name,
					avatar_url: user.photo,
					updated_at: new Date().toISOString()
				}, { onConflict: 'id' });
				if (error) supabaseProfilesOk = false;
				console.log('[Auth] Session synced — gIVEME účet:', user.name);
				return user;
			}
		} catch (e) {
			supabaseProfilesOk = false;
			console.warn('[Auth] syncAuthFromSupabase:', e);
		}
		return null;
	}

	// ─── Coin systém — extracted to public/js/coins.js ───
	const Coins = window.Coins; // bridge to extracted module

	// ─── Scoreboard / Stats (per používateľ — games_generated, games_exported) ───
	const STATS_STORAGE_KEY = 'givemegame_stats';
	let statsProfilesOk = true;

	async function loadStats() {
		let generated = 0, exported = 0;
		const fromStorage = (() => {
			try {
				const raw = localStorage.getItem(STATS_STORAGE_KEY);
				if (!raw) return null;
				const o = JSON.parse(raw);
				return { generated: Math.max(0, parseInt(o.generated) || 0), exported: Math.max(0, parseInt(o.exported) || 0) };
			} catch { return null; }
		})();

		const user = getCurrentUser();
		if (user && user.uid !== 'guest' && supabaseClient && statsProfilesOk) {
			try {
				const { data, error } = await supabaseClient.from('profiles').select('games_generated, games_exported').eq('id', user.uid).single();
				if (error) { statsProfilesOk = false; }
				else {
					generated = Math.max(0, parseInt(data?.games_generated) || 0);
					exported = Math.max(0, parseInt(data?.games_exported) || 0);
					if (fromStorage && (fromStorage.generated > generated || fromStorage.exported > exported)) {
						generated = Math.max(generated, fromStorage.generated);
						exported = Math.max(exported, fromStorage.exported);
						saveStats(generated, exported);
					}
				}
			} catch (e) {
				statsProfilesOk = false;
			}
		}
		if (fromStorage && generated === 0 && exported === 0) {
			generated = fromStorage.generated;
			exported = fromStorage.exported;
		}
		return { generated, exported };
	}

	function saveStats(generated, exported) {
		try {
			localStorage.setItem(STATS_STORAGE_KEY, JSON.stringify({ generated, exported }));
		} catch (e) {}
		const user = getCurrentUser();
		if (user && user.uid !== 'guest' && supabaseClient && statsProfilesOk) {
			supabaseClient.from('profiles').update({
				games_generated: generated,
				games_exported: exported,
				updated_at: new Date().toISOString()
			}).eq('id', user.uid).then(({ error }) => {
				if (error) statsProfilesOk = false;
			}).catch(() => { statsProfilesOk = false; });
		}
	}

	// ─── Quest Log (per používateľ, nikdy sa nemazá) ───
	async function loadQuestLog() {
		const user = getCurrentUser();
		if (!user || !supabaseClient) return;
		try {
			const { data: rows, error } = await Promise.race([
				supabaseClient
					.from('quest_log')
					.select('game_data')
					.eq('user_id', user.uid)
					.order('created_at', { ascending: false })
					.limit(100),
				new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 8000))
			]);
			if (error) throw error;
			const games = (rows || []).map(r => r.game_data).filter(Boolean);
			if (games.length > 0) GameUI.loadHistory(games);
		} catch (e) { console.warn('[QuestLog] load:', e); }
	}

	async function saveQuestLogEntry(game) {
		const user = getCurrentUser();
		if (!user || !supabaseClient) return;
		try {
			await Promise.race([
				supabaseClient.from('quest_log').insert({ user_id: user.uid, game_data: game }),
				new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 8000))
			]);
		} catch (e) { console.warn('[QuestLog] save:', e); }
	}

	// ─── Jazyk / i18n ───
	let currentLang = localStorage.getItem('givemegame_preferred_lang') || 'cs';
	window.givemegame_currentLang = currentLang;
	const translationCache = {};

	// Kľúče, ktorých hodnota obsahuje HTML (použijeme innerHTML namiesto textContent)
	const HTML_KEYS = new Set(['welcome_text']);

	async function loadTranslations(lang) {
		if (translationCache[lang]) return translationCache[lang];
		try {
			const res = await fetch(`data/i18n/${lang}.json`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			translationCache[lang] = data;
			console.log(`[i18n] Preklady načítané: ${lang} (${Object.keys(data).length} kľúčov)`);
			return data;
		} catch (err) {
			console.warn(`[i18n] Nepodarilo sa načítať ${lang}.json:`, err);
			return null;
		}
	}

	function applyTranslations(translations) {
		if (!translations) return;

		// 1) data-i18n — textContent alebo innerHTML podľa kľúča
		document.querySelectorAll('[data-i18n]').forEach(el => {
			// narrator-hint — vždy spravuje Narrator.refreshHint(), neprepisovať
			if (el.classList.contains('narrator-hint')) return;

			const key = el.getAttribute('data-i18n');
			if (translations[key] === undefined) return;

			// <option> vnútri <select> — meníme textContent vždy
			if (el.tagName === 'OPTION') {
				el.textContent = translations[key];
				return;
			}

			if (HTML_KEYS.has(key)) {
				el.innerHTML = translations[key];
			} else {
				el.textContent = translations[key];
			}
		});

		// 2) data-i18n-title — title atribút (tooltipy)
		document.querySelectorAll('[data-i18n-title]').forEach(el => {
			const key = el.getAttribute('data-i18n-title');
			if (translations[key] !== undefined) {
				el.title = translations[key];
			}
		});
	}

	// Helper: preklad kľúča z cache (pre dynamické texty v JS)
	function t(key, fallback) {
		const tr = translationCache[currentLang];
		return (tr && tr[key] !== undefined) ? tr[key] : (fallback || key);
	}
	window.givemegame_t = t;

	async function setLang(lang) {
		currentLang = lang;
		window.givemegame_currentLang = lang;
		try { localStorage.setItem('givemegame_preferred_lang', lang); } catch (e) {}
		document.querySelectorAll('.btn-lang').forEach(btn => {
			btn.classList.toggle('active', btn.dataset.lang === lang);
		});
		document.documentElement.lang = lang;
		console.log(`[App] Jazyk: ${lang}`);

		const translations = await loadTranslations(lang);
		applyTranslations(translations);
		if (typeof Narrator !== 'undefined' && Narrator.refreshHint) Narrator.refreshHint();

		const label = translations?._meta?.label || lang.toUpperCase();
		GameUI.toast(`🌐 ${label}`);
	}

	// ─── Bind jazykových tlačítek ───
	function bindLangButtons() {
		document.querySelectorAll('.btn-lang').forEach(btn => {
			btn.addEventListener('click', () => setLang(btn.dataset.lang));
		});
	}

	// ─── Robot Challenge modul ───
	const RobotChallenge = (() => {
		const TOTAL_CHALLENGES = 3;
		const MAX_ATTEMPTS = 3;
		const EMOJI_CATEGORIES = {
			animals: ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮'],
			fruits:  ['🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🍒','🍑','🥭','🍍'],
			vehicles:['🚗','🚕','🚙','🚌','🏎️','🚓','🚑','🚒','🚐','🛻','🚚','🚜'],
			food:    ['🍕','🍔','🌭','🍟','🌮','🌯','🥪','🍩','🍪','🎂','🧁','🍰'],
			sports:  ['⚽','🏀','🏈','⚾','🎾','🏐','🏉','🎱','🏓','🏸','🥊','⛳']
		};
		const CATEGORY_LABELS = {
			animals: () => t('robot_cat_animals', 'animals'),
			fruits:  () => t('robot_cat_fruits', 'fruits'),
			vehicles:() => t('robot_cat_vehicles', 'vehicles'),
			food:    () => t('robot_cat_food', 'food'),
			sports:  () => t('robot_cat_sports', 'sports')
		};

		let stage = 'closed'; // closed, checkbox, math, sequence, image-grid, success, failed
		let currentIdx = 0;
		let score = 0;
		let attempts = 0;
		let imageGrid = [];
		let targetCategory = '';

		function shuffle(arr) {
			const a = [...arr];
			for (let i = a.length - 1; i > 0; i--) {
				const j = Math.floor(Math.random() * (i + 1));
				[a[i], a[j]] = [a[j], a[i]];
			}
			return a;
		}
		function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

		function open() {
			stage = 'checkbox';
			currentIdx = 0;
			score = 0;
			attempts = 0;
			render();
			document.getElementById('robot-challenge-overlay').style.display = 'flex';
		}

		function close() {
			stage = 'closed';
			document.getElementById('robot-challenge-overlay').style.display = 'none';
		}

		function nextChallenge(idx) {
			const types = shuffle(['math', 'sequence', 'image-grid']);
			stage = types[idx % types.length];
			render();
		}

		function handleSuccess() {
			score++;
			currentIdx++;
			if (currentIdx >= TOTAL_CHALLENGES) {
				stage = 'success';
				Coins.award('robot_challenge');
				render();
			} else {
				nextChallenge(currentIdx);
			}
		}

		function handleFailure() {
			attempts++;
			if (attempts >= MAX_ATTEMPTS) {
				stage = 'failed';
				render();
			} else {
				// Regenerate same type
				render();
			}
		}

		// ── Generators ──
		function generateMath() {
			const a = randInt(2, 15);
			const b = randInt(2, 15);
			const ops = [
				{ s: '+', r: a + b },
				{ s: '-', r: a - b },
				{ s: '×', r: a * b }
			];
			const op = ops[randInt(0, 2)];
			const wrong = new Set();
			while (wrong.size < 3) {
				const w = op.r + randInt(-5, 5);
				if (w !== op.r) wrong.add(w);
			}
			return {
				question: `${a} ${op.s} ${b} = ?`,
				answer: op.r,
				options: shuffle([op.r, ...Array.from(wrong)])
			};
		}

		function generateSequence() {
			const start = randInt(1, 10);
			const step = randInt(2, 5);
			const seq = Array.from({ length: 6 }, (_, i) => start + step * i);
			const miss = randInt(1, 4);
			const answer = seq[miss];
			const wrong = new Set();
			while (wrong.size < 3) {
				const w = answer + randInt(-step * 2, step * 2);
				if (w !== answer && w > 0) wrong.add(w);
			}
			return { sequence: seq, missingIndex: miss, answer, options: shuffle([answer, ...Array.from(wrong)]) };
		}

		function generateImageGrid() {
			const keys = Object.keys(EMOJI_CATEGORIES);
			const targetKey = keys[randInt(0, keys.length - 1)];
			const others = keys.filter(k => k !== targetKey);
			const targets = shuffle(EMOJI_CATEGORIES[targetKey]).slice(0, randInt(3, 5));
			const fillerCount = 9 - targets.length;
			const fillers = [];
			const usedKeys = shuffle(others).slice(0, 3);
			for (let i = 0; i < fillerCount; i++) {
				const k = usedKeys[i % usedKeys.length];
				fillers.push(EMOJI_CATEGORIES[k][randInt(0, EMOJI_CATEGORIES[k].length - 1)]);
			}
			imageGrid = shuffle([
				...targets.map((e, i) => ({ id: i, emoji: e, isTarget: true, selected: false })),
				...fillers.map((e, i) => ({ id: targets.length + i, emoji: e, isTarget: false, selected: false }))
			]).map((c, i) => ({ ...c, id: i }));
			targetCategory = CATEGORY_LABELS[targetKey]();
		}

		// ── Render ──
		function render() {
			const content = document.getElementById('robot-content');
			const progress = document.getElementById('robot-progress');
			if (!content) return;

			const showProgress = !['checkbox', 'success', 'failed', 'closed'].includes(stage);
			progress.style.display = showProgress ? 'flex' : 'none';
			if (showProgress) {
				document.getElementById('robot-progress-fill').style.width = `${(currentIdx / TOTAL_CHALLENGES) * 100}%`;
				document.getElementById('robot-progress-text').textContent = `${currentIdx + 1}/${TOTAL_CHALLENGES}`;
				document.getElementById('robot-attempts').textContent = `${'●'.repeat(MAX_ATTEMPTS - attempts)}${'○'.repeat(attempts)} ${MAX_ATTEMPTS - attempts}`;
			}

			if (stage === 'checkbox') renderCheckbox(content);
			else if (stage === 'math') renderMath(content);
			else if (stage === 'sequence') renderSequence(content);
			else if (stage === 'image-grid') renderImageGrid(content);
			else if (stage === 'success') renderResult(content, true);
			else if (stage === 'failed') renderResult(content, false);
		}

		function renderCheckbox(el) {
			el.innerHTML = `
				<div style="font-size:40px;margin-bottom:8px;">🛡️</div>
				<h2>${t('robot_title', 'Security Check')}</h2>
				<p>${t('robot_subtitle', 'Verify that you are human by completing challenges.')}</p>
				<button class="robot-checkbox-btn" id="robot-start-btn">
					<div class="robot-checkbox-box" id="robot-cb-box"></div>
					<span class="robot-checkbox-label">${t('robot_not_robot', "I'm not a robot")}</span>
				</button>
			`;
			document.getElementById('robot-start-btn').addEventListener('click', () => {
				document.getElementById('robot-cb-box').classList.add('checked');
				document.getElementById('robot-cb-box').innerHTML = '✓';
				setTimeout(() => nextChallenge(0), 800);
			});
		}

		function renderMath(el) {
			const ch = generateMath();
			el.innerHTML = `
				<h2>${t('robot_solve', 'Solve the equation')}</h2>
				<p>${t('robot_select_answer', 'Select the correct answer')}</p>
				<div class="robot-question-box">
					<span class="robot-question-text">${ch.question}</span>
				</div>
				<div class="robot-answers">
					${ch.options.map(opt => `<button class="robot-answer-btn" data-val="${opt}">${opt}</button>`).join('')}
				</div>
			`;
			el.querySelectorAll('.robot-answer-btn').forEach(btn => {
				btn.addEventListener('click', () => {
					const val = parseInt(btn.dataset.val);
					if (val === ch.answer) {
						btn.classList.add('correct');
						setTimeout(handleSuccess, 500);
					} else {
						btn.classList.add('wrong');
						setTimeout(handleFailure, 500);
					}
				});
			});
		}

		function renderSequence(el) {
			const ch = generateSequence();
			el.innerHTML = `
				<h2>${t('robot_find_number', 'Find the missing number')}</h2>
				<p>${t('robot_complete_pattern', 'What number completes the pattern?')}</p>
				<div class="robot-sequence">
					${ch.sequence.map((n, i) => {
						if (i === ch.missingIndex) {
							return `<div class="robot-seq-num robot-seq-missing">?</div>`;
						}
						return `<div class="robot-seq-num">${n}</div>`;
					}).join('<span class="robot-seq-arrow">›</span>')}
				</div>
				<div class="robot-answers">
					${ch.options.map(opt => `<button class="robot-answer-btn" data-val="${opt}">${opt}</button>`).join('')}
				</div>
			`;
			el.querySelectorAll('.robot-answer-btn').forEach(btn => {
				btn.addEventListener('click', () => {
					const val = parseInt(btn.dataset.val);
					if (val === ch.answer) {
						btn.classList.add('correct');
						setTimeout(handleSuccess, 500);
					} else {
						btn.classList.add('wrong');
						setTimeout(handleFailure, 500);
					}
				});
			});
		}

		function renderImageGrid(el) {
			generateImageGrid();
			el.innerHTML = `
				<h2>${t('robot_select_all', 'Select all {category}').replace('{category}', targetCategory)}</h2>
				<p>${t('robot_click_match', 'Click on each tile that matches')}</p>
				<div class="robot-emoji-grid">
					${imageGrid.map(c => `<button class="robot-emoji-cell" data-id="${c.id}">${c.emoji}</button>`).join('')}
				</div>
				<button class="robot-verify-btn">${t('robot_verify', 'Verify Selection')}</button>
			`;
			el.querySelectorAll('.robot-emoji-cell').forEach(btn => {
				btn.addEventListener('click', () => {
					const id = parseInt(btn.dataset.id);
					imageGrid = imageGrid.map(c => c.id === id ? { ...c, selected: !c.selected } : c);
					btn.classList.toggle('selected');
				});
			});
			el.querySelector('.robot-verify-btn').addEventListener('click', () => {
				const allCorrect = imageGrid.every(c => c.selected === c.isTarget);
				if (allCorrect) handleSuccess();
				else handleFailure();
			});
		}

		function renderResult(el, success) {
			el.innerHTML = `
				<div class="robot-result-emoji ${success ? 'success' : ''}">${success ? '✅' : '🤖'}</div>
				<h2>${success ? t('robot_complete', 'Verification Complete!') : t('robot_failed', 'Verification Failed')}</h2>
				<p>${success
					? t('robot_verified', 'You have been verified as a human.')
					: t('robot_too_many', 'Too many incorrect attempts.')}</p>
				<div style="font-family:'Press Start 2P',monospace;font-size:10px;color:var(--text,#ccc);">
					Score: ${score}/${TOTAL_CHALLENGES}
				</div>
				${success ? `
					<div class="robot-result-badge">
						<span class="badge-icon">🛡️</span>
						<div class="badge-text">
							<div class="badge-title">Access Granted</div>
							<div class="badge-sub">+250 🪙 gIVEMECOIN earned!</div>
						</div>
					</div>
					<div class="robot-coin-reward">+250 🪙</div>
				` : ''}
				<button class="robot-retry-btn" id="robot-action-btn">
					${success ? t('robot_close', 'Close') : t('robot_try_again', 'Try Again')}
				</button>
			`;
			document.getElementById('robot-action-btn').addEventListener('click', () => {
				if (success) close();
				else open(); // Reset and try again
			});
		}

		return { open, close };
	})();

	// ─── Profile (gIVEME) ───
	const Profile = (() => {
		let phoneVibrateInterval = null;

		function open() {
			const user = getCurrentUser();
			const header = document.getElementById('profile-header');
			const nameEl = document.getElementById('profile-name');
			const emailEl = document.getElementById('profile-email');
			const avatarEl = document.getElementById('profile-avatar');
			const coinsEl = document.getElementById('profile-coins');
			const loginCta = document.getElementById('profile-login-cta');
			const logoutSection = document.getElementById('profile-logout-section');
			const coinsSection = document.querySelector('.profile-coins-section');
			if (user) {
				if (header) header.style.display = 'flex';
				if (loginCta) loginCta.style.display = 'none';
				if (nameEl) nameEl.textContent = user.name || '';
				if (emailEl) { emailEl.textContent = user.email || ''; emailEl.style.display = user.email ? 'block' : 'none'; }
				if (avatarEl) avatarEl.textContent = user.photo ? '' : '👤';
				if (avatarEl && user.photo) { avatarEl.innerHTML = `<img src="${user.photo}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`; }
				if (logoutSection) logoutSection.style.display = 'block';
			} else {
				if (header) header.style.display = 'none';
				if (loginCta) loginCta.style.display = 'block';
				if (logoutSection) logoutSection.style.display = 'none';
			}
			if (coinsEl) coinsEl.textContent = Coins.getBalance();
			if (coinsSection) coinsSection.style.display = 'block';
			const billingSection = document.getElementById('profile-billing-section');
			if (user && billingSection) {
				billingSection.style.display = 'block';
				if (App?.Billing?.refreshState) App.Billing.refreshState();
			} else if (billingSection) billingSection.style.display = 'none';
			switchTab('profil'); // Profil tab — billing section visible hneď
			GameUI.openModal('profile-modal');

			// RPG Avatar — always render (function handles eligible/non-eligible states internally)
			if (user && window.RpgAvatar) {
				RpgAvatar.load().then(data => {
					RpgAvatar.renderProfileAvatar('rpg-avatar-container');
					// Override profile-avatar circle with RPG avatar if set
					if (data?.eligible && data.current_avatar_id) {
						const el = document.getElementById('profile-avatar');
						if (el) el.innerHTML = `<img src="/avatars/${data.current_avatar_id}.png" alt="RPG Avatar" style="width:100%;height:100%;object-fit:cover;border-radius:50%;image-rendering:pixelated;">`;
					}
				});
			}
		}

		async function logout() {
			try {
				if (supabaseClient) await supabaseClient.auth.signOut();
			} catch (e) { console.warn('[Profile] signOut:', e); }
			sessionStorage.removeItem('givemegame_user');
			localStorage.removeItem('givemegame_user');
			GameUI.closeModal('profile-modal');
			window.location.href = '/login.html';
		}

		function switchTab(tab) {
			document.querySelectorAll('.profile-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
			document.getElementById('profile-tab-profil').style.display    = tab === 'profil'    ? 'block' : 'none';
			document.getElementById('profile-tab-analytics').style.display = tab === 'analytics' ? 'block' : 'none';
			document.getElementById('profile-tab-giveme').style.display    = tab === 'giveme'    ? 'block' : 'none';

			const modalBox = document.querySelector('#profile-modal .modal-box');
			if (modalBox) modalBox.classList.toggle('profile-modal-giveme', tab === 'giveme');

			if (tab === 'profil') {
				const coinsEl = document.getElementById('profile-coins');
				if (coinsEl) coinsEl.textContent = Coins.getBalance();
				_loadProfileCompetencies();
				if (App?.Billing?.refreshState) App.Billing.refreshState();
			}
			if (tab === 'analytics') _loadAnalytics();
			if (tab === 'giveme') {
				const iframe = document.getElementById('giveme-iframe');
				if (iframe) syncGivemeIframe(iframe);
			}
		}

		async function _loadProfileCompetencies() {
			const compSection = document.getElementById('profile-competencies');
			const compBars    = document.getElementById('profile-comp-bars');
			if (!compSection || !compBars) return;
			const user = getCurrentUser();
			if (!user || user.uid === 'guest' || !supabaseClient) {
				compSection.style.display = 'none';
				return;
			}
			try {
				const { data: { session } } = await Promise.race([
					supabaseClient.auth.getSession(),
					new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 8000))
				]);
				const token = session?.access_token;
				if (!token) { compSection.style.display = 'none'; return; }
				const ctrl = new AbortController();
				const _cft = setTimeout(() => ctrl.abort(), 10000);
				let res;
				try {
					res = await fetch('/api/profile/competencies', {
						headers: { 'Authorization': `Bearer ${token}` },
						signal: ctrl.signal
					});
				} finally { clearTimeout(_cft); }
				if (!res.ok) { compSection.style.display = 'none'; return; }
				const data = await res.json();
				GameUI.renderProfileCompetencies(compBars, data.competencies || data.competency_points || {});
				compSection.style.display = 'block';
			} catch (e) {
				compSection.style.display = 'none';
			}
		}

		// Small lookup so the analytics renderer can translate competency keys
		// without needing access to the private COMP_META inside game-ui.js.
		const _COMP_LABEL = {
			'k-uceni':             ['comp_learning',  'K učeniu'],
			'k-reseni-problemu':   ['comp_problem',   'K riešeniu'],
			'komunikativni':       ['comp_comm',      'Komunikatívna'],
			'socialni-personalni': ['comp_social',    'Sociálna'],
			'obcanske':            ['comp_civic',     'Občianska'],
			'pracovni':            ['comp_work',      'Pracovná'],
			'digitalni':           ['comp_digital',   'Digitálna'],
		};

		async function _loadAnalytics() {
			const el = document.getElementById('analytics-content');
			if (!el) return;
			const user = getCurrentUser();
			if (!user || user.uid === 'guest' || !supabaseClient) {
				el.innerHTML = `<p class="analytics-hint">${t('ana_login_required', 'Prihlás sa pre štatistiky')}</p>`;
				return;
			}
			el.innerHTML = `<p class="analytics-loading">${t('ana_loading', 'Načítavam...')}</p>`;
			try {
				// 8s timeout — prevents hanging if Supabase auth is slow on token refresh
				const sessionResult = await Promise.race([
					supabaseClient.auth.getSession(),
					new Promise((_, reject) => setTimeout(() => reject(new Error('session_timeout')), 8000))
				]);
				const token = sessionResult.data?.session?.access_token;
				if (!token) { el.innerHTML = `<p class="analytics-hint">${t('ana_login_required', 'Prihlás sa pre štatistiky')}</p>`; return; }
				const controller = new AbortController();
				const fetchTimeout = setTimeout(() => controller.abort(), 10000);
				let res;
				try {
					res = await fetch('/api/profile/analytics', {
						headers: { 'Authorization': `Bearer ${token}` },
						signal: controller.signal
					});
				} finally {
					clearTimeout(fetchTimeout);
				}
				if (!res.ok) { el.innerHTML = `<p class="analytics-hint">${t('ana_no_data', 'Zatiaľ bez dát')}</p>`; return; }
				const data = await res.json();
				el.innerHTML = _renderAnalytics(data);
			} catch (e) {
				el.innerHTML = `<p class="analytics-hint">${t('ana_no_data', 'Zatiaľ bez dát')}</p>`;
			}
		}

		function _renderAnalytics(d) {
			const modeLabels = {
				solo:     `🎮 ${t('ana_style_solo',     'Sólový hráč')}`,
				session:  `👥 ${t('ana_style_group',    'Tímový hráč')}`,
				balanced: `⚖️ ${t('ana_style_balanced', 'Vyvážený')}`,
			};
			const compLabel = key => {
				if (!key) return '—';
				const [lkey, lfb] = _COMP_LABEL[key] || ['', key];
				return t(lkey, lfb);
			};
			const stat = (value, label, sub) => `
				<div class="analytics-stat">
					<div class="analytics-stat-value">${value}</div>
					<div class="analytics-stat-label">${label}</div>
					${sub ? `<div class="analytics-stat-sub">${sub}</div>` : ''}
				</div>`;
			return `<div class="analytics-grid">
				${stat(d.games_generated,     t('ana_games_gen',   'Hier'))}
				${stat(d.solo_completions,    t('ana_solo',        'Solo hry'))}
				${stat(d.session_completions, t('ana_sessions',    'Sessie'))}
				${stat(d.total_xp,            t('ana_total_xp',   'Celkové XP'))}
				${stat(d.strongest ? compLabel(d.strongest) : '—', t('ana_strongest', 'Najsilnejšia'))}
				${stat(d.weakest   ? compLabel(d.weakest)   : '—', t('ana_weakest',   'Najslabšia'))}
				${stat(`🪙 ${d.coins_earned}`, t('ana_coins_earned', 'Coinov zarobených'))}
				${stat(`🪙 ${d.coins_spent}`,  t('ana_coins_spent',  'Coinov minutých'))}
				${stat(d.dominant_mode ? modeLabels[d.dominant_mode] : '—', t('ana_play_style', 'Herný štýl'))}
			</div>`;
		}

		function syncGivemeIframe(iframe) {
			if (!iframe?.contentWindow) return;
			try {
				const user = getCurrentUser();
				iframe.contentWindow.postMessage({ type: 'giveme_syncUser', user: user || null }, '*');
				iframe.contentWindow.postMessage({ type: 'giveme_syncCoins' }, '*');
			} catch (e) { console.warn('[Profile] syncGivemeIframe:', e); }
		}

		function onGivemeLoad(iframe) {
			if (!iframe?.src || !iframe.src.includes('gIVEME')) return;
			syncGivemeIframe(iframe);
			// Retry po 1.5s ak user ešte nebol dostupný pri prvom pokuse
			setTimeout(() => syncGivemeIframe(iframe), 1500);
		}

		function startPhoneVibrate() {
			if (phoneVibrateInterval) return;
			const btn = document.getElementById('btn-phone');
			if (!btn) return;
			phoneVibrateInterval = setInterval(() => {
				btn.classList.add('phone-vibrate');
				setTimeout(() => btn.classList.remove('phone-vibrate'), 400);
				Coins.award('phone_buzz');
				GameUI.toast('📱 +5 gIVEMECOIN!');
			}, 30000);
		}

		function stopPhoneVibrate() {
			if (phoneVibrateInterval) { clearInterval(phoneVibrateInterval); phoneVibrateInterval = null; }
		}

		// Spusti vibráciu po init
		document.addEventListener('DOMContentLoaded', () => setTimeout(startPhoneVibrate, 5000));

		return { open, switchTab, onGivemeLoad, syncGivemeIframe, logout, startPhoneVibrate, stopPhoneVibrate };
	})();

	// ─── Billing (Payment Link MVP — manual provisioning) ───
	const Billing = (() => {
		async function getToken() {
			try {
				const { data: { session } } = await Promise.race([
					supabaseClient?.auth?.getSession(),
					new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 8000))
				]);
				return session?.access_token || null;
			} catch { return null; }
		}

		async function refreshState() {
			const section = document.getElementById('profile-billing-section');
			const statusEl = document.getElementById('profile-billing-status');
			const upgradeBtn = document.getElementById('btn-billing-upgrade');
			const hintEl = document.getElementById('profile-billing-hint');
			if (!section || !statusEl) return;
			const token = await getToken();
			if (!token) { section.style.display = 'none'; return; }
			try {
				const res = await fetch('/api/billing/state', {
					headers: { ...ngrokHeaders(), 'Authorization': `Bearer ${token}` }
				});
				if (!res.ok) { statusEl.textContent = 'Free'; if (upgradeBtn) upgradeBtn.style.display = 'block'; return; }
				const data = await res.json();
				statusEl.textContent = data.hasPaidAccess ? 'Pro' : 'Free';
				if (upgradeBtn) upgradeBtn.style.display = data.hasPaidAccess ? 'none' : 'block';
				if (hintEl) hintEl.textContent = data.hasPaidAccess ? '30 hier/min, premium funkcie' : 'Pro: 30 hier/min. Platba bezpečne cez Stripe.';
			} catch (e) {
				statusEl.textContent = 'Free';
				if (upgradeBtn) upgradeBtn.style.display = 'block';
			}
		}

		async function upgrade() {
			const token = await getToken();
			if (!token) { GameUI.toast('Prihlás sa pre upgrade'); return; }
			try {
				const res = await fetch('/api/billing/upgrade-url', {
					headers: { ...ngrokHeaders(), 'Authorization': `Bearer ${token}` }
				});
				const data = await res.json();
				if (!res.ok) throw new Error(data.error || 'Upgrade not configured');
				if (data.url) window.location.href = data.url;
				else throw new Error('No payment link');
			} catch (e) {
				GameUI.toast('❌ ' + (e.message || 'Chyba pri otvorení platby'));
			}
		}

		return { refreshState, upgrade };
	})();

	// ─── Game Library (extracted → js/library.js) ───
	const Library = window.Library; // bridge to extracted module

	// ─── Game Edit Modal (extracted → js/game-edit.js) ───
	const GameEdit = window.GameEdit; // bridge to extracted module

	// ─── Veřejné API ───
	return {
		init,
		generate,
		remixCurrentGame,
		surprise,
		exportGame,
		exportAs,
		copyGame,
		setMode,
		getMode,
		setLang,
		t,
		Music,
		Timer,
		Coins,
		Library,
		GameEdit,
		Filters,
		RobotChallenge,
		Profile,
		Billing,
		UI: GameUI,
		API: GameAPI,
		Data: GameData
	};
})();

// Pre iframe gIVEME (prístup k Coins)
if (typeof window !== 'undefined') window.App = App;

// gIVEME môže požiadať o sync (napr. pri načítaní)
window.addEventListener('message', (e) => {
	if (e.data?.type === 'giveme_requestSync') {
		const iframe = document.getElementById('giveme-iframe');
		if (iframe && e.source === iframe.contentWindow && App?.Profile?.syncGivemeIframe) {
			App.Profile.syncGivemeIframe(iframe);
		}
	}
	if (e.data?.type === 'giveme_needLogin') {
		const iframe = document.getElementById('giveme-iframe');
		if (iframe && e.source === iframe.contentWindow && !getCurrentUser()) {
			window.location.href = '/login.html';
		}
	}
	if (e.data?.type === 'tamagochi_coin') {
		const iframe = document.getElementById('tamagochi-iframe');
		if (iframe && e.source === iframe.contentWindow && App?.Coins?.award) {
			App.Coins.award('tamagochi_coin');
		}
	}
});

// ─── Spuštění ───
document.addEventListener('DOMContentLoaded', () => App.init());
