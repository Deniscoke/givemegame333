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
		const settingLabels = { indoor: 'Uvnitř', outdoor: 'Venku', any: 'Kdekoli' };
		const modeEmojis    = { party: '🎉', classroom: '📚', reflection: '🪞', circus: '🎪', cooking: '🍳', meditation: '🧘' };

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
		addBadge(badges, `${game.playerCount?.min}–${game.playerCount?.max} hráčů`, 'players', 'bi-people');
		addBadge(badges, `${game.duration?.min}–${game.duration?.max} min`, 'duration', 'bi-clock');
		addBadge(badges, `Věk ${game.ageRange?.min}–${game.ageRange?.max}`, 'age', 'bi-person');

		// Meta row
		const metaRow = el('game-meta-row');
		metaRow.innerHTML = '';
		addMeta(metaRow, 'bi-people-fill', `${game.playerCount?.min}–${game.playerCount?.max}`, 'Hráči');
		addMeta(metaRow, 'bi-clock-fill',  `${game.duration?.min}–${game.duration?.max}m`,       'Délka');
		addMeta(metaRow, 'bi-geo-alt-fill', settingLabel,                                         'Prostředí');
		addMeta(metaRow, 'bi-person-fill',  `${game.ageRange?.min}–${game.ageRange?.max}`,        'Věk');

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
