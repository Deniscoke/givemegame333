/* ═══════════════════════════════════════════════════════════════════
   gIVEMEGAME.IO — Pixel-Art Cursor Effect (Canvas 2D)

   Lightweight retro pixel particle system.
   Burst triggered on mode switch — shows for ~4s then fades.
   Runs at capped ~30 FPS for authentic pixel feel.
   Zero external dependencies.
   ═══════════════════════════════════════════════════════════════════ */

const modeColors = {
	party:      ['#ff006e', '#fb5607', '#ffbe0b', '#3a86ff', '#8338ec'],
	classroom:  ['#06d6a0', '#118ab2', '#073b4c', '#ffd166', '#ef476f'],
	reflection: ['#7209b7', '#3a0ca3', '#4361ee', '#4cc9f0', '#f72585'],
	circus:     ['#ff0000', '#ffd700', '#00ff00', '#ff4500', '#1e90ff'],
	cooking:    ['#f97316', '#eab308', '#ef4444', '#84cc16', '#fbbf24'],
	meditation: ['#6366f1', '#8b5cf6', '#a78bfa', '#818cf8', '#c084fc']
};

// Pixel art sprite patterns (8x8 grids, 1=filled)
const SPRITES = {
	star: [
		[0,0,0,1,1,0,0,0],
		[0,0,1,1,1,1,0,0],
		[0,1,1,1,1,1,1,0],
		[1,1,1,1,1,1,1,1],
		[1,1,1,1,1,1,1,1],
		[0,1,1,1,1,1,1,0],
		[0,0,1,1,1,1,0,0],
		[0,0,0,1,1,0,0,0]
	],
	diamond: [
		[0,0,0,1,1,0,0,0],
		[0,0,1,1,1,1,0,0],
		[0,1,1,0,0,1,1,0],
		[1,1,0,0,0,0,1,1],
		[1,1,0,0,0,0,1,1],
		[0,1,1,0,0,1,1,0],
		[0,0,1,1,1,1,0,0],
		[0,0,0,1,1,0,0,0]
	],
	heart: [
		[0,1,1,0,0,1,1,0],
		[1,1,1,1,1,1,1,1],
		[1,1,1,1,1,1,1,1],
		[1,1,1,1,1,1,1,1],
		[0,1,1,1,1,1,1,0],
		[0,0,1,1,1,1,0,0],
		[0,0,0,1,1,0,0,0],
		[0,0,0,0,0,0,0,0]
	],
	coin: [
		[0,0,1,1,1,1,0,0],
		[0,1,1,0,0,1,1,0],
		[1,1,0,1,1,0,1,1],
		[1,1,0,1,1,0,1,1],
		[1,1,0,1,1,0,1,1],
		[1,1,0,1,1,0,1,1],
		[0,1,1,0,0,1,1,0],
		[0,0,1,1,1,1,0,0]
	]
};
const SPRITE_KEYS = Object.keys(SPRITES);

let canvas, ctx;
let particles = [];
let animId = null;
let fadeTimer = null;
let isActive = false;
let lastFrame = 0;
const FPS_CAP = 30;
const FRAME_INTERVAL = 1000 / FPS_CAP;

// Mouse tracking
let mouseX = 0, mouseY = 0;
document.addEventListener('mousemove', (e) => {
	mouseX = e.clientX;
	mouseY = e.clientY;
});

function init() {
	canvas = document.getElementById('cursor-canvas');
	if (!canvas) return;
	ctx = canvas.getContext('2d');
	resize();
	window.addEventListener('resize', resize);
	console.log('[CursorFX] Pixel-art engine ready');
}

function resize() {
	if (!canvas) return;
	canvas.width = window.innerWidth;
	canvas.height = window.innerHeight;
}

function createParticle(x, y, colors) {
	const angle = Math.random() * Math.PI * 2;
	const speed = 0.6 + Math.random() * 1.8;  // ~39% slower (was 1–3)
	const spriteKey = SPRITE_KEYS[Math.floor(Math.random() * SPRITE_KEYS.length)];
	const pixelSize = 1 + Math.floor(Math.random() * 2); // 1-2px per pixel cell (~39% smaller)

	return {
		x, y,
		vx: Math.cos(angle) * speed,
		vy: Math.sin(angle) * speed - 1,
		life: 1.0,
		decay: 0.008 + Math.random() * 0.015,
		color: colors[Math.floor(Math.random() * colors.length)],
		sprite: SPRITES[spriteKey],
		pixelSize
	};
}

function spawnBurst(x, y, colors, count) {
	for (let i = 0; i < count; i++) {
		particles.push(createParticle(
			x + (Math.random() - 0.5) * 24,  // ~39% tighter spread (was 40)
			y + (Math.random() - 0.5) * 24,
			colors
		));
	}
}

function drawSprite(p) {
	const { x, y, sprite, pixelSize, color } = p;
	ctx.globalAlpha = Math.max(0, p.life);
	ctx.fillStyle = color;

	for (let row = 0; row < 8; row++) {
		for (let col = 0; col < 8; col++) {
			if (sprite[row][col]) {
				ctx.fillRect(
					Math.round(x + col * pixelSize),
					Math.round(y + row * pixelSize),
					pixelSize,
					pixelSize
				);
			}
		}
	}
	ctx.globalAlpha = 1;
}

function tick(timestamp) {
	if (!isActive) return;

	// FPS cap at 30
	const elapsed = timestamp - lastFrame;
	if (elapsed < FRAME_INTERVAL) {
		animId = requestAnimationFrame(tick);
		return;
	}
	lastFrame = timestamp - (elapsed % FRAME_INTERVAL);

	ctx.clearRect(0, 0, canvas.width, canvas.height);

	// Spawn trail particles near mouse (max 120 on screen, ~39% less)
	if (particles.length < 120 && currentColors) {
		spawnBurst(mouseX, mouseY, currentColors, 1);
	}

	// Update + draw particles
	for (let i = particles.length - 1; i >= 0; i--) {
		const p = particles[i];
		p.x += p.vx;
		p.y += p.vy;
		p.vy += 0.03; // subtle gravity
		p.life -= p.decay;

		if (p.life <= 0) {
			particles.splice(i, 1);
		} else {
			drawSprite(p);
		}
	}

	animId = requestAnimationFrame(tick);
}

let currentColors = null;

function triggerBurst(mode) {
	if (!canvas) init();
	if (!canvas) return;

	currentColors = modeColors[mode] || modeColors.party;

	// Initial center burst (~39% fewer particles, tighter spread)
	spawnBurst(
		canvas.width / 2 + (Math.random() - 0.5) * 120,
		canvas.height / 2 + (Math.random() - 0.5) * 120,
		currentColors, 15
	);

	// Activate
	isActive = true;
	canvas.classList.add('cursor-active');

	if (animId) cancelAnimationFrame(animId);
	animId = requestAnimationFrame(tick);

	// Auto-fade after 4 seconds
	if (fadeTimer) clearTimeout(fadeTimer);
	fadeTimer = setTimeout(() => {
		canvas.classList.remove('cursor-active');
		setTimeout(() => {
			isActive = false;
			if (animId) cancelAnimationFrame(animId);
			particles = [];
			if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
		}, 2000);
	}, 4000);
}

// Listen for mode changes from classic script
document.addEventListener('givemegame:modechange', (e) => {
	const mode = e.detail?.mode;
	if (mode) triggerBurst(mode);
});

console.log('[CursorFX] Pixel-art module loaded — waiting for mode changes');
