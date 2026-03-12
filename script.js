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

// ─────────────────────────────────────────────────
// GameAPI — Směrovač generování
// ─────────────────────────────────────────────────
const GameAPI = (() => {
	let engineMode = 'ai'; // default: vždy AI

	async function generateGame(filters) {
		// Vždy skúsime AI prvý; ak server neodpovie, fallback na local
		try {
			return await generateWithAI(filters);
		} catch (err) {
			console.warn('[GameAPI] AI zlyhalo, fallback na lokálny engine:', err.message);
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
				headers: { ...ngrokHeaders(), 'Content-Type': 'application/json' },
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
		generateGame, generateWithAI, generateLocally,
		setMode, getMode, checkServer
	};
})();


// ─────────────────────────────────────────────────
// GameData — Lokální data a procedurální engine
// ─────────────────────────────────────────────────
const GameData = (() => {
	let sampleGames = [];
	let rvpData = null;
	let loaded = false;

	async function load() {
		try {
			const [gamesRes, rvpRes] = await Promise.all([
				fetch('./data/games.json'),
				fetch('./data/rvp.json')
			]);
			sampleGames = await gamesRes.json();
			rvpData = await rvpRes.json();
			loaded = true;
			console.log(`[GameData] Načteno ${sampleGames.length} her a RVP data.`);
		} catch (err) {
			console.error('[GameData] Chyba načítání dat:', err);
			sampleGames = [];
			rvpData = null;
		}
	}

	function generate(filters) {
		if (!loaded || sampleGames.length === 0) {
			return createFallbackGame();
		}

		const scored = sampleGames.map(game => ({
			game,
			score: scoreMatch(game, filters)
		}));

		scored.sort((a, b) => b.score - a.score);

		const topPool = scored.filter(s => s.score >= scored[0].score * 0.6);
		const pick = topPool[Math.floor(Math.random() * topPool.length)];

		return { ...pick.game };
	}

	function scoreMatch(game, filters) {
		let score = 0;

		// Režim (nejvyšší priorita)
		if (filters.mode && game.mode) {
			if (game.mode === filters.mode || game.mode === 'universal') score += 6;
			else score -= 3;
		}

		// Energie
		if (filters.energy && game.energyLevel) {
			if (game.energyLevel === filters.energy) score += 4;
			else score -= 1;
		}

		// Prostředí
		if (filters.setting && filters.setting !== 'any') {
			if (game.setting === filters.setting) score += 3;
			else score -= 1;
		}

		// Věk
		if (filters.ageMin) {
			if (game.ageRange.min <= parseInt(filters.ageMin)) score += 2;
		}
		if (filters.ageMax) {
			if (game.ageRange.max >= parseInt(filters.ageMax)) score += 2;
		}

		// Počet hráčů
		if (filters.players) {
			const max = game.playerCount.max;
			if (filters.players === 'small' && max <= 8) score += 3;
			else if (filters.players === 'medium' && max <= 20 && max >= 5) score += 3;
			else if (filters.players === 'large' && max >= 15) score += 3;
		}

		// Délka
		if (filters.duration) {
			const dur = game.duration.max;
			if (filters.duration === 'quick' && dur <= 20) score += 3;
			else if (filters.duration === 'medium' && dur <= 40 && dur >= 15) score += 3;
			else if (filters.duration === 'long' && dur >= 30) score += 3;
		}

		// Typ aktivity (circus režim)
		if (filters.activity && game.activityType) {
			if (game.activityType === filters.activity) score += 4;
		}

		// Emoční hloubka (reflection režim)
		if (filters.depth && game.emotionalDepth) {
			if (game.emotionalDepth === filters.depth) score += 4;
		}

		// RVP: Stupeň
		if (filters.stupen && game.rvp) {
			if (game.rvp.stupen.includes(filters.stupen)) score += 4;
			else score -= 2;
		}

		// RVP: Kompetence
		if (filters.kompetence && game.rvp) {
			if (game.rvp.kompetence.includes(filters.kompetence)) score += 5;
			else score -= 1;
		}

		// RVP: Oblast
		if (filters.oblast && game.rvp) {
			if (game.rvp.oblasti.includes(filters.oblast)) score += 5;
			else score -= 1;
		}

		return score;
	}

	function createFallbackGame() {
		return {
			id: 'fallback-001',
			title: 'Kruh jmen',
			pitch: 'Klasická seznamovací hra, kde si hráči házejí míček a říkají jména — jednoduché, účinné a funguje kdekoli!',
			playerCount: { min: 5, max: 30 },
			ageRange: { min: 5, max: 99 },
			duration: { min: 5, max: 15 },
			setting: 'any',
			materials: ['Jeden měkký míček nebo pytlík s fazolemi'],
			instructions: [
				'Hráči stojí v kruhu.',
				'První hráč řekne své jméno a hodí míček někomu jinému.',
				'Chytající řekne „Děkuji, [jméno]!" a pak řekne své vlastní jméno a hodí míček dál.',
				'Pokračujte, dokud všichni nechytili míček alespoň jednou.',
				'Kolo 2: Zkuste si zapamatovat a říct jméno toho, komu házíte.'
			],
			learningGoals: ['zapamatování jmen', 'sociální propojení', 'aktivní naslouchání'],
			reflectionPrompts: ['Kolik jmen si pamatujete?', 'Co vám pomohlo zapamatovat si jména?'],
			safetyNotes: ['Používejte měkký míček', 'Zajistěte dostatek prostoru mezi hráči'],
			adaptationTips: ['Přidejte kategorie (oblíbené jídlo + jméno)', 'Použijte více míčků pro výzvu'],
			facilitatorNotes: 'Skvělé pro první setkání. Udržujte lehkou a hravou atmosféru. Netlačte na paměť.',
			rvp: {
				kompetence: ['komunikativni', 'socialni-personalni'],
				oblasti: ['clovek-svet'],
				stupen: ['prvni', 'druhy'],
				prurezova_temata: ['osobnostni-vychova'],
				ocekavane_vystupy: [
					'Žák se představí a aktivně naslouchá ostatním',
					'Žák spolupracuje ve skupině a respektuje pravidla'
				],
				doporucene_hodnoceni: ['slovni', 'sebahodnoceni']
			}
		};
	}

	function getRvp() { return rvpData; }
	function getAll() { return [...sampleGames]; }
	function getCount() { return sampleGames.length; }

	return { load, generate, getAll, getCount, getRvp };
})();


// ─────────────────────────────────────────────────
// GameUI — Vykreslování DOM a interakce
// ─────────────────────────────────────────────────
const GameUI = (() => {

	function showScreen(name) {
		document.getElementById('welcome-screen').style.display = name === 'welcome' ? '' : 'none';
		document.getElementById('loading-screen').style.display = name === 'loading' ? '' : 'none';
		document.getElementById('game-card').style.display = name === 'game' ? '' : 'none';
	}

	// ─── Překlady nastavení ───
	const settingLabels = { indoor: 'Uvnitř', outdoor: 'Venku', any: 'Kdekoli' };

	function renderGame(game) {
		// Název
		document.getElementById('game-title').textContent = game.title;

		// Odznaky
		const badges = document.getElementById('game-badges');
		badges.innerHTML = '';
		const settingLabel = settingLabels[game.setting] || game.setting;
		addBadge(badges, settingLabel, 'setting', game.setting === 'outdoor' ? 'bi-tree' : game.setting === 'indoor' ? 'bi-house' : 'bi-globe2');
		addBadge(badges, `${game.playerCount.min}–${game.playerCount.max} hráčů`, 'players', 'bi-people');
		addBadge(badges, `${game.duration.min}–${game.duration.max} min`, 'duration', 'bi-clock');
		addBadge(badges, `Věk ${game.ageRange.min}–${game.ageRange.max}`, 'age', 'bi-person');

		// Popis
		document.getElementById('game-pitch').textContent = game.pitch;

		// Meta řádek
		const metaRow = document.getElementById('game-meta-row');
		metaRow.innerHTML = '';
		addMeta(metaRow, 'bi-people-fill', `${game.playerCount.min}–${game.playerCount.max}`, 'Hráči');
		addMeta(metaRow, 'bi-clock-fill', `${game.duration.min}–${game.duration.max}m`, 'Délka');
		addMeta(metaRow, 'bi-geo-alt-fill', settingLabel, 'Prostředí');
		addMeta(metaRow, 'bi-person-fill', `${game.ageRange.min}–${game.ageRange.max}`, 'Věk');

		// Pomůcky
		renderList('game-materials', game.materials);

		// Instrukce
		renderList('game-instructions', game.instructions);

		// Vzdělávací cíle (jako tagy)
		const goalsEl = document.getElementById('game-goals');
		goalsEl.innerHTML = '';
		game.learningGoals.forEach(g => {
			const tag = document.createElement('span');
			tag.className = 'game-tag';
			tag.textContent = g;
			goalsEl.appendChild(tag);
		});

		// RVP sekce
		renderRvpSection(game);

		// Skládací sekce
		renderList('game-reflection', game.reflectionPrompts);
		renderList('game-safety', game.safetyNotes);
		renderList('game-adaptation', game.adaptationTips);
		document.getElementById('game-facilitator').textContent = game.facilitatorNotes;

		// Reset skládacích stavů
		document.querySelectorAll('.collapsible').forEach(el => el.classList.remove('collapsed'));

		showScreen('game');
	}

	function renderRvpSection(game) {
		const rvp = GameData.getRvp();
		const gameRvp = game.rvp;

		if (!rvp || !gameRvp) {
			const sectionEl = document.getElementById('section-rvp');
			if (sectionEl) sectionEl.innerHTML = '<p style="opacity:0.5;font-size:14px;">RVP data nejsou k dispozici</p>';
			return;
		}

		// Klíčové kompetence
		const kompEl = document.getElementById('rvp-kompetence');
		kompEl.innerHTML = '';
		(gameRvp.kompetence || []).forEach(key => {
			const def = rvp.kompetence[key];
			if (def) {
				kompEl.appendChild(createRvpBadge(def.nazev, def.ikona, def.barva));
			}
		});

		// Vzdělávací oblasti
		const oblEl = document.getElementById('rvp-oblasti');
		oblEl.innerHTML = '';
		(gameRvp.oblasti || []).forEach(key => {
			const def = rvp.vzdelavaci_oblasti[key];
			if (def) {
				oblEl.appendChild(createRvpBadge(def.nazev, def.ikona, def.barva));
			}
		});

		// Stupeň
		const stupEl = document.getElementById('rvp-stupen');
		stupEl.innerHTML = '';
		(gameRvp.stupen || []).forEach(key => {
			const def = rvp.stupne[key];
			if (def) {
				stupEl.appendChild(createRvpBadge(def.nazev, 'bi-mortarboard', '#6c757d'));
			}
		});

		// Průřezová témata
		const pruzEl = document.getElementById('rvp-prurezova');
		pruzEl.innerHTML = '';
		(gameRvp.prurezova_temata || []).forEach(key => {
			const nazev = rvp.prurezova_temata[key];
			if (nazev) {
				pruzEl.appendChild(createRvpBadge(nazev, 'bi-intersect', '#6f42c1'));
			}
		});

		// Očekávané výstupy
		renderList('rvp-vystupy', gameRvp.ocekavane_vystupy || []);

		// Doporučené hodnocení
		const hodEl = document.getElementById('rvp-hodnoceni');
		hodEl.innerHTML = '';
		const hodTypes = rvp.hodnoceni ? rvp.hodnoceni.typy : [];
		(gameRvp.doporucene_hodnoceni || []).forEach(id => {
			const typ = hodTypes.find(t => t.id === id);
			if (typ) {
				hodEl.appendChild(createRvpBadge(typ.nazev, 'bi-check-circle', '#17a2b8'));
			}
		});
	}

	function createRvpBadge(text, icon, color) {
		const span = document.createElement('span');
		span.className = 'rvp-badge';
		span.style.backgroundColor = color;
		span.style.borderColor = color;
		span.innerHTML = `<i class="bi ${icon}"></i> ${text}`;
		return span;
	}

	function addBadge(container, text, type, icon) {
		const span = document.createElement('span');
		span.className = `badge badge-${type}`;
		span.innerHTML = `<i class="bi ${icon}"></i> ${text}`;
		container.appendChild(span);
	}

	function addMeta(container, icon, value, label) {
		const div = document.createElement('div');
		div.className = 'meta-item';
		div.innerHTML = `<i class="bi ${icon} meta-icon"></i><span class="meta-value">${value}</span><span>${label}</span>`;
		container.appendChild(div);
	}

	function renderList(elementId, items) {
		const el = document.getElementById(elementId);
		if (!el) return;
		el.innerHTML = '';
		(items || []).forEach(item => {
			const li = document.createElement('li');
			li.textContent = item;
			el.appendChild(li);
		});
	}

	function renderQuickView(game) {
		const qv = document.getElementById('quick-view');
		const settingLabel = settingLabels[game.setting] || game.setting;

		// Kompetence pro náhled
		let kompText = '';
		if (game.rvp && game.rvp.kompetence) {
			const rvp = GameData.getRvp();
			if (rvp) {
				kompText = game.rvp.kompetence
					.slice(0, 3)
					.map(k => rvp.kompetence[k] ? rvp.kompetence[k].nazev : k)
					.join(', ');
			}
		}

		qv.innerHTML = `
			<div class="quick-summary">
				<strong>${game.title}</strong><br>
				<i class="bi bi-people"></i> ${game.playerCount.min}–${game.playerCount.max} &nbsp;
				<i class="bi bi-clock"></i> ${game.duration.min}–${game.duration.max}m &nbsp;
				<i class="bi bi-geo-alt"></i> ${settingLabel}<br>
				${kompText ? `<small>${kompText}</small>` : ''}
			</div>
		`;
	}

	function addToHistory(game) {
		const list = document.getElementById('history-list');
		const empty = list.querySelector('.history-empty');
		if (empty) empty.remove();

		const settingLabel = settingLabels[game.setting] || game.setting;
		const item = document.createElement('div');
		item.className = 'history-item';
		item.innerHTML = `
			<div class="history-item-title">${game.title}</div>
			<div class="history-item-meta">
				${settingLabel} · ${game.playerCount.min}–${game.playerCount.max} hráčů · ${game.duration.min}–${game.duration.max}m
			</div>
		`;
		item.addEventListener('click', () => renderGame(game));
		list.insertBefore(item, list.firstChild);
	}

	function clearHistory() {
		const list = document.getElementById('history-list');
		if (!list) return;
		list.innerHTML = '';
		const empty = document.createElement('div');
		empty.className = 'history-empty';
		empty.innerHTML = '<i class="bi bi-hourglass"></i><span data-i18n="history_empty">Vygenerované hry se zobrazí zde</span>';
		list.appendChild(empty);
	}

	function loadHistory(games) {
		clearHistory();
		const list = document.getElementById('history-list');
		const empty = list.querySelector('.history-empty');
		if (!games || games.length === 0) return;
		if (empty) empty.remove();
		games.forEach(game => addToHistory(game));
	}

	function toggleSection(sectionName) {
		const section = document.querySelector(`[data-section="${sectionName}"]`);
		if (section) section.classList.toggle('collapsed');
	}

	// ─── Vzhled ───
	function toggleTheme() {
		document.body.classList.toggle('light-mode');
		const icon = document.getElementById('theme-icon');
		if (document.body.classList.contains('light-mode')) {
			icon.className = 'bi bi-sun-fill';
		} else {
			icon.className = 'bi bi-moon-fill';
		}
	}

	// ─── Modaly ───
	function openModal(id) {
		document.getElementById(id).style.display = 'flex';
	}
	function closeModal(id) {
		document.getElementById(id).style.display = 'none';
	}
	function openHelp() { openModal('help-modal'); }

	// ─── Celá obrazovka ───
	function toggleFullscreen() {
		if (!document.fullscreenElement) {
			document.documentElement.requestFullscreen();
		} else {
			document.exitFullscreen();
		}
	}

	function toggleHistory() {
		const rightPanel = document.querySelector('.right-panel');
		if (rightPanel) rightPanel.scrollTop = 0;
	}

	// ─── Toast ───
	function toast(message) {
		const el = document.getElementById('toast');
		el.textContent = message;
		el.classList.add('show');
		setTimeout(() => el.classList.remove('show'), 2500);
	}

	// ─── Stav ───
	function setStatus(text) {
		document.getElementById('status-text').textContent = text;
	}

	function updateStats(generated, exported) {
		document.getElementById('stat-generated').textContent = generated;
		document.getElementById('stat-exported').textContent = exported;
	}

	return {
		showScreen, renderGame, renderQuickView, addToHistory, clearHistory, loadHistory,
		toggleSection, toggleTheme, openModal, closeModal,
		openHelp, toggleFullscreen, toggleHistory,
		toast, setStatus, updateStats
	};
})();

// ─────────────────────────────────────────────────
// Narrator — AI vypraváč (ako Dračí Hlídka: OpenAI TTS + fallback Web Speech)
// ─────────────────────────────────────────────────
const Narrator = (() => {
	let speechSynth = null;
	let awardedForCurrent = false;
	let usePremiumTts = null;
	let localFacts = { sk: [], cs: [], en: [], es: [] };
	const FALLBACK_FACTS = {
		sk: ['Medúzy existujú na Zemi už viac ako 650 miliónov rokov – sú staršie ako dinosaury!', 'Včely komunikujú tancom.'],
		cs: ['Medúzy existují na Zemi už více než 650 milionů let – jsou starší než dinosauři!', 'Včely komunikují tancem.'],
		en: ['Jellyfish have existed on Earth for over 650 million years – older than dinosaurs!', 'Bees communicate through dance.'],
		es: ['Las medusas existen en la Tierra desde hace más de 650 millones de años.', 'Las abejas se comunican bailando.']
	};

	async function loadLocalFacts() {
		try {
			const res = await fetch('data/narrator-facts.json', { headers: ngrokHeaders() });
			if (res.ok) localFacts = await res.json();
		} catch (e) { /* optional */ }
	}

	function getRandomLocalFact(lang) {
		const arr = localFacts[lang] || localFacts.sk;
		if (arr && arr.length > 0) return arr[Math.floor(Math.random() * arr.length)];
		const fallback = FALLBACK_FACTS[lang] || FALLBACK_FACTS.sk;
		return fallback[Math.floor(Math.random() * fallback.length)];
	}

	function getLangBcp47(lang) {
		return lang === 'sk' ? 'sk-SK' : lang === 'cs' ? 'cs-CZ' : lang === 'es' ? 'es-ES' : 'en-US';
	}

	function getPreferredVoice(lang) {
		if (!speechSynth) return null;
		const voices = speechSynth.getVoices();
		const bcp = getLangBcp47(lang);
		const langCode = bcp.split('-')[0].toLowerCase();
		return voices.find(v => v.lang.toLowerCase() === bcp.toLowerCase())
			|| voices.find(v => v.lang.toLowerCase().startsWith(langCode))
			|| voices.find(v => /en/i.test(v.lang))
			|| null;
	}

	async function loadNarratorAreas() {
		const sel = document.getElementById('narrator-area');
		if (!sel) return;
		try {
			const res = await fetch('/api/narrator-areas', { headers: ngrokHeaders() });
			if (res.ok) {
				const { areas } = await res.json();
				sel.innerHTML = areas.map(a => `<option value="${a.id}">${a.name}</option>`).join('');
				return;
			}
		} catch (e) { console.warn('[Narrator] Areas API:', e); }
		try {
			const rvpRes = await fetch('data/rvp.json', { headers: ngrokHeaders() });
			if (rvpRes.ok) {
				const rvp = await rvpRes.json();
				const areas = [{ id: '', name: 'Náhodná oblasť' }];
				if (rvp.vzdelavaci_oblasti) {
					for (const [id, v] of Object.entries(rvp.vzdelavaci_oblasti)) {
						areas.push({ id, name: v.nazev });
					}
				}
				if (rvp.kompetence) {
					for (const [id, v] of Object.entries(rvp.kompetence)) {
						areas.push({ id: 'komp-' + id, name: v.nazev });
					}
				}
				if (rvp.prurezova_temata) {
					for (const [id, name] of Object.entries(rvp.prurezova_temata)) {
						areas.push({ id: 'tema-' + id, name });
					}
				}
				sel.innerHTML = areas.map(a => `<option value="${a.id}">${a.name}</option>`).join('');
			}
		} catch (e) { console.warn('[Narrator] Areas fallback:', e); }
	}

	function init() {
		speechSynth = window.speechSynthesis;
		if (speechSynth) {
			speechSynth.onvoiceschanged = () => {};
			speechSynth.getVoices();
		}
		loadLocalFacts();
		loadNarratorAreas();
		const btn = document.getElementById('narrator-bot');
		const hint = btn?.querySelector('.narrator-hint');
		if (!btn) return;
		btn.addEventListener('click', async (e) => {
			e.preventDefault();
			e.stopPropagation();
			if (hint) hint.textContent = 'Načítavam...';
			try {
				await onNarratorClick();
			} finally {
				if (hint) hint.textContent = (window.givemegame_t || ((k,f)=>f||k))('narrator_click', 'Klikni a počúvaj');
			}
		});
	}

	let playbackEndTimeout = null;
	function onPlaybackEnd(btn) {
		if (playbackEndTimeout) { clearTimeout(playbackEndTimeout); playbackEndTimeout = null; }
		if (!awardedForCurrent) {
			awardedForCurrent = true;
			try {
				if (typeof App !== 'undefined' && App?.Coins?.award) App.Coins.award('narrator_fact');
			} catch (e) { console.warn('[Narrator] Coins.award:', e); }
			GameUI.toast(`🪙 +50 gIVEMECOIN! ${(window.givemegame_t || ((k,f)=>f||k))('narrator_listened', 'Vypočutá zaujímavosť!')}`);
		}
		btn.disabled = false;
	}
	function schedulePlaybackEndSafety(btn, ms = 30000) {
		if (playbackEndTimeout) clearTimeout(playbackEndTimeout);
		playbackEndTimeout = setTimeout(() => {
			playbackEndTimeout = null;
			if (btn && btn.disabled) {
				console.warn('[Narrator] Safety timeout — re-enabling button');
				onPlaybackEnd(btn);
			}
		}, ms);
	}

	async function speakAndAward(fact, lang, btn, factEl, source = 'local') {
		if (factEl) {
			factEl.classList.remove('narrator-fact-placeholder');
			factEl.setAttribute('aria-hidden', 'true');
			factEl.innerHTML = '';
			const p = document.createElement('p');
			p.textContent = fact;
			p.style.margin = '0';
			p.setAttribute('aria-hidden', 'true');
			factEl.appendChild(p);
			const badge = document.createElement('span');
			badge.className = 'narrator-source-badge';
			badge.textContent = source === 'openai' ? '🤖 AI' : '📋 Lokál';
			badge.title = source === 'openai' ? 'Vygenerované OpenAI' : 'Lokálna zaujímavosť';
			factEl.appendChild(badge);
		}
		if (usePremiumTts !== false) {
			try {
				const TTS_TIMEOUT_MS = 8000;
				const ctrl = new AbortController();
				const to = setTimeout(() => ctrl.abort(), TTS_TIMEOUT_MS);
				const res = await fetch('/api/tts', {
					method: 'POST',
					headers: { ...ngrokHeaders(), 'Content-Type': 'application/json' },
					body: JSON.stringify({ text: fact, voice: 'marin' }),
					signal: ctrl.signal
				});
				clearTimeout(to);
				if (res.ok) {
					usePremiumTts = true;
					const blob = await res.blob();
					const url = URL.createObjectURL(blob);
					const audio = new Audio(url);
					schedulePlaybackEndSafety(btn);
					audio.onended = () => {
						URL.revokeObjectURL(url);
						onPlaybackEnd(btn);
					};
					audio.onerror = () => {
						URL.revokeObjectURL(url);
						onPlaybackEnd(btn);
					};
					await audio.play();
					return;
				}
				if (res.status === 503 || res.status === 502) usePremiumTts = false;
			} catch (err) {
				if (err?.name === 'AbortError') console.warn('[Narrator] TTS timeout — fallback na Web Speech');
				usePremiumTts = false;
			}
		}
		if (speechSynth) {
			speechSynth.cancel();
			const u = new SpeechSynthesisUtterance(fact);
			u.lang = getLangBcp47(lang);
			u.rate = 0.9;
			u.pitch = 0.82;
			const preferred = getPreferredVoice(lang);
			if (preferred) u.voice = preferred;
			schedulePlaybackEndSafety(btn);
			u.onend = () => onPlaybackEnd(btn);
			u.onerror = () => onPlaybackEnd(btn);
			speechSynth.speak(u);
		} else {
			GameUI.toast((window.givemegame_t || ((k,f)=>f||k))('narrator_no_tts', 'Tento prehliadač nepodporuje hlasový výstup.'));
			btn.disabled = false;
		}
	}

	async function onNarratorClick() {
		const btn = document.getElementById('narrator-bot');
		const factEl = document.getElementById('narrator-fact');
		if (!btn) return;
		btn.disabled = true;
		if (factEl) {
			factEl.classList.add('narrator-fact-placeholder');
			factEl.innerHTML = '<i class="bi bi-hourglass-split"></i><span>Načítavam...</span>';
		}
		awardedForCurrent = false;

		const langMap = { sk: 'sk', cs: 'cs', en: 'en', es: 'es' };
		const activeLang = document.querySelector('.btn-lang.active')?.dataset?.lang || window.givemegame_currentLang || 'cs';
		const lang = langMap[activeLang] || 'sk';
		const areaEl = document.getElementById('narrator-area');
		const area = areaEl?.value || '';
		const genZ = document.getElementById('narrator-genz')?.checked || false;

		const TIMEOUT_MS = 8000;
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

		try {
			let url = `/api/random-fact?lang=${lang}`;
			if (area) url += `&area=${encodeURIComponent(area)}`;
			if (genZ) url += '&style=genz';
			const res = await fetch(url, {
				headers: ngrokHeaders(),
				signal: controller.signal
			});
			clearTimeout(timeoutId);
			const data = await res.json().catch(() => ({}));
			let fact = data?.fact;
			const source = data?.source || 'local';
			if (!fact && !res.ok) {
				console.warn('[Narrator] API error:', res.status, data?.error);
			}
			if (!fact) fact = getRandomLocalFact(lang);
			if (!fact) throw new Error('Žiadna zaujímavosť');
			console.log('[Narrator] Zaujímavosť:', source === 'openai' ? '🤖 AI (OpenAI)' : '📋 Lokál');
			await speakAndAward(fact, lang, btn, factEl || null, source);
		} catch (err) {
			clearTimeout(timeoutId);
			console.warn('[Narrator]', err);
			const fact = getRandomLocalFact(lang);
			if (fact) {
				await speakAndAward(fact, lang, btn, factEl || null, 'local');
			} else {
				if (factEl) {
					factEl.classList.add('narrator-fact-placeholder');
					const _t = window.givemegame_t || ((k,f)=>f||k);
					factEl.innerHTML = '<i class="bi bi-exclamation-triangle"></i><span>' + (err.name === 'AbortError' ? _t('narrator_timeout', 'Čas vypršal – skús znova') : (err.message || 'Chyba')) + '</span>';
				}
				const _t = window.givemegame_t || ((k,f)=>f||k);
				GameUI.toast(err.name === 'AbortError' ? _t('narrator_timeout', 'Čas vypršal – skús znova') : (err.message || 'Chyba načítania.'));
				btn.disabled = false;
			}
		}
	}

	return { init };
})();

// ─────────────────────────────────────────────────
// App — Veřejný kontrolér
// ─────────────────────────────────────────────────
const App = (() => {
	let currentGame = null;
	let stats = { generated: 0, exported: 0 };
	let isGenerating = false;

	// ─── Inicializace ───
	async function init() {
		try {
			const raw = sessionStorage.getItem('givemegame_user');
			const u = raw ? JSON.parse(raw) : null;
			if (u?.uid === 'guest') sessionStorage.removeItem('givemegame_user');
		} catch (e) {}
		await syncAuthFromSupabase();
		supabaseClient?.auth.onAuthStateChange((event, session) => {
			if ((event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && session?.user) {
				syncAuthFromSupabase();
			}
		});

		await GameData.load();
		await Coins.load();
		await loadQuestLog();
		bindKeyboard();
		bindModalClicks();
		bindLangButtons();
		Narrator.init();
		setMode('party'); // Výchozí režim
		await setLang(currentLang); // Načíst a aplikovat překlady

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
	async function generate(costAction = 'generate') {
		if (isGenerating) return;

		// Check if player can afford the generation cost
		if (!Coins.canAfford(costAction)) {
			GameUI.toast(`🪙 ${t('not_enough_coins', 'Nedostatek coinů!')} (${Coins.getCost(costAction)} potřeba, máš ${Coins.getBalance()})`);
			return;
		}

		isGenerating = true;

		// Deduct coins immediately
		Coins.spend(costAction);

		const btn = document.getElementById('btn-generate');
		const btnText = document.getElementById('generate-text');
		btn.classList.add('generating');
		btnText.textContent = t('status_generating', 'GENERATING...');
		GameUI.setStatus(t('status_generating', 'GENERATING...'));

		GameUI.showScreen('loading');

		try {
			const filters = getFilters();
			const game = await GameAPI.generateGame(filters);
			currentGame = game;
			stats.generated++;

			await new Promise(r => setTimeout(r, 1300));

			GameUI.renderGame(game);
			GameUI.renderQuickView(game);
			GameUI.addToHistory(game);
			saveQuestLogEntry(game);
			GameUI.updateStats(stats.generated, stats.exported);
			GameUI.setStatus(t('status_game_ready', 'GAME READY'));

			// Setup timer based on game duration
			Timer.setup(game.duration);
		} catch (err) {
			console.error('[App] Generování selhalo:', err);
			GameUI.showScreen('welcome');

			// Chyba — ale vďaka fallbacku v GameAPI sa sem dostaneme len zriedka
			let errorMsg = t('status_error', 'ERROR') + ' — ' + err.message;

			GameUI.toast(errorMsg);
			GameUI.setStatus(t('status_error', 'ERROR'));
		} finally {
			isGenerating = false;
			btn.classList.remove('generating');
			btnText.textContent = t('generate', 'GENERATE GAME');
		}
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

	// ─── Timer modul ───
	const Timer = (() => {
		let timerId = null;
		let totalSeconds = 0;
		let remainingSeconds = 0;

		function setup(duration) {
			// duration = { min: X, max: Y } — use max as countdown
			const block = document.getElementById('game-timer-block');
			const display = document.getElementById('timer-display');
			const btn = document.getElementById('btn-timer-ready');
			const status = document.getElementById('timer-status');
			if (!block) return;

			// Clear any running timer
			stop();

			const minutes = (duration && duration.max) || 15;
			totalSeconds = minutes * 60;
			remainingSeconds = totalSeconds;

			display.textContent = formatTime(remainingSeconds);
			display.className = 'timer-display';
			btn.disabled = false;
			btn.style.display = '';
			status.textContent = t('timer_waiting', '⏳ Press READY to start');
			block.style.display = '';
		}

		function start() {
			if (timerId || remainingSeconds <= 0) return;

			const btn = document.getElementById('btn-timer-ready');
			const status = document.getElementById('timer-status');
			if (btn) { btn.disabled = true; btn.style.display = 'none'; }
			if (status) status.textContent = t('timer_running', '🔥 Game in progress...');

			GameUI.toast(`⏱️ ${t('timer_started', 'Timer started!')} — ${formatTime(remainingSeconds)}`);

			timerId = setInterval(tick, 1000);
		}

		function tick() {
			remainingSeconds--;
			const display = document.getElementById('timer-display');

			if (remainingSeconds <= 0) {
				complete();
				return;
			}

			if (display) {
				display.textContent = formatTime(remainingSeconds);

				// Color transitions: green → yellow → red
				const pct = remainingSeconds / totalSeconds;
				display.className = 'timer-display' +
					(pct <= 0.15 ? ' timer-critical' :
					 pct <= 0.35 ? ' timer-warning' : '');
			}
		}

		function complete() {
			stop();
			const display = document.getElementById('timer-display');
			const status = document.getElementById('timer-status');
			if (display) {
				display.textContent = '🏆 GG!';
				display.className = 'timer-display timer-done';
			}
			if (status) status.textContent = t('timer_complete', '✅ Game over! Coins awarded.');

			// Award coins for completing the timer
			Coins.award('timer');
			GameUI.toast(`🪙 ${t('coin_awarded', '+10 gIVEMECOIN!')}`);
		}

		function stop() {
			if (timerId) {
				clearInterval(timerId);
				timerId = null;
			}
		}

		function formatTime(sec) {
			const m = Math.floor(sec / 60);
			const s = sec % 60;
			return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
		}

		return { setup, start, stop };
	})();

	// ─── Supabase + Auth (pre Coins sync + gIVEME account) ───
	const SUPABASE_URL = 'https://vhpkkbixshfyytohkruv.supabase.co';
	const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZocGtrYml4c2hmeXl0b2hrcnV2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMxMDAzNzcsImV4cCI6MjA4ODY3NjM3N30.umrrhSqC9LW2Wlcs5y4uCViVfZmqyHcMbaPQaQiMbR0';
	let supabaseClient = null;
	try {
		if (window.supabase) {
			supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
				auth: { detectSessionInUrl: true, persistSession: true }
			});
		}
	} catch (e) { console.warn('[Auth] Supabase init failed:', e); }

	function getCurrentUser() {
		try {
			const raw = sessionStorage.getItem('givemegame_user');
			const u = raw ? JSON.parse(raw) : null;
			return u?.uid && u.uid !== 'guest' ? u : null;
		} catch { return null; }
	}

	// Sync Supabase session → sessionStorage (každý používateľ má svoj gIVEME účet)
	async function syncAuthFromSupabase() {
		if (!supabaseClient) return;
		try {
			const { data: { session } } = await supabaseClient.auth.getSession();
			if (session?.user) {
				const user = {
					uid: session.user.id,
					name: session.user.user_metadata?.full_name || session.user.email?.split('@')[0] || 'Player',
					email: session.user.email,
					photo: session.user.user_metadata?.avatar_url || null
				};
				sessionStorage.setItem('givemegame_user', JSON.stringify(user));
				// Ulož/aktualizuj profil v Supabase
				await supabaseClient.from('profiles').upsert({
					id: session.user.id,
					display_name: user.name,
					avatar_url: user.photo,
					updated_at: new Date().toISOString()
				}, { onConflict: 'id' });
				console.log('[Auth] Session synced — gIVEME účet:', user.name);
				return user;
			}
		} catch (e) { console.warn('[Auth] syncAuthFromSupabase:', e); }
		return null;
	}

	// ─── Coin systém — gIVEMECOIN (localStorage = hlavný zdroj, Supabase = sync pre prihlásených) ───
	const Coins = (() => {
		const STORAGE_KEY = 'givemegame_coins';
		let balance = 0;

		const rewards = {
			timer: 500,
			robot_challenge: 250,
			mode_click: 1,
			tamagochi_coin: 1,
			phone_buzz: 5,
			narrator_fact: 50   // AI vypraváč — vypočuj si zaujímavosť
		};

		const costs = {
			generate: 125,
			surprise: 50
		};

		async function load() {
			// 1. VŽDY načítaj z localStorage (pretrvá pri refreshi)
			let fromStorage = Math.max(0, parseInt(localStorage.getItem(STORAGE_KEY)) || 0);
			if (fromStorage === 0 && !localStorage.getItem(STORAGE_KEY + '_init')) {
				fromStorage = 150;
				localStorage.setItem(STORAGE_KEY, '150');
				localStorage.setItem(STORAGE_KEY + '_init', '1');
			}

			const user = getCurrentUser();
			if (user && user.uid !== 'guest' && supabaseClient) {
				try {
					const { data } = await supabaseClient.from('profiles').select('coins').eq('id', user.uid).single();
					const fromSupabase = Math.max(0, parseInt(data?.coins) || 0);
					balance = Math.max(fromSupabase, fromStorage);
					if (balance > fromSupabase) save();
				} catch (e) {
					balance = fromStorage;
				}
			} else {
				balance = fromStorage;
			}
			updateDisplay();
		}

		function save() {
			// 1. VŽDY ulož do localStorage (okamžite — pretrvá pri refreshi)
			try { localStorage.setItem(STORAGE_KEY, String(balance)); } catch (e) {}

			const user = getCurrentUser();
			if (user && user.uid !== 'guest' && supabaseClient) {
				supabaseClient.from('profiles').upsert({
					id: user.uid,
					coins: balance,
					display_name: user.name || null,
					avatar_url: user.photo || null,
					updated_at: new Date().toISOString()
				}, { onConflict: 'id' }).then(() => {}).catch(() => {});
			}
		}

		function award(source) {
			const amount = rewards[source] || 1;
			balance += amount;
			save();
			updateDisplay();

			// Pop animation
			const display = document.getElementById('coin-display');
			if (display) {
				display.classList.remove('coin-awarded');
				void display.offsetWidth; // Force reflow
				display.classList.add('coin-awarded');
			}

			// Coin sound (short retro "pling")
			playCoinSound();

			console.log(`[Coins] +${amount} (${source}) → balance: ${balance}`);
		}

		// ─── Mode-specific coin sound profiles ───
		const coinSoundProfiles = {
			party: {
				type: 'square',      // 8-bit arcade vibe
				notes: [987.77, 1318.51, 1567.98],  // B5→E6→G6 (major fanfare)
				step: 0.06, volume: 0.08, duration: 0.25
			},
			classroom: {
				type: 'triangle',    // Soft school-bell chime
				notes: [523.25, 659.25, 783.99],     // C5→E5→G5 (clean major triad)
				step: 0.07, volume: 0.10, duration: 0.30
			},
			reflection: {
				type: 'sine',        // Warm singing-bowl tone
				notes: [440, 554.37, 659.25],        // A4→C#5→E5 (gentle A-major)
				step: 0.10, volume: 0.07, duration: 0.40
			},
			circus: {
				type: 'sawtooth',    // Whimsical calliope organ
				notes: [783.99, 987.77, 1174.66, 1318.51], // G5→B5→D6→E6 (playful run)
				step: 0.05, volume: 0.06, duration: 0.28
			},
			cooking: {
				type: 'triangle',    // Kitchen timer ding
				notes: [1046.50, 1318.51, 1046.50],  // C6→E6→C6 (ding-ding-ding)
				step: 0.06, volume: 0.09, duration: 0.25
			},
			meditation: {
				type: 'sine',        // Zen bowl — slow, deep, resonant
				notes: [293.66, 349.23],             // D4→F4 (minor second, contemplative)
				step: 0.15, volume: 0.06, duration: 0.55
			}
		};

		let _sharedAudioContext = null;
		function getSharedAudioContext() {
			if (!_sharedAudioContext) _sharedAudioContext = new (window.AudioContext || window.webkitAudioContext)();
			return _sharedAudioContext;
		}
		function playCoinSound() {
			try {
				const profiles = Object.values(coinSoundProfiles);
				const profile = profiles[Math.floor(Math.random() * profiles.length)];
				const ac = getSharedAudioContext();
				const osc = ac.createOscillator();
				const gain = ac.createGain();
				osc.connect(gain);
				gain.connect(ac.destination);

				osc.type = profile.type;

				// Schedule note sequence
				profile.notes.forEach((freq, i) => {
					osc.frequency.setValueAtTime(freq, ac.currentTime + i * profile.step);
				});

				gain.gain.setValueAtTime(profile.volume, ac.currentTime);
				gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + profile.duration);

				osc.start(ac.currentTime);
				osc.stop(ac.currentTime + profile.duration);
			} catch {}
		}

		function updateDisplay() {
			const el = document.getElementById('coin-count');
			if (el) el.textContent = balance;
		}

		function spend(action) {
			const cost = costs[action] || 0;
			if (cost <= 0) return true;
			if (balance < cost) return false;
			balance -= cost;
			save();
			updateDisplay();
			console.log(`[Coins] -${cost} (${action}) → balance: ${balance}`);
			return true;
		}

		function canAfford(action) {
			const cost = costs[action] || 0;
			return balance >= cost;
		}

		function getCost(action) {
			return costs[action] || 0;
		}

		function getBalance() { return balance; }

		function spendAmount(amount) {
			const amt = parseInt(amount) || 0;
			if (amt <= 0 || balance < amt) return false;
			balance -= amt;
			save();
			updateDisplay();
			return true;
		}

		return { load, award, spend, spendAmount, canAfford, getCost, getBalance };
	})();

	// ─── Quest Log (per používateľ, nikdy sa nemazá) ───
	async function loadQuestLog() {
		const user = getCurrentUser();
		if (!user || !supabaseClient) return;
		try {
			const { data: rows, error } = await supabaseClient
				.from('quest_log')
				.select('game_data')
				.eq('user_id', user.uid)
				.order('created_at', { ascending: false })
				.limit(100);
			if (error) throw error;
			const games = (rows || []).map(r => r.game_data).filter(Boolean);
			if (games.length > 0) GameUI.loadHistory(games);
		} catch (e) { console.warn('[QuestLog] load:', e); }
	}

	async function saveQuestLogEntry(game) {
		const user = getCurrentUser();
		if (!user || !supabaseClient) return;
		try {
			await supabaseClient.from('quest_log').insert({
				user_id: user.uid,
				game_data: game
			});
		} catch (e) { console.warn('[QuestLog] save:', e); }
	}

	// ─── Jazyk / i18n ───
	let currentLang = 'cs';
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
		document.querySelectorAll('.btn-lang').forEach(btn => {
			btn.classList.toggle('active', btn.dataset.lang === lang);
		});
		document.documentElement.lang = lang;
		console.log(`[App] Jazyk: ${lang}`);

		const translations = await loadTranslations(lang);
		applyTranslations(translations);

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
			switchTab('giveme');
			GameUI.openModal('profile-modal');
		}

		async function logout() {
			try {
				if (supabaseClient) await supabaseClient.auth.signOut();
			} catch (e) { console.warn('[Profile] signOut:', e); }
			sessionStorage.removeItem('givemegame_user');
			GameUI.closeModal('profile-modal');
			window.location.href = 'index.html';
		}

		function switchTab(tab) {
			document.querySelectorAll('.profile-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
			document.getElementById('profile-tab-profil').style.display = tab === 'profil' ? 'block' : 'none';
			document.getElementById('profile-tab-giveme').style.display = tab === 'giveme' ? 'block' : 'none';

			const modalBox = document.querySelector('#profile-modal .modal-box');
			if (modalBox) modalBox.classList.toggle('profile-modal-giveme', tab === 'giveme');

			if (tab === 'profil') {
				const coinsEl = document.getElementById('profile-coins');
				if (coinsEl) coinsEl.textContent = Coins.getBalance();
			}

			if (tab === 'giveme') {
				const iframe = document.getElementById('giveme-iframe');
				if (iframe) syncGivemeIframe(iframe);
			}
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

	// ─── Veřejné API ───
	return {
		init,
		generate,
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
		Filters,
		RobotChallenge,
		Profile,
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
	if (e.data?.type === 'tamagochi_coin') {
		const iframe = document.getElementById('tamagochi-iframe');
		if (iframe && e.source === iframe.contentWindow && App?.Coins?.award) {
			App.Coins.award('tamagochi_coin');
		}
	}
});

// ─── Spuštění ───
document.addEventListener('DOMContentLoaded', () => App.init());
