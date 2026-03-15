/* ═══════════════════════════════════════════════════════════════════
   gIVEMEGAME.IO — GameUI module (extracted from script.js Phase 3.3)

   Dependencies (globals resolved at call-time, not load-time):
     • GameData       — declared in game-data.js (shared global scope)

   Exposes: window.GameUI  (also visible as global `const GameUI`)
   ═══════════════════════════════════════════════════════════════════ */

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

		// Rating widget — create once, update on every renderGame
		let ratingEl = document.getElementById('game-rating-widget');
		if (!ratingEl) {
			ratingEl = document.createElement('div');
			ratingEl.id = 'game-rating-widget';
			ratingEl.className = 'game-rating-widget';
			const footer = document.querySelector('.game-card-footer');
			if (footer) footer.insertAdjacentElement('beforebegin', ratingEl);
		}
		_renderRatingWidget(ratingEl, game._savedId || null, game._currentRating || 0);

		showScreen('game');
	}

	function _renderRatingWidget(el, savedId, currentRating) {
		const active = !!savedId;
		el.dataset.savedId = savedId || '';
		el.dataset.pendingRating = '';
		const stars = [1, 2, 3, 4, 5].map(n =>
			`<button class="star-btn${n <= currentRating ? ' active' : ''}"
			         data-star="${n}" ${active ? '' : 'disabled'} aria-label="${n} stars">★</button>`
		).join('');
		el.innerHTML = `
			<span class="rating-label">${active ? 'Ohodnoť hru' : 'Uložte hru pre hodnotenie'}</span>
			<div class="rating-stars">${stars}</div>
			<div class="rating-feedback${currentRating > 0 ? '' : ' hidden'}">
				<textarea class="rating-text" placeholder="Voliteľná spätná väzba..." maxlength="500" rows="2"></textarea>
				<button class="btn btn-retro btn-xs" onclick="App.Library._submitRating()">Odoslať</button>
			</div>
		`;
		if (active) {
			el.querySelectorAll('.star-btn').forEach(btn => {
				btn.addEventListener('click', () => {
					const n = parseInt(btn.dataset.star, 10);
					el.dataset.pendingRating = n;
					el.querySelectorAll('.star-btn').forEach((b, i) => b.classList.toggle('active', i < n));
					el.querySelector('.rating-feedback')?.classList.remove('hidden');
				});
			});
		}
	}

	function renderRvpSection(game) {
		const rvp = GameData.getRvp();
		const gameRvp = game.rvp;

		if (!rvp || !gameRvp) {
			const sectionEl = document.getElementById('section-rvp');
			if (sectionEl) sectionEl.innerHTML = '<p style="opacity:0.5;font-size:14px;">RVP data nejsou k dispozici</p>';
			// Mark parent collapsible so @media print can hide the whole section
			const collapsibleEl = sectionEl?.closest('.collapsible');
			if (collapsibleEl) collapsibleEl.dataset.rvpEmpty = '1';
			return;
		}

		// Klíčové kompetence
		const kompEl = document.getElementById('rvp-kompetence');
		if (!kompEl) return;
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
		const stupenKeys = Array.isArray(gameRvp.stupen) ? gameRvp.stupen : (gameRvp.stupen ? [gameRvp.stupen] : []);
		stupenKeys.forEach(key => {
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
		const hodnoceniKeys = Array.isArray(gameRvp.doporucene_hodnoceni) ? gameRvp.doporucene_hodnoceni : (gameRvp.doporucene_hodnoceni ? [gameRvp.doporucene_hodnoceni] : []);
		hodnoceniKeys.forEach(id => {
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

	// ─── Mobile overlays ───
	function toggleMobileFilters() {
		document.body.classList.toggle('mobile-filters-open');
		if (document.body.classList.contains('mobile-filters-open')) {
			document.body.classList.remove('mobile-smarta-open');
		}
	}
	function toggleMobileSmarta() {
		document.body.classList.toggle('mobile-smarta-open');
		if (document.body.classList.contains('mobile-smarta-open')) {
			document.body.classList.remove('mobile-filters-open');
		}
	}
	function closeMobileOverlays() {
		document.body.classList.remove('mobile-filters-open', 'mobile-smarta-open');
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

	// ─── Competency stats panel ───
	// Colors match rvp.json kompetence barva values exactly.
	// Labels resolved at render-time via _t() so language changes are respected.
	const _t = (key, fallback) => (window.givemegame_t || ((k, f) => f || k))(key, fallback);

	const COMP_META = {
		'k-uceni':             { labelKey: 'comp_learning',  labelFb: 'K učeniu',        color: '#4A90D9', icon: 'bi-book' },
		'k-reseni-problemu':   { labelKey: 'comp_problem',   labelFb: 'K riešeniu prob.', color: '#E8A838', icon: 'bi-puzzle' },
		'komunikativni':       { labelKey: 'comp_comm',      labelFb: 'Komunikatívna',    color: '#50C878', icon: 'bi-chat-dots' },
		'socialni-personalni': { labelKey: 'comp_social',    labelFb: 'Sociálna',         color: '#E84C8B', icon: 'bi-people' },
		'obcanske':            { labelKey: 'comp_civic',     labelFb: 'Občianska',        color: '#8B5CF6', icon: 'bi-flag' },
		'pracovni':            { labelKey: 'comp_work',      labelFb: 'Pracovná',         color: '#F97316', icon: 'bi-tools' },
		'digitalni':           { labelKey: 'comp_digital',   labelFb: 'Digitálna',        color: '#06B6D4', icon: 'bi-laptop' }
	};

	function renderCompetencies(pointsOrEnriched) {
		const panel = document.getElementById('competency-panel');
		const bars  = document.getElementById('competency-bars');
		if (!bars) return;

		const allKeys = Object.keys(COMP_META);

		// Support both raw {key: number} and enriched {key: {points, level, progress_pct}} formats
		const getEntry = k => {
			const v = pointsOrEnriched[k];
			if (typeof v === 'object' && v !== null) return v;
			const p = parseInt(v, 10) || 0;
			return { points: p, level: null, progress_pct: 0 };
		};

		const hasAny = allKeys.some(k => getEntry(k).points > 0);
		if (!hasAny) {
			if (panel) panel.style.display = 'none';
			return;
		}

		const panelHeadingSpan = panel?.querySelector('.panel-heading span');
		if (panelHeadingSpan) panelHeadingSpan.textContent = _t('comp_panel_title', 'Kompetencie');

		const wasHidden = panel?.style.display === 'none' || !panel?.style.display;
		if (panel) panel.style.display = '';

		bars.innerHTML = '';
		allKeys.forEach(key => {
			const entry = getEntry(key);
			const meta  = COMP_META[key];
			const label = _t(meta.labelKey, meta.labelFb);
			const levelLabel = entry.level ? ` · ${entry.level}` : '';

			const row = document.createElement('div');
			row.className = 'comp-row';
			row.innerHTML = `
				<div class="comp-label">
					<i class="bi ${meta.icon}" style="color:${meta.color}"></i>
					<span>${label}</span>
				</div>
				<div class="comp-bar-wrap">
					<div class="comp-bar" style="width:${entry.progress_pct}%;background:${meta.color}"></div>
				</div>
				<span class="comp-val">${entry.points}${levelLabel}</span>`;
			bars.appendChild(row);
		});

		// animationend listener (once:true) avoids coupling JS timeout to CSS duration.
		if (panel && wasHidden) {
			panel.classList.add('comp-panel-flash');
			panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
			panel.addEventListener('animationend', () => panel.classList.remove('comp-panel-flash'), { once: true });
		}
	}

	// ─── Profile modal competency view ───
	// Full "character sheet" — all 6 competencies, level + XP bar within bracket.
	// Accepts enriched {key:{points,level,progress_pct,next_threshold}} or raw {key:number}.
	function renderProfileCompetencies(container, enriched) {
		if (!container) return;
		container.innerHTML = '';
		Object.keys(COMP_META).forEach(key => {
			const raw  = enriched[key];
			const isEnriched = typeof raw === 'object' && raw !== null;
			const pts  = isEnriched ? (raw.points || 0) : (parseInt(raw, 10) || 0);
			const pct  = isEnriched ? (raw.progress_pct ?? 0) : 0;
			const level = isEnriched ? (raw.level || '') : '';
			const next  = isEnriched ? raw.next_threshold : null;
			const meta  = COMP_META[key];
			const label = _t(meta.labelKey, meta.labelFb);

			const row = document.createElement('div');
			row.className = 'comp-row profile-comp-row';
			row.innerHTML = `
				<div class="comp-label profile-comp-label">
					<i class="bi ${meta.icon}" style="color:${meta.color}"></i>
					<span>${label}</span>
				</div>
				<div class="profile-comp-right">
					<div class="profile-comp-meta">
						<span class="profile-comp-pts">${pts}</span>
						${level ? `<span class="profile-comp-level" style="color:${meta.color}">${level}</span>` : ''}
						${next  ? `<span class="profile-comp-next">→ ${next}</span>` : ''}
					</div>
					<div class="comp-bar-wrap">
						<div class="comp-bar" style="width:${pct}%;background:${meta.color}"></div>
					</div>
				</div>`;
			container.appendChild(row);
		});
	}

	function activateRating(savedId, currentRating) {
		const el = document.getElementById('game-rating-widget');
		if (el) _renderRatingWidget(el, savedId, currentRating || 0);
	}

	// ─── Level-up feedback panel ───
	// Shows a slide-in panel after game completion with per-competency point gains.
	// levelChanges: { [compKey]: { previous_points, new_points, from_level, to_level, leveled_up } }
	function showLevelUpFeedback(levelChanges) {
		if (!levelChanges || !Object.keys(levelChanges).length) return;

		const existing = document.getElementById('levelup-feedback');
		if (existing) existing.remove();

		// Filter to only competencies where points were actually gained
		const gained = Object.entries(levelChanges).filter(([, c]) => c.new_points > c.previous_points);
		if (!gained.length) return;

		const panel = document.createElement('div');
		panel.id = 'levelup-feedback';
		panel.className = 'levelup-panel';

		panel.innerHTML = `
			<div class="levelup-panel-header">
				<span>${_t('levelup_title', '🧠 Kompetencie')}</span>
				<button class="levelup-close" onclick="document.getElementById('levelup-feedback')?.remove()">✕</button>
			</div>
			<div class="levelup-list"></div>`;

		const list = panel.querySelector('.levelup-list');
		let hasLevelUp = false;
		gained.forEach(([key, change], i) => {
			const meta = COMP_META[key];
			if (!meta) return;
			const pts    = change.new_points - change.previous_points;
			const label  = _t(meta.labelKey, meta.labelFb);
			const lvlTxt = change.leveled_up
				? `${change.from_level} → ${change.to_level} <span class="levelup-badge">${_t('levelup_badge', '▲ Level Up!')}</span>`
				: change.to_level;
			if (change.leveled_up) hasLevelUp = true;

			const row = document.createElement('div');
			row.className = 'levelup-row' + (change.leveled_up ? ' leveled-up' : '');
			row.style.animationDelay = `${i * 100}ms`;
			row.innerHTML = `
				<i class="bi ${meta.icon} levelup-icon" style="color:${meta.color}"></i>
				<span class="levelup-name">${label}</span>
				<span class="levelup-pts">+${pts} ${_t('levelup_pts', 'b.')}</span>
				<span class="levelup-level">${lvlTxt}</span>`;
			list.appendChild(row);
		});

		document.body.appendChild(panel);
		if (hasLevelUp && window.SFX) SFX.play('levelup');
		// Auto-dismiss after 10 s
		setTimeout(() => { if (document.getElementById('levelup-feedback') === panel) panel.remove(); }, 10000);
	}

	return {
		showScreen, renderGame, renderQuickView, addToHistory, clearHistory, loadHistory,
		toggleSection, toggleTheme, openModal, closeModal,
		openHelp, toggleFullscreen, toggleHistory,
		toggleMobileFilters, toggleMobileSmarta, closeMobileOverlays,
		toast, setStatus, updateStats, renderCompetencies, renderProfileCompetencies,
		activateRating, showLevelUpFeedback
	};
})();

// Expose globally so scripts loaded after this one can reference window.GameUI
window.GameUI = GameUI;
