/* ═══════════════════════════════════════════════════════════════════
   gIVEMEGAME.IO — Session module (Phase 4 + Phase 6 Online)

   Manages multiplayer game sessions: create, join (account or guest),
   lobby, realtime sync, presence and the slow fallback poll.

   The server owns the state machine (lib/routes/sessions.js):
     waiting → active → reflection → completing → completed | expired
   This client only shows the state the server reports. It keeps
   Supabase Realtime (signed-in users) plus a slow heartbeat poll in
   every phase, so phones without a websocket still see changes.

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
	const SLOW_POLL_MS = 10000;  // heartbeat + status check in every phase
	const MAX_PLAYER_CHOICES = [2, 4, 6, 8, 10, 15, 20, 30, 40]; // = lib/session-state.js

	// Resolve translation at call-time so language changes are respected
	const _t = (key, fallback) => (window.givemegame_t || ((k, f) => f || k))(key, fallback);

	let _code       = null;  // current session join_code
	let _sessionId  = null;  // current session uuid
	let _isHost     = false;
	let _role       = null;  // 'host' | 'player' | 'guest'
	let _guestToken = null;  // only for guests (no account)
	let _channel    = null;  // Supabase Realtime channel
	let _pollTimer  = null;  // fast lobby poll (participants) while the lobby is open
	let _slowTimer  = null;  // slow heartbeat poll, every phase
	let _lastKnownStatus = 'waiting';
	let _lastSession = null; // last full GET /api/sessions/:code
	let _wakeLock = null;
	let _restoring = null;
	let _activeModal = null;
	let _modalReturnFocus = null;
	let _inertedBackground = [];

	function _persist() {
		if (!_code || !_sessionId) return;
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify({
				code: _code, sessionId: _sessionId, isHost: _isHost, role: _role,
				guestToken: _guestToken || null, ts: Date.now()
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

	const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
		'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
	}[c]));

	function setFocusedState(active) {
		const focused = Boolean(active);
		document.body.classList.toggle('session-focused', focused);
		if (focused) document.body.classList.remove('mobile-filters-open', 'mobile-smarta-open');
	}

	function _modalFocusables(modal) {
		if (!modal || typeof modal.querySelectorAll !== 'function') return [];
		return Array.from(modal.querySelectorAll(
			'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
		)).filter((element) => !element.hidden && !element.disabled);
	}

	function _handleModalKeydown(event) {
		if (!_activeModal) return;
		if (event.key === 'Escape') {
			event.preventDefault();
			if (_activeModal.id === 'session-join-modal') _closeJoinModal();
			else if (_activeModal.id === 'session-lobby-modal') _closeLobby();
			return;
		}
		if (event.key !== 'Tab') return;

		const focusables = _modalFocusables(_activeModal);
		if (!focusables.length) return;
		const first = focusables[0];
		const last = focusables[focusables.length - 1];
		if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		} else if (!_activeModal.contains(document.activeElement)) {
			event.preventDefault();
			first.focus();
		}
	}

	function _activateModal(modal, initialFocusId) {
		if (!modal) return;
		if (_activeModal && _activeModal !== modal) _deactivateModal(_activeModal, false);
		_modalReturnFocus = document.activeElement && !modal.contains(document.activeElement)
			? document.activeElement
			: null;
		_inertedBackground = Array.from(document.body?.children || [])
			.filter((element) => element !== modal)
			.map((element) => ({ element, inert: Boolean(element.inert) }));
		_inertedBackground.forEach(({ element }) => { element.inert = true; });
		_activeModal = modal;
		setTimeout(() => document.getElementById(initialFocusId)?.focus(), 50);
	}

	function _deactivateModal(modal, restoreFocus = true) {
		if (!modal || _activeModal !== modal) return;
		_inertedBackground.forEach(({ element, inert }) => { element.inert = inert; });
		_inertedBackground = [];
		_activeModal = null;
		const returnFocus = _modalReturnFocus;
		_modalReturnFocus = null;
		if (restoreFocus && returnFocus?.isConnected !== false && typeof returnFocus?.focus === 'function') {
			returnFocus.focus();
		}
	}

	// ─── Auth headers: signed-in user or guest token ──────────────

	async function authHeaders() {
		const token = await _token();
		if (token) return { 'Authorization': `Bearer ${token}` };
		if (_guestToken) return { 'X-Guest-Token': _guestToken };
		return null;
	}

	function _setRole(role) {
		_role = role || null;
		_isHost = role === 'host';
	}

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
				// Lobby size, guests and play style are set in the lobby (POST /settings).
				body: JSON.stringify({ game_json: gameJson })
			});
			const data = await res.json();
			if (!res.ok) { GameUI.toast(`❌ ${data.error}`); return; }

			_code      = data.join_code;
			_sessionId = data.id;
			_guestToken = null;
			_setRole('host');
			_lastKnownStatus = 'waiting';
			_lastSession = { status: 'waiting', play_style: data.play_style, max_players: data.max_players,
				allow_guests: data.allow_guests !== false, participants: [] };
			_persist();

			_openLobby();
			_subscribe();
			_startPoll();
			_startSlowPoll();
			await _refreshParticipants();
		} catch (err) {
			GameUI.toast(`❌ ${err.message}`);
		}
	}

	/**
	 * @param {string} rawCode
	 * @param {{ nickname?: string }} [opts] — guests without an account
	 */
	async function join(rawCode, opts = {}) {
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
		const nickname = String(opts.nickname || '').trim();
		if (!token && !nickname) {
			_setJoinLoading(false);
			_setJoinError(_t('sess_login_or_nick', 'Prihlás sa, alebo zadaj prezývku a hraj ako hosť.'));
			return;
		}

		try {
			const res = token
				? await fetchApi(`/api/sessions/${code}/join`, {
					method: 'POST',
					headers: { 'Authorization': `Bearer ${token}` }
				})
				: await fetchApi(`/api/sessions/${code}/join-guest`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ nickname })
				});
			const data = await res.json();
			if (!res.ok) {
				_setJoinLoading(false);
				_setJoinError(_joinErrorText(data, res.status));
				return;
			}

			_code      = code;
			_sessionId = data.session_id;
			_guestToken = token ? null : data.guest_token;
			_setRole(data.role || (token ? 'player' : 'guest'));
			_persist();
			_closeJoinModal();

			if (data.role === 'host' || data.rejoined) {
				// Host on another device, or a player's second device: resume, never re-pay.
				await _rehydrate(code, _sessionId);
				return;
			}
			if (_role === 'guest') {
				GameUI.toast(_t('sess_guest_joined', '👋 Si v hre ako hosť. Hosť nezískava coiny ani XP.'));
			}
			_lastKnownStatus = data.status || 'waiting';
			_openLobby();
			_subscribe();
			_startPoll();
			_startSlowPoll();
			await _refreshParticipants();
		} catch (err) {
			_setJoinLoading(false);
			_setJoinError(err.name === 'AbortError'
				? _t('sess_timeout', 'Server neodpovedal — skús znova')
				: err.message);
		}
	}

	function _joinErrorText(data, status) {
		const byCode = {
			LOBBY_FULL: _t('sess_err_full', 'Lobby je plné.'),
			ALREADY_STARTED: _t('sess_err_started', 'Hra už beží. Pripojiť sa dá len pred štartom.'),
			EXPIRED: _t('sess_err_expired', 'Táto hra už skončila.'),
			GUESTS_DISABLED: _t('sess_err_no_guests', 'Hostiteľ dovolil len hráčov s účtom. Prihlás sa.'),
			BAD_NICKNAME: _t('sess_err_nick', 'Prezývka musí mať 2 až 24 znakov.'),
			NOT_FOUND: _t('sess_not_found', '❌ Session neexistuje'),
			RATE_LIMITED: _t('sess_err_rate', 'Príliš veľa pokusov. Skús to o chvíľu.'),
		};
		return byCode[data?.code] || data?.error || `Chyba ${status}`;
	}

	async function start() {
		if (!_isHost || !_code) return;
		const token = await _token();
		if (!token) return;

		// Disable button immediately so mobile users don't double-tap
		const startBtn = document.getElementById('btn-lobby-start');
		if (startBtn) { startBtn.disabled = true; startBtn.textContent = '⏳ ' + _t('sess_starting', 'Štartujem...'); }

		try {
			const res = await fetchApi(`/api/sessions/${_code}/start`, {
				method: 'POST',
				headers: { 'Authorization': `Bearer ${token}` }
			});
			const data = await res.json();
			if (!res.ok) {
				if (startBtn) { startBtn.disabled = false; startBtn.textContent = _t('sess_btn_start','▶️ Štart — odráta {cost} 🪙 každému').replace('{cost}', JOIN_COST); }
				GameUI.toast(`❌ ${data.error}`);
				return;
			}
			// Honest summary: who paid, who could not, who was gone.
			let msg = _t('sess_started_paid', '▶️ Hra beží! Zaplatilo {paid} hráčov.').replace('{paid}', data.participants_charged ?? 0);
			if (data.participants_unpaid) msg += ' ' + _t('sess_started_unpaid', '{n} nemalo dosť coinov — hrajú bez odmeny.').replace('{n}', data.participants_unpaid);
			if (data.participants_absent) msg += ' ' + _t('sess_started_absent', '{n} neboli pripojení — nič sme im neodrátali.').replace('{n}', data.participants_absent);
			GameUI.toast(msg);
			// Mobile-safe: don't wait for realtime — fetch the session and update now.
			await _fetchFullAndUpdate();
		} catch (err) {
			if (startBtn) { startBtn.disabled = false; startBtn.textContent = _t('sess_btn_start','▶️ Štart — odráta {cost} 🪙 každému').replace('{cost}', JOIN_COST); }
			GameUI.toast(`❌ ${err.message}`);
		}
	}

	async function openReflectionForAll() {
		if (!_isHost || !_code) return;
		const token = await _token();
		if (!token) return;
		try {
			const res = await fetchApi(`/api/sessions/${_code}/reflection`, {
				method: 'POST',
				headers: { 'Authorization': `Bearer ${token}` }
			});
			const data = await res.json();
			if (!res.ok) { GameUI.toast(`❌ ${data.error}`); return; }
			await _fetchFullAndUpdate();
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

			let msg = _t('sess_end_success', '🏆 Session ukončená! {count} hráčov dostalo odmeny.').replace('{count}', data.participants_rewarded ?? '?');
			if (data.host_xp_awarded > 0) msg += ' ' + _t('sess_host_xp', 'Ty si získal +{xp} XP.').replace('{xp}', data.host_xp_awarded);
			GameUI.toast(msg);
			if (window.Coins?.load) window.Coins.load();
			_loadAndRenderRpgHud();
			if (GameUI.updateGameCardStats) GameUI.updateGameCardStats(data);
			if (data.my_rpg_level_up && GameUI.toast) {
				GameUI.toast(_t('rpg_level_up_toast', '⭐ Nový RPG level!'));
			}
			if (data.rpg_xp_gained > 0 && window.RpgXpFx) RpgXpFx.trigger(data.rpg_xp_gained, '⚔️ Session dokončená');
			_cleanup();
		} catch (err) {
			GameUI.toast(`❌ ${err.message}`);
		}
	}

	async function _saveSettings() {
		if (!_isHost || !_code) return;
		const token = await _token();
		if (!token) return;
		const maxSel = document.getElementById('lobby-max-players');
		const guestsBox = document.getElementById('lobby-allow-guests');
		const styleSel = document.getElementById('lobby-play-style');
		const body = {};
		if (maxSel) body.max_players = parseInt(maxSel.value, 10);
		if (guestsBox) body.allow_guests = !!guestsBox.checked;
		if (styleSel) body['play_style'] = styleSel.value;
		try {
			const res = await fetchApi(`/api/sessions/${_code}/settings`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
				body: JSON.stringify(body)
			});
			const data = await res.json();
			if (!res.ok) { GameUI.toast(`❌ ${data.error}`); return; }
			_lastSession = { ...(_lastSession || {}), ...data };
			GameUI.toast(_t('sess_settings_saved', '✅ Nastavenie uložené'));
		} catch (err) {
			GameUI.toast(`❌ ${err.message}`);
		}
	}

	// ─── Join modal (account or guest nickname) ──────────────────

	function openJoinDialog(prefillCode) {
		let modal = document.getElementById('session-join-modal');
		if (!modal) {
			modal = document.createElement('div');
			modal.id = 'session-join-modal';
			modal.className = 'modal-overlay session-modal';
			modal.addEventListener('keydown', _handleModalKeydown);
			document.body.appendChild(modal);
		}
		const code = typeof prefillCode === 'string' ? esc(prefillCode.toUpperCase().slice(0, 6)) : '';
		modal.hidden = false;
		modal.innerHTML = `
			<div class="session-dialog session-dialog--join" role="dialog" aria-modal="true" aria-labelledby="session-join-title">
				<header class="session-dialog__header">
					<h2 id="session-join-title">🎮 ${_t('sess_join_title','Pripojiť sa k session')}</h2>
				</header>
				<p class="session-dialog__hint">
					${_t('sess_join_hint','Zadaj 6-znakový kód od hostitela')}
				</p>
				<input id="join-code-input" class="session-code-input" type="text" maxlength="6"
					placeholder="XXXXXX" value="${code}" aria-label="${_t('sess_code_label','Kód hry')}"
					oninput="this.value=this.value.toUpperCase().replace(/[^A-Z0-9]/g,'')"
					onkeydown="if(event.key==='Enter')Session._submitJoin()">
				<label class="session-field" for="join-nick-input">${_t('sess_nick_label','Prezývka (len ak nemáš účet)')}</label>
				<input id="join-nick-input" class="session-nick-input" type="text" maxlength="24" autocomplete="nickname"
					onkeydown="if(event.key==='Enter')Session._submitJoin()">
				<p class="session-dialog__hint session-dialog__hint--small">
					${_t('sess_guest_hint','Bez účtu hráš ako hosť: zadarmo, ale bez coinov a XP.')}
				</p>
				<div id="join-error" class="session-dialog__error" aria-live="polite"></div>
				<div class="session-actions">
					<button class="btn btn-retro session-action session-action--secondary" onclick="Session._closeJoinModal()">${_t('cancel','Zrušiť')}</button>
					<button id="btn-join-submit" class="btn btn-retro session-action session-action--primary"
					        onclick="Session._submitJoin()">
						${_t('sess_btn_join','Pripojiť sa')} · ${JOIN_COST} 🪙
					</button>
				</div>
			</div>`;
		_activateModal(modal, 'join-code-input');
	}

	function _submitJoin() {
		const input = document.getElementById('join-code-input');
		const nick = document.getElementById('join-nick-input');
		if (input) join(input.value, { nickname: nick?.value || '' });
	}

	function _closeJoinModal() {
		const modal = document.getElementById('session-join-modal');
		if (modal) modal.hidden = true;
		_deactivateModal(modal);
	}

	function _setJoinLoading(on) {
		const btn = document.getElementById('btn-join-submit');
		const input = document.getElementById('join-code-input');
		if (btn) { btn.disabled = on; btn.textContent = on ? '⏳ ' + _t('sess_joining', 'Pripájam...') : `${_t('sess_btn_join','Pripojiť sa')} · ${JOIN_COST} 🪙`; }
		if (input) input.disabled = on;
	}

	function _setJoinError(msg) {
		const el = document.getElementById('join-error');
		if (el) el.textContent = msg || '';
		else GameUI.toast(`❌ ${msg}`);
	}

	// ─── Realtime (signed-in users) ──────────────────────────────

	function _subscribe() {
		if (_channel) { _channel.unsubscribe(); _channel = null; }
		// Guests have no Supabase session, so RLS hides the rows: they use the poll.
		if (typeof supabaseClient === 'undefined' || !supabaseClient || !_code || _role === 'guest') return;

		_channel = supabaseClient
			.channel(`session:${_code}`)
			.on('postgres_changes', {
				event: 'UPDATE',
				schema: 'public',
				table: 'sessions',
				filter: `join_code=eq.${_code}`
			}, payload => _onRealtimeSessionUpdate(payload.new))
			.on('postgres_changes', {
				event: '*',
				schema: 'public',
				table: 'session_participants',
				filter: `session_id=eq.${_sessionId}`
			}, () => _refreshParticipants())
			.subscribe();
	}

	// Realtime UPDATE rows can omit unchanged large (TOASTed) columns, so a
	// status-only change may arrive without game_json. Fetch the full session.
	async function _onRealtimeSessionUpdate(row) {
		if (!row?.status || row.status === _lastKnownStatus) return;
		await _fetchFullAndUpdate();
	}

	async function _fetchFull() {
		if (!_code) return null;
		const headers = await authHeaders();
		if (!headers) return null;
		const res = await fetchApi(`/api/sessions/${_code}`, { headers });
		if (!res.ok) return { _status: res.status };
		const data = await res.json();
		if (!data.preview) _lastSession = data;
		return data;
	}

	async function _fetchFullAndUpdate() {
		try {
			const full = await _fetchFull();
			if (full && !full._status && !full.preview) _onSessionUpdate(full);
		} catch { /* the slow poll will catch up */ }
	}

	function _onSessionUpdate(session) {
		const changed = session.status !== _lastKnownStatus;
		_lastKnownStatus = session.status;
		_renderStatus(session.status);
		if (changed) _renderLobbyActions();

		if (session.status === 'active') {
			_onActive(session);
		} else if (session.status === 'reflection') {
			_onReflection(session);
		} else if (session.status === 'completed') {
			_onCompleted();
		} else if (session.status === 'expired') {
			_onExpired(session);
		}
	}

	function _ensureGame(session) {
		if (session?.game_json && window.GameUI?.renderGame) {
			if (!window.currentGame || !_isHost) {
				window.currentGame = session.game_json;
				GameUI.renderGame(session.game_json);
			}
		}
	}

	function _onActive(session) {
		_stopPoll(); // lobby list poll; the slow poll keeps running
		setFocusedState(true);
		// Host keeps the local game (often already on screen); players get session.game_json.
		_ensureGame(session);

		_closeLobby();
		_showSessionBadge();
		_acquireWakeLock();

		const notesBlock = document.getElementById('session-notes-block');
		if (notesBlock) {
			notesBlock.style.display = '';
			const saved = localStorage.getItem('givemegame_session_notes') || '';
			const ta = document.getElementById('session-notes-input');
			if (ta) ta.value = saved;
		}

		// Sync timer to server's timer_ends_at; M10: open reflection when time is up.
		const msLeft  = new Date(session.timer_ends_at) - Date.now();
		const secLeft = Math.max(0, Math.round(msLeft / 1000));
		if (!(secLeft > 0)) {
			_onReflection(session);
			return;
		}
		if (window.Timer) {
			const approxMin = Math.ceil(secLeft / 60);
			Timer.setup({ min: 0, max: approxMin });
			Timer.setRemaining(secLeft, approxMin * 60);
			Timer.setOnComplete(() => {
				_onReflection(session);
				_slowTick(); // the server opens reflection for everyone
			});
			Timer.start();
		}
	}

	function _onReflection(session) {
		setFocusedState(true);
		_ensureGame(session || _lastSession);
		_showSessionBadge();
		if (!window.currentGame || !window.Reflection) return;
		if (_lastSession?.me?.reflection_done) return;
		const modal = document.getElementById('reflection-modal');
		if (modal?.style.display === 'flex') return; // already open

		Reflection.open(window.currentGame, _code, () => {
			if (_lastSession?.me) _lastSession.me.reflection_done = true;
			if (_isHost) {
				_renderLobbyActions();
				GameUI.toast(_t('sess_refl_sent_host',
					'✅ Reflexia uložená. Keď budú všetci hotoví, v lobby potvrď dokončenie session (Dokončiť).'));
			} else {
				GameUI.toast(_t('sess_refl_sent', '✅ Reflexia odoslaná! Čakaj na potvrdenie hostitela.'));
			}
		});
	}

	async function _onCompleted() {
		const role = _role;
		const code = _code;
		const me = _lastSession?.me || null;
		_cleanup();
		if (role === 'host') return; // the host already saw the result of /complete
		if (role === 'guest') {
			GameUI.toast(_t('sess_done_guest', '🏁 Hra skončila. Hosť bez účtu nezískava coiny ani XP.'));
			return;
		}
		if (window.Coins?.load) window.Coins.load();
		_loadAndRenderRpgHud();
		// Honest result for this player only.
		try {
			const headers = await authHeaders();
			const res = headers ? await fetchApi(`/api/sessions/${code}/my-reward`, { headers }) : null;
			const data = res && res.ok ? await res.json() : null;
			const awarded = data?.awarded || {};
			if (awarded.rpg && awarded.xp > 0) {
				GameUI.toast(_t('sess_done_xp', '🏆 Hra dokončená! +{xp} XP a vrátené coiny.').replace('{xp}', awarded.xp));
				if (window.RpgXpFx) RpgXpFx.trigger(awarded.xp, '⚔️ Session dokončená');
			} else if (awarded.rpg) {
				GameUI.toast(_t('sess_done_capped', '🏆 Hra dokončená! Coiny sú späť. Dnešné XP zo session už máš.'));
			} else if (me && !me.paid) {
				GameUI.toast(_t('sess_done_unpaid', '🏁 Hra skončila. Bez zaplateného vstupu nie je odmena.'));
			} else {
				GameUI.toast(_t('sess_done_no_reflection', '🏁 Hra skončila. Bez reflexie nie je odmena.'));
			}
			if (window.RpgScreen?.refresh) await RpgScreen.refresh();
		} catch { /* silent */ }
	}

	function _onExpired(session) {
		const reason = session?.expire_reason;
		_cleanup();
		GameUI.toast(reason === 'host_cancelled'
			? _t('sess_cancelled', '⛔ Hostiteľ hru zrušil. Ak si platil, coiny sa vrátili.')
			: _t('sess_expired', '⌛ Hra vypršala. Ak si platil, coiny sa vrátili.'));
		if (window.Coins?.load) window.Coins.load();
	}

	function _cleanup() {
		_stopPoll();
		_stopSlowPoll();
		try { _channel?.unsubscribe(); } catch {}
		_channel = null;
		_releaseWakeLock();
		_clearPersist();
		_closeLobby();
		_hideSessionBadge();
		setFocusedState(false);
		_code = null; _sessionId = null; _guestToken = null; _lastSession = null;
		_setRole(null);
		_lastKnownStatus = 'waiting';
		try { localStorage.removeItem('givemegame_session_notes'); } catch {}
		const notesBlock = document.getElementById('session-notes-block');
		if (notesBlock) notesBlock.style.display = 'none';
	}

	// ─── Restore on page load (sticky session, refresh-safe) ─────────
	// Order of priority:
	//   1) ?lobby=CODE in URL → resume (host/member) or join
	//   2) localStorage record → rehydrate; the server says which role we have
	function restoreFromUrlOrStorage() {
		// Called from init() and from the SIGNED_IN handler: run once at a time.
		if (_restoring) return _restoring;
		_restoring = _restore().finally(() => { _restoring = null; });
		return _restoring;
	}

	async function _restore() {
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
				const saved = _readPersist();
				if (saved?.guestToken && saved.code === urlCode) {
					await _rehydrateFromStorage(saved);
					return;
				}
				// Park the code so login flow can pick it up, and offer guest play.
				try { sessionStorage.setItem('givemegame_pending_lobby', urlCode); } catch {}
				GameUI.toast(_t('sess_login_or_guest', 'Prihlás sa, alebo sa pripoj ako hosť s prezývkou.'));
				if (typeof document.createElement === 'function') openJoinDialog(urlCode);
				return;
			}
			await _restoreOrJoin(urlCode);
			return;
		}

		if (_code) return; // already in a session on this page

		// Pending lobby from pre-login redirect
		try {
			const pending = sessionStorage.getItem('givemegame_pending_lobby');
			if (pending) {
				const token = await _token();
				if (token) {
					await _restoreOrJoin(pending);
					sessionStorage.removeItem('givemegame_pending_lobby');
					return;
				}
			}
		} catch {}

		const saved = _readPersist();
		if (saved) await _rehydrateFromStorage(saved);
	}

	async function _rehydrateFromStorage(saved) {
		_guestToken = saved.guestToken || null;
		const headers = await authHeaders();
		if (!headers) { _guestToken = null; return; }
		await _rehydrate(saved.code, saved.sessionId);
	}

	// Member (host, player, guest) → resume. Otherwise join while waiting.
	async function _restoreOrJoin(code) {
		const token = await _token();
		try {
			const probe = await fetchApi(`/api/sessions/${code}`, {
				headers: { 'Authorization': `Bearer ${token}` }
			});
			if (probe.status === 404) { GameUI.toast(_t('sess_not_found', '❌ Session neexistuje')); return; }
			const data = await probe.json();
			if (data.my_role) { await _rehydrate(code, data.id, data); return; }
			if (data.status === 'waiting') { await join(code); return; }
			if (data.status === 'completed' || data.status === 'expired') {
				GameUI.toast(_t('sess_already_done', '⚠️ Session už skončila'));
				return;
			}
			GameUI.toast(_t('sess_err_started', 'Hra už beží. Pripojiť sa dá len pred štartom.'));
		} catch {
			await join(code); // best-effort
		}
	}

	/**
	 * Rehydrate UI/channel for an existing membership without re-charging.
	 * The role comes from the server (host_id / participant row), so a host can
	 * resume from any device.
	 */
	async function _rehydrate(code, sessionId, known) {
		_code = code;
		_sessionId = sessionId || _sessionId;
		try {
			const session = known || await _fetchFull();
			if (!session || session._status || !session.my_role) {
				// Gone or not a member — clear stale storage
				_cleanup();
				return;
			}
			_lastSession = session;
			_sessionId = session.id || _sessionId;
			_setRole(session.my_role);
			_persist();
			_lastKnownStatus = session.status;
			_subscribe();
			_startSlowPoll();

			if (session.status === 'waiting') {
				_openLobby();
				_startPoll();
				_renderParticipants(session.participants || []);
			} else if (session.status === 'active') {
				_onActive(session);
				GameUI.toast(_t('sess_resumed', '▶️ Pokračuješ v session'));
				if (session.me && !session.me.paid) {
					GameUI.toast(_t('sess_playing_unpaid', 'Nebol si pri štarte, hráš bez odmeny.'));
				}
			} else if (session.status === 'reflection') {
				_onReflection(session);
			} else if (session.status === 'completing') {
				_showSessionBadge();
			} else if (session.status === 'completed') {
				_onCompleted();
			} else if (session.status === 'expired') {
				_onExpired(session);
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
			modal.className = 'modal-overlay session-modal';
			// Backdrop click closes the lobby — important on mobile.
			modal.addEventListener('click', (e) => {
				if (e.target === modal) _closeLobby();
			});
			modal.addEventListener('keydown', _handleModalKeydown);
			document.body.appendChild(modal);
		}
		setFocusedState(true);
		_showSessionBadge();
		modal.hidden = false;
		_renderLobby();
		_activateModal(modal, 'session-lobby-close');
	}

	// In-game floating badge: re-open the lobby or leave at any moment.
	function _showSessionBadge() {
		let badge = document.getElementById('session-badge');
		if (!badge) {
			badge = document.createElement('div');
			badge.id = 'session-badge';
			badge.className = 'session-badge';
			document.body.appendChild(badge);
		}
		badge.innerHTML = `
			<span class="session-badge__code">${_role === 'guest' ? '👤' : '🎮'} ${esc(_code)}</span>
			<button onclick="event.stopPropagation();Session._openLobbyFromBadge()"
			        class="session-badge__action session-badge__action--open"
			        aria-label="${_t('sess_open_lobby','Otvoriť lobby')}">📋</button>
			<button onclick="event.stopPropagation();Session._quitSession()"
			        class="session-badge__action session-badge__action--leave"
			        aria-label="${_t('sess_quit','Opustiť session')}">✕</button>
		`;
		badge.hidden = false;
	}

	function _hideSessionBadge() {
		const badge = document.getElementById('session-badge');
		if (badge) badge.hidden = true;
	}

	function _openLobbyFromBadge() {
		if (!_code) return;
		_openLobby();
		if (_lastKnownStatus === 'waiting') _startPoll();
		_refreshParticipants();
	}

	// ✕ on the badge. A player leaves (before start nothing is charged); the
	// host cancels the game for everyone (payers get their coins back).
	function _quitSession() {
		const host = _isHost;
		const ask = host
			? _t('sess_cancel_confirm', 'Zrušiť hru pre všetkých? Kto zaplatil, dostane coiny späť.')
			: _t('sess_leave_confirm', 'Odísť z hry? Pred štartom ti nič neodrátame.');
		if (!confirm(ask)) return;
		const code = _code;
		const guestToken = _guestToken;
		_cleanup();
		GameUI.toast(host
			? _t('sess_cancel_done', '⛔ Hra je zrušená')
			: _t('sess_quit_done', '👋 Opustil si session'));
		if (code) _sendLeave(code, guestToken);
	}

	async function _sendLeave(code, guestToken) {
		try {
			const token = await _token();
			const headers = token ? { 'Authorization': `Bearer ${token}` }
				: (guestToken ? { 'X-Guest-Token': guestToken } : null);
			if (!headers) return;
			await fetchApi(`/api/sessions/${code}/leave`, { method: 'POST', headers });
		} catch { /* the server expires the session or ignores the stale player */ }
	}

	function _playStyleLabel(style) {
		return String(style) === 'online'
			? _t('sess_style_online', '🌐 Online — každý na svojom mobile alebo počítači')
			: _t('sess_style_room', '🏫 V jednej miestnosti — hra na tabuli');
	}

	function _renderLobby() {
		const modal = document.getElementById('session-lobby-modal');
		if (!modal) return;

		modal.innerHTML = `
			<div class="session-dialog session-dialog--lobby" role="dialog" aria-modal="true" aria-labelledby="session-lobby-title" onclick="event.stopPropagation()">
				<header class="session-dialog__header">
					<h2 id="session-lobby-title">🎮 Session Lobby</h2>
					<button id="session-lobby-close" class="modal-close" onclick="Session._closeLobby()" aria-label="${_t('close','Zavrieť')}"
					        type="button">✕</button>
				</header>
				<div class="session-code">${esc(_code)}</div>
				<p class="session-dialog__hint">
					${_t('sess_lobby_code_hint','Hráči zadajú tento kód · Vstup stojí {cost} 🪙').replace('{cost}', JOIN_COST)}
				</p>
				<div class="session-share">
					<input id="lobby-share-url" class="session-share__url" readonly value="${esc(_shareUrl())}"
						aria-label="${_t('sess_copy_link','Skopírovať odkaz')}" onclick="this.select()">
					<button class="btn btn-retro session-share__copy"
						        onclick="Session._copyShareLink()" title="${_t('sess_copy_link','Skopírovať odkaz')}">📋</button>
				</div>
				<div id="lobby-settings" class="session-settings"></div>
				<div id="lobby-status" class="session-status" aria-live="polite">
					${_t('sess_status_waiting','⏳ Čakám na hráčov...')}
				</div>
				<div id="lobby-participants" class="session-participants" aria-live="polite"></div>
				<div id="lobby-actions"></div>
			</div>`;
		_renderLobbyActions();
		_renderStatus(_lastKnownStatus);
		if (_lastSession?.participants) _renderParticipants(_lastSession.participants);
	}

	// Settings + action buttons depend on role and status; re-rendered only
	// when the status changes so a host's open <select> is not destroyed.
	function _renderLobbyActions() {
		const settings = document.getElementById('lobby-settings');
		const actions = document.getElementById('lobby-actions');
		const s = _lastSession || {};
		const status = _lastKnownStatus;

		if (settings) {
			if (_isHost && status === 'waiting') {
				const max = s.max_players || 10;
				const options = MAX_PLAYER_CHOICES.map((n) =>
					`<option value="${n}"${n === max ? ' selected' : ''}>${n}</option>`).join('');
				settings.innerHTML = `
					<label class="session-field" for="lobby-play-style">${_t('sess_style_label','Ako hráte?')}</label>
					<select id="lobby-play-style" class="session-select" onchange="Session._saveSettings()">
						<option value="room"${s.play_style !== 'online' ? ' selected' : ''}>${_playStyleLabel('room')}</option>
						<option value="online"${String(s.play_style) === 'online' ? ' selected' : ''}>${_playStyleLabel('online')}</option>
					</select>
					<label class="session-field" for="lobby-max-players">${_t('sess_max_label','Najviac hráčov')}</label>
					<select id="lobby-max-players" class="session-select" onchange="Session._saveSettings()">${options}</select>
					<label class="session-field session-field--check">
						<input id="lobby-allow-guests" type="checkbox"${s.allow_guests !== false ? ' checked' : ''} onchange="Session._saveSettings()">
						${_t('sess_allow_guests','Povoliť hostí bez účtu (bez coinov a XP)')}
					</label>`;
			} else if (s.play_style) {
				settings.innerHTML = `<p class="session-dialog__hint">${_playStyleLabel(s.play_style)}</p>`;
			} else {
				settings.innerHTML = '';
			}
		}

		if (!actions) return;
		if (_isHost) {
			const startLbl = _t('sess_btn_start','▶️ Štart — odráta {cost} 🪙 každému').replace('{cost}', JOIN_COST);
			const parts = [];
			if (status === 'waiting') {
				parts.push(`<button id="btn-lobby-start" class="btn-primary session-action session-action--primary" onclick="Session.start()">${startLbl}</button>`);
			}
			if (status === 'active') {
				parts.push(`<button id="btn-lobby-reflection" class="btn-primary session-action session-action--secondary" onclick="Session.openReflectionForAll()">${_t('sess_btn_reflection','🧠 Otvoriť reflexiu pre všetkých')}</button>`);
			}
			parts.push(`<button id="btn-lobby-complete" class="btn-primary session-action session-action--primary"${status === 'active' || status === 'reflection' ? '' : ' hidden'}
				onclick="Session.complete()">${_t('sess_btn_complete','✅ Potvrdiť dokončenie a udeliť body')}</button>`);
			actions.innerHTML = `<div class="session-actions">${parts.join('')}</div>`;
		} else {
			const waitText = status === 'waiting'
				? _t('sess_wait_host','Čakaj na štart hostitela...')
				: _t('sess_wait_host_end','Hostiteľ potvrdí koniec hry.');
			actions.innerHTML = `<p class="session-dialog__waiting">${waitText}</p>`;
		}
	}

	function _renderStatus(status) {
		const el = document.getElementById('lobby-status');
		if (!el) return;
		const labels = {
			waiting:    _t('sess_status_waiting',    '⏳ Čakám na hráčov...'),
			active:     _t('sess_status_active',     '🔥 Hra prebieha!'),
			reflection: _t('sess_status_reflection', '🧠 Reflexia — vypĺňajte formulár'),
			completing: _t('sess_status_completing', '⏳ Rozdávam odmeny...'),
			completed:  _t('sess_status_completed',  '🏆 Dokončené!'),
			expired:    _t('sess_status_expired',    '⌛ Hra vypršala'),
		};
		el.textContent = labels[status] || status;
	}

	async function _refreshParticipants() {
		if (!_code) return;
		try {
			const data = await _fetchFull();
			if (!data || data._status || data.preview) {
				if (data?._status === 404) _cleanup();
				return;
			}
			_renderParticipants(data.participants || []);
			_renderStatus(data.status);
			// Realtime fallback: detect status change via polling
			if (data.status && data.status !== _lastKnownStatus) _onSessionUpdate(data);
		} catch (e) { /* silent */ }
	}

	function _renderParticipants(list) {
		const el = document.getElementById('lobby-participants');
		if (!el) return;
		const nameFb    = _t('sess_player_fallback', 'Hráč');
		const reflLabel = _t('sess_refl_label', 'reflexia');
		const hostLabel = _t('sess_you_host', 'Ty (Host)');
		const countLbl  = _t('sess_count_label', 'Hráči');
		const guestLbl  = _t('sess_guest_tag', 'hosť');
		const leftLbl   = _t('sess_left_tag', 'odišiel');
		const offLbl    = _t('sess_offline_tag', 'offline');
		const unpaidLbl = _t('sess_unpaid_tag', 'bez odmeny');
		const meLbl     = _t('sess_me_tag', 'ty');
		const started   = _lastKnownStatus !== 'waiting';

		// Always show a host row on top so the host immediately knows the lobby is live.
		const rows = [];
		if (_isHost) {
			rows.push(`
				<div class="session-participant session-participant--host">
					<span>👑 ${esc(hostLabel)}</span>
					<span class="session-participant__state">🎮</span>
				</div>`);
		}
		rows.push(...list.map(p => {
			const tags = [];
			if (p.is_me) tags.push(meLbl);
			if (p.is_guest) tags.push(guestLbl);
			if (p.left) tags.push(leftLbl);
			else if (p.online === false) tags.push(offLbl);
			if (started && !p.paid && !p.left) tags.push(unpaidLbl);
			const dot = p.left ? '⚪' : (p.online === false ? '🟠' : '🟢');
			return `
			<div class="session-participant${p.left ? ' session-participant--left' : ''}">
				<span>${dot} ${esc(p.display_name || nameFb)}${tags.length ? ` <small>(${esc(tags.join(', '))})</small>` : ''}</span>
				<span class="session-participant__state">${p.reflection_done ? `✅ ${esc(reflLabel)}` : '⏳'}</span>
			</div>`;
		}));

		if (rows.length === 0) {
			el.innerHTML = `<p class="session-participants__empty">${esc(_t('sess_no_players','Žiadni hráči ešte...'))}</p>`;
			return;
		}

		const active = list.filter((p) => !p.left).length;
		const max = _lastSession?.max_players;
		const header = `<div class="session-participants__count">
			${esc(countLbl)} · ${active}${max ? ` / ${max}` : ''}${_isHost ? ` (+ ${esc(hostLabel.toLowerCase())})` : ''}
		</div>`;

		el.innerHTML = header + rows.join('');
	}

	function _closeLobby() {
		const modal = document.getElementById('session-lobby-modal');
		if (modal) modal.hidden = true;
		_stopPoll();
		_deactivateModal(modal);
	}

	// Fast lobby poll while the waiting lobby is open (participants appear quickly).
	function _startPoll() {
		_stopPoll();
		let burst = 0;
		const fastTick = () => {
			_refreshParticipants();
			burst++;
			if (burst >= 4) {
				clearInterval(_pollTimer);
				_pollTimer = setInterval(() => _refreshParticipants(), 4000);
			}
		};
		_pollTimer = setInterval(fastTick, 1500);
	}

	function _stopPoll() {
		if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
	}

	// Slow poll in every phase (M10): heartbeat = presence + status. A phone
	// without a websocket still sees reflection / completion within ~10 s.
	function _startSlowPoll() {
		_stopSlowPoll();
		_slowTimer = setTimeout(_slowTick, SLOW_POLL_MS);
	}

	function _stopSlowPoll() {
		if (_slowTimer) { clearTimeout(_slowTimer); _slowTimer = null; }
	}

	async function _slowTick() {
		_stopSlowPoll();
		if (!_code) return;
		const code = _code;
		try {
			const headers = await authHeaders();
			if (!headers) return;
			const res = await fetchApi(`/api/sessions/${code}/heartbeat`, { method: 'POST', headers });
			if (code !== _code) return;
			if (res.status === 404 || res.status === 403) { _cleanup(); return; }
			if (res.ok) {
				const hb = await res.json();
				if (hb.status && hb.status !== _lastKnownStatus) await _fetchFullAndUpdate();
			}
		} catch { /* offline for a moment — try again next tick */ }
		if (_code === code) _startSlowPoll();
	}

	// ─── Phones: resume on wake, keep the screen on while playing ───

	async function _acquireWakeLock() {
		try {
			if (typeof navigator === 'undefined' || !navigator.wakeLock || _wakeLock) return;
			_wakeLock = await navigator.wakeLock.request('screen');
			_wakeLock.addEventListener?.('release', () => { _wakeLock = null; });
		} catch { _wakeLock = null; }
	}

	function _releaseWakeLock() {
		try { _wakeLock?.release?.(); } catch {}
		_wakeLock = null;
	}

	function _onVisibility() {
		if (document.visibilityState !== 'visible' || !_code) return;
		_slowTick();
		if (!_channel) _subscribe();
		if (_lastKnownStatus === 'active') _acquireWakeLock();
	}

	if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
		document.addEventListener('visibilitychange', _onVisibility);
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

	function isInSession() {
		return !!_code;
	}

	return {
		create, join, start, complete, openJoinDialog, openReflectionForAll,
		setFocusedState, authHeaders,
		_closeLobby, _submitJoin, _closeJoinModal, _saveSettings,
		_copyShareLink, _shareNative,
		_openLobbyFromBadge, _quitSession,
		restoreFromUrlOrStorage, isInSession
	};
})();

window.Session = Session;
