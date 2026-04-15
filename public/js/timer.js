/* ═══════════════════════════════════════════════════════════════════
   gIVEMEGAME.IO — Timer module (extracted from script.js Phase 1)

   Solo: po stlačení PLAY sa stav uloží do localStorage a po obnovení
   stránky sa obnoví rovnaká hra + odpočítavanie (deadline podľa času).

   Dependencies (globals resolved at call-time, not load-time):
     • window.Coins      — defined in public/js/coins.js
     • GameUI.toast()    — defined in script.js (top-level GameUI IIFE)
     • window.givemegame_t — set by App.setLang() in script.js
     • window.Session?.isInSession — session.js (nepersistovať MP časovač)

   Exposes: window.Timer  (also bridged inside App as `const Timer = window.Timer`)
   ═══════════════════════════════════════════════════════════════════ */

const Timer = (() => {
	const SOLO_STORAGE_KEY = 'givemegame_solo_active_timer_v1';

	let timerId = null;
	let totalSeconds = 0;
	let remainingSeconds = 0;
	/** When set, tick() derives remaining from wall clock (handles tab throttling). */
	let _deadlineMs = null;
	let _onCompleteCallback = null;

	const _t = (key, fallback) => (window.givemegame_t || ((k, f) => f || k))(key, fallback);

	function _soloPersistOk() {
		try {
			return typeof window.Session?.isInSession === 'function' ? !window.Session.isInSession() : true;
		} catch {
			return true;
		}
	}

	function clearSoloPersistence() {
		try { localStorage.removeItem(SOLO_STORAGE_KEY); } catch (e) { /* ignore */ }
	}

	function _persistSoloRun() {
		if (!_soloPersistOk()) return;
		try {
			const game = window.currentGame;
			if (!game?.title || _deadlineMs == null) return;
			localStorage.setItem(SOLO_STORAGE_KEY, JSON.stringify({
				v: 1,
				game,
				deadlineMs: _deadlineMs,
				totalSeconds: Math.max(1, totalSeconds || 1)
			}));
		} catch (e) {
			console.warn('[Timer] solo persist failed', e?.message);
		}
	}

	function _applyRunningDom() {
		const block = document.getElementById('game-timer-block');
		const display = document.getElementById('timer-display');
		const btn = document.getElementById('btn-timer-ready');
		const status = document.getElementById('timer-status');
		if (block) block.style.display = '';
		if (btn) { btn.disabled = true; btn.style.display = 'none'; }
		if (status) status.textContent = _t('timer_running', '🔥 Game in progress...');
		if (display) {
			display.textContent = formatTime(remainingSeconds);
			const pct = totalSeconds > 0 ? remainingSeconds / totalSeconds : 0;
			display.className = 'timer-display' +
				(pct <= 0.15 ? ' timer-critical' :
				 pct <= 0.35 ? ' timer-warning' : '');
		}
	}

	function _applyExpiredDomNoAward() {
		const block = document.getElementById('game-timer-block');
		const display = document.getElementById('timer-display');
		const btn = document.getElementById('btn-timer-ready');
		const status = document.getElementById('timer-status');
		if (block) block.style.display = '';
		if (btn) { btn.disabled = true; btn.style.display = 'none'; }
		if (display) {
			display.textContent = formatTime(0);
			display.className = 'timer-display timer-critical';
		}
		if (status) {
			status.textContent = _t('timer_restore_expired', '⏱️ Čas vypršal počas obnovenia stránky.');
		}
	}

	function setup(duration) {
		const block = document.getElementById('game-timer-block');
		const display = document.getElementById('timer-display');
		const btn = document.getElementById('btn-timer-ready');
		const status = document.getElementById('timer-status');
		if (!block) return;

		stop();
		_deadlineMs = null;
		clearSoloPersistence();

		const minutes = (duration && duration.max) || 15;
		totalSeconds = minutes * 60;
		remainingSeconds = totalSeconds;

		display.textContent = formatTime(remainingSeconds);
		display.className = 'timer-display';
		btn.disabled = false;
		btn.style.display = '';
		status.textContent = _t('timer_waiting', '⏳ Press READY to start');
		block.style.display = '';
	}

	function start() {
		if (timerId || remainingSeconds <= 0) return;

		const btn = document.getElementById('btn-timer-ready');
		const status = document.getElementById('timer-status');
		if (btn) { btn.disabled = true; btn.style.display = 'none'; }
		if (status) status.textContent = _t('timer_running', '🔥 Game in progress...');

		_deadlineMs = Date.now() + remainingSeconds * 1000;
		if (_soloPersistOk()) _persistSoloRun();

		GameUI.toast(`⏱️ ${_t('timer_started', 'Timer started!')} — ${formatTime(remainingSeconds)}`);

		timerId = setInterval(tick, 1000);
	}

	function tick() {
		if (_deadlineMs != null) {
			remainingSeconds = Math.max(0, Math.ceil((_deadlineMs - Date.now()) / 1000));
		} else {
			remainingSeconds--;
		}

		const display = document.getElementById('timer-display');

		if (remainingSeconds <= 0) {
			complete();
			return;
		}

		if (display) {
			display.textContent = formatTime(remainingSeconds);
			const pct = totalSeconds > 0 ? remainingSeconds / totalSeconds : 0;
			display.className = 'timer-display' +
				(pct <= 0.15 ? ' timer-critical' :
				 pct <= 0.35 ? ' timer-warning' : '');
		}
	}

	function complete() {
		stop();
		_deadlineMs = null;
		clearSoloPersistence();

		const display = document.getElementById('timer-display');
		const status = document.getElementById('timer-status');
		if (display) {
			display.textContent = '🏆 GG!';
			display.className = 'timer-display timer-done';
		}
		if (status) status.textContent = _t('timer_complete', '✅ Game over! Coins awarded.');

		if (window.Coins?.award) window.Coins.award('timer');
		GameUI.toast(`🪙 ${_t('coin_awarded', '+500 gIVEMECOIN!')}`);
		if (_onCompleteCallback) _onCompleteCallback();
	}

	function stop() {
		if (timerId) {
			clearInterval(timerId);
			timerId = null;
		}
	}

	function setOnComplete(fn) {
		_onCompleteCallback = typeof fn === 'function' ? fn : null;
	}

	function formatTime(sec) {
		const m = Math.floor(sec / 60);
		const s = sec % 60;
		return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
	}

	function addTime(minutes) {
		const extra = (parseInt(minutes, 10) || 0) * 60;
		if (extra <= 0) return;
		remainingSeconds += extra;
		totalSeconds += extra;
		if (_deadlineMs != null) {
			_deadlineMs = Date.now() + remainingSeconds * 1000;
			if (_soloPersistOk()) _persistSoloRun();
		}
		const display = document.getElementById('timer-display');
		if (display) display.textContent = formatTime(remainingSeconds);
		GameUI.toast(`⏱️ +${minutes} min pridaných!`);
	}

	/**
	 * Nastaví zostávajúci čas pred start() (napr. sync session z servera).
	 * @param {number} seconds
	 * @param {number} [totalForBar] — celkový čas pre farbu progressu (≥ seconds)
	 */
	function setRemaining(seconds, totalForBar) {
		remainingSeconds = Math.max(0, parseInt(seconds, 10) || 0);
		if (totalForBar != null) {
			const t = Math.max(1, parseInt(totalForBar, 10) || 1);
			totalSeconds = Math.max(t, remainingSeconds);
		} else {
			totalSeconds = Math.max(totalSeconds || 1, remainingSeconds);
		}
		const display = document.getElementById('timer-display');
		if (display) display.textContent = formatTime(remainingSeconds);
	}

	function restoreSoloSessionIfAny() {
		if (window.Session?.isInSession?.()) return false;
		let raw;
		try { raw = localStorage.getItem(SOLO_STORAGE_KEY); } catch { return false; }
		if (!raw) return false;

		let data;
		try { data = JSON.parse(raw); } catch { clearSoloPersistence(); return false; }
		if (!data || data.v !== 1 || !data.game?.title || typeof data.deadlineMs !== 'number') {
			clearSoloPersistence();
			return false;
		}

		const game = data.game;
		totalSeconds = Math.max(1, parseInt(data.totalSeconds, 10) || 1);
		const msLeft = data.deadlineMs - Date.now();
		remainingSeconds = Math.max(0, Math.ceil(msLeft / 1000));

		window.currentGame = game;
		if (window.GameUI?.renderGame) GameUI.renderGame(game);
		if (window.GameUI?.renderQuickView) GameUI.renderQuickView(game);

		if (remainingSeconds <= 0) {
			clearSoloPersistence();
			_deadlineMs = null;
			stop();
			_applyExpiredDomNoAward();
			GameUI.toast(_t('timer_restore_late', '⏱️ Čas medzitým vypršal — spusti Novú hru alebo vygeneruj znova.'));
			return true;
		}

		_deadlineMs = data.deadlineMs;
		_applyRunningDom();
		if (_soloPersistOk()) _persistSoloRun();

		timerId = setInterval(tick, 1000);
		GameUI.toast(_t('timer_restored', '▶️ Hra a časovač obnovené po obnovení stránky.'));
		return true;
	}

	return {
		setup,
		start,
		stop,
		setOnComplete,
		addTime,
		setRemaining,
		clearSoloPersistence,
		restoreSoloSessionIfAny
	};
})();

window.Timer = Timer;
