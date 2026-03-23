/* ═══════════════════════════════════════════════════════════════
   gIVEMEGAME.IO — Public game viewer (/game/:id)
   Fetches a saved game via the public API and renders it.
   No auth required. Read-only.
   ═══════════════════════════════════════════════════════════════ */

const GP = (() => {
	// ─── Helpers ────────────────────────────────────────────────

	function esc(str) {
		return String(str ?? '')
			.replace(/&/g, '&amp;').replace(/</g, '&lt;')
			.replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}

	function el(id) { return document.getElementById(id); }

	function renderList(id, arr, ordered = false) {
		const ul = el(id);
		if (!ul) return;
		ul.innerHTML = '';
		(arr || []).forEach(item => {
			const li = document.createElement('li');
			li.textContent = item;
			ul.appendChild(li);
		});
	}

	function renderTags(id, arr) {
		const wrap = el(id);
		if (!wrap) return;
		wrap.innerHTML = '';
		(arr || []).forEach(text => {
			const tag = document.createElement('span');
			tag.className = 'game-tag';
			tag.textContent = text;
			wrap.appendChild(tag);
		});
	}

	function renderRvpBadges(containerId, keys, lookup, fallbackColor = '#555') {
		const wrap = el(containerId);
		if (!wrap) return;
		wrap.innerHTML = '';
		(keys || []).forEach(key => {
			const def = lookup?.[key];
			const badge = document.createElement('span');
			badge.className = 'rvp-badge';
			badge.style.background = def?.barva || fallbackColor;
			badge.style.color = '#fff';
			badge.innerHTML = def?.ikona ? `<i class="bi ${def.ikona}"></i> ${esc(def.nazev || key)}` : esc(def?.nazev || key);
			wrap.appendChild(badge);
		});
	}

	function addBadge(container, text, type, icon) {
		const b = document.createElement('span');
		b.className = `badge badge-${type}`;
		b.innerHTML = `<i class="bi ${icon}"></i> ${esc(text)}`;
		container.appendChild(b);
	}

	function addMeta(container, icon, value, label) {
		const m = document.createElement('div');
		m.className = 'meta-item';
		m.innerHTML = `<i class="bi ${icon}"></i><span>${esc(value)}</span>`;
		m.title = label;
		container.appendChild(m);
	}

	function _toggleSection(id, show) {
		const s = el(id);
		if (s) s.style.display = show ? '' : 'none';
	}

	function _renderPlayerBrief(pb) {
		if (!pb || typeof pb !== 'object') { _toggleSection('section-player-brief', false); return; }
		const has = (pb.goal && pb.goal.trim()) || (pb.rules && pb.rules.length) || (pb.roles && pb.roles.length) || (pb.winCondition && pb.winCondition.trim());
		_toggleSection('section-player-brief', !!has);
		if (!has) return;
		const wrap = el('game-player-brief');
		if (!wrap) return;
		let h = '';
		if (pb.goal && pb.goal.trim()) h += `<p class="player-brief-goal"><strong>Cíl:</strong> ${esc(pb.goal)}</p>`;
		if (pb.rules && pb.rules.length) h += `<div class="player-brief-rules"><strong>Pravidla:</strong><ul>${pb.rules.map(r => `<li>${esc(r)}</li>`).join('')}</ul></div>`;
		if (pb.roles && pb.roles.length) h += `<div class="player-brief-roles"><strong>Role:</strong> ${esc(pb.roles.join(', '))}</div>`;
		if (pb.winCondition && pb.winCondition.trim()) h += `<p class="player-brief-win"><strong>Výhra:</strong> ${esc(pb.winCondition)}</p>`;
		wrap.innerHTML = h;
	}

	function _renderLessonFlow(flow) {
		if (!Array.isArray(flow) || flow.length === 0) { _toggleSection('section-lesson-flow', false); return; }
		_toggleSection('section-lesson-flow', true);
		const wrap = el('game-lesson-flow');
		if (!wrap) return;
		wrap.innerHTML = flow.map(p => {
			let h = `<div class="lesson-phase"><div class="lesson-phase-header">${esc(p.phase)}`;
			if (p.minutes > 0) h += ` <span class="lesson-phase-min">(${p.minutes} min)</span>`;
			h += `</div>`;
			if (p.teacherActions && p.teacherActions.length) h += `<div class="lesson-teacher"><strong>Učitel:</strong><ul>${p.teacherActions.map(a => `<li>${esc(a)}</li>`).join('')}</ul></div>`;
			if (p.studentActions && p.studentActions.length) h += `<div class="lesson-student"><strong>Žáci:</strong><ul>${p.studentActions.map(a => `<li>${esc(a)}</li>`).join('')}</ul></div>`;
			h += `</div>`;
			return h;
		}).join('');
	}

	function _renderAdaptations(adaptations) {
		if (!Array.isArray(adaptations) || adaptations.length === 0) { _toggleSection('section-adaptations', false); return; }
		_toggleSection('section-adaptations', true);
		const wrap = el('game-adaptations');
		if (!wrap) return;
		wrap.innerHTML = adaptations.map(a => {
			if (!a.scenario && !a.adjustment) return '';
			return `<div class="adaptation-pair"><span class="adaptation-scenario">${esc(a.scenario || '')}</span> → <span class="adaptation-adjustment">${esc(a.adjustment || '')}</span></div>`;
		}).filter(Boolean).join('');
	}

	// ─── Section toggle (same `.collapsed` mechanism as main app) ─

	function toggleSection(name) {
		const section = document.querySelector(`[data-section="${name}"]`);
		if (section) section.classList.toggle('collapsed');
	}

	// ─── Copy share link ─────────────────────────────────────────

	async function copyLink() {
		const url = window.location.href;
		try {
			await navigator.clipboard.writeText(url);
			showToast('🔗 Odkaz skopírovaný!');
		} catch {
			prompt('Skopíruj tento odkaz:', url);
		}
	}

	// ─── Minimal toast ──────────────────────────────────────────

	let _toastTimer = null;
	function showToast(msg) {
		let t = document.getElementById('gp-toast');
		if (!t) {
			t = document.createElement('div');
			t.id = 'gp-toast';
			t.style.cssText = `position:fixed;bottom:20px;left:50%;transform:translateX(-50%);
				background:#333;color:#fff;padding:10px 18px;border-radius:4px;
				font-family:'Press Start 2P',cursive;font-size:9px;z-index:9999;
				pointer-events:none;transition:opacity 0.3s;`;
			document.body.appendChild(t);
		}
		t.textContent = msg;
		t.style.opacity = '1';
		clearTimeout(_toastTimer);
		_toastTimer = setTimeout(() => { t.style.opacity = '0'; }, 2500);
	}

	// ─── Render ──────────────────────────────────────────────────

	function renderGame(game, rvp) {
		game = (window.normalizeGameSchema && window.normalizeGameSchema(game)) || game;
		const settingLabels = { indoor: 'Uvnitř', outdoor: 'Venku', any: 'Kdekoli' };
		const modeEmojis    = { party: '🎉', classroom: '📚', reflection: '🪞', circus: '🎪', cooking: '🍳', meditation: '🧘' };
		const pc = game.playerCount || { min: 1, max: 30 };
		const dur = game.duration || { min: 15, max: 30 };
		const age = game.ageRange || { min: 6, max: 15 };

		// Mode badge
		const badge = el('game-mode-badge');
		if (badge) {
			badge.textContent = `${modeEmojis[game.mode] || '🎮'} ${game.mode || ''}`;
			badge.className = `game-mode-badge badge-${game.mode || 'party'}`;
		}

		// Set page title
		document.title = `${game.title} — gIVEMEGAME.IO`;

		el('game-title').textContent = game.title;
		el('game-pitch').textContent = game.pitch;

		// Badges row
		const badges = el('game-badges');
		badges.innerHTML = '';
		const settingLabel = settingLabels[game.setting] || game.setting || '';
		addBadge(badges, settingLabel, 'setting', game.setting === 'outdoor' ? 'bi-tree' : game.setting === 'indoor' ? 'bi-house' : 'bi-globe2');
		addBadge(badges, `${pc.min}–${pc.max} hráčů`, 'players', 'bi-people');
		addBadge(badges, `${dur.min}–${dur.max} min`, 'duration', 'bi-clock');
		addBadge(badges, `Věk ${age.min}–${age.max}`, 'age', 'bi-person');

		// Meta row
		const metaRow = el('game-meta-row');
		metaRow.innerHTML = '';
		addMeta(metaRow, 'bi-people-fill', `${pc.min}–${pc.max}`, 'Hráči');
		addMeta(metaRow, 'bi-clock-fill',  `${dur.min}–${dur.max}m`, 'Délka');
		addMeta(metaRow, 'bi-geo-alt-fill', settingLabel, 'Prostředí');
		addMeta(metaRow, 'bi-person-fill',  `${age.min}–${age.max}`, 'Věk');

		// Game Pack
		_renderPlayerBrief(game.playerBrief);
		_renderLessonFlow(game.lessonFlow);
		_renderAdaptations(game.adaptations);
		renderList('game-risk-notes', game.riskNotes);
		_toggleSection('section-risk', Array.isArray(game.riskNotes) && game.riskNotes.length > 0);
		renderList('game-teacher-guide', game.teacherGuide);
		const tgEl = el('game-teacher-guide');
		if (tgEl) tgEl.style.display = (game.teacherGuide && game.teacherGuide.length) ? '' : 'none';

		// Lists
		renderList('game-materials',    game.materials);
		renderList('game-instructions', game.instructions);
		renderTags('game-goals',        game.learningGoals);
		renderList('game-reflection',   game.reflectionPrompts);
		renderList('game-safety',       game.safetyNotes);
		renderList('game-adaptation',   game.adaptationTips);
		el('game-facilitator').textContent = game.facilitatorNotes || '';

		// RVP — use lookup if available, else raw keys as plain badges
		const gameRvp = game.rvp || {};
		renderRvpBadges('rvp-kompetence', gameRvp.kompetence,       rvp?.kompetence);
		renderRvpBadges('rvp-oblasti',    gameRvp.oblasti,           rvp?.vzdelavaci_oblasti);
		renderRvpBadges('rvp-stupen',     gameRvp.stupen,            rvp?.stupne, '#6c757d');
		renderRvpBadges('rvp-prurezova',  gameRvp.prurezova_temata,  null);
		renderList('rvp-vystupy',         gameRvp.ocekavane_vystupy);
		renderRvpBadges('rvp-hodnoceni',  gameRvp.doporucene_hodnoceni, null, '#888');

		// Show card
		el('gp-loading').style.display = 'none';
		el('game-card').style.display  = 'block';
	}

	// ─── Error state ─────────────────────────────────────────────

	function showError(msg) {
		el('gp-loading').style.display = 'none';
		el('gp-error-msg').textContent = msg;
		el('gp-error').style.display   = '';
	}

	// ─── Init ────────────────────────────────────────────────────

	async function init() {
		const match = window.location.pathname.match(/\/game\/([0-9a-f-]{36})/i);
		if (!match) { showError('Neplatný odkaz na hru.'); return; }
		const gameId = match[1];

		try {
			// Load game + RVP data in parallel; RVP is optional
			const [gameRes, rvpRes] = await Promise.allSettled([
				fetch(`/api/games/public/${gameId}`),
				fetch('/data/rvp.json')
			]);

			if (gameRes.status === 'rejected' || !gameRes.value.ok) {
				const status = gameRes.value?.status;
				showError(status === 404 ? 'Hra sa nenašla.' : 'Chyba načítania hry.');
				return;
			}

			const game = await gameRes.value.json();
			const rvp  = rvpRes.status === 'fulfilled' && rvpRes.value.ok
				? await rvpRes.value.json()
				: null;

			renderGame(game, rvp);
		} catch (e) {
			console.error('[GP] init error:', e);
			showError('Chyba siete. Skús znova.');
		}
	}

	document.addEventListener('DOMContentLoaded', init);

	return { toggleSection, copyLink };
})();
