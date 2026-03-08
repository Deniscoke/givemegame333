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

// ─────────────────────────────────────────────────
// GameAPI — Směrovač generování
// ─────────────────────────────────────────────────
const GameAPI = (() => {
	let engineMode = 'local';

	async function generateGame(filters) {
		if (engineMode === 'ai') {
			return await generateWithAI(filters);
		}
		return generateLocally(filters);
	}

	async function generateWithAI(filters) {
		console.warn('[GameAPI] AI režim je mockovaný. Používám lokální generátor.');
		await new Promise(resolve => setTimeout(resolve, 800));
		return generateLocally(filters);
	}

	function generateLocally(filters) {
		return GameData.generate(filters);
	}

	function setMode(mode) {
		engineMode = mode;
		console.log(`[GameAPI] Režim enginu: ${mode}`);
	}

	function getMode() {
		return engineMode;
	}

	return { generateGame, generateWithAI, generateLocally, setMode, getMode };
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
		showScreen, renderGame, renderQuickView, addToHistory,
		toggleSection, toggleTheme, openModal, closeModal,
		openHelp, toggleFullscreen, toggleHistory,
		toast, setStatus, updateStats
	};
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
		await GameData.load();
		bindKeyboard();
		bindModalClicks();
		GameUI.setStatus('PŘIPRAVEN');
		console.log('[App] gIVEMEGAME.IO inicializováno.');
	}

	// ─── Sběr filtrů ───
	function getFilters() {
		return {
			ageMin: document.getElementById('filter-age-min').value,
			ageMax: document.getElementById('filter-age-max').value,
			players: document.getElementById('filter-players').value,
			duration: document.getElementById('filter-duration').value,
			setting: getActiveSetting(),
			stupen: document.getElementById('filter-stupen').value,
			kompetence: document.getElementById('filter-kompetence').value,
			oblast: document.getElementById('filter-oblast').value
		};
	}

	function getActiveSetting() {
		if (document.getElementById('setting-indoor').classList.contains('active')) return 'indoor';
		if (document.getElementById('setting-outdoor').classList.contains('active')) return 'outdoor';
		return 'any';
	}

	// ─── Generování ───
	async function generate() {
		if (isGenerating) return;
		isGenerating = true;

		const btn = document.getElementById('btn-generate');
		const btnText = document.getElementById('generate-text');
		btn.classList.add('generating');
		btnText.textContent = 'GENERUJI...';
		GameUI.setStatus('GENERUJI...');

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
			GameUI.updateStats(stats.generated, stats.exported);
			GameUI.setStatus('HRA PŘIPRAVENA');
		} catch (err) {
			console.error('[App] Generování selhalo:', err);
			GameUI.showScreen('welcome');
			GameUI.toast('Generování selhalo. Zkuste to znovu!');
			GameUI.setStatus('CHYBA');
		} finally {
			isGenerating = false;
			btn.classList.remove('generating');
			btnText.textContent = 'GENEROVAT HRU';
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

		await generate();
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
		GameUI.toast(`Exportováno jako ${format.toUpperCase()}!`);
	}

	function copyGame() {
		if (!currentGame) return;
		const text = gameToText(currentGame);
		navigator.clipboard.writeText(text).then(() => {
			GameUI.toast('Hra zkopírována do schránky!');
		}).catch(() => {
			GameUI.toast('Kopírování selhalo — zkuste export.');
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
			if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;

			if (e.key === ' ' || e.key === 'Enter') {
				e.preventDefault();
				generate();
			} else if (e.key === 's' || e.key === 'S') {
				surprise();
			} else if (e.key === 't' || e.key === 'T') {
				GameUI.toggleTheme();
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

	// ─── Veřejné API ───
	return {
		init,
		generate,
		surprise,
		exportGame,
		exportAs,
		copyGame,
		Filters,
		UI: GameUI,
		API: GameAPI,
		Data: GameData
	};
})();


// ─── Spuštění ───
document.addEventListener('DOMContentLoaded', () => App.init());
