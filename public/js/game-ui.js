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

	// ─── RPG stats (aligned with rpg-screen.js / GET /api/rpg/talents) ───
	const RPG_STAT_META = {
		insight:       { labelKey: 'rpg_stat_insight',       labelFb: 'Insight',       icon: '🔍', color: '#7dd3fc' },
		focus:         { labelKey: 'rpg_stat_focus',         labelFb: 'Focus',         icon: '🎯', color: '#a5f3fc' },
		creativity:    { labelKey: 'rpg_stat_creativity',    labelFb: 'Creativity',    icon: '🎨', color: '#f9a8d4' },
		resilience:    { labelKey: 'rpg_stat_resilience',    labelFb: 'Resilience',    icon: '🛡️', color: '#86efac' },
		communication: { labelKey: 'rpg_stat_communication', labelFb: 'Communication', icon: '💬', color: '#fde68a' },
		strategy:      { labelKey: 'rpg_stat_strategy',      labelFb: 'Strategy',      icon: '♟️', color: '#c4b5fd' },
	};

	/** Pravý panel / SMARTA — kompaktný RPG postup (namiesto kompetenčných barov). */
	function renderRpgHudFromTalents(data) {
		const panel = document.getElementById('competency-panel');
		const bars = document.getElementById('competency-bars');
		if (!panel || !bars) return;

		const panelHeadingSpan = panel.querySelector('.panel-heading span');
		if (panelHeadingSpan) panelHeadingSpan.textContent = _t('rpg_hud_title', '⚔️ RPG postup');

		if (!data || !data.progression) {
			panel.style.display = 'none';
			return;
		}

		const prog = data.progression;
		const xpLabel = prog.xpToNext
			? `${prog.xp.toLocaleString()} / ${prog.xpToNext.toLocaleString()} XP`
			: `${prog.xp.toLocaleString()} XP — MAX`;
		const wasHidden = panel.style.display === 'none' || !panel.style.display;
		panel.style.display = '';
		bars.innerHTML = `
			<div class="rpg-hud-compact">
				<div class="rpg-hud-compact-row">
					<span class="rpg-hud-lv">${_t('rpg_level_short', 'Lv.')} ${prog.level}</span>
					<span class="rpg-hud-xp-mini">${xpLabel}</span>
				</div>
				<div class="rpg-hud-xpbar-wrap" title="${prog.progressPct ?? 0}%">
					<div class="rpg-hud-xpbar" style="width:${prog.progressPct ?? 0}%"></div>
				</div>
				<button type="button" class="btn btn-retro rpg-hud-open-btn" onclick="window.RpgScreen && RpgScreen.open()">
					${_t('rpg_open_profile', '⚔️ Otvoriť RPG profil')}
				</button>
				${!data.eligible ? `<p class="rpg-hud-hint">${_t('rpg_hud_need_school', 'Pre talent tree a plné štatistiky sa zapoj do školy cez gIVEMEEDU.')}</p>` : ''}
			</div>`;

		if (wasHidden) {
			panel.classList.add('comp-panel-flash');
			panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
			panel.addEventListener('animationend', () => panel.classList.remove('comp-panel-flash'), { once: true });
		}
	}

	/** Zachované meno pre staršie volania — vždy použije posledné načítané /api/rpg/talents. */
	function renderCompetencies(_legacy) {
		void _legacy;
		renderRpgHudFromTalents(window.__lastRpgTalentsData || null);
	}

	/** Modal gIVEME → záložka Profil — rovnaké štatistiky ako v RPG (Postup + 6 atribútov). */
	function renderProfileRpgBlock(container, data) {
		if (!container) return;
		if (!data || !data.progression) {
			container.innerHTML = `<p class="profile-rpg-muted">${_t('profile_rpg_load', 'Načítaj RPG údaje…')}</p>`;
			return;
		}

		const prog = data.progression;
		const stats = data.stats || {};
		const base = stats.base || {};
		const bonuses = stats.bonuses || {};
		const effective = stats.effective || {};
		const hasClass = Boolean(data.class_id);

		const xpLine = prog.xpToNext
			? `${prog.xp.toLocaleString()} / ${prog.xpToNext.toLocaleString()} XP`
			: `${prog.xp.toLocaleString()} XP — MAX LEVEL`;
		const needXp = prog.xpToNext ? Math.max(0, prog.xpToNext - prog.xp) : 0;

		const statRows = Object.entries(RPG_STAT_META).map(([key, meta]) => {
			const eff = effective[key] || 0;
			const bon = bonuses[key] || 0;
			const barW = hasClass ? Math.min(100, Math.round(eff / 20 * 100)) : 0;
			const bonHtml = bon > 0 ? `<span class="rpg-stat-bonus">+${bon}</span>` : '';
			const label = _t(meta.labelKey, meta.labelFb);
			return `
				<div class="profile-rpg-stat-row">
					<span class="profile-rpg-stat-ic">${meta.icon}</span>
					<span class="profile-rpg-stat-name">${label}</span>
					<div class="profile-rpg-stat-bar-wrap">
						<div class="profile-rpg-stat-bar" style="width:${barW}%;background:${meta.color}"></div>
					</div>
					<span class="profile-rpg-stat-val">${eff}${bonHtml}</span>
				</div>`;
		}).join('');

		container.innerHTML = `
			<section class="profile-rpg-block">
				<h4 class="profile-rpg-subtitle">${_t('rpg_section_progress', '⚡ Postup')}</h4>
				<div class="profile-rpg-level-row">
					<span class="profile-rpg-badge">${_t('rpg_level_word', 'Level')} ${prog.level}</span>
					<span class="profile-rpg-xp-line">${xpLine}</span>
				</div>
				<div class="profile-rpg-xpbar-wrap"><div class="profile-rpg-xpbar" style="width:${prog.progressPct ?? 0}%"></div></div>
				${prog.xpToNext
					? `<p class="profile-rpg-xp-hint">${_t('rpg_need_xp', 'Do ďalšieho levelu chýba {n} XP').replace('{n}', needXp.toLocaleString())}</p>`
					: `<p class="profile-rpg-xp-hint">${_t('rpg_max_level', 'Maximálny level!')}</p>`}

				<h4 class="profile-rpg-subtitle">${_t('rpg_section_stats', '📊 Atribúty postavy')}</h4>
				${!hasClass
					? `<p class="profile-rpg-muted">${_t('profile_rpg_pick_avatar', 'Vyber si RPG avatara v plnom RPG profile — potom sa zobrazia základné hodnoty triedy a bonusy z talentov.')}</p>`
					: ''}
				<div class="profile-rpg-stat-list">${statRows}</div>
				${hasClass && Object.values(bonuses).some(v => v > 0)
					? `<p class="profile-rpg-bonus-note">${_t('rpg_bonus_note', 'Zelené + sú bonusy z talent tree.')}</p>`
					: ''}
			</section>`;
	}

	/** @deprecated — kompetencie nahradené RPG; ponechané ako prázdny hook */
	function renderProfileCompetencies(container, _legacy) {
		renderProfileRpgBlock(container, window.__lastRpgTalentsData || null);
	}

	function activateRating(savedId, currentRating) {
		const el = document.getElementById('game-rating-widget');
		if (el) _renderRatingWidget(el, savedId, currentRating || 0);
	}

	// ─── Level-up feedback — kompetencie nahradené RPG (XP efekt + toast) ───
	function showLevelUpFeedback(_levelChanges) {
		void _levelChanges;
	}

	return {
		showScreen, renderGame, renderQuickView, addToHistory, clearHistory, loadHistory,
		toggleSection, toggleTheme, openModal, closeModal,
		openHelp, toggleFullscreen, toggleHistory,
		toggleMobileFilters, toggleMobileSmarta, closeMobileOverlays,
		toast, setStatus, updateStats, renderCompetencies, renderProfileCompetencies,
		renderRpgHudFromTalents, renderProfileRpgBlock,
		activateRating, showLevelUpFeedback
	};
})();

// Expose globally so scripts loaded after this one can reference window.GameUI
window.GameUI = GameUI;
