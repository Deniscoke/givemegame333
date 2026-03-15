/* ═══════════════════════════════════════════════════════════════════
   gIVEMEGAME.IO — SFX module (retro chip-tune sound effects)

   Lightweight Web Audio oscillator-based sounds (<0.5 s each).
   Same technique as the Music module in script.js — no audio files.

   Exposes: window.SFX
   ═══════════════════════════════════════════════════════════════════ */

const SFX = (() => {
	let ctx = null;

	function _ctx() {
		if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
		if (ctx.state === 'suspended') ctx.resume();
		return ctx;
	}

	function _beep(freq, dur, type, vol) {
		const c = _ctx();
		const t = c.currentTime;
		const osc = c.createOscillator();
		const g   = c.createGain();
		osc.type = type;
		osc.frequency.value = freq;
		g.gain.setValueAtTime(vol, t);
		g.gain.exponentialRampToValueAtTime(0.001, t + dur);
		osc.connect(g);
		g.connect(c.destination);
		osc.start(t);
		osc.stop(t + dur);
	}

	function _arp(notes, gap, type, vol) {
		notes.forEach((f, i) => setTimeout(() => _beep(f, 0.12, type, vol), i * gap));
	}

	const FX = {
		click:    () => _beep(800, 0.04, 'square',   0.03),
		generate: () => _arp([330, 440, 554],        60, 'square',   0.06),
		ready:    () => _arp([523, 659, 784],        80, 'triangle', 0.07),
		complete: () => _arp([523, 659, 784, 1047],  70, 'triangle', 0.08),
		levelup:  () => _arp([440, 554, 659, 880],   55, 'square',   0.07),
	};

	function play(name) {
		try { (FX[name] || FX.click)(); } catch { /* silent on any audio error */ }
	}

	// Global micro-interaction: subtle click on retro buttons
	document.addEventListener('pointerdown', e => {
		if (e.target.closest('.btn-retro, .btn-action, .rating-btn')) play('click');
	}, { passive: true });

	return { play };
})();

window.SFX = SFX;
