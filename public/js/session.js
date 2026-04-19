/* ═══════════════════════════════════════════════════════════════════
   gIVEMEGAME.IO — Session module (Phase 4)

   Manages multiplayer game sessions: create, join, lobby, realtime sync.

   Dependencies (resolved at call-time):
     • supabaseClient      — var in script.js
     • GameUI              — global (game-ui.js)
     • Reflection          — global (reflection.js)
     • Timer               — global (timer.js)
     • window.currentGame  — var in script.js
     • window.Coins        — global (coins.js)

   Exposes: window.Session
   ═══════════════════════════════════════════════════════════════════ */

const Session = (() => {
	const JOIN_COST = 100; // musí byť rovnaké ako SESSION_JOIN_COST v server.js
	const STORAGE_KEY = 'givemegame_active_session';
	const STORAGE_TTL_MS = 6 * 60 * 60 * 1000; // 6 h — staršie záznamy ignorujeme

	function _persist() {
		if (!_code || !_sessionId) return;
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify({
				code: _code, sessionId: _sessionId, isHost: _isHost, ts: Date.now()
			}));
		} catch {}
	}
	function _clearPersist() {
		try { localStorage.removeItem(STORAGE_KEY); } catch {}
	}
	function _readPersist() {
		try {
			const raw = localStorage.getItem(STORAGE_KEY);
			if (!raw) return null;
			const obj = JSON.parse(raw);
			if (!obj?.code || !obj?.sessionId) return null;
			if (Date.now() - (obj.ts || 0) > STORAGE_TTL_MS) { _clearPersist(); return null; }
			return obj;
		} catch { return null; }
	}

	// Resolve translation at call-time so language changes are respected
	const _t = (key, fallback) => (window.givemegame_t || ((k, f) => f || k))(key, fallback);

	let _code      = null;  // current session join_code
	let _sessionId = null;  // current session uuid
	let _isHost    = false;
	let _channel   = null;  // Supabase Realtime channel
	let _pollTimer = null;  // fallback polling interval for lobby participants
	let _lastKnownStatus = 'waiting'; // track session status for poll-based transition

	// ─── Public API ───────────────────────────────────────────────

	async function create(gameJson) {
		if (!gameJson?.title) {
			GameUI.toast(_t('sess_no_game', '⚠️ Najprv vygeneruj hru')); return;
		}
		const token = await _token();
		if (!token) { GameUI.toast(_t('sess_login_create', 'Prihlás sa pre vytvorenie session')); return; }

		try {
			const res = await fetchApi('/api/sessions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
				body: JSON.stringify({ game_json: gameJson })
			});
			const data = await res.json();
			if (!res.ok) { GameUI.toast(`❌ ${data.error}`); return; }

			_code      = data.join_code;
			_sessionId = data.id;
			_isHost    = true;
			_persist();

			_openLobby();
			_subscribe();
			_startPoll();
			await _refreshParticipants();
		} catch (err) {
			GameUI.toast(`❌ ${err.message}`);
		}
	}

	async function join(rawCode) {
		const code = (rawCode || '').toUpperCase().trim();
		if (code.length !== 6) {
			_setJoinError(_t('sess_bad_code', '⚠️ Zadaj 6-znakový kód'));
			return;
		}

		_setJoinLoading(true);

		// Try to get token; if null, attempt a session refresh first (expired token scenario)
		let token = await _token();
		if (!token && typeof syncAuthFromSupabase === 'function') {
			await syncAuthFromSupabase();
			token = await _token();
		}
		if (!token) {
			_setJoinLoading(false);
			_setJoinError(_t('sess_login_join', 'Prihlás sa pre pripojenie'));
			return;
		}

		try {
			const res = await fetchApi(`/api/sessions/${code}/join`, {
				method: 'POST',
				headers: { 'Authorization': `Bearer ${token}` }
			});
			const data = await res.json();
			if (!res.ok) {
				_setJoinLoading(false);
				_setJoinError(data.error || `Chyba ${res.status}`);
				return;
			}

			_code      = code;
			_sessionId = data.session_id;
			_isHost    = false;
			_persist();

			_closeJoinModal();
			_openLobby();
			_subscribe();
			_startPoll();
			await _refreshParticipants();
		} catch (err) {
			_setJoinLoading(false);
			_setJoinError(err.name === 'AbortError'
				? _t('sess_timeout', 'Server neodpovedal — skús znova')
				: err.message);
		}
	}

	async function start() {
		if (!_isHost || !_code) return;
		const token = await _token();
		if (!token) return;
		try {
			const res = await fetchApi(`/api/sessions/${_code}/start`, {
				method: 'POST',
				headers: { 'Authorization': `Bearer ${token}` }
			});
			const data = await res.json();
			if (!res.ok) { GameUI.toast(`❌ ${data.error}${data.detail ? ': ' + data.detail : ''}`); return; }
			// Realtime will handle status transition to 'active'
		} catch (err) {
			GameUI.toast(`❌ ${err.message}`);
		}
	}

	async function complete() {
		if (!_isHost || !_code) return;
		const token = await _token();
		if (!token) return;
		try {
			const res = await fetchApi(`/api/sessions/${_code}/complete`, {
				method: 'POST',
				headers: { 'Authorization': `Bearer ${token}` }
			});
			const data = await res.json();
			if (!res.ok) {
				let msg = data.error;
				const v = data.validation;
				if (data.code === 'DURATION_TOO_SHORT' && v) {
					msg = _t('err_duration_short', msg).replace('{actual}', Math.round(v.duration_actual_min)).replace('{required}', v.duration_required_min);
				} else if (data.code === 'NOT_ENOUGH_PLAYERS' && v) {
					msg = _t('err_not_enough_players', msg).replace('{actual}', v.participants_actual).replace('{required}', v.participants_required);
				} else if (data.code === 'HOST_COOLDOWN') {
					msg = _t('err_host_cooldown', msg);
				}
				GameUI.toast(`❌ ${msg}`);
				return;
			}

			GameUI.toast(_t('sess_end_success', '🏆 Session ukončená! {count} hráčov dostalo odmeny.').replace('{count}', data.participants_rewarded ?? '?'));
			if (window.Coins?.load) window.Coins.load();
			_loadAndRenderRpgHud();
			if (GameUI.updateGameCardStats) GameUI.updateGameCardStats(data);
			if (data.my_rpg_level_up && GameUI.toast) {
				GameUI.toast(_t('rpg_level_up_toast', '⭐ Nový RPG level!'));
			}
			if (data.rpg_xp_gained > 0 && window.RpgXpFx) RpgXpFx.trigger(data.rpg_xp_gained, '⚔️ Session dokončená');
		} catch (err) {
			GameUI.toast(`❌ ${err.message}`);
		}
	}

	// ─── Join modal (replaces browser prompt for better UX) ──────────

	function openJoinDialog() {
		let modal = document.getElementById('session-join-modal');
		if (!modal) {
			modal = document.createElement('div');
			modal.id = 'session-join-modal';
			modal.className = 'modal-overlay';
			modal.style.cssText = 'display:flex;z-index:10000';
			document.body.appendChild(modal);
		}
		modal.style.display = 'flex';
		modal.innerHTML = `
			<div class="modal-box" style="max-width:360px;text-align:center">
				<div class="modal-header" style="justify-content:center">
					<h3>🎮 ${_t('sess_join_title','Pripojiť sa k session')}</h3>
				</div>
				<p style="opacity:0.6;font-size:12px;margin-bottom:16px">
					${_t('sess_join_hint','Zadaj 6-znakový kód od hostitela')}
				</p>
				<input id="join-code-input" type="text" maxlength="6"
					placeholder="XXXXXX"
					style="width:100%;font-size:24px;text-align:center;letter-spacing:6px;text-transform:uppercase;
					       padding:10px;border-radius:8px;border:2px solid var(--accent,#633cff);background:var(--bg,#1a1a2e);color:var(--text,#fff);margin-bottom:12px;box-sizing:border-box"
					oninput="this.value=this.value.toUpperCase().replace(/[^A-Z0-9]/g,'')"
					onkeydown="if(event.key==='Enter')Session._submitJoin()">
				<div id="join-error" style="color:#f87171;font-size:12px;min-height:18px;margin-bottom:8px"></div>
				<div style="display:flex;gap:8px">
					<button class="btn btn-retro" style="flex:1" onclick="Session._closeJoinModal()">${_t('cancel','Zrušiť')}</button>
					<button id="btn-join-submit" class="btn btn-retro" style="flex:2;background:var(--accent,#633cff);color:#fff"
					        onclick="Session._submitJoin()">
						${_t('sess_btn_join','Pripojiť sa')} · ${JOIN_COST} 🪙
					</button>
				</div>
			</div>`;
		setTimeout(() => document.getElementById('join-code-input')?.focus(), 50);
	}

	function _submitJoin() {
		const input = document.getElementById('join-code-input');
		if (input) join(input.value);
	}

	function _closeJoinModal() {
		const modal = document.getElementById('session-join-modal');
		if (modal) modal.style.display = 'none';
	}

	function _setJoinLoading(on) {
		const btn = document.getElementById('btn-join-submit');
		const input = document.getElementById('join-code-input');
		if (btn) { btn.disabled = on; btn.textContent = on ? '⏳ Pripájam...' : `${_t('sess_btn_join','Pripojiť sa')} · ${JOIN_COST} 🪙`; }
		if (input) input.disabled = on;
	}

	function _setJoinError(msg) {
		const el = document.getElementById('join-error');
		if (el) el.textContent = msg || '';
		else GameUI.toast(`❌ ${msg}`);
	}

	// ─── Realtime ─────────────────────────────────────────────────

	function _subscribe() {
		if (_channel) { _channel.unsubscribe(); _channel = null; }
		if (!supabaseClient || !_code) return;

		_channel = supabaseClient
			.channel(`session:${_code}`)
			.on('postgres_changes', {
				event: 'UPDATE',
				schema: 'public',
				table: 'sessions',
				filter: `join_code=eq.${_code}`
			}, payload => _onSessionUpdate(payload.new))
			.on('postgres_changes', {
				event: '*',
				schema: 'public',
				table: 'session_participants',
				filter: `session_id=eq.${_sessionId}`
			}, () => _refreshParticipants())
			.subscribe();
	}

	function _onSessionUpdate(session) {
		_renderStatus(session.status);

		if (session.status === 'active') {
			_onActive(session);
		} else if (session.status === 'reflection') {
			_onReflection();
		} else if (session.status === 'completed') {
			_onCompleted();
		}
	}

	function _onActive(session) {
		_stopPoll(); // session started, no need to poll lobby anymore

		// For participants: load and render the game from session data
		if (!_isHost && session.game_json && window.GameUI?.renderGame) {
			window.currentGame = session.game_json;
			GameUI.renderGame(session.game_json);
		}

		// Close the lobby modal so the game is visible
		_closeLobby();

		// Show notes block
		const notesBlock = document.getElementById('session-notes-block');
		if (notesBlock) {
			notesBlock.style.display = '';
			const saved = localStorage.getItem('givemegame_session_notes') || '';
			const ta = document.getElementById('session-notes-input');
			if (ta) ta.value = saved;
		}

		// Sync timer to server's timer_ends_at
		const msLeft  = new Date(session.timer_ends_at) - Date.now();
		const secLeft = Math.max(0, Math.round(msLeft / 1000));

		if (window.Timer && secLeft > 0) {
			const approxMin = Math.ceil(secLeft / 60);
			Timer.setup({ min: 0, max: approxMin });
			Timer.setRemaining(secLeft, approxMin * 60);

			Timer.setOnComplete(() => {
				// Move to reflection phase on this client
				_onReflection();
			});
			Timer.start();
		}
	}

	function _onReflection() {
		if (!window.currentGame) return;
		const modal = document.getElementById('reflection-modal');
		if (modal?.style.display === 'flex') return; // already open

		Reflection.open(window.currentGame, _code, () => {
			// After player submits reflection (multiplayer only — _code is set)
			if (_isHost) {
				_showCompleteButton();
				GameUI.toast(_t('sess_refl_sent_host',
					'✅ Reflexia uložená. Keď budú všetci hotoví, v lobby potvrď dokončenie session (Dokončiť).'));
			} else {
				GameUI.toast(_t('sess_refl_sent', '✅ Reflexia odoslaná! Čakaj na potvrdenie hostitela.'));
			}
		});
	}

	function _onCompleted() {
		GameUI.toast(_t('sess_completed', '🏆 Session dokončená! RPG odmeny udelené.'));
		if (window.Coins?.load) window.Coins.load();
		_loadAndRenderRpgHud();
		_fetchAndShowMyReward();
		_closeLobby();
		_channel?.unsubscribe();
		_channel = null;
		_clearPersist();
		_code = null; _sessionId = null; _isHost = false;
		localStorage.removeItem('givemegame_session_notes');
		const notesBlock = document.getElementById('session-notes-block');
		if (notesBlock) notesBlock.style.display = 'none';
	}

	// ─── Restore on page load (sticky session, refresh-safe) ─────────
	// Order of priority:
	//   1) ?lobby=CODE in URL → auto-join (if not already a participant) or just open lobby
	//   2) localStorage record → silently rehydrate channel + UI for current state
	async function restoreFromUrlOrStorage() {
		const params = new URLSearchParams(window.location.search);
		const urlCode = (params.get('lobby') || '').toUpperCase().trim();

		if (urlCode && urlCode.length === 6) {
			// Strip ?lobby= from URL so a future refresh doesn't keep re-triggering join
			params.delete('lobby');
			const cleanQs = params.toString();
			const cleanUrl = window.location.pathname + (cleanQs ? `?${cleanQs}` : '') + window.location.hash;
			history.replaceState({}, '', cleanUrl);

			const token = await _token();
			if (!token) {
				// Park the code so login flow can pick it up
				try { sessionStorage.setItem('givemegame_pending_lobby', urlCode); } catch {}
				GameUI.toast(_t('sess_login_join', 'Prihlás sa pre pripojenie'));
				return;
			}
			await _restoreOrJoin(urlCode);
			return;
		}

		// Pending lobby from pre-login redirect
		try {
			const pending = sessionStorage.getItem('givemegame_pending_lobby');
			if (pending) {
				sessionStorage.removeItem('givemegame_pending_lobby');
				const token = await _token();
				if (token) { await _restoreOrJoin(pending); return; }
			}
		} catch {}

		// Fallback: localStorage rehydration
		const saved = _readPersist();
		if (!saved) return;
		const token = await _token();
		if (!token) return;
		await _rehydrate(saved.code, saved.sessionId, saved.isHost);
	}

	// If user is already a participant of this code → just rehydrate. Otherwise call join.
	async function _restoreOrJoin(code) {
		const saved = _readPersist();
		if (saved && saved.code === code) {
			await _rehydrate(saved.code, saved.sessionId, saved.isHost);
			return;
		}
		// Probe session state — if active/completed, we cannot re-join cleanly
		const token = await _token();
		try {
			const probe = await fetchApi(`/api/sessions/${code}`, {
				headers: { 'Authorization': `Bearer ${token}` }
			});
			if (probe.status === 404) { GameUI.toast(_t('sess_not_found', '❌ Session neexistuje')); return; }
			const data = await probe.json();
			if (data.status === 'completed') { GameUI.toast(_t('sess_already_done', '⚠️ Session už skončila')); return; }
			if (data.status === 'waiting') { await join(code); return; }
			// active/reflection — try to join, server returns 409 if already started
			await join(code);
		} catch {
			await join(code); // best-effort
		}
	}

	// Rehydrate UI/channel for an existing membership without re-charging coins.
	async function _rehydrate(code, sessionId, isHost) {
		_code = code;
		_sessionId = sessionId;
		_isHost = !!isHost;

		const token = await _token();
		if (!token) return;
		try {
			const res = await fetchApi(`/api/sessions/${code}`, {
				headers: { 'Authorization': `Bearer ${token}` }
			});
			if (!res.ok) {
				// Session gone — clear stale storage
				_clearPersist();
				_code = null; _sessionId = null; _isHost = false;
				return;
			}
			const session = await res.json();

			// Verify this user actually belongs (host or participant) — server already filters via RLS
			const isParticipant = (session.participants || []).some(p => session.host_id && (p.user_id === session.host_id || true));
			// We can't strictly check user_id without /me; trust localStorage + RLS.

			_persist(); // refresh ts
			_lastKnownStatus = session.status;
			_subscribe();
			_startPoll();

			if (session.status === 'waiting') {
				_openLobby();
				await _refreshParticipants();
			} else if (session.status === 'active') {
				_onActive(session);
				GameUI.toast(_t('sess_resumed', '▶️ Pokračuješ v session'));
			} else if (session.status === 'reflection') {
				_onReflection();
			} else if (session.status === 'completed') {
				_onCompleted();
			}
		} catch (e) {
			// Network/transient — keep storage, retry next load
		}
	}

	function _shareUrl() {
		if (!_code) return '';
		return `${window.location.origin}/?lobby=${_code}`;
	}

	async function _copyShareLink() {
		const url = _shareUrl();
		if (!url) return;
		try {
			await navigator.clipboard.writeText(url);
			GameUI.toast(_t('sess_link_copied', '🔗 Odkaz skopírovaný'));
		} catch {
			window.prompt(_t('sess_link_manual', 'Skopíruj odkaz:'), url);
		}
	}

	async function _shareNative() {
		const url = _shareUrl();
		if (!url) return;
		const title = 'gIVEMEGAME.IO — pripoj sa do hry';
		const text = _t('sess_share_text', 'Hraj so mnou! Klikni na odkaz a pripoj sa do lobby (kód {code}).').replace('{code}', _code);
		if (navigator.share) {
			try { await navigator.share({ title, text, url }); return; } catch {}
		}
		_copyShareLink();
	}

	// ─── Lobby UI ─────────────────────────────────────────────────

	function _openLobby() {
		let modal = document.getElementById('session-lobby-modal');
		if (!modal) {
			modal = document.createElement('div');
			modal.id = 'session-lobby-modal';
			modal.className = 'modal-overlay';
			document.body.appendChild(modal);
		}
		modal.style.display = 'flex';
		_renderLobby();
	}

	function _renderLobby() {
		const modal = document.getElementById('session-lobby-modal');
		if (!modal) return;

		modal.innerHTML = `
			<div class="modal-box" style="max-width:480px">
				<div class="modal-header">
					<h3>🎮 Session Lobby</h3>
					<button class="modal-close" onclick="Session._closeLobby()" aria-label="${_t('close','Zavrieť')}">✕</button>
				</div>
				<div style="text-align:center;font-size:36px;letter-spacing:10px;padding:16px 0;
				            font-weight:700;color:var(--accent,#633cff)">${_code}</div>
				<p style="text-align:center;opacity:0.6;font-size:12px;margin-bottom:10px">
					${_t('sess_lobby_code_hint','Hráči zadajú tento kód · Vstup stojí {cost} 🪙').replace('{cost}', JOIN_COST)}
				</p>
				<div style="display:flex;gap:6px;margin-bottom:14px">
					<input id="lobby-share-url" readonly value="${_shareUrl()}"
						style="flex:1;font-size:11px;padding:8px;border-radius:6px;border:1px solid rgba(255,255,255,0.15);
						       background:rgba(0,0,0,0.25);color:var(--text,#fff)"
						onclick="this.select()">
					<button class="btn btn-retro" style="padding:6px 10px;font-size:12px"
					        onclick="Session._copyShareLink()" title="${_t('sess_copy_link','Skopírovať odkaz')}">📋</button>
				</div>
				<div id="lobby-status" style="text-align:center;font-size:13px;opacity:0.8;margin-bottom:12px">
					${_t('sess_status_waiting','⏳ Čakám na hráčov...')}
				</div>
				<div id="lobby-participants" style="margin-bottom:16px;min-height:40px"></div>
				${_isHost ? `
					<button id="btn-lobby-start" class="btn-primary" style="width:100%;margin-bottom:8px"
					        onclick="Session.start()">
						${_t('sess_btn_start','▶️ Štart — odráta {cost} 🪙 každému').replace('{cost}', JOIN_COST)}
					</button>
				` : `
					<p style="text-align:center;font-size:12px;opacity:0.5">
						${_t('sess_wait_host','Čakaj na štart hostitela...')}
					</p>
				`}
				<button id="btn-lobby-complete" class="btn-primary" style="width:100%;display:none"
				        onclick="Session.complete()">
					${_t('sess_btn_complete','✅ Potvrdiť dokončenie a udeliť body')}
				</button>
			</div>`;
	}

	function _renderStatus(status) {
		const el = document.getElementById('lobby-status');
		if (!el) return;
		const labels = {
			waiting:    _t('sess_status_waiting',    '⏳ Čakám na hráčov...'),
			active:     _t('sess_status_active',     '🔥 Hra prebieha!'),
			reflection: _t('sess_status_reflection', '🧠 Reflexia — vypĺňajte formulár'),
			completed:  _t('sess_status_completed',  '🏆 Dokončené!')
		};
		el.textContent = labels[status] || status;
	}

	async function _refreshParticipants() {
		if (!_code) return;
		const token = await _token();
		if (!token) return;
		try {
			const res = await fetchApi(`/api/sessions/${_code}`, {
				headers: { 'Authorization': `Bearer ${token}` }
			});
			if (!res.ok) return;
			const data = await res.json();
			_renderParticipants(data.participants || []);
			_renderStatus(data.status);
			// Realtime fallback: detect status change via polling
			if (data.status && data.status !== _lastKnownStatus) {
				_lastKnownStatus = data.status;
				_onSessionUpdate(data);
			}
		} catch (e) { /* silent */ }
	}

	function _renderParticipants(list) {
		const el = document.getElementById('lobby-participants');
		if (!el) return;
		if (!list.length) {
			el.innerHTML = `<p style="opacity:0.4;text-align:center;font-size:12px">${_t('sess_no_players','Žiadni hráči ešte...')}</p>`;
			return;
		}
		const nameFb   = _t('sess_player_fallback', 'Hráč');
		const reflLabel = _t('sess_refl_label', 'reflexia');
		el.innerHTML = list.map(p => `
			<div style="display:flex;justify-content:space-between;align-items:center;
			            padding:7px 0;border-bottom:1px solid rgba(255,255,255,0.06);font-size:13px">
				<span>${p.display_name || nameFb}</span>
				<span style="opacity:0.5">${p.reflection_done ? `✅ ${reflLabel}` : '⏳'}</span>
			</div>`).join('');
	}

	function _showCompleteButton() {
		const btn = document.getElementById('btn-lobby-complete');
		if (btn) btn.style.display = '';
	}

	function _closeLobby() {
		const modal = document.getElementById('session-lobby-modal');
		if (modal) modal.style.display = 'none';
		_stopPoll();
	}

	function _startPoll() {
		_stopPoll();
		// Poll every 4s as fallback in case Realtime subscription misses events
		_pollTimer = setInterval(() => _refreshParticipants(), 4000);
	}

	function _stopPoll() {
		if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
	}

	// ─── Helpers ──────────────────────────────────────────────────

	async function _token() {
		try {
			const { data: { session } } = await Promise.race([
				supabaseClient.auth.getSession(),
				new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 8000))
			]);
			return session?.access_token || null;
		} catch { return null; }
	}

	async function fetchApi(url, opts = {}, ms = 12000) {
		const ctrl = new AbortController();
		const t = setTimeout(() => ctrl.abort(), ms);
		try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
		finally { clearTimeout(t); }
	}

	async function _loadAndRenderRpgHud() {
		try {
			if (!window.RpgTalents?.load || !GameUI.renderRpgHudFromTalents) return;
			const data = await RpgTalents.load();
			if (data) GameUI.renderRpgHudFromTalents(data);
		} catch (e) { /* silent */ }
	}

	// Fetch this participant's own level changes after session completion.
	// Skipped for hosts — they already received my_level_changes in the /complete response.
	async function _fetchAndShowMyReward() {
		if (_isHost || !_code) return;
		try {
			await _loadAndRenderRpgHud();
			if (window.RpgScreen?.refresh) await RpgScreen.refresh();
		} catch (e) { /* silent */ }
	}

	function isInSession() {
		return !!_code;
	}

	return {
		create, join, start, complete, openJoinDialog,
		_closeLobby, _submitJoin, _closeJoinModal,
		_copyShareLink, _shareNative,
		restoreFromUrlOrStorage, isInSession
	};
})();

window.Session = Session;
