/* ═══════════════════════════════════════════════════════════════════
   gIVEMEGAME.IO — Timer module (extracted from script.js Phase 1)

   Dependencies (globals resolved at call-time, not load-time):
     • window.Coins      — defined in public/js/coins.js
     • GameUI.toast()    — defined in script.js (top-level GameUI IIFE)
     • window.givemegame_t — set by App.setLang() in script.js

   Exposes: window.Timer  (also bridged inside App as `const Timer = window.Timer`)
   ═══════════════════════════════════════════════════════════════════ */

const Timer = (() => {
	let timerId = null;
	let totalSeconds = 0;
	let remainingSeconds = 0;
	let _onCompleteCallback = null;

	// Local t() helper — uses App's i18n if available, falls back to hardcoded string
	const _t = (key, fallback) => (window.givemegame_t || ((k, f) => f || k))(key, fallback);

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
		status.textContent = _t('timer_waiting', '⏳ Press READY to start');
		block.style.display = '';
	}

	function start() {
		if (timerId || remainingSeconds <= 0) return;

		const btn = document.getElementById('btn-timer-ready');
		const status = document.getElementById('timer-status');
		if (btn) { btn.disabled = true; btn.style.display = 'none'; }
		if (status) status.textContent = _t('timer_running', '🔥 Game in progress...');

		GameUI.toast(`⏱️ ${_t('timer_started', 'Timer started!')} — ${formatTime(remainingSeconds)}`);

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
		if (status) status.textContent = _t('timer_complete', '✅ Game over! Coins awarded.');

		// Award coins for completing the timer — use window.Coins (coins.js module)
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
		const extra = (parseInt(minutes) || 0) * 60;
		if (extra <= 0) return;
		remainingSeconds += extra;
		totalSeconds += extra;
		const display = document.getElementById('timer-display');
		if (display) display.textContent = formatTime(remainingSeconds);
		GameUI.toast(`⏱️ +${minutes} min pridaných!`);
	}

	return { setup, start, stop, setOnComplete, addTime };
})();

// Expose globally so App can bridge it as `const Timer = window.Timer`
window.Timer = Timer;
