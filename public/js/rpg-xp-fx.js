/* ═══════════════════════════════════════════════════════════════════
   gIVEMEGAME.IO — RPG XP Celebration Effect

   Lightweight canvas-based pixel-art sparkle burst shown when the
   player earns XP. Blue/cyan palette only, pixel-snapped coordinates.

   Usage:
     RpgXpFx.trigger(50, '⚡ Talent odomknutý')
     RpgXpFx.trigger(50, '📚 Solo hra dokončená')

   Design:
   - Fixed full-screen canvas overlay (pointer-events: none)
   - Pixel square particles (2/4/6 px) — hard-edge retro feel
   - Integer-snapped positions for true pixel-art look
   - Particles spawn from screen center-top, gravity pulls them down
   - +N XP banner with glow and float-up keyframe animation
   - Total lifetime: ~5 seconds (3s banner + 2s particle fade)

   No external dependencies. Exposes: window.RpgXpFx
   ═══════════════════════════════════════════════════════════════════ */

const RpgXpFx = (() => {
  'use strict';

  // ─── Blue / cyan pixel-art palette ──────────────────────────────
  const COLORS = [
    '#00ffff', // pure cyan
    '#0ea5e9', // sky blue
    '#38bdf8', // lighter sky
    '#7dd3fc', // pale blue
    '#a5f3fc', // very pale cyan
    '#e0f2fe', // near-white blue
    '#ffffff',  // white sparkle
  ];

  // ─── State ───────────────────────────────────────────────────────
  let _canvas = null;
  let _ctx    = null;
  let _banner = null;
  let _particles = [];
  let _rafId  = null;
  let _hideTimer  = null;
  let _cleanTimer = null;

  // ─── Setup (lazy, runs once) ─────────────────────────────────────
  function _setup() {
    if (_canvas) return;

    _canvas = document.createElement('canvas');
    _canvas.id = 'rpg-xp-fx-canvas';
    Object.assign(_canvas.style, {
      position: 'fixed', inset: '0', zIndex: '99999',
      pointerEvents: 'none', width: '100%', height: '100%',
      imageRendering: 'pixelated',
    });
    document.body.appendChild(_canvas);
    _ctx = _canvas.getContext('2d');

    _banner = document.createElement('div');
    _banner.id = 'rpg-xp-banner';
    Object.assign(_banner.style, {
      position: 'fixed', top: '42%', left: '50%',
      transform: 'translate(-50%, -50%)',
      zIndex: '100000', pointerEvents: 'none',
      display: 'none', textAlign: 'center',
    });
    document.body.appendChild(_banner);

    window.addEventListener('resize', _resize);
    _resize();
  }

  function _resize() {
    if (!_canvas) return;
    _canvas.width  = window.innerWidth;
    _canvas.height = window.innerHeight;
  }

  // ─── Particle factory ─────────────────────────────────────────────
  function _spawn(cx, cy, count) {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 1.5 + Math.random() * 5.5;
      const size  = [2, 4, 6][Math.floor(Math.random() * 3)]; // pixel sizes

      // Bias upward: subtract from vy so burst goes up first
      _particles.push({
        x:     cx,
        y:     cy,
        vx:    Math.cos(angle) * speed,
        vy:    Math.sin(angle) * speed - 2.5,
        size,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        alpha: 1,
        decay: 0.012 + Math.random() * 0.018,
      });
    }
  }

  // ─── Animation loop ───────────────────────────────────────────────
  function _tick() {
    const ctx = _ctx;
    ctx.clearRect(0, 0, _canvas.width, _canvas.height);

    _particles = _particles.filter(p => p.alpha > 0.02);

    for (const p of _particles) {
      p.x  += p.vx;
      p.y  += p.vy;
      p.vy += 0.09;   // gravity
      p.vx *= 0.99;   // light air resistance
      p.alpha -= p.decay;

      ctx.globalAlpha = Math.max(0, p.alpha);
      ctx.fillStyle   = p.color;
      // Integer-snap for true pixel-art hard edges
      ctx.fillRect(Math.round(p.x), Math.round(p.y), p.size, p.size);
    }
    ctx.globalAlpha = 1;

    if (_particles.length > 0) {
      _rafId = requestAnimationFrame(_tick);
    } else {
      _rafId = null;
    }
  }

  // ─── Reduced-motion check ────────────────────────────────────────
  function _prefersReducedMotion() {
    return typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  }

  // ─── Public: trigger the effect ──────────────────────────────────
  /**
   * Show the XP gain celebration.
   * @param {number} xpAmount   — number displayed in "+N XP" banner
   * @param {string} [label]    — optional sub-label (event description)
   *
   * Reduced-motion: when prefers-reduced-motion is set, skips the canvas
   * particle system entirely and shows only a brief static banner (no keyframes).
   */
  function trigger(xpAmount, label) {
    _setup();

    const reducedMotion = _prefersReducedMotion();

    // Cancel any in-progress effect
    if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
    clearTimeout(_hideTimer);
    clearTimeout(_cleanTimer);
    _particles = [];

    // Banner (always shown)
    _banner.innerHTML = `
      <div class="rpg-xp-gained">+${Number(xpAmount).toLocaleString()} XP</div>
      ${label ? `<div class="rpg-xp-label">${label}</div>` : ''}`;
    _banner.style.display = 'block';
    _banner.classList.remove('rpg-xp-out', 'rpg-xp-in', 'rpg-xp-static');

    if (reducedMotion) {
      // Static fallback: no animation, just visible text for 2.5 s then fade
      _banner.classList.add('rpg-xp-static');
      _hideTimer  = setTimeout(() => { _banner.classList.add('rpg-xp-out'); }, 2500);
      _cleanTimer = setTimeout(() => {
        _banner.style.display = 'none';
        _banner.classList.remove('rpg-xp-out', 'rpg-xp-static');
      }, 3000);
      return; // skip canvas entirely
    }

    // Full-motion path
    _resize();

    const cx = Math.round(window.innerWidth  / 2);
    const cy = Math.round(window.innerHeight * 0.38);

    // Spawn two bursts: tight centre + wider halo
    _spawn(cx, cy, 50);
    setTimeout(() => _spawn(cx, cy, 30), 180);

    // Force reflow so re-animation triggers if called twice quickly
    void _banner.offsetWidth;
    _banner.classList.add('rpg-xp-in');

    _rafId = requestAnimationFrame(_tick);

    // Fade out banner after 2.8 s
    _hideTimer = setTimeout(() => {
      _banner.classList.remove('rpg-xp-in');
      _banner.classList.add('rpg-xp-out');
    }, 2800);

    // Hide banner entirely after fade
    _cleanTimer = setTimeout(() => {
      _banner.style.display = 'none';
      _banner.classList.remove('rpg-xp-out');
    }, 3400);
  }

  return { trigger };
})();

window.RpgXpFx = RpgXpFx;
