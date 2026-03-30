/* ═══════════════════════════════════════════════════════════════════
   gIVEMEGAME.IO — Library module (extracted from script.js Phase 2)

   Dependencies (globals resolved at call-time, not load-time):
     • currentGame        — var declared in script.js (top-level)
     • supabaseClient     — var declared in script.js (top-level)
     • getCurrentUser()   — function declared in script.js (top-level)
     • GameUI             — const declared in script.js (top-level, shared global scope)
     • Timer              — window.Timer set by timer.js
     • ngrokHeaders()     — const declared in script.js (top-level)

   Exposes: window.Library  (also bridged inside App as `const Library = window.Library`)
   ═══════════════════════════════════════════════════════════════════ */

const Library = (() => {
	const MODE_ICONS = { party: '🎉', classroom: '📚', reflection: '🪞', circus: '🎪', cooking: '🍳', meditation: '🧘', default: '🎮' };
	let _allGames = []; // full fetched list; kept in sync for client-side filter/sort

	async function getAuthHeader() {
		if (!supabaseClient) return null;
		try {
			const { data: { session } } = await Promise.race([
				supabaseClient.auth.getSession(),
				new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 8000))
			]);
			if (!session?.access_token) return null;
			return { Authorization: `Bearer ${session.access_token}` };
		} catch { return null; }
	}

	async function fetchApi(url, opts = {}, ms = 12000) {
		const ctrl = new AbortController();
		const t = setTimeout(() => ctrl.abort(), ms);
		try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
		finally { clearTimeout(t); }
	}

	async function saveCurrentGame() {
		const user = getCurrentUser();
		if (!user) {
			GameUI.toast('📚 Prihlás sa pre ukladanie hier');
			return;
		}
		if (!currentGame) {
			GameUI.toast('Najprv vygeneruj hru!');
			return;
		}
		const btn = document.getElementById('btn-save-game');
		if (btn) { btn.disabled = true; btn.querySelector('span').textContent = 'Ukladám...'; }
		try {
			const headers = await getAuthHeader();
			if (!headers) { GameUI.toast('Chyba autentifikácie'); return; }
			const resp = await fetchApi('/api/games/save', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', ...headers },
				body: JSON.stringify({ game: currentGame })
			});
			if (!resp.ok) {
				const err = await resp.json().catch(() => ({}));
				throw new Error(err.error || 'Nepodarilo sa uložiť');
			}
			const data = await resp.json();
			if (data.game?.id && currentGame) {
				currentGame._savedId = data.game.id;
				if (window.GameUI?.activateRating) GameUI.activateRating(data.game.id, 0);
			}
			if (btn) {
				btn.classList.add('saved');
				btn.querySelector('span').textContent = 'Uložené ✓';
			}
			GameUI.toast('📚 Hra uložená do knižnice!');
			setTimeout(() => {
				if (btn) { btn.disabled = false; btn.classList.remove('saved'); btn.querySelector('span').textContent = 'Uložiť'; }
			}, 3000);
		} catch (err) {
			GameUI.toast('Chyba: ' + err.message);
			if (btn) { btn.disabled = false; btn.querySelector('span').textContent = 'Uložiť'; }
		}
	}

	async function open() {
		const modal = document.getElementById('library-modal');
		if (!modal) return;
		modal.style.display = 'flex';
		await loadLibrary();
	}

	function close() {
		const modal = document.getElementById('library-modal');
		if (modal) modal.style.display = 'none';
	}

	async function loadLibrary() {
		const listEl = document.getElementById('library-list');
		if (!listEl) return;

		const user = getCurrentUser();
		if (!user) {
			listEl.innerHTML = '<div class="library-empty"><span class="library-empty-icon">🔒</span>Pre prístup ku knižnici sa prihlás.</div>';
			return;
		}

		listEl.innerHTML = '<div class="library-loading">Načítavam knižnicu...</div>';

		try {
			const headers = await getAuthHeader();
			if (!headers) {
				listEl.innerHTML = '<div class="library-empty">Chyba autentifikácie.</div>';
				return;
			}
			const resp = await fetchApi('/api/games/library?limit=50', { headers });
			if (!resp.ok) throw new Error('Nepodarilo sa načítať');
			const { games } = await resp.json();

			if (!games || games.length === 0) {
				listEl.innerHTML = '<div class="library-empty"><span class="library-empty-icon">📭</span>Žiadne uložené hry. Vygeneruj hru a klikni Uložiť!</div>';
				return;
			}

			_allGames = games;
			_renderFiltered();
		} catch (err) {
			listEl.innerHTML = `<div class="library-empty">Chyba načítania: ${escapeHtml(err.message)}</div>`;
		}
	}

	async function loadGameById(id) {
		close();
		const headers = await getAuthHeader();
		if (!headers) return;
		try {
			const resp = await fetch(`/api/games/${id}`, { headers });
			if (!resp.ok) throw new Error('Nepodarilo sa načítať hru');
			const game = await resp.json();
			currentGame = game;
			GameUI.renderGame(game);
			GameUI.renderQuickView(game);
			GameUI.addToHistory(game);
			GameUI.setStatus('GAME LOADED');
			Timer.setup(game.duration);
			GameUI.toast('📚 Hra načítaná z knižnice');
			const editBtn = document.getElementById('btn-edit-game');
			if (editBtn) editBtn.style.display = '';
		} catch (err) {
			GameUI.toast('Chyba: ' + err.message);
		}
	}

	async function _toggleFav(id, btn) {
		const isActive = btn.classList.contains('active');
		const newFav = !isActive;
		const headers = await getAuthHeader();
		if (!headers) return;
		try {
			const resp = await fetch(`/api/games/${id}/favorite`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json', ...headers },
				body: JSON.stringify({ favorite: newFav })
			});
			if (!resp.ok) throw new Error('Chyba');
			btn.classList.toggle('active', newFav);
			btn.innerHTML = `<i class="bi bi-${newFav ? 'star-fill' : 'star'}"></i>`;
		} catch { GameUI.toast('Chyba pri aktualizácii obľúbenej'); }
	}

	async function _delete(id, btn) {
		if (!confirm('Zmazať túto hru z knižnice?')) return;
		const headers = await getAuthHeader();
		if (!headers) return;
		try {
			const resp = await fetch(`/api/games/${id}`, { method: 'DELETE', headers });
			if (!resp.ok) throw new Error('Chyba mazania');
			_allGames = _allGames.filter(g => g.id !== id);
			const item = btn.closest('.library-item');
			if (item) item.remove();
			const listEl = document.getElementById('library-list');
			if (listEl && _allGames.length === 0) {
				listEl.innerHTML = '<div class="library-empty"><span class="library-empty-icon">📭</span>Žiadne uložené hry.</div>';
			}
			GameUI.toast('Hra zmazaná z knižnice');
		} catch { GameUI.toast('Chyba mazania'); }
	}

	function escapeHtml(str) {
		return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
	}

	// Keyboard: Escape closes modal
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape') close();
	});

	async function _share(id) {
		const headers = await getAuthHeader();
		if (!headers) { GameUI.toast('Prihlás sa pre zdieľanie'); return; }
		try {
			const resp = await fetch(`/api/games/${id}/publish`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json', ...headers },
				body: JSON.stringify({ publish: true })
			});
			if (!resp.ok) throw new Error('Chyba');
			const { token } = await resp.json();
			if (!token) throw new Error('Žiadny token');
			const url = `${window.location.origin}/game/${token}`;
			try { await navigator.clipboard.writeText(url); }
			catch { prompt('Skopíruj odkaz:', url); return; }
			GameUI.toast('🔗 Odkaz skopírovaný! Hra je teraz verejná.');
			// Reflect shared state in _allGames + DOM without full re-render
			const g = _allGames.find(x => x.id === id);
			if (g) g.is_shared = true;
			document.querySelectorAll('.share-btn').forEach(b => {
				if (b.getAttribute('onclick')?.includes(id)) {
					b.classList.add('active');
					b.title = 'Verejná hra (skopírovať odkaz)';
					b.querySelector('i')?.classList.replace('bi-link-45deg', 'bi-globe2');
				}
			});
		} catch (err) {
			GameUI.toast('Chyba zdieľania: ' + err.message);
		}
	}

	async function _edit(id, btn) {
		const item = btn.closest('.library-item');
		const info = item.querySelector('.library-item-info');
		const headers = await getAuthHeader();
		if (!headers) return;
		btn.disabled = true;
		try {
			const resp = await fetchApi('/api/games/' + id, { headers });
			if (!resp.ok) throw new Error('Nepodarilo sa načítať hru');
			const game = await resp.json();
			item._originalInfoHtml = info.innerHTML;
			item._editGame = game;
			const arr = (a) => (a || []).join('\n');
			info.innerHTML =
				'<div onclick="event.stopPropagation()">' +
				'<span class="lib-edit-label">Názov</span>' +
				'<input class="lib-edit-input" id="lib-ei-title-' + id + '" value="' + escapeHtml(game.title || '') + '" maxlength="120">' +
				'<span class="lib-edit-label">Krátky popis</span>' +
				'<textarea class="lib-edit-textarea" id="lib-ei-pitch-' + id + '" rows="2">' + escapeHtml(game.pitch || '') + '</textarea>' +
				'<span class="lib-edit-label">Pomôcky (jeden na riadok)</span>' +
				'<textarea class="lib-edit-textarea" id="lib-ei-mat-' + id + '" rows="3">' + escapeHtml(arr(game.materials)) + '</textarea>' +
				'<span class="lib-edit-label">Inštrukcie (jeden krok na riadok)</span>' +
				'<textarea class="lib-edit-textarea" id="lib-ei-instr-' + id + '" rows="5">' + escapeHtml(arr(game.instructions)) + '</textarea>' +
				'<span class="lib-edit-label">Vzdelávacie ciele (jeden na riadok)</span>' +
				'<textarea class="lib-edit-textarea" id="lib-ei-goals-' + id + '" rows="2">' + escapeHtml(arr(game.learningGoals)) + '</textarea>' +
				'<span class="lib-edit-label">Reflexné otázky (jedna na riadok)</span>' +
				'<textarea class="lib-edit-textarea" id="lib-ei-refl-' + id + '" rows="3">' + escapeHtml(arr(game.reflectionPrompts)) + '</textarea>' +
				'<span class="lib-edit-label">Bezpečnostné poznámky (jedna na riadok)</span>' +
				'<textarea class="lib-edit-textarea" id="lib-ei-safe-' + id + '" rows="2">' + escapeHtml(arr(game.safetyNotes)) + '</textarea>' +
				'<span class="lib-edit-label">Tipy na úpravy (jeden na riadok)</span>' +
				'<textarea class="lib-edit-textarea" id="lib-ei-adap-' + id + '" rows="2">' + escapeHtml(arr(game.adaptationTips)) + '</textarea>' +
				'<span class="lib-edit-label">Poznámky pre vedúceho</span>' +
				'<textarea class="lib-edit-textarea" id="lib-ei-fac-' + id + '" rows="2">' + escapeHtml(game.facilitatorNotes || '') + '</textarea>' +
				'<span class="lib-edit-label">Príručka pre učiteľa (jeden bod na riadok)</span>' +
				'<textarea class="lib-edit-textarea" id="lib-ei-tguide-' + id + '" rows="2">' + escapeHtml(arr(game.teacherGuide)) + '</textarea>' +
				'<span class="lib-edit-label">Riziká (jedno na riadok)</span>' +
				'<textarea class="lib-edit-textarea" id="lib-ei-risk-' + id + '" rows="2">' + escapeHtml(arr(game.riskNotes)) + '</textarea>' +
				'<div class="lib-edit-actions">' +
				'<button class="library-action-btn" onclick="event.stopPropagation(); App.Library._saveEdit(\'' + id + '\', this)"><i class="bi bi-check-lg"></i> Uložiť</button>' +
				'<button class="library-action-btn" onclick="event.stopPropagation(); App.Library._cancelEdit(\'' + id + '\', this)"><i class="bi bi-x-lg"></i> Zrušiť</button>' +
				'</div></div>';
			item.classList.add('editing');
		} catch (err) {
			GameUI.toast('Chyba: ' + err.message);
		} finally {
			btn.disabled = false;
		}
	}

	async function _saveEdit(id, btn) {
		const item = btn.closest('.library-item');
		const info = item.querySelector('.library-item-info');
		const v = (elId) => document.getElementById('lib-ei-' + elId + '-' + id)?.value || '';
		const toArr = (txt) => txt.split('\n').map(s => s.trim()).filter(Boolean);
		const patch = {
			title:             v('title').trim(),
			pitch:             v('pitch').trim(),
			materials:         toArr(v('mat')),
			instructions:      toArr(v('instr')),
			learningGoals:     toArr(v('goals')),
			reflectionPrompts: toArr(v('refl')),
			safetyNotes:       toArr(v('safe')),
			adaptationTips:    toArr(v('adap')),
			facilitatorNotes:  v('fac').trim(),
			teacherGuide:      toArr(v('tguide')),
			riskNotes:         toArr(v('risk'))
		};
		if (!patch.title) { GameUI.toast('Názov nemôže byť prázdny'); return; }
		const headers = await getAuthHeader();
		if (!headers) return;
		btn.disabled = true;
		try {
			const resp = await fetchApi('/api/games/' + id, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json', ...headers },
				body: JSON.stringify(patch)
			});
			if (!resp.ok) throw new Error('Nepodarilo sa uložiť');
			const g = item._editGame;
			const date = new Date(g._savedAt || g.created_at).toLocaleDateString('sk-SK', { day: '2-digit', month: '2-digit', year: 'numeric' });
			info.innerHTML = '<div class="library-item-title">' + escapeHtml(patch.title) + '</div>' +
				'<div class="library-item-meta">' + escapeHtml(g.mode || '') + ' · ' + date + '</div>';
			item._originalInfoHtml = info.innerHTML;
			item.classList.remove('editing');
			GameUI.toast('✅ Hra aktualizovaná');
		} catch (err) {
			GameUI.toast('Chyba: ' + err.message);
			btn.disabled = false;
		}
	}

	function _cancelEdit(id, btn) {
		const item = btn.closest('.library-item');
		const info = item.querySelector('.library-item-info');
		info.innerHTML = item._originalInfoHtml;
		item.classList.remove('editing');
	}

	// ─── Search / Filter / Sort ───────────────────────────────────────

	function _renderList(listEl, games) {
		listEl.innerHTML = '';
		if (!games.length) {
			listEl.innerHTML = '<div class="library-empty"><span class="library-empty-icon">🔍</span>Žiadne hry nevyhovujú filtrom.</div>';
			return;
		}
		games.forEach(g => {
			const icon = MODE_ICONS[g.mode] || MODE_ICONS.default;
			const date = new Date(g.created_at).toLocaleDateString('sk-SK', { day: '2-digit', month: '2-digit', year: 'numeric' });
			const stars = g.rating ? `<span class="lib-stars">${'★'.repeat(g.rating)}${'☆'.repeat(5 - g.rating)}</span>` : '';
			const item = document.createElement('div');
			item.className = 'library-item';
			item.innerHTML = `
				<div class="library-item-icon">${icon}</div>
				<div class="library-item-info">
					<div class="library-item-title">${escapeHtml(g.title)}</div>
					<div class="library-item-meta">${g.mode} · ${date}${stars ? ' · ' + stars : ''}</div>
				</div>
				<div class="library-item-actions" onclick="event.stopPropagation()">
					<button class="library-action-btn fav-btn ${g.is_favorite ? 'active' : ''}" title="Obľúbená" onclick="App.Library._toggleFav('${g.id}', this)">
						<i class="bi bi-${g.is_favorite ? 'star-fill' : 'star'}"></i>
					</button>
					<button class="library-action-btn share-btn${g.is_shared ? ' active' : ''}" title="${g.is_shared ? 'Verejná hra (skopírovať odkaz)' : 'Zdieľať odkaz'}" onclick="App.Library._share('${g.id}')">
						<i class="bi bi-${g.is_shared ? 'globe2' : 'link-45deg'}"></i>
					</button>
					<button class="library-action-btn remix-btn" title="Remix" onclick="App.Library._remix('${g.id}')">
						<i class="bi bi-shuffle"></i>
					</button>
					<button class="library-action-btn edit-btn" title="Upraviť" onclick="App.Library._edit('${g.id}', this)">
						<i class="bi bi-pencil"></i>
					</button>
					<button class="library-action-btn del-btn" title="Zmazať" onclick="App.Library._delete('${g.id}', this)">
						<i class="bi bi-trash"></i>
					</button>
				</div>
			`;
			item.addEventListener('click', () => loadGameById(g.id));
			listEl.appendChild(item);
		});
	}

	function _renderFiltered() {
		const listEl = document.getElementById('library-list');
		if (!listEl || !_allGames.length) return;
		const q    = (document.getElementById('lib-search')?.value || '').toLowerCase().trim();
		const mode = document.getElementById('lib-mode')?.value || '';
		const sort = document.getElementById('lib-sort')?.value || 'newest';
		let filtered = _allGames
			.filter(g => !q    || g.title.toLowerCase().includes(q))
			.filter(g => !mode || g.mode === mode);
		if      (sort === 'oldest') filtered.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
		else if (sort === 'rating') filtered.sort((a, b) => (b.rating || 0) - (a.rating || 0));
		else                        filtered.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
		_renderList(listEl, filtered);
	}

	// ─── Rating ───────────────────────────────────────────────────────
	// Returns the fetch promise chain so callers can attach .catch() for error handling
	async function _rate(id, rating, feedback) {
		const headers = await getAuthHeader();
		if (!headers) return;
		return fetch(`/api/games/${id}/rate`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json', ...headers },
			body: JSON.stringify({ rating, feedback: feedback || null })
		}).then(r => { if (!r.ok) throw new Error(r.status); });
	}

	async function _submitRating() {
		const el = document.getElementById('game-rating-widget');
		if (!el) return;
		const savedId = el.dataset.savedId;
		const rating = parseInt(el.dataset.pendingRating, 10);
		if (!savedId || !rating || rating < 1 || rating > 5) {
			GameUI.toast('Vyber 1–5 hviezdičiek');
			return;
		}
		const feedback = el.querySelector('.rating-text')?.value?.trim() || null;
		const submitBtn = el.querySelector('.btn-xs');
		// Lock button immediately (visible loading state)
		if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = '...'; }
		// Optimistic UI — fire non-blocking, revert on failure
		if (window.currentGame) window.currentGame._currentRating = rating;
		GameUI.toast('⭐ Hodnotenie uložené!');
		_rate(savedId, rating, feedback)
			?.then(() => {
				if (submitBtn) { submitBtn.textContent = '✓ Uložené'; }
			})
			?.catch(() => {
				GameUI.toast('❌ Hodnotenie sa nepodarilo uložiť. Skús znova.');
				if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Odoslať'; }
			});
	}

	async function _remix(id) {
		const headers = await getAuthHeader();
		if (!headers) return;
		try {
			const resp = await fetch(`/api/games/${id}`, { headers });
			if (!resp.ok) throw new Error('Nepodarilo sa načítať hru');
			const game = await resp.json();
			currentGame = game;
			close();
			window.App.generate('remix', game);
		} catch (err) {
			GameUI.toast('Chyba remixu: ' + err.message);
		}
	}

	return { open, close, saveCurrentGame, loadLibrary, _toggleFav, _delete, _share, _edit, _saveEdit, _cancelEdit, _submitRating, _renderFiltered, _remix };
})();

// Expose globally so App can bridge it as `const Library = window.Library`
window.Library = Library;
