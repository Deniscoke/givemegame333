/* ═══════════════════════════════════════════════════════════════════
   gIVEMEGAME.IO — Backend Server

   Express server s dvoma úlohami:
   1. Statický file serving pre frontend (HTML/CSS/JS)
   2. API endpoint /api/generate-game → OpenAI generovanie hier
   ═══════════════════════════════════════════════════════════════════ */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
const { validateDurationGate, validateParticipantGate, validateHostCooldownGate } = require('./lib/reward-validation');
const { createEduRouter } = require('./lib/edu-routes');
const {
	getUserBillingState,
	hasPaidAccess,
	getUserPlan,
	PLAN_PRO
} = require('./lib/billing');

const SESSION_JOIN_COST = 100;
const COMPETENCY_AWARD  = 50;
const COMPLETION_BONUS  = 100;
const JOIN_CODE_CHARS   = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const JOIN_CODE_LENGTH  = 6;

// ─── Reward validation constants ───
const VALID_COMPETENCY_KEYS = [
	'k-uceni', 'k-reseni-problemu', 'komunikativni',
	'socialni-personalni', 'obcanske', 'pracovni', 'digitalni'
];
const MIN_SESSION_DURATION_FLOOR = 3;    // minutes — absolute minimum even if game.duration.min is lower
const MIN_SESSION_DURATION_FALLBACK = 5; // minutes — used when game has no duration.min
const HOST_COOLDOWN_MAX  = 5;            // max completed sessions per host per rolling hour
const SOLO_DAILY_LIMIT   = 10;           // max solo completions per user per 24h

// ─── Competency level thresholds ───────────────────────────────────────────
const COMP_LEVELS = [
	{ name: 'Nováčik', min:    0, next:  250 },
	{ name: 'Skúsený', min:  250, next:  750 },
	{ name: 'Expert',  min:  750, next: 1500 },
	{ name: 'Majster', min: 1500, next: 3000 },
	{ name: 'Legenda', min: 3000, next: null },
];

function computeLevel(pts) {
	const p = parseInt(pts, 10) || 0;
	let lvl = COMP_LEVELS[0];
	for (const l of COMP_LEVELS) { if (p >= l.min) lvl = l; }
	const progress_pct = lvl.next
		? Math.min(100, Math.round((p - lvl.min) / (lvl.next - lvl.min) * 100))
		: 100;
	return { points: p, level: lvl.name, next_threshold: lvl.next, progress_pct };
}

function enrichCompetencies(raw) {
	const result = {};
	VALID_COMPETENCY_KEYS.forEach(k => { result[k] = computeLevel(raw[k] || 0); });
	return result;
}

const app = express();
// Trust proxy for correct req.ip behind Vercel/nginx
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());

// ─── Security headers ──────────────────────────────────────────────────────
// Applied to every response. CSP uses 'unsafe-inline' because the current
// frontend uses inline <script> blocks — tighten by moving to external .js
// files in Sprint 2 to enable a nonce-based CSP.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://*.supabase.co https://lh3.googleusercontent.com",
    "connect-src 'self' https://*.supabase.co",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'self'",
  ].join('; '));
  next();
});

// Favicon — predchádza 404
app.get('/favicon.ico', (req, res) => {
	const icon = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
	res.type('image/png').send(icon);
});

// Root: vždy login — na mobile aj desktop. Hra je na /index.html (redirect po prihlásení)
const PUBLIC_DIR = path.join(__dirname, 'public');
app.get('/', (req, res) => {
	res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

// ─── Billing post-payment pages (Payment Link MVP) ───
app.get('/billing/success', (req, res) => {
	res.sendFile(path.join(PUBLIC_DIR, 'billing', 'success.html'));
});
app.get('/billing/cancel', (req, res) => {
	res.sendFile(path.join(PUBLIC_DIR, 'billing', 'cancel.html'));
});

// ─── Source of Knowledge pipeline ───
const KNOWLEDGE_DIR = path.join(__dirname, 'source of knowledge');
const SUPPORTED_EXTS = ['.txt', '.md', '.json', '.csv'];
let knowledgeCache = [];
let knowledgeSummary = '';

function loadKnowledgeBase() {
	knowledgeCache = [];
	knowledgeSummary = '';
	if (!fs.existsSync(KNOWLEDGE_DIR)) {
		try {
			fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true });
			console.log('[Knowledge] Priečinok "source of knowledge" vytvorený.');
		} catch (e) { /* Na Vercel je filesystem read-only */ }
		return;
	}
	try {
		const files = fs.readdirSync(KNOWLEDGE_DIR).filter(f => {
			const ext = path.extname(f).toLowerCase();
			return SUPPORTED_EXTS.includes(ext) && !f.startsWith('.');
		});
		for (const file of files) {
			try {
				const filePath = path.join(KNOWLEDGE_DIR, file);
				const stat = fs.statSync(filePath);
				if (stat.size > 100_000) { // Skip files >100KB
					console.warn(`[Knowledge] Preskakujem veľký súbor: ${file} (${(stat.size / 1024).toFixed(0)}KB)`);
					continue;
				}
				const raw = fs.readFileSync(filePath, 'utf-8');
				const ext = path.extname(file).toLowerCase();
				let content = raw;
				// JSON files: extract values as text
				if (ext === '.json') {
					try {
						const obj = JSON.parse(raw);
						content = JSON.stringify(obj, null, 0).substring(0, 5000);
					} catch { content = raw.substring(0, 5000); }
				}
				// Trim to max 5000 chars per file
				if (content.length > 5000) content = content.substring(0, 5000) + '…';
				knowledgeCache.push({
					name: file,
					ext,
					size: stat.size,
					modified: stat.mtime.toISOString(),
					content
				});
			} catch (e) {
				console.warn(`[Knowledge] Chyba čítania ${file}:`, e.message);
			}
		}
		// Build summary for AI injection
		if (knowledgeCache.length > 0) {
			const pieces = knowledgeCache.map(k => `--- FILE: ${k.name} ---\n${k.content}`);
			knowledgeSummary = pieces.join('\n\n');
			// Limit total knowledge to ~15K chars for prompt safety
			if (knowledgeSummary.length > 15000) {
				knowledgeSummary = knowledgeSummary.substring(0, 15000) + '\n…[truncated]';
			}
		}
		console.log(`[Knowledge] Načítaných ${knowledgeCache.length} súborov z "source of knowledge".`);
	} catch (e) {
		console.error('[Knowledge] Chyba skenovania:', e.message);
	}
}
// Load on startup + watch for changes (iba lokálne — fs.watch nie je podporovaný na Vercel)
loadKnowledgeBase();
if (!process.env.VERCEL && fs.existsSync(KNOWLEDGE_DIR)) {
	try {
		fs.watch(KNOWLEDGE_DIR, { persistent: false }, () => {
			console.log('[Knowledge] Zmena detekovaná — reloadujem...');
			setTimeout(loadKnowledgeBase, 500); // debounce
		});
	} catch (e) { console.warn('[Knowledge] fs.watch nie je dostupný:', e.message); }
}

// ─── Coin / Supabase infra ───
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL || '';

let coinsDbPool = null;
if (SUPABASE_DB_URL) {
	try {
		coinsDbPool = new Pool({
			connectionString: SUPABASE_DB_URL,
			ssl: SUPABASE_DB_URL.includes('supabase.co') ? { rejectUnauthorized: false } : undefined
		});
		coinsDbPool.on('error', (err) => console.error('[Coins] Database pool error:', err.message));
		console.log('[Coins] Database pool inicializovaný.');
	} catch (err) {
		console.error('[Coins] Nepodarilo sa inicializovať databázový pool:', err.message);
		coinsDbPool = null;
	}
} else {
	console.warn('[Coins] SUPABASE_DB_URL nie je nastavený — Coin API zostane vypnuté.');
}

const SUPABASE_AUTH_ENDPOINT = SUPABASE_URL ? `${SUPABASE_URL}/auth/v1/user` : '';

async function fetchSupabaseUser(accessToken) {
	if (!accessToken || !SUPABASE_AUTH_ENDPOINT || !SUPABASE_ANON_KEY) return null;
	const resp = await fetch(SUPABASE_AUTH_ENDPOINT, {
		headers: {
			apikey: SUPABASE_ANON_KEY,
			Authorization: `Bearer ${accessToken}`
		}
	});
	if (!resp.ok) {
		const errText = await resp.text().catch(() => '');
		throw new Error(`Supabase user lookup failed (${resp.status}) ${errText}`);
	}
	const data = await resp.json();
	return { id: data.id, email: data.email || null, raw: data };
}

async function requireSupabaseUser(req, res) {
	const authHeader = req.headers.authorization || '';
	if (!authHeader.startsWith('Bearer ')) {
		res.status(401).json({ error: 'Authorization header missing', code: 'NO_TOKEN' });
		return null;
	}
	const token = authHeader.slice(7).trim();
	if (!token) {
		res.status(401).json({ error: 'Access token missing', code: 'EMPTY_TOKEN' });
		return null;
	}
	try {
		const user = await fetchSupabaseUser(token);
		if (!user) throw new Error('Token verification failed');
		return user;
	} catch (err) {
		const status = err.message.includes('401') ? 401 : 403;
		res.status(status).json({ error: 'Neplatný Supabase token', code: 'INVALID_TOKEN' });
		return null;
	}
}

/** Like requireSupabaseUser but never responds — returns null if no/invalid auth. */
async function optionalSupabaseUser(req) {
	const authHeader = req.headers.authorization || '';
	if (!authHeader.startsWith('Bearer ')) return null;
	const token = authHeader.slice(7).trim();
	if (!token) return null;
	try {
		const user = await fetchSupabaseUser(token);
		return user || null;
	} catch {
		return null;
	}
}

function generateJoinCode() {
	let code = '';
	for (let i = 0; i < JOIN_CODE_LENGTH; i++) {
		code += JOIN_CODE_CHARS[Math.floor(Math.random() * JOIN_CODE_CHARS.length)];
	}
	return code;
}

function coinApiReady() {
	return Boolean(coinsDbPool && SUPABASE_AUTH_ENDPOINT && SUPABASE_ANON_KEY);
}

function respondCoinApiDisabled(res) {
	return res.status(503).json({
		error: 'Coin API nie je nakonfigurovaný. Nastav SUPABASE_DB_URL, SUPABASE_URL a SUPABASE_ANON_KEY.',
		code: 'COIN_API_DISABLED'
	});
}

async function queryCoinsDb(text, params = []) {
	if (!coinsDbPool) throw new Error('Coin DB pool nie je inicializovaný');
	return coinsDbPool.query(text, params);
}

// ─── gIVEMEEDU routes ───
if (coinsDbPool) {
	const eduRouter = createEduRouter({
		pool: coinsDbPool,
		requireSupabaseUser
	});
	app.use('/api/edu', eduRouter);
	console.log('[EDU] gIVEMEEDU API mounted at /api/edu/*');
} else {
	console.warn('[EDU] gIVEMEEDU API disabled — SUPABASE_DB_URL not set.');
}

// ─── OpenAI klient ───
let openai = null;

function initOpenAI(apiKey) {
	if (!apiKey || apiKey === 'sk-your-openai-api-key-here') {
		console.warn('[Server] OpenAI API kľúč nie je nastavený.');
		return false;
	}
	openai = new OpenAI({ apiKey });
	console.log('[Server] OpenAI klient inicializovaný.');
	return true;
}

// Inicializácia z .env
initOpenAI(process.env.OPENAI_API_KEY);

// ─── Vzorový game JSON pre prompt ───
// Structural fallback used when games.json is absent or empty.
// Shows the exact schema shape — field names, types, nesting.
const SCHEMA_FALLBACK = `{
  "id": "ai-abc123",
  "title": "Example Game Title",
  "pitch": "Short catchy hook for the game.",
  "mode": "party",
  "setting": "indoor",
  "energyLevel": "high",
  "playerCount": { "min": 5, "max": 20 },
  "ageRange": { "min": 10, "max": 18 },
  "duration": { "min": 15, "max": 30 },
  "materials": ["paper", "markers"],
  "instructions": [
    "Step 1: Do this. Example: Player A picks a card and reads it aloud.",
    "Step 2: Then this. Example: Player B responds with their answer."
  ],
  "learningGoals": ["Participants will practise active listening."],
  "reflectionPrompts": ["What worked well for you?", "What would you change next time?"],
  "safetyNotes": ["Ensure enough space for movement.", "Adapt for any physical limitations."],
  "facilitatorNotes": "Keep energy up — encourage everyone to participate, no pressure."
}`;

// Compact schema for AI format reference (~85 tokens vs ~600 for a full example).
// Field names + types are sufficient — sample values add noise, not signal.
const COMPACT_GAME_SCHEMA = `{"id":"ai-XXXXXX","title":"string","pitch":"string","playerCount":{"min":2,"max":15},"ageRange":{"min":8,"max":15},"duration":{"min":15,"max":30},"setting":"indoor|outdoor|any","mode":"party|classroom|reflection|circus|cooking|meditation","energyLevel":"low|medium|high","materials":["string"],"instructions":["string"],"learningGoals":["string"],"reflectionPrompts":["string"],"safetyNotes":["string"],"adaptationTips":["string"],"facilitatorNotes":"string","rvp":{"kompetence":["k-uceni"],"oblasti":["string"],"stupen":"prvni|druhy","prurezova_temata":["string"],"ocekavane_vystupy":["string"],"doporucene_hodnoceni":"string"}}`;

// ─── Strict constraint mapping for AI ───
function buildFilterDescription(filters) {
	const constraints = [];

	// ── Mode → THEME directive (most important) ──
	if (filters.mode) {
		const modeThemes = {
			party: 'THEME: Party / teambuilding game. MUST be high-energy, fun, group-oriented with celebration atmosphere. Think team challenges, laughter, movement, social bonding.',
			classroom: 'THEME: Educational classroom activity tied to curriculum. MUST include clear learning outcomes and structured facilitation. Constructive, focused tone.',
			reflection: 'THEME: Reflective / calm activity. MUST be introspective, emotionally safe, gentle. Think journaling, paired sharing, mindfulness circles.',
			circus: 'THEME: Circus / performance activity. MUST involve circus-inspired mechanics — juggling metaphors, acrobatics, performance, audience, ring, clowning, balance. Activities MUST involve body movement and creativity inspired by circus arts.',
			cooking: 'THEME: Cooking / recipe-based activity. MUST involve food preparation, tasting, nutrition education, or culinary creativity. Kitchen and food themes are MANDATORY.',
			meditation: 'THEME: Mindfulness / meditation exercise. MUST focus on breathing, body awareness, visualization, or gentle yoga. The tone MUST be calm, safe, and health-focused. NO competitive elements.'
		};
		constraints.push(modeThemes[filters.mode] || `THEME: ${filters.mode}`);
		constraints.push(`JSON field "mode" MUST be "${filters.mode}".`);
	}

	// ── Age → exact range ──
	if (filters.ageMin || filters.ageMax) {
		const min = filters.ageMin || '5';
		const max = filters.ageMax || '99';
		constraints.push(`CONSTRAINT ageRange: "ageRange.min" MUST be >= ${min} and "ageRange.max" MUST be <= ${max}. Do NOT generate a game for children outside ${min}–${max} years.`);
	}

	// ── Players → exact numeric range ──
	if (filters.players && filters.players !== 'any') {
		const playerRanges = {
			solo:   { min: 1, max: 1,  label: '1 player (solo)' },
			small:  { min: 2, max: 5,  label: '2–5 players (small group)' },
			medium: { min: 6, max: 15, label: '6–15 players (medium group)' },
			large:  { min: 16, max: 30, label: '16–30 players (large group)' }
		};
		const pr = playerRanges[filters.players];
		if (pr) {
			constraints.push(`CONSTRAINT playerCount: "playerCount.min" MUST be >= ${pr.min} and "playerCount.max" MUST be <= ${pr.max}. This is a ${pr.label}. Do NOT generate a game requiring more than ${pr.max} players.`);
		}
	}

	// ── Activity type → solo override ──
	if (filters.activity && filters.activity !== 'any') {
		const actConstraints = {
			solo: 'CONSTRAINT activity: This MUST be a SOLO / individual activity. "playerCount.min" MUST be 1, "playerCount.max" MUST be 1. ONE person plays alone.',
			pair: 'CONSTRAINT activity: This MUST be a PAIR activity. "playerCount.min" MUST be 2, "playerCount.max" MUST be 2.',
			group: 'CONSTRAINT activity: This MUST be a GROUP activity for 3–10 players.',
			mass: 'CONSTRAINT activity: This MUST be a MASS activity for 10+ players.'
		};
		constraints.push(actConstraints[filters.activity] || `CONSTRAINT activity: ${filters.activity}`);
	}

	// ── Duration → exact minute range ──
	if (filters.duration && filters.duration !== 'any') {
		const durationRanges = {
			quick:  { min: 5,  max: 15, label: '5–15 minutes' },
			medium: { min: 15, max: 30, label: '15–30 minutes' },
			long:   { min: 30, max: 60, label: '30–60 minutes' }
		};
		const dr = durationRanges[filters.duration];
		if (dr) {
			constraints.push(`CONSTRAINT duration: "duration.min" MUST be >= ${dr.min} and "duration.max" MUST be <= ${dr.max}. Game MUST fit in ${dr.label}.`);
		}
	}

	// ── Setting ──
	if (filters.setting && filters.setting !== 'any') {
		constraints.push(`CONSTRAINT setting: "setting" MUST be "${filters.setting}". Do NOT suggest ${filters.setting === 'indoor' ? 'outdoor' : 'indoor'} activities.`);
	}

	// ── Energy ──
	if (filters.energy && filters.energy !== 'any') {
		constraints.push(`CONSTRAINT energyLevel: "energyLevel" MUST be "${filters.energy}".`);
	}

	// ── Reflection depth ──
	if (filters.depth && filters.depth !== 'any') {
		const depthLabels = { light: 'light/playful', medium: 'moderate depth', deep: 'deep/emotional' };
		constraints.push(`CONSTRAINT emotionalDepth: "emotionalDepth" MUST be "${filters.depth}" (${depthLabels[filters.depth]}).`);
	}

	// ── Cuisine type (cooking mode) ──
	if (filters.cuisine && filters.cuisine !== 'any') {
		const cuisineLabels = { sweet: 'sweet/dessert', savory: 'savory/main course', healthy: 'healthy/nutritious', international: 'international/world cuisine' };
		constraints.push(`CONSTRAINT cuisine: The cooking activity MUST focus on ${cuisineLabels[filters.cuisine] || filters.cuisine} food.`);
	}

	// ── Focus type (meditation mode) ──
	if (filters.focus && filters.focus !== 'any') {
		const focusLabels = { breath: 'breathing exercises', body: 'body scan / body awareness', visualization: 'guided visualization', movement: 'gentle movement / yoga' };
		constraints.push(`CONSTRAINT focus: The meditation MUST focus on ${focusLabels[filters.focus] || filters.focus}.`);
	}

	// ── RVP (classroom mode) ──
	if (filters.stupen && filters.stupen !== 'any') {
		constraints.push(`CONSTRAINT rvp.stupen: MUST include "${filters.stupen === 'prvni' ? 'prvni' : 'druhy'}" (${filters.stupen === 'prvni' ? '1st level / grades 1-5' : '2nd level / grades 6-9'}).`);
	}
	if (filters.kompetence && filters.kompetence !== 'any') {
		constraints.push(`CONSTRAINT rvp.kompetence: MUST include "${filters.kompetence}" in the kompetence array.`);
	}
	if (filters.oblast && filters.oblast !== 'any') {
		constraints.push(`CONSTRAINT rvp.oblasti: MUST include "${filters.oblast}" in the oblasti array.`);
	}

	// ── Setting "any" → explicit flexibility ──
	if (filters.setting === 'any' || !filters.setting) {
		constraints.push(`CONSTRAINT setting: "setting" MAY be "indoor" OR "outdoor" — user chose ANYWHERE, so game can work in either. Prefer the one that fits the activity best.`);
	}

	// ── Facilitator description / custom instructions ──
	if (filters.description && filters.description.trim()) {
		constraints.push(`FACILITATOR NOTE — the person creating this activity wrote the following custom instructions. You MUST incorporate this into the game design:\n"${filters.description.trim()}"\nAdapt these notes using sound pedagogical approaches. Make the game attractive for Gen Z — gamified, authentic, relatable. Do NOT just copy the text literally; weave it creatively into the activity design.`);
	}

	return constraints.join('\n');
}

// ─── EXACT values AI MUST output (pre prompt) ───
function buildExactValuesBlock(filters) {
	const lines = [];
	const f = filters || {};

	const playerRanges = { solo: [1,1], small: [2,5], medium: [6,15], large: [16,30] };
	const pr = f.players && playerRanges[f.players] ? playerRanges[f.players] : null;
	if (pr) lines.push(`playerCount: { min: ${pr[0]}, max: ${pr[1]} }`);

	const durationRanges = { quick: [5,15], medium: [15,30], long: [30,60] };
	const dr = f.duration && durationRanges[f.duration] ? durationRanges[f.duration] : null;
	if (dr) lines.push(`duration: { min: ${dr[0]}, max: ${dr[1]} }`);

	if (f.ageMin || f.ageMax) {
		const min = f.ageMin || '5', max = f.ageMax || '99';
		lines.push(`ageRange: { min: ${min}, max: ${max} }`);
	}

	if (f.setting && f.setting !== 'any') lines.push(`setting: "${f.setting}"`);

	if (lines.length === 0) return '';
	return `\n⚠️ EXACT JSON VALUES (copy these — no other values allowed):\n${lines.join('\n')}\n`;
}

// ─── Server-side enforcement: oprava výstupu podľa panelu ───
function enforceConstraints(game, filters) {
	const f = filters || {};
	const playerRanges = { solo: [1,1], small: [2,5], medium: [6,15], large: [16,30] };
	const durationRanges = { quick: [5,15], medium: [15,30], long: [30,60] };

	if (f.players && playerRanges[f.players]) {
		const [min, max] = playerRanges[f.players];
		game.playerCount = { min, max };
	}
	if (f.duration && durationRanges[f.duration]) {
		const [min, max] = durationRanges[f.duration];
		game.duration = { min, max };
	}
	if (f.ageMin || f.ageMax) {
		game.ageRange = {
			min: parseInt(f.ageMin) || game.ageRange?.min || 5,
			max: parseInt(f.ageMax) || game.ageRange?.max || 99
		};
	}
	if (f.setting && f.setting !== 'any') {
		game.setting = f.setting;
	}
	if (f.energy && f.energy !== 'any') game.energyLevel = f.energy;

	return game;
}

// ─── Game JSON validation ───
// Returns [] if valid, or an array of human-readable error strings.
function validateGame(game) {
	const errors = [];

	// Required non-empty string fields
	for (const field of ['id', 'title', 'pitch', 'mode', 'setting', 'energyLevel', 'facilitatorNotes']) {
		if (typeof game[field] !== 'string' || !game[field].trim()) {
			errors.push(`Missing or empty field: ${field}`);
		}
	}

	// Required numeric range objects: { min: number, max: number }
	for (const field of ['playerCount', 'ageRange', 'duration']) {
		const obj = game[field];
		if (!obj || typeof obj.min !== 'number' || typeof obj.max !== 'number') {
			errors.push(`Invalid range object: ${field} (must be { min: number, max: number })`);
		}
	}

	// Required non-empty arrays
	for (const field of ['materials', 'instructions', 'learningGoals', 'reflectionPrompts', 'safetyNotes']) {
		if (!Array.isArray(game[field]) || game[field].length === 0) {
			errors.push(`Missing or empty array: ${field}`);
		}
	}

	// Content sanity: title must be a real name, not a placeholder
	if (game.title && game.title.trim().length < 3) {
		errors.push('Title too short (min 3 characters)');
	}

	// Content sanity: first instruction must be a real sentence
	if (Array.isArray(game.instructions) && game.instructions.length > 0) {
		if (String(game.instructions[0]).trim().length < 10) {
			errors.push('First instruction is too short to be meaningful');
		}
	}

	// Content sanity: array items must not be empty or trivially short strings
	for (const field of ['instructions', 'learningGoals', 'reflectionPrompts']) {
		if (Array.isArray(game[field])) {
			const hollow = game[field].filter(item => !item || String(item).trim().length < 5);
			if (hollow.length > 0) {
				errors.push(`Array "${field}" contains ${hollow.length} empty or trivially short item(s)`);
			}
		}
	}

	return errors;
}

// ─── Safety validation ───
// Checks generated game text for content inappropriate for educational/youth contexts.
// Returns [] if safe, or an array of violation strings.
// Hard-reject only — no repair attempt, to avoid rephrasing the same unsafe content.
function validateSafety(game) {
	const violations = [];

	const allText = [
		game.title, game.pitch, game.facilitatorNotes,
		...(Array.isArray(game.instructions)     ? game.instructions     : []),
		...(Array.isArray(game.learningGoals)     ? game.learningGoals     : []),
		...(Array.isArray(game.reflectionPrompts) ? game.reflectionPrompts : []),
		...(Array.isArray(game.safetyNotes)       ? game.safetyNotes       : []),
		...(Array.isArray(game.materials)         ? game.materials         : []),
		...(Array.isArray(game.adaptationTips)    ? game.adaptationTips    : []),
	].filter(Boolean).join(' ');

	const UNSAFE = [
		// Explicit sexual content (cognates across EN/CS/SK/ES)
		{ pattern: /\bporno?graph/i,                          label: 'explicit sexual content' },
		{ pattern: /\bsexually explicit\b/i,                  label: 'explicit sexual content' },
		// Named hard drugs (international loanwords, consistent across all 4 supported languages)
		{ pattern: /\bcocain[ae]?\b/i,                        label: 'hard drug reference (cocaine)' },
		{ pattern: /\bheroin\b/i,                             label: 'hard drug reference (heroin)' },
		{ pattern: /\bmethamphetamin/i,                       label: 'hard drug reference (meth)' },
		{ pattern: /\bfentanyl\b/i,                           label: 'hard drug reference (fentanyl)' },
		// Instructions to physically harm self or others (EN verb-first; CS/SK allow verb-after)
		{ pattern: /\b(hurt|harm|injure|zranit|zraniť|ublíži[tť])\s+(yourself|each other|one another|navzájem|navzájom)\b/i, label: 'direct harm instruction' },
		{ pattern: /\b(navzájem|navzájom)\s+(zranit|zraniť|ublíži[tť])(?:\s|$)/i,                                           label: 'direct harm instruction (CS/SK)' },
		{ pattern: /\b(hit|strike|beat|attack|udeř[ií])\s+(each other|one another|navzájem|navzájom)\b/i,                  label: 'physical violence instruction' },
		{ pattern: /\b(navzájem|navzájom)\s+(udeř[ií]|bij[eií]|atakuj)(?:\s|$)/i,                                         label: 'physical violence instruction (CS/SK)' },
	];

	for (const { pattern, label } of UNSAFE) {
		if (pattern.test(allText)) {
			violations.push(`Unsafe content detected: ${label}`);
		}
	}

	return violations;
}

// ─── One-shot repair call for structurally invalid AI output ───
// Uses low temperature and a minimal focused prompt — not a full regeneration.
async function callRepairAPI(brokenOutput, errors, useModel, aiLanguage) {
	const prompt = `The following game JSON has validation errors. Fix ALL errors listed below and return ONLY a corrected valid JSON object.

ERRORS TO FIX:
${errors.join('\n')}

BROKEN OUTPUT:
${String(brokenOutput).substring(0, 4000)}

RULES:
- Return ONLY the fixed JSON. No markdown, no code fences, no explanation.
- Required string fields: id, title, pitch, mode, setting, energyLevel, facilitatorNotes
- Required range objects (must have min and max as numbers): playerCount, ageRange, duration
- Required non-empty arrays: materials, instructions, learningGoals, reflectionPrompts, safetyNotes
- Write ALL text content in ${aiLanguage}`;

	return openai.chat.completions.create({
		model: useModel,
		temperature: 0.3,
		max_tokens: 3000,
		messages: [
			{ role: 'system', content: 'You are a JSON repair assistant. Your only job is to fix validation errors in game JSON objects. Return only valid JSON.' },
			{ role: 'user', content: prompt }
		]
	});
}

// ─── Didaktická navigácia (research-backed) ───
function buildDidacticGuidance(filters) {
	const tips = [];
	const mode = filters?.mode || 'party';
	const depth = filters?.depth || '';
	const energy = filters?.energy || '';
	const setting = filters?.setting || '';

	// Brain-based & experiential learning (research-backed)
	tips.push(`PEDAGOGICAL FOUNDATION: Use evidence-based approaches — experiential learning (Kolb), active learning (neuroscience shows it outperforms passive instruction), gamification that supports intrinsic motivation. Avoid extrinsic rewards that undermine engagement.`);

	// Mode-specific didactics
	const modeDidactics = {
		party: 'Collaborative learning, team-building (Tuckman), playful competition, social bonding. Use ice-breaker mechanics, low stakes, high energy.',
		classroom: 'Structured facilitation, clear learning outcomes (Bloom), scaffolding, formative assessment. Align with curriculum (RVP ZV). Use inquiry-based or problem-based learning where appropriate.',
		reflection: 'Reflective practice (Schön), emotional safety, paired/group sharing. Depth levels: light=playful check-ins; medium=guided reflection; deep=safe-space circles, journaling.',
		circus: 'Circus pedagogy: body awareness, risk-taking in safe context, performance as learning. Progressive skill-building, peer feedback.',
		cooking: 'Hands-on experiential learning, sensory engagement, practical life skills. Recipe as scaffold, tasting as assessment.',
		meditation: 'Mindfulness-based approaches (MBSR-inspired), body scan, breath awareness. No competition — contemplative, inclusive.'
	};
	tips.push(`MODE DIDACTIC: ${modeDidactics[mode] || modeDidactics.party}`);

	if (depth === 'deep') tips.push('EMOTIONAL DEPTH: Create safe space for vulnerability. Use prompts that invite sharing without pressure. Facilitator notes should emphasize consent and opt-out.');
	if (depth === 'light') tips.push('EMOTIONAL DEPTH: Keep tone playful, avoid heavy topics. Quick check-ins, not deep dives.');
	if (energy === 'high') tips.push('ENERGY: Design for movement, quick transitions, physical engagement. Avoid long seated phases.');
	if (energy === 'low') tips.push('ENERGY: Calm, seated or slow movement. Allow thinking time, no rush.');
	if (setting === 'outdoor') tips.push('SETTING: Leverage nature — spatial awareness, sensory input, natural materials. Consider weather.');
	if (setting === 'indoor') tips.push('SETTING: Optimize for classroom/room — clear boundaries, minimal setup, furniture as props.');
	if (filters?.cuisine) tips.push(`CUISINE: Focus on ${filters.cuisine} — connect to nutrition, culture, or sensory learning.`);
	if (filters?.focus) tips.push(`MEDITATION FOCUS: ${filters.focus} — use evidence-based techniques (breath work, body scan, etc.).`);

	return tips.join('\n');
}

// ─── Systémový prompt ───
function buildSystemPrompt() {
	return `You are a CREATIVE GAME DESIGNER who speaks like a Gen Z friend — casual, relatable, fun. You design original educational games for facilitators (teachers, trainers, youth workers). You know pedagogy (Kolb, Bloom, experiential learning) but you EXPLAIN things simply, like you're talking to a mate.

IDENTITY:
- Game designer with solid pedagogy knowledge — but you NEVER sound like a textbook
- You respond ONLY based on the user's PANEL INPUT — every filter above "Spawnuj hru" is your mandatory brief
- You can use professional/technical content from knowledge base — but you INTERPRET it simply and add EXAMPLES

CONTEXT — PANEL INPUT IS YOUR BRIEF:
The user configures a left panel with: MÓD (mode), VĚK (age), SQUAD (players), TIMER (duration), MAPA (setting), ENERGY, mode-specific filters (activity/depth/cuisine/focus), RVP filters (classroom), POPIS (custom description). EVERY value from that panel is your INPUT. You MUST use ALL of them. Do NOT invent values the user did not choose. Do NOT forget or ignore any panel input.

VOICE & STYLE — GEN Z, NOT ACADEMIC:
- Write like a chill friend explaining a game — NOT like a professor or academic paper
- Use casual, relatable language. Gaming slang where it fits: "spawn", "quest", "level up", "grind", "vibe", "lowkey", "no cap", "fr"
- CZ/SK: "v pohodě", "lit", "based", "to je vibe", "žádný cap", "lowkey", "prostě"
- AVOID: stiff phrases, formal jargon, long academic sentences, "pedagogically sound", "facilitate", "scaffolding" — say it simply!
- ALWAYS include CONCRETE EXAMPLES in instructions (e.g. "např. Honza hází míč Zuzce a říká její jméno")
- Learning goals: keep them clear but phrase them like "co si odnesou" — not like curriculum bullet points
- Reflection prompts: ask like a friend would — "Co ti šlo nejlíp? Co bys příště udělal jinak?"
- facilitatorNotes: tips for the leader, written like a buddy giving advice — "Prostě nech je to baví, netlač na výkon"

RULES:
- Generate ONE UNIQUE, ORIGINAL game — do not recreate well-known games.
- The game must be practical, immediately playable, and described in detail.
- Instructions: clear, step-by-step, with CONCRETE EXAMPLES (e.g. "První hráč hodí míč a řekne jméno — např. 'Petra!' — chytající odpoví 'Díky, Honzo!' a hodí dál").
- Materials must be commonly available (paper, ball, markers...).
- Always include reflection prompts (casual, friend-like) and safety notes (simple, no jargon).
- If mode is "classroom", include full RVP ZV mapping (competences, areas, cross-topics).
- If mode is "cooking", the game MUST be a cooking/recipe activity.
- If mode is "meditation", the game MUST be a mindfulness/wellness exercise.
- Respond ONLY with a valid JSON object — no markdown, no comments.
- Language is specified in the user message — write ALL output in that language.

CRITICAL — PANEL INPUT COMPLIANCE:
The user specifies MANDATORY constraints below. You MUST satisfy ALL of them. Before outputting JSON, verify:
✓ playerCount.min and playerCount.max fall within the specified player range
✓ duration.min and duration.max fall within the specified time range
✓ setting matches the specified environment (indoor/outdoor)
✓ mode matches the specified mode
✓ The game's THEME and AESTHETIC match the mode (circus=circus theme, cooking=food theme, etc.)
✓ If activity is "solo", playerCount MUST be {min:1, max:1}
✓ If facilitator wrote a POPIS (description), you MUST weave it into the game design
If ANY constraint fails, regenerate before responding.

RESPONSE FORMAT — exactly this JSON shape:
${COMPACT_GAME_SCHEMA}

IMPORTANT: Generate "id" as "ai-" + random 6-character code. All fields are required.`;
}

// Computed once at startup — identical string every call → OpenAI prompt cache activates.
const STATIC_SYSTEM_PROMPT = buildSystemPrompt();

// ─── Rate limit for /api/generate-game (per-IP or per-user, paid=higher limit) ───
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_FREE = 10;
const RATE_LIMIT_MAX_PRO = 30;
const generateGameRateMap = new Map(); // key -> { count, resetAt }

function cleanupRateLimitMap() {
	const now = Date.now();
	for (const [key, data] of generateGameRateMap.entries()) {
		if (data.resetAt < now) generateGameRateMap.delete(key);
	}
}
setInterval(cleanupRateLimitMap, 60 * 1000);

function checkGenerateGameRateLimit(key, limit) {
	const now = Date.now();
	let data = generateGameRateMap.get(key);
	if (!data || data.resetAt < now) {
		data = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
		generateGameRateMap.set(key, data);
	}
	data.count++;
	if (data.count > limit) return { ok: false };
	return { ok: true };
}

// ─── API endpoint ───
app.post('/api/generate-game', async (req, res, next) => {
	const ip = req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
	let limit = RATE_LIMIT_MAX_FREE;
	let key = `ip:${ip}`;
	try {
		const user = await optionalSupabaseUser(req);
		if (user && coinsDbPool) {
			key = `user:${user.id}`;
			const state = await getUserBillingState(coinsDbPool, user.id);
			if (hasPaidAccess(state)) limit = RATE_LIMIT_MAX_PRO;
		}
	} catch (e) {
		console.warn('[GenerateGame] Rate limit user lookup:', e.message);
	}
	const rate = checkGenerateGameRateLimit(key, limit);
	if (!rate.ok) {
		return res.status(429).json({
			error: 'Príliš veľa požiadaviek. Skúste znova o minútu.',
			code: 'RATE_LIMIT_EXCEEDED',
			retryAfter: 60
		});
	}
	next();
}, async (req, res) => {
	const { filters, remix } = req.body;

	// API kľúč výhradne z .env (nikdy z klienta)
	const effectiveKey = process.env.OPENAI_API_KEY;

	if (!effectiveKey || effectiveKey === 'sk-your-openai-api-key-here') {
		return res.status(400).json({
			error: 'To enable AI generation, set OPENAI_API_KEY in your .env file.',
			code: 'NO_API_KEY'
		});
	}

	// Inicializuj klienta ak treba
	if (!openai) {
		openai = new OpenAI({ apiKey: effectiveKey });
	}

	const f = filters || {};
	const filterDescription = buildFilterDescription(f);
	const didacticGuidance = buildDidacticGuidance(f);
	const aiLanguage = f.aiLanguage || 'Czech';

	// Zhrnutie panelu pre AI — VŠETKO nad "Spawnuj hru", ľudsky čitateľné
	const modeLabels = { party: 'Párty/teambuilding', classroom: 'Trieda/vzdelávanie', reflection: 'Reflexia', circus: 'Cirkus', cooking: 'Varenie', meditation: 'Meditácia' };
	const playerLabels = { solo: '1 hráč', small: '2–5 hráčov', medium: '6–15 hráčov', large: '16–30 hráčov' };
	const durationLabels = { quick: '5–15 min', medium: '15–30 min', long: '30–60 min' };
	const settingLabels = { any: 'kdekoľvek', indoor: 'vnútri', outdoor: 'vonku' };
	const energyLabels = { low: 'nízka', medium: 'stredná', high: 'vysoká' };
	const activityLabels = { solo: 'sólo', pair: 'dvojice', group: 'skupinka', mass: 'hromadná' };
	const depthLabels = { light: 'ľahká', medium: 'stredná', deep: 'hlboká' };
	const cuisineLabels = { sweet: 'sladká', savory: 'slaná', healthy: 'zdravá', international: 'svetová' };
	const focusLabels = { breath: 'dych', body: 'telo', visualization: 'vizualizácia', movement: 'pohyb/jóga' };

	const panelSummary = [
		`═══ VŠETKO Z ĽAVÉHO PANELU (nad tlačidlom Spawnuj hru) — POUŽI VŠETKO ═══`,
		``,
		`MÓD (režim): ${modeLabels[f.mode] || f.mode || 'party'} — hra MUSÍ byť v tomto štýle`,
		`VĚK: ${f.ageMin || '?'}–${f.ageMax || '?'} rokov`,
		`SQUAD (počet hráčov): ${playerLabels[f.players] || f.players || 'ľubovoľný'}`,
		`TIMER (dĺžka): ${durationLabels[f.duration] || f.duration || 'ľubovoľná'}`,
		`MAPA (prostredie): ${settingLabels[f.setting] || f.setting || 'any'}`,
		`ENERGY: ${energyLabels[f.energy] || f.energy || 'ľubovoľná'}`,
		f.activity ? `TYP AKTIVITY (circus): ${activityLabels[f.activity] || f.activity}` : null,
		f.depth ? `EMOČNÁ HĽBKA (reflection): ${depthLabels[f.depth] || f.depth}` : null,
		f.cuisine ? `TYP KUCHYNE (cooking): ${cuisineLabels[f.cuisine] || f.cuisine}` : null,
		f.focus ? `ZAMERANIE (meditation): ${focusLabels[f.focus] || f.focus}` : null,
		f.stupen ? `RVP STUPEŇ: ${f.stupen === 'prvni' ? '1. stupeň (6–11)' : '2. stupeň (11–15)'}` : null,
		f.kompetence ? `RVP KOMPETENCIA: ${f.kompetence}` : null,
		f.oblast ? `RVP OBLAST: ${f.oblast}` : null,
		f.description ? `POPIS (zadanie od používateľa — MUSÍŠ zapracovať): "${f.description}"` : null
	].filter(Boolean).join('\n');

	const exactValues = buildExactValuesBlock(f);
	const userContent = `${panelSummary}
${exactValues}
══════════════════════════════════════
MANDATORY CONSTRAINTS (do NOT forget):
══════════════════════════════════════

${filterDescription}

══════════════════════════════════════
DIDACTIC GUIDANCE (research-backed):
══════════════════════════════════════

${didacticGuidance}

──────────────────────────────────────
ÚLOHA: Vygeneruj jednu originálnu hru/aktivitu.
POUŽI VŠETKY vstupy z panelu vyššie — každý filter je tvoj brief.
ŠTÝL: Piš Gen Z — jednoducho, uvolnene, s príkladmi. Žiadny akademický žargón.
PRÍKLADY: V inštrukciách, reflexných otázkach a poznámkach vždy uveď konkrétne príklady (napr. "Honza hádže loptu Zuzke a povie jej meno").
Pred odpoveďou skontroluj, či si splnil VŠETKY obmedzenia.
Odpovedz JEDNÝM JSON objektom.
──────────────────────────────────────
LANGUAGE: Write ALL output in ${aiLanguage}. Every text field must be in ${aiLanguage}.${knowledgeSummary ? `
──────────────────────────────────────
═══ SOURCE OF KNOWLEDGE ═══
The following reference material was uploaded by the facilitator. Use it to ENRICH and CUSTOMIZE the generated game.
- You MAY use professional/technical content from these files — themes, facts, scenarios
- BUT: INTERPRET everything SIMPLY. Explain like you're telling a friend, not citing a textbook
- Add CONCRETE EXAMPLES based on the content (e.g. if it mentions photosynthesis, say "rostlina bere světlo a dělá z něj jídlo — ako solárny panel")
- Always respect the MANDATORY CONSTRAINTS above.

${knowledgeSummary}
═══ END SOURCE OF KNOWLEDGE ═══` : ''}${(remix && typeof remix === 'object' && remix.title) ? `
──────────────────────────────────────
REMIX — VYTVOR VARIÁCIU (neplagiaruj, len sa inšpiruj):
Pôvodná hra: "${remix.title}"
Pôvodný mód: ${remix.mode || 'neuvedený'}
Pôvodné kompetencie: ${(remix.rvp?.kompetence || []).join(', ') || 'neuvedené'}
Pôvodné ciele učenia: ${(remix.learningGoals || []).slice(0, 3).join(' | ') || 'neuvedené'}
Zachovaj mód, vzdelávacie ciele a kompetencie. Zmeň mechaniku, materiály, názov a postup VÝRAZNE.
──────────────────────────────────────` : ''}`;

	const FALLBACK_MODEL = 'gpt-4o-mini';
	// Repair always uses the cheaper mini model — fast, low-cost, sufficient for structural fixes.
	const REPAIR_MODEL = 'gpt-4o-mini';
	const model = process.env.OPENAI_MODEL || 'gpt-4o';
	const fallbackModel = model !== FALLBACK_MODEL ? FALLBACK_MODEL : 'gpt-4o';
	const maxTokens = parseInt(process.env.OPENAI_MAX_TOKENS) || 2000;
	const temperature = parseFloat(process.env.OPENAI_TEMPERATURE) || 0.8;

	console.log(`[API] Generujem hru: model=${model}, filters:`, JSON.stringify(filters, null, 0));

	// Models that support response_format: json_object.
	// Keeps the JSON guarantee at the API level — eliminates parse failures upstream.
	function supportsJsonFormat(modelId) {
		return /^gpt-4o|^gpt-4-turbo|^gpt-3\.5-turbo-(?:1106|0125|16k)/.test(modelId);
	}

	async function callAPI(useModel) {
		const isLegacy = /^gpt-5\./.test(useModel); // GPT-5 uses max_completion_tokens
		const opts = {
			model: useModel,
			temperature,
			messages: [
				{ role: 'system', content: STATIC_SYSTEM_PROMPT },
				{ role: 'user', content: userContent }
			]
		};
		opts[isLegacy ? 'max_completion_tokens' : 'max_tokens'] = maxTokens;
		if (supportsJsonFormat(useModel)) {
			opts.response_format = { type: 'json_object' };
		}
		return openai.chat.completions.create(opts);
	}

	// Extracts a JSON object from raw AI output.
	// Handles: bare JSON, markdown code fences, JSON embedded in prose.
	function extractJSON(raw) {
		let s = (raw || '').trim();
		// Case 1: wrapped in markdown code fences ```json ... ```
		const fenceMatch = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
		if (fenceMatch) return fenceMatch[1].trim();
		// Case 2: JSON object starts mid-string (model added a preamble)
		const objStart = s.indexOf('{');
		const objEnd = s.lastIndexOf('}');
		if (objStart > 0 && objEnd > objStart) {
			return s.substring(objStart, objEnd + 1);
		}
		// Case 3: already clean JSON
		return s;
	}

	try {
		// ── Step 1: Call primary model, fall back to cheaper model on 404 ──
		let response;
		let usedModel = model;
		try {
			response = await callAPI(model);
		} catch (modelErr) {
			if ((modelErr.status === 404 || modelErr.code === 'model_not_found') && model !== fallbackModel) {
				console.warn(`[API] Model ${model} nedostupný, skúšam ${fallbackModel}`);
				usedModel = fallbackModel;
				response = await callAPI(fallbackModel);
			} else {
				throw modelErr;
			}
		}

		const content = response.choices[0]?.message?.content;
		if (!content) {
			throw new Error('Prázdna odpoveď z OpenAI');
		}

		// ── Step 2: Parse JSON — if parse fails, try one repair call ──
		let gameJSON = extractJSON(content);
		let game;
		try {
			game = JSON.parse(gameJSON);
		} catch (parseErr) {
			console.warn('[API] JSON parse zlyhalo, skúšam repair...');
			const repairResp = await callRepairAPI(content, ['Output is not valid JSON — fix it'], REPAIR_MODEL, aiLanguage);
			const repairContent = repairResp.choices[0]?.message?.content || '';
			game = JSON.parse(extractJSON(repairContent)); // throws SyntaxError if still broken
		}

		// ── Step 3: Validate schema — if invalid, try one repair call ──
		let validationErrors = validateGame(game);
		if (validationErrors.length > 0) {
			console.warn(`[API] Validácia zlyhala (${validationErrors.length} chýb), skúšam repair...`, validationErrors);
			const repairResp = await callRepairAPI(gameJSON, validationErrors, REPAIR_MODEL, aiLanguage);
			const repairContent = repairResp.choices[0]?.message?.content || '';
			const repairedGame = JSON.parse(extractJSON(repairContent));
			validationErrors = validateGame(repairedGame);
			if (validationErrors.length > 0) {
				console.error('[API] Repair zlyhala — vraciam VALIDATION_ERROR.', validationErrors);
				return res.status(502).json({
					error: 'AI vrátilo neplatný formát hry aj po oprave. Skúste znova.',
					code: 'VALIDATION_ERROR',
					details: validationErrors
				});
			}
			game = repairedGame;
		}

		// ── Step 3b: Safety check — hard-reject, no repair ──
		const safetyViolations = validateSafety(game);
		if (safetyViolations.length > 0) {
			console.error('[API] Safety check zlyhala:', safetyViolations);
			return res.status(422).json({
				error: 'Vygenerovaná hra neprešla bezpečnostnou kontrolou.',
				code: 'SAFE_GENERATION_FAILED',
				details: safetyViolations
			});
		}

		// ── Step 4: Enforce filter constraints server-side ──
		enforceConstraints(game, f);

		console.log(`[API] Hra vygenerovaná: "${game.title}" (model: ${usedModel})`);

		// Metadata
		game._engine = 'ai';
		game._model = usedModel;
		game._timestamp = new Date().toISOString();

		res.json(game);

	} catch (err) {
		console.error('[API] Chyba generovania:', err.message);

		if (err.code === 'invalid_api_key' || err.status === 401) {
			return res.status(401).json({ error: 'Neplatný API kľúč.', code: 'INVALID_KEY' });
		}
		if (err.status === 429) {
			return res.status(429).json({ error: 'Príliš veľa požiadaviek. Skúste znova o chvíľu.', code: 'RATE_LIMIT' });
		}
		if (err instanceof SyntaxError) {
			return res.status(502).json({ error: 'AI vrátilo neplatný JSON aj po oprave. Skúste znova.', code: 'PARSE_ERROR' });
		}

		res.status(500).json({
			error: `Chyba generovania: ${err.message}`,
			code: 'GENERATION_ERROR'
		});
	}
});

// ─── Knowledge endpoint ───
app.get('/api/knowledge', (req, res) => {
	res.json({
		status: 'ok',
		fileCount: knowledgeCache.length,
		totalChars: knowledgeSummary.length,
		files: knowledgeCache.map(k => ({
			name: k.name,
			ext: k.ext,
			size: k.size,
			modified: k.modified,
			preview: k.content.substring(0, 200) + (k.content.length > 200 ? '…' : '')
		}))
	});
});

// ─── Knowledge reload endpoint ───
app.post('/api/knowledge/reload', (req, res) => {
	loadKnowledgeBase();
	res.json({
		status: 'ok',
		fileCount: knowledgeCache.length,
		message: `Reloaded ${knowledgeCache.length} knowledge files.`
	});
});

// ─── Coin API ───
app.get('/api/coins/balance', async (req, res) => {
	if (!coinApiReady()) return respondCoinApiDisabled(res);
	const user = await requireSupabaseUser(req, res);
	if (!user) return;
	try {
		const { rows } = await queryCoinsDb('SELECT coins, updated_at FROM public.profiles WHERE id = $1 LIMIT 1', [user.id]);
		const profileRow = rows?.[0] || null;
		const balance = profileRow ? Math.max(0, parseInt(profileRow.coins, 10) || 0) : 0;
		res.json({
			balance,
			updatedAt: profileRow?.updated_at || null
		});
	} catch (err) {
		console.error('[Coins] balance query failed:', err.message);
		res.status(500).json({ error: 'Nepodarilo sa načítať coin balance', code: 'BALANCE_ERROR' });
	}
});

app.get('/api/coins/history', async (req, res) => {
	if (!coinApiReady()) return respondCoinApiDisabled(res);
	const user = await requireSupabaseUser(req, res);
	if (!user) return;
	const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 20, 100));
	try {
		const { rows } = await queryCoinsDb(
			`SELECT id, amount, action, metadata, created_at\n			 FROM public.coin_transactions\n			 WHERE user_id = $1\n			 ORDER BY created_at DESC\n			 LIMIT $2`,
			[user.id, limit]
		);
		res.json({
			transactions: rows.map(row => ({
				id: row.id,
				amount: row.amount,
				action: row.action,
				metadata: row.metadata || null,
				createdAt: row.created_at
			}))
		});
	} catch (err) {
		console.error('[Coins] history query failed:', err.message);
		res.status(500).json({ error: 'Nepodarilo sa načítať históriu coinov', code: 'HISTORY_ERROR' });
	}
});

app.post('/api/coins/log', async (req, res) => {
	if (!coinApiReady()) return respondCoinApiDisabled(res);
	const user = await requireSupabaseUser(req, res);
	if (!user) return;
	const { amount, action, metadata } = req.body || {};
	if (!Number.isInteger(amount) || typeof action !== 'string' || !action.trim()) {
		return res.status(400).json({ error: 'amount (integer) a action (string) sú povinné' });
	}
	try {
		await queryCoinsDb(
			'INSERT INTO public.coin_transactions (user_id, amount, action, metadata) VALUES ($1, $2, $3, $4)',
			[user.id, amount, action.trim(), metadata || null]
		);
		res.json({ ok: true });
	} catch (err) {
		console.error('[Coins] log insert failed:', err.message);
		res.status(500).json({ error: 'Nepodarilo sa zaznamenať transakciu', code: 'LOG_ERROR' });
	}
});

// ─── Billing API (Payment Link MVP — manual provisioning) ───
const STRIPE_PAYMENT_LINK = process.env.STRIPE_PAYMENT_LINK_PRO_MONTHLY || '';

app.get('/api/billing/state', async (req, res) => {
	if (!coinApiReady()) return res.status(503).json({ error: 'Service unavailable', code: 'DB_UNAVAILABLE' });
	const user = await requireSupabaseUser(req, res);
	if (!user) return;
	try {
		const state = await getUserBillingState(coinsDbPool, user.id);
		const planCode = getUserPlan(state);
		const paid = hasPaidAccess(state);
		res.json({
			planCode,
			hasPaidAccess: paid,
			billingNote: state?.billing_note || null
		});
	} catch (err) {
		console.error('[Billing] state failed:', err.message);
		res.status(500).json({ error: 'Failed to load billing state', code: 'BILLING_ERROR' });
	}
});

app.get('/api/billing/upgrade-url', async (req, res) => {
	const user = await requireSupabaseUser(req, res);
	if (!user) return;
	const url = (STRIPE_PAYMENT_LINK || '').trim();
	if (!url) return res.status(503).json({ error: 'Upgrade not configured', code: 'BILLING_DISABLED' });
	res.json({ url }); // Payment Link URL — no secret, safe to expose
});

// ─── Mode-click coin award — server-authoritative with daily cap ───
// Client calls this instead of awarding locally; server checks daily total and
// atomically logs + credits. Returns 429 when cap is reached (no award).
const MODE_CLICK_DAILY_CAP = 1000;
const MODE_CLICK_AMOUNT    = 1;

app.post('/api/coins/award-mode-click', async (req, res) => {
	if (!coinApiReady()) return respondCoinApiDisabled(res);
	const user = await requireSupabaseUser(req, res);
	if (!user) return;

	try {
		// Sum today's mode_click earnings for this user (UTC day boundary)
		const { rows } = await queryCoinsDb(
			`SELECT COALESCE(SUM(amount), 0)::int AS daily_total
			 FROM public.coin_transactions
			 WHERE user_id = $1 AND action = 'mode_click'
			   AND created_at >= CURRENT_DATE`,
			[user.id]
		);
		const dailyTotal = rows[0]?.daily_total || 0;

		if (dailyTotal >= MODE_CLICK_DAILY_CAP) {
			console.log(`[Coins] mode_click cap hit for user ${user.id} (${dailyTotal}/${MODE_CLICK_DAILY_CAP})`);
			return res.status(429).json({
				awarded: false,
				reason: 'Daily cap reached',
				code: 'MODE_CLICK_DAILY_CAP',
				daily_total: dailyTotal,
				cap: MODE_CLICK_DAILY_CAP
			});
		}

		// Atomically log transaction + credit profile
		const client = await coinsDbPool.connect();
		try {
			await client.query('BEGIN');
			await client.query(
				'INSERT INTO public.coin_transactions (user_id, amount, action) VALUES ($1, $2, $3)',
				[user.id, MODE_CLICK_AMOUNT, 'mode_click']
			);
			await client.query(
				'UPDATE public.profiles SET coins = COALESCE(coins, 0) + $1 WHERE id = $2',
				[MODE_CLICK_AMOUNT, user.id]
			);
			await client.query('COMMIT');
		} catch (txErr) {
			await client.query('ROLLBACK');
			throw txErr;
		} finally {
			client.release();
		}

		const newTotal = dailyTotal + MODE_CLICK_AMOUNT;
		console.log(`[Coins] mode_click awarded to ${user.id} (${newTotal}/${MODE_CLICK_DAILY_CAP})`);
		res.json({ awarded: true, amount: MODE_CLICK_AMOUNT, daily_total: newTotal, cap: MODE_CLICK_DAILY_CAP });
	} catch (err) {
		console.error('[Coins] award-mode-click failed:', err.message);
		res.status(500).json({ error: 'Nepodarilo sa udeliť mode_click coin', code: 'AWARD_ERROR' });
	}
});

// ─── Solo game completion — awards competency points to authenticated user ───
app.post('/api/profile/complete-solo', async (req, res) => {
	if (!coinApiReady()) return respondCoinApiDisabled(res);
	const user = await requireSupabaseUser(req, res);
	if (!user) return;

	const { game_json } = req.body || {};
	const kompetence = game_json?.rvp?.kompetence;
	if (!Array.isArray(kompetence) || kompetence.length === 0) {
		return res.status(400).json({ error: 'game_json.rvp.kompetence je povinné', code: 'MISSING_COMPETENCIES' });
	}

	// ─── Solo cooldown: max SOLO_DAILY_LIMIT per 24h ──────────────
	try {
		const { rows: soloRows } = await queryCoinsDb(
			`SELECT COUNT(*)::int AS cnt FROM public.coin_transactions
			 WHERE user_id = $1 AND action = 'solo_complete'
			   AND created_at > NOW() - INTERVAL '24 hours'`,
			[user.id]
		);
		if ((soloRows[0]?.cnt || 0) >= SOLO_DAILY_LIMIT) {
			return res.status(429).json({
				error: `Denný limit solo hier dosiahnutý (${soloRows[0].cnt}/${SOLO_DAILY_LIMIT})`,
				code: 'SOLO_DAILY_LIMIT'
			});
		}
	} catch (e) {
		console.error('[Completion] solo cooldown check failed:', e.message);
		return res.status(500).json({ error: 'Kontrola limitu zlyhala', code: 'COOLDOWN_CHECK_ERROR' });
	}

	try {
		// Fetch current competency points
		const { rows: profileRows } = await queryCoinsDb(
			'SELECT competency_points FROM public.profiles WHERE id = $1',
			[user.id]
		);
		const current = profileRows[0]?.competency_points || {};

		// Merge: add COMPETENCY_AWARD to each listed competency
		const updated = { ...current };
		const awarded = {};
		const validKomps = kompetence.filter(k => VALID_COMPETENCY_KEYS.includes(k));
		// Snapshot levels before awarding — used for level-up detection below
		const prevLevels = {};
		validKomps.forEach(k => { prevLevels[k] = computeLevel(current[k] || 0); });
		validKomps.forEach(k => {
			updated[k] = (parseInt(updated[k], 10) || 0) + COMPETENCY_AWARD;
			awarded[k] = COMPETENCY_AWARD;
		});
		// Compute per-competency level changes
		const level_changes = {};
		validKomps.forEach(k => {
			const from = prevLevels[k];
			const to   = computeLevel(updated[k]);
			level_changes[k] = {
				previous_points: from.points,
				new_points:      to.points,
				from_level:      from.level,
				to_level:        to.level,
				leveled_up:      from.level !== to.level,
			};
		});

		// Write updated competency points
		await queryCoinsDb(
			'UPDATE public.profiles SET competency_points = $1 WHERE id = $2',
			[JSON.stringify(updated), user.id]
		);

		// Award completion bonus coins
		await queryCoinsDb(
			'UPDATE public.profiles SET coins = COALESCE(coins, 0) + $1 WHERE id = $2',
			[COMPLETION_BONUS, user.id]
		);
		await queryCoinsDb(
			'INSERT INTO public.coin_transactions (user_id, amount, action, metadata) VALUES ($1, $2, $3, $4)',
			[user.id, COMPLETION_BONUS, 'solo_complete', JSON.stringify({ kompetence: awarded })]
		);

		res.json({ ok: true, awarded, competency_points: updated, competencies: enrichCompetencies(updated), level_changes });
	} catch (err) {
		console.error('[Completion] solo complete failed:', err.message);
		res.status(500).json({ error: 'Nepodarilo sa udeliť body', code: 'AWARD_ERROR' });
	}
});

// ─── Get competency points for authenticated user ───
app.get('/api/profile/competencies', async (req, res) => {
	if (!coinApiReady()) return respondCoinApiDisabled(res);
	const user = await requireSupabaseUser(req, res);
	if (!user) return;
	try {
		const { rows } = await queryCoinsDb(
			'SELECT competency_points FROM public.profiles WHERE id = $1',
			[user.id]
		);
		const raw = rows[0]?.competency_points || {};
		res.json({ competency_points: raw, competencies: enrichCompetencies(raw) });
	} catch (err) {
		console.error('[Competencies] fetch failed:', err.message);
		res.status(500).json({ error: 'Nepodarilo sa načítať kompetencie', code: 'COMP_ERROR' });
	}
});

// ─── Teacher analytics — aggregated stats for the authenticated user ───
// Reads profiles (games_generated, competency_points) + coin_transactions aggregate.
// No new tables or columns required.
app.get('/api/profile/analytics', async (req, res) => {
	if (!coinApiReady()) return respondCoinApiDisabled(res);
	const user = await requireSupabaseUser(req, res);
	if (!user) return;

	// Map competency keys to their i18n label keys (mirrors COMP_META in game-ui.js)
	const COMP_LABEL_KEYS = {
		'k-uceni':             'comp_learning',
		'k-reseni-problemu':   'comp_problem',
		'komunikativni':       'comp_comm',
		'socialni-personalni': 'comp_social',
		'obcanske':            'comp_civic',
		'pracovni':            'comp_work',
		'digitalni':           'comp_digital',
	};

	try {
		// 1. Profile row — games_generated, games_exported, competency_points
		const { rows: profRows } = await queryCoinsDb(
			`SELECT COALESCE(games_generated, 0)::int AS games_generated,
			        COALESCE(games_exported,  0)::int AS games_exported,
			        competency_points
			 FROM public.profiles WHERE id = $1`,
			[user.id]
		);
		const prof = profRows[0] || {};
		const compPoints = prof.competency_points || {};

		// 2. Transaction aggregates — solo/session counts + coin flows
		const { rows: txRows } = await queryCoinsDb(
			`SELECT
			   COUNT(*)           FILTER (WHERE action = 'solo_complete')    AS solo_completions,
			   COUNT(*)           FILTER (WHERE action = 'session_complete') AS session_completions,
			   COALESCE(SUM(amount)        FILTER (WHERE amount > 0), 0)::int AS coins_earned,
			   COALESCE(SUM(ABS(amount))   FILTER (WHERE amount < 0), 0)::int AS coins_spent
			 FROM public.coin_transactions WHERE user_id = $1`,
			[user.id]
		);
		const tx = txRows[0] || {};
		const solo     = parseInt(tx.solo_completions,    10) || 0;
		const sessions = parseInt(tx.session_completions, 10) || 0;

		// 3. Derive competency stats from stored points
		const pointEntries = VALID_COMPETENCY_KEYS.map(k => [k, parseInt(compPoints[k], 10) || 0]);
		const total_xp     = pointEntries.reduce((s, [, v]) => s + v, 0);
		const withPoints   = pointEntries.filter(([, v]) => v > 0);
		const strongest    = withPoints.length
			? withPoints.reduce((a, b) => b[1] > a[1] ? b : a)[0]
			: null;
		// Weakest only meaningful when ≥2 competencies have points
		const weakest      = withPoints.length > 1
			? withPoints.reduce((a, b) => b[1] < a[1] ? b : a)[0]
			: null;

		// 4. Dominant mode: inferred from solo vs session completions
		const dominant_mode = solo > sessions ? 'solo'
			: sessions > solo              ? 'session'
			: (solo + sessions > 0)        ? 'balanced'
			: null;

		res.json({
			games_generated:        prof.games_generated || 0,
			games_exported:         prof.games_exported  || 0,
			solo_completions:       solo,
			session_completions:    sessions,
			coins_earned:           parseInt(tx.coins_earned, 10) || 0,
			coins_spent:            parseInt(tx.coins_spent,  10) || 0,
			total_xp,
			strongest,
			strongest_label_key:    strongest ? (COMP_LABEL_KEYS[strongest] || strongest) : null,
			weakest,
			weakest_label_key:      weakest   ? (COMP_LABEL_KEYS[weakest]   || weakest)   : null,
			dominant_mode,
		});
	} catch (err) {
		console.error('[Analytics] fetch failed:', err.message);
		res.status(500).json({ error: 'Nepodarilo sa načítať analytiku', code: 'ANALYTICS_ERROR' });
	}
});

// ─── Sessions API ─────────────────────────────────────────────────

app.post('/api/sessions', async (req, res) => {
	if (!coinApiReady()) return respondCoinApiDisabled(res);
	const user = await requireSupabaseUser(req, res);
	if (!user) return;

	const { game_json } = req.body || {};
	if (!game_json?.title) {
		return res.status(400).json({ error: 'game_json je povinné', code: 'MISSING_GAME' });
	}

	// Generate unique join code (retry on collision)
	let join_code;
	for (let attempt = 0; attempt < 10; attempt++) {
		const candidate = generateJoinCode();
		const { rows } = await queryCoinsDb(
			'SELECT id FROM public.sessions WHERE join_code = $1', [candidate]
		);
		if (rows.length === 0) { join_code = candidate; break; }
	}
	if (!join_code) {
		return res.status(500).json({ error: 'Nepodarilo sa vygenerovať unikátny kód', code: 'CODE_GEN_ERROR' });
	}

	try {
		const { rows } = await queryCoinsDb(
			`INSERT INTO public.sessions (host_id, game_json, join_code)
			 VALUES ($1, $2, $3)
			 RETURNING id, join_code, status, created_at`,
			[user.id, JSON.stringify(game_json), join_code]
		);
		res.json(rows[0]);
	} catch (err) {
		console.error('[Sessions] create failed:', err.message);
		res.status(500).json({ error: 'Nepodarilo sa vytvoriť session', code: 'CREATE_ERROR' });
	}
});

app.get('/api/sessions/:code', async (req, res) => {
	if (!coinApiReady()) return respondCoinApiDisabled(res);
	const user = await requireSupabaseUser(req, res);
	if (!user) return;

	const code = (req.params.code || '').toUpperCase().trim();
	if (!code) return res.status(400).json({ error: 'Kód je povinný', code: 'MISSING_CODE' });

	try {
		const { rows: sRows } = await queryCoinsDb(
			`SELECT id, host_id, game_json, join_code, status, timer_ends_at, created_at
			 FROM public.sessions WHERE join_code = $1`,
			[code]
		);
		if (!sRows.length) return res.status(404).json({ error: 'Session nenájdená', code: 'NOT_FOUND' });
		const session = sRows[0];

		const { rows: pRows } = await queryCoinsDb(
			`SELECT sp.user_id, sp.coins_paid, sp.reflection_done, sp.joined_at,
			        p.display_name
			 FROM public.session_participants sp
			 LEFT JOIN public.profiles p ON p.id = sp.user_id
			 WHERE sp.session_id = $1
			 ORDER BY sp.joined_at ASC`,
			[session.id]
		);

		res.json({ ...session, participants: pRows });
	} catch (err) {
		console.error('[Sessions] get failed:', err.message);
		res.status(500).json({ error: 'Nepodarilo sa načítať session', code: 'FETCH_ERROR' });
	}
});

app.post('/api/sessions/:code/join', async (req, res) => {
	if (!coinApiReady()) return respondCoinApiDisabled(res);
	const user = await requireSupabaseUser(req, res);
	if (!user) return;

	const code = (req.params.code || '').toUpperCase().trim();
	try {
		const { rows } = await queryCoinsDb(
			'SELECT id, status FROM public.sessions WHERE join_code = $1', [code]
		);
		if (!rows.length) return res.status(404).json({ error: 'Session nenájdená', code: 'NOT_FOUND' });
		const sess = rows[0];
		if (sess.status !== 'waiting') {
			return res.status(409).json({ error: 'Session už beží alebo skončila', code: 'ALREADY_STARTED' });
		}

		// Check coin balance
		const { rows: pRows } = await queryCoinsDb(
			'SELECT coins FROM public.profiles WHERE id = $1', [user.id]
		);
		const coins = parseInt(pRows[0]?.coins, 10) || 0;
		if (coins < SESSION_JOIN_COST) {
			return res.status(402).json({
				error: `Potrebuješ aspoň ${SESSION_JOIN_COST} coinov pre vstup`,
				code: 'INSUFFICIENT_COINS'
			});
		}

		await queryCoinsDb(
			`INSERT INTO public.session_participants (session_id, user_id)
			 VALUES ($1, $2) ON CONFLICT (session_id, user_id) DO NOTHING`,
			[sess.id, user.id]
		);
		res.json({ ok: true, session_id: sess.id });
	} catch (err) {
		console.error('[Sessions] join failed:', err.message);
		res.status(500).json({ error: 'Nepodarilo sa pripojiť', code: 'JOIN_ERROR' });
	}
});

app.post('/api/sessions/:code/start', async (req, res) => {
	if (!coinApiReady()) return respondCoinApiDisabled(res);
	const user = await requireSupabaseUser(req, res);
	if (!user) return;

	const code = (req.params.code || '').toUpperCase().trim();
	try {
		const { rows } = await queryCoinsDb(
			'SELECT id, host_id, game_json, status FROM public.sessions WHERE join_code = $1', [code]
		);
		if (!rows.length) return res.status(404).json({ error: 'Session nenájdená', code: 'NOT_FOUND' });
		const sess = rows[0];
		if (sess.host_id !== user.id) {
			return res.status(403).json({ error: 'Len host môže štartovať session', code: 'NOT_HOST' });
		}
		if (sess.status !== 'waiting') {
			return res.status(409).json({ error: 'Session už beží', code: 'ALREADY_STARTED' });
		}

		const durationMin = sess.game_json?.duration?.max || 15;
		const timerEndsAt = new Date(Date.now() + durationMin * 60 * 1000).toISOString();

		// Deduct coins from all participants
		const { rows: parts } = await queryCoinsDb(
			'SELECT user_id FROM public.session_participants WHERE session_id = $1 AND coins_paid = 0', [sess.id]
		);

		for (const p of parts) {
			await queryCoinsDb(
				'UPDATE public.profiles SET coins = GREATEST(0, COALESCE(coins,0) - $1) WHERE id = $2',
				[SESSION_JOIN_COST, p.user_id]
			);
			await queryCoinsDb(
				'UPDATE public.session_participants SET coins_paid = $1 WHERE session_id = $2 AND user_id = $3',
				[SESSION_JOIN_COST, sess.id, p.user_id]
			);
			await queryCoinsDb(
				'INSERT INTO public.coin_transactions (user_id, amount, action, metadata) VALUES ($1, $2, $3, $4)',
				[p.user_id, -SESSION_JOIN_COST, 'session_join', JSON.stringify({ session_code: code })]
			);
		}

		await queryCoinsDb(
			`UPDATE public.sessions SET status = 'active', timer_ends_at = $1, started_at = NOW() WHERE id = $2`,
			[timerEndsAt, sess.id]
		);

		res.json({ ok: true, timer_ends_at: timerEndsAt, participants_charged: parts.length });
	} catch (err) {
		console.error('[Sessions] start failed:', err.message);
		res.status(500).json({ error: 'Nepodarilo sa štartovať session', code: 'START_ERROR', detail: err.message });
	}
});

app.post('/api/sessions/:code/reflect', async (req, res) => {
	if (!coinApiReady()) return respondCoinApiDisabled(res);
	const user = await requireSupabaseUser(req, res);
	if (!user) return;

	const code = (req.params.code || '').toUpperCase().trim();
	const { reflection_data } = req.body || {};
	if (!reflection_data || typeof reflection_data !== 'object' || Array.isArray(reflection_data)) {
		return res.status(400).json({ error: 'reflection_data (object) je povinné', code: 'MISSING_DATA' });
	}

	try {
		const { rows } = await queryCoinsDb(
			'SELECT id, status FROM public.sessions WHERE join_code = $1', [code]
		);
		if (!rows.length) return res.status(404).json({ error: 'Session nenájdená', code: 'NOT_FOUND' });
		const sess = rows[0];
		if (!['active', 'reflection'].includes(sess.status)) {
			return res.status(409).json({ error: 'Session nie je aktívna', code: 'WRONG_STATUS' });
		}

		const { rowCount } = await queryCoinsDb(
			`UPDATE public.session_participants
			 SET reflection_data = $1, reflection_done = true
			 WHERE session_id = $2 AND user_id = $3`,
			[JSON.stringify(reflection_data), sess.id, user.id]
		);
		// rowCount === 0 means host (not in session_participants) — silently ok so onSubmitted fires
		if (rowCount === 0) {
			console.warn(`[Sessions] reflect: user ${user.id} is not a participant in session ${sess.id} (likely host)`);
			// Return 200 so Reflection.js calls onSubmitted and host can complete the session
		}
		res.json({ ok: true });
	} catch (err) {
		console.error('[Sessions] reflect failed:', err.message);
		res.status(500).json({ error: 'Nepodarilo sa uložiť reflexiu', code: 'REFLECT_ERROR' });
	}
});

app.post('/api/sessions/:code/complete', async (req, res) => {
	if (!coinApiReady()) return respondCoinApiDisabled(res);
	const user = await requireSupabaseUser(req, res);
	if (!user) return;

	const code = (req.params.code || '').toUpperCase().trim();
	try {
		const { rows } = await queryCoinsDb(
			'SELECT id, host_id, game_json, status, started_at FROM public.sessions WHERE join_code = $1', [code]
		);
		if (!rows.length) return res.status(404).json({ error: 'Session nenájdená', code: 'NOT_FOUND' });
		const sess = rows[0];
		if (sess.host_id !== user.id) {
			return res.status(403).json({ error: 'Len host môže ukončiť session', code: 'NOT_HOST' });
		}
		if (sess.status === 'completed') {
			return res.status(409).json({ error: 'Session je už dokončená', code: 'ALREADY_COMPLETED' });
		}
		// Explicit status guard — only active or reflection sessions can complete
		if (!['active', 'reflection'].includes(sess.status)) {
			return res.status(409).json({ error: 'Session nie je aktívna', code: 'WRONG_STATUS' });
		}

		// ─── VALIDATION GATE 1: Duration ───────────────────────────────
		const durResult = validateDurationGate(sess.started_at, sess.game_json);
		if (!durResult.pass) {
			await queryCoinsDb(
				'UPDATE public.sessions SET reward_validation = $1 WHERE id = $2',
				[JSON.stringify(durResult.validation), sess.id]
			);
			return res.status(422).json({
				error: `Session trvala príliš krátko (${Math.round(durResult.validation.duration_actual_min)}/${durResult.validation.duration_required_min} min)`,
				code: 'DURATION_TOO_SHORT',
				validation: durResult.validation
			});
		}
		const actualMin = durResult.validation.duration_actual_min;

		// ─── VALIDATION GATE 2: Participant count ──────────────────────
		const { rows: paidParts } = await queryCoinsDb(
			'SELECT COUNT(*)::int AS cnt FROM public.session_participants WHERE session_id = $1 AND coins_paid > 0',
			[sess.id]
		);
		const actualPlayers = paidParts[0]?.cnt || 0;
		const partResult = validateParticipantGate(actualPlayers, sess.game_json);
		if (!partResult.pass) {
			await queryCoinsDb(
				'UPDATE public.sessions SET reward_validation = $1 WHERE id = $2',
				[JSON.stringify(partResult.validation), sess.id]
			);
			return res.status(422).json({
				error: `Nedostatok hráčov (${actualPlayers}/${partResult.validation.participants_required})`,
				code: 'NOT_ENOUGH_PLAYERS',
				validation: partResult.validation
			});
		}

		// ─── VALIDATION GATE 3: Host cooldown ──────────────────────────
		const { rows: cooldownRows } = await queryCoinsDb(
			`SELECT COUNT(*)::int AS cnt FROM public.sessions
			 WHERE host_id = $1 AND status = 'completed'
			   AND completed_at > NOW() - INTERVAL '1 hour'`,
			[user.id]
		);
		const hostSessionsLastHour = cooldownRows[0]?.cnt || 0;
		const coolResult = validateHostCooldownGate(hostSessionsLastHour);
		if (!coolResult.pass) {
			await queryCoinsDb(
				'UPDATE public.sessions SET reward_validation = $1 WHERE id = $2',
				[JSON.stringify(coolResult.validation), sess.id]
			);
			return res.status(429).json({
				error: `Príliš veľa sessions za hodinu (${hostSessionsLastHour}/${HOST_COOLDOWN_MAX}). Skús neskôr.`,
				code: 'HOST_COOLDOWN',
				validation: coolResult.validation
			});
		}

		// ─── Atomic status lock: prevent concurrent /complete race ─────
		// Compare-and-swap: only one request can transition away from active/reflection
		const { rowCount: lockCount } = await queryCoinsDb(
			`UPDATE public.sessions SET status = 'completing' WHERE id = $1 AND status IN ('active', 'reflection')`,
			[sess.id]
		);
		if (lockCount === 0) {
			return res.status(409).json({ error: 'Session je už dokončená', code: 'ALREADY_COMPLETED' });
		}

		// ─── Filter and whitelist competency keys ──────────────────────
		const rawKompetence = sess.game_json?.rvp?.kompetence || [];
		const kompetence = rawKompetence.filter(k => VALID_COMPETENCY_KEYS.includes(k));
		const awarded = {};
		kompetence.forEach(k => { awarded[k] = COMPETENCY_AWARD; });

		// ─── Transactional reward loop ─────────────────────────────────
		// All awards are wrapped in a single DB transaction to prevent
		// partial awarding on crash/error (atomicity guarantee).
		const client = await coinsDbPool.connect();
		let participantsRewarded = 0;
		let myLevelChanges = null;
		try {
			await client.query('BEGIN');

			const { rows: parts } = await client.query(
				`SELECT user_id FROM public.session_participants
				 WHERE session_id = $1 AND reflection_done = true AND awarded_competencies IS NULL`,
				[sess.id]
			);

			for (const p of parts) {
				const { rows: profRows } = await client.query(
					'SELECT competency_points FROM public.profiles WHERE id = $1', [p.user_id]
				);
				const current = profRows[0]?.competency_points || {};
				const updated = { ...current };
				const pPrevLevels = {};
				kompetence.forEach(k => { pPrevLevels[k] = computeLevel(current[k] || 0); });
				kompetence.forEach(k => {
					updated[k] = (parseInt(updated[k], 10) || 0) + COMPETENCY_AWARD;
				});
				// Track level changes for the requesting user
				if (p.user_id === user.id) {
					myLevelChanges = {};
					kompetence.forEach(k => {
						const from = pPrevLevels[k];
						const to   = computeLevel(updated[k]);
						myLevelChanges[k] = {
							previous_points: from.points,
							new_points:      to.points,
							from_level:      from.level,
							to_level:        to.level,
							leveled_up:      from.level !== to.level,
						};
					});
				}

				// UPSERT guards against silent failure when profile row does not exist yet;
				// a plain UPDATE would award 0 points with no error if the profile is missing.
				const { rowCount: profileRowCount } = await client.query(
					`INSERT INTO public.profiles (id, competency_points)
					 VALUES ($1, $2)
					 ON CONFLICT (id) DO UPDATE SET competency_points = EXCLUDED.competency_points`,
					[p.user_id, JSON.stringify(updated)]
				);
				if (profileRowCount === 0) console.error(`[Sessions] complete: profile upsert returned 0 rows for user ${p.user_id}`);
				await client.query(
					`UPDATE public.session_participants
					 SET awarded_competencies = $1 WHERE session_id = $2 AND user_id = $3`,
					[JSON.stringify(awarded), sess.id, p.user_id]
				);
				await client.query(
					'UPDATE public.profiles SET coins = COALESCE(coins,0) + $1 WHERE id = $2',
					[COMPLETION_BONUS, p.user_id]
				);
				await client.query(
					'INSERT INTO public.coin_transactions (user_id, amount, action, metadata) VALUES ($1, $2, $3, $4)',
					[p.user_id, COMPLETION_BONUS, 'session_complete', JSON.stringify({ session_code: code, kompetence: awarded })]
				);
			}
			participantsRewarded = parts.length;

			// Write audit trail + mark completed (inside transaction)
			const validation = {
				duration_actual_min: Math.round(actualMin * 10) / 10,
				duration_required_min: requiredMin,
				participants_actual: actualPlayers,
				participants_required: requiredPlayers,
				host_sessions_last_hour: hostSessionsLastHour,
				competencies_awarded: kompetence,
				participants_rewarded: parts.length,
				passed: true,
				validated_at: new Date().toISOString()
			};
			await client.query(
				`UPDATE public.sessions SET status = 'completed', completed_at = NOW(), reward_validation = $1 WHERE id = $2`,
				[JSON.stringify(validation), sess.id]
			);

			await client.query('COMMIT');

			res.json({ ok: true, awarded, participants_rewarded: participantsRewarded, validation, my_level_changes: myLevelChanges });
		} catch (txErr) {
			await client.query('ROLLBACK');
			// Revert status lock so host can retry
			await queryCoinsDb(
				`UPDATE public.sessions SET status = 'active' WHERE id = $1 AND status = 'completing'`,
				[sess.id]
			);
			throw txErr;
		} finally {
			client.release();
		}
	} catch (err) {
		console.error('[Sessions] complete failed:', err.message);
		res.status(500).json({ error: 'Nepodarilo sa ukončiť session', code: 'COMPLETE_ERROR' });
	}
});

// ─── Session reward: participant fetches their own level changes ───
// Back-calculates from stored awarded_competencies + current profile points.
// Only returns data for the authenticated requesting user — never exposes others.
app.get('/api/sessions/:code/my-reward', async (req, res) => {
	if (!coinApiReady()) return respondCoinApiDisabled(res);
	const user = await requireSupabaseUser(req, res);
	if (!user) return;

	const code = (req.params.code || '').toUpperCase().trim();
	try {
		// 1. Verify session exists and is completed
		const { rows: sessRows } = await queryCoinsDb(
			'SELECT id, status FROM public.sessions WHERE join_code = $1', [code]
		);
		if (!sessRows.length) return res.status(404).json({ error: 'Session nenájdená', code: 'NOT_FOUND' });
		const sess = sessRows[0];
		if (sess.status !== 'completed') {
			return res.status(400).json({ error: 'Session ešte nie je dokončená', code: 'NOT_COMPLETED' });
		}

		// 2. Fetch only this user's participant row
		const { rows: partRows } = await queryCoinsDb(
			`SELECT awarded_competencies FROM public.session_participants
			 WHERE session_id = $1 AND user_id = $2`,
			[sess.id, user.id]
		);
		if (!partRows.length) return res.status(404).json({ error: 'Nie si účastníkom tejto session', code: 'NOT_PARTICIPANT' });

		const awarded = partRows[0].awarded_competencies || {};
		if (!Object.keys(awarded).length) {
			// Participant didn't reflect or wasn't rewarded — return empty, no panel shown
			return res.json({ awarded: {}, competencies: enrichCompetencies({}), level_changes: {} });
		}

		// 3. Fetch current profile points (this user only)
		const { rows: profRows } = await queryCoinsDb(
			'SELECT competency_points FROM public.profiles WHERE id = $1', [user.id]
		);
		const current = profRows[0]?.competency_points || {};

		// 4. Back-calculate level changes: previous = current - awarded
		const level_changes = {};
		Object.keys(awarded).forEach(k => {
			const gain    = parseInt(awarded[k], 10) || 0;
			const newPts  = parseInt(current[k],  10) || 0;
			const prevPts = Math.max(0, newPts - gain);
			const from    = computeLevel(prevPts);
			const to      = computeLevel(newPts);
			level_changes[k] = {
				previous_points: prevPts,
				new_points:      newPts,
				from_level:      from.level,
				to_level:        to.level,
				leveled_up:      from.level !== to.level,
			};
		});

		res.json({ awarded, competencies: enrichCompetencies(current), level_changes });
	} catch (err) {
		console.error('[Sessions] my-reward failed:', err.message);
		res.status(500).json({ error: 'Nepodarilo sa načítať odmenu', code: 'REWARD_ERROR' });
	}
});

// ─── Public game viewer — no auth, read-only ───
app.get('/api/games/public/:id', async (req, res) => {
	if (!coinApiReady()) return res.status(503).json({ error: 'Databáza nie je dostupná', code: 'DB_UNAVAILABLE' });
	const { id } = req.params;
	if (!id || !/^[0-9a-f-]{36}$/.test(id)) {
		return res.status(400).json({ error: 'Neplatné ID hry', code: 'INVALID_ID' });
	}
	try {
		const { rows } = await queryCoinsDb(
			`SELECT game_json FROM public.saved_games WHERE public_token = $1 LIMIT 1`,
			[id]
		);
		if (rows.length === 0) return res.status(404).json({ error: 'Hra nenájdená', code: 'NOT_FOUND' });
		// game_json contains only AI-generated game content — no user data
		res.json(rows[0].game_json);
	} catch (err) {
		console.error('[Games/public] fetch failed:', err.message);
		res.status(500).json({ error: 'Chyba servera', code: 'FETCH_ERROR' });
	}
});

// ─── Game Library API ───
app.post('/api/games/save', async (req, res) => {
	if (!coinApiReady()) return respondCoinApiDisabled(res);
	const user = await requireSupabaseUser(req, res);
	if (!user) return;
	const { game } = req.body || {};
	if (!game || typeof game !== 'object' || !game.title) {
		return res.status(400).json({ error: 'Pole "game" (objekt s title) je povinné' });
	}
	const title = String(game.title).trim().slice(0, 200);
	const mode = String(game.mode || 'party').slice(0, 50);
	try {
		const { rows } = await queryCoinsDb(
			`INSERT INTO public.saved_games (user_id, title, mode, game_json)
			 VALUES ($1, $2, $3, $4)
			 RETURNING id, title, mode, created_at`,
			[user.id, title, mode, JSON.stringify(game)]
		);
		res.json({ ok: true, game: rows[0] });
	} catch (err) {
		console.error('[Games] save insert failed:', err.message);
		res.status(500).json({ error: 'Nepodarilo sa uložiť hru', code: 'SAVE_ERROR' });
	}
});

app.get('/api/games/library', async (req, res) => {
	if (!coinApiReady()) return respondCoinApiDisabled(res);
	const user = await requireSupabaseUser(req, res);
	if (!user) return;
	const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 50, 200));
	try {
		const { rows } = await queryCoinsDb(
			`SELECT id, title, mode, is_favorite, rating,
			        public_token IS NOT NULL AS is_shared,
			        created_at, updated_at
			 FROM public.saved_games
			 WHERE user_id = $1
			 ORDER BY is_favorite DESC, created_at DESC
			 LIMIT $2`,
			[user.id, limit]
		);
		res.json({ games: rows });
	} catch (err) {
		console.error('[Games] library query failed:', err.message);
		res.status(500).json({ error: 'Nepodarilo sa načítať knižnicu', code: 'LIBRARY_ERROR' });
	}
});

app.get('/api/games/:id', async (req, res) => {
	if (!coinApiReady()) return respondCoinApiDisabled(res);
	const user = await requireSupabaseUser(req, res);
	if (!user) return;
	const { id } = req.params;
	if (!id || !/^[0-9a-f-]{36}$/.test(id)) {
		return res.status(400).json({ error: 'Neplatné ID hry' });
	}
	try {
		const { rows } = await queryCoinsDb(
			`SELECT id, title, mode, game_json, is_favorite, rating, created_at
			 FROM public.saved_games
			 WHERE id = $1 AND user_id = $2
			 LIMIT 1`,
			[id, user.id]
		);
		if (rows.length === 0) return res.status(404).json({ error: 'Hra nenájdená', code: 'NOT_FOUND' });
		const row = rows[0];
		res.json({ ...row.game_json, _savedId: row.id, _savedAt: row.created_at, _favorite: row.is_favorite, _currentRating: row.rating || 0 });
	} catch (err) {
		console.error('[Games] fetch game failed:', err.message);
		res.status(500).json({ error: 'Nepodarilo sa načítať hru', code: 'FETCH_ERROR' });
	}
});

app.patch('/api/games/:id/favorite', async (req, res) => {
	if (!coinApiReady()) return respondCoinApiDisabled(res);
	const user = await requireSupabaseUser(req, res);
	if (!user) return;
	const { id } = req.params;
	if (!id || !/^[0-9a-f-]{36}$/.test(id)) {
		return res.status(400).json({ error: 'Neplatné ID hry' });
	}
	const { favorite } = req.body || {};
	try {
		const { rows } = await queryCoinsDb(
			`UPDATE public.saved_games SET is_favorite = $1, updated_at = now()
			 WHERE id = $2 AND user_id = $3
			 RETURNING id, is_favorite`,
			[!!favorite, id, user.id]
		);
		if (rows.length === 0) return res.status(404).json({ error: 'Hra nenájdená', code: 'NOT_FOUND' });
		res.json({ ok: true, favorite: rows[0].is_favorite });
	} catch (err) {
		console.error('[Games] favorite update failed:', err.message);
		res.status(500).json({ error: 'Nepodarilo sa aktualizovať obľúbenú', code: 'FAVORITE_ERROR' });
	}
});

// ─── Game publish / unpublish ───
app.patch('/api/games/:id/publish', async (req, res) => {
	if (!coinApiReady()) return respondCoinApiDisabled(res);
	const user = await requireSupabaseUser(req, res);
	if (!user) return;
	const { id } = req.params;
	if (!id || !/^[0-9a-f-]{36}$/.test(id)) {
		return res.status(400).json({ error: 'Neplatné ID hry' });
	}
	const { publish } = req.body || {};
	try {
		if (publish === false) {
			// Revoke: clear the token so all old links 404 immediately
			const { rowCount } = await queryCoinsDb(
				`UPDATE public.saved_games SET public_token = NULL, updated_at = NOW()
				 WHERE id = $1 AND user_id = $2`,
				[id, user.id]
			);
			if (rowCount === 0) return res.status(404).json({ error: 'Hra nenájdená', code: 'NOT_FOUND' });
			return res.json({ ok: true, token: null });
		}
		// Publish: generate token only if not already set (idempotent)
		const { rows } = await queryCoinsDb(
			`UPDATE public.saved_games
			 SET public_token = COALESCE(public_token, gen_random_uuid()), updated_at = NOW()
			 WHERE id = $1 AND user_id = $2
			 RETURNING public_token`,
			[id, user.id]
		);
		if (rows.length === 0) return res.status(404).json({ error: 'Hra nenájdená', code: 'NOT_FOUND' });
		res.json({ ok: true, token: rows[0].public_token });
	} catch (err) {
		console.error('[Games] publish toggle failed:', err.message);
		res.status(500).json({ error: 'Nepodarilo sa nastaviť zdieľanie', code: 'PUBLISH_ERROR' });
	}
});

// ─── Game rating ───
app.patch('/api/games/:id/rate', async (req, res) => {
	if (!coinApiReady()) return respondCoinApiDisabled(res);
	const user = await requireSupabaseUser(req, res);
	if (!user) return;
	const { id } = req.params;
	if (!id || !/^[0-9a-f-]{36}$/.test(id)) {
		return res.status(400).json({ error: 'Neplatné ID hry' });
	}
	const { rating, feedback } = req.body || {};
	if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
		return res.status(400).json({ error: 'rating musí byť celé číslo 1–5', code: 'INVALID_RATING' });
	}
	const cleanFeedback = feedback ? String(feedback).trim().slice(0, 500) : null;
	try {
		const { rowCount } = await queryCoinsDb(
			`UPDATE public.saved_games SET rating = $1, feedback = $2, updated_at = NOW()
			 WHERE id = $3 AND user_id = $4`,
			[rating, cleanFeedback, id, user.id]
		);
		if (rowCount === 0) return res.status(404).json({ error: 'Hra nenájdená', code: 'NOT_FOUND' });
		res.json({ ok: true });
	} catch (err) {
		console.error('[Games] rate update failed:', err.message);
		res.status(500).json({ error: 'Nepodarilo sa uložiť hodnotenie', code: 'RATE_ERROR' });
	}
});

app.delete('/api/games/:id', async (req, res) => {
	if (!coinApiReady()) return respondCoinApiDisabled(res);
	const user = await requireSupabaseUser(req, res);
	if (!user) return;
	const { id } = req.params;
	if (!id || !/^[0-9a-f-]{36}$/.test(id)) {
		return res.status(400).json({ error: 'Neplatné ID hry' });
	}
	try {
		const { rows } = await queryCoinsDb(
			`DELETE FROM public.saved_games WHERE id = $1 AND user_id = $2 RETURNING id`,
			[id, user.id]
		);
		if (rows.length === 0) return res.status(404).json({ error: 'Hra nenájdená', code: 'NOT_FOUND' });
		res.json({ ok: true });
	} catch (err) {
		console.error('[Games] delete failed:', err.message);
		res.status(500).json({ error: 'Nepodarilo sa zmazať hru', code: 'DELETE_ERROR' });
	}
});

// ─── Game inline edit ───
app.patch('/api/games/:id', async (req, res) => {
	if (!coinApiReady()) return respondCoinApiDisabled(res);
	const user = await requireSupabaseUser(req, res);
	if (!user) return;
	const { id } = req.params;
	if (!id || !/^[0-9a-f-]{36}$/.test(id)) {
		return res.status(400).json({ error: 'Neplatné ID hry' });
	}
	const ALLOWED = ['title', 'pitch', 'materials', 'instructions', 'learningGoals', 'reflectionPrompts', 'safetyNotes', 'adaptationTips', 'facilitatorNotes'];
	const body = req.body || {};
	const patch = {};
	for (const key of ALLOWED) {
		if (key in body) patch[key] = body[key];
	}
	if (Object.keys(patch).length === 0) {
		return res.status(400).json({ error: 'Žiadne povolené polia na aktualizáciu', code: 'NO_FIELDS' });
	}
	try {
		const { rows } = await queryCoinsDb(
			`UPDATE public.saved_games
			 SET game_json = game_json || $1::jsonb,
			     title = COALESCE($2, title),
			     updated_at = now()
			 WHERE id = $3 AND user_id = $4
			 RETURNING game_json`,
			[JSON.stringify(patch), patch.title ?? null, id, user.id]
		);
		if (rows.length === 0) return res.status(404).json({ error: 'Hra nenájdená', code: 'NOT_FOUND' });
		res.json({ ok: true, game: rows[0].game_json });
	} catch (err) {
		console.error('[Games] patch failed:', err.message);
		res.status(500).json({ error: 'Nepodarilo sa aktualizovať hru', code: 'PATCH_ERROR' });
	}
});

// ─── User Preferences API ───
app.get('/api/user/preferences', async (req, res) => {
	if (!coinApiReady()) return respondCoinApiDisabled(res);
	const user = await requireSupabaseUser(req, res);
	if (!user) return;
	try {
		const { rows } = await queryCoinsDb(
			`SELECT narrator_styles, narrator_lang FROM public.profiles WHERE id = $1`,
			[user.id]
		);
		if (rows.length === 0) return res.json({ narrator_styles: [], narrator_lang: 'sk' });
		res.json({
			narrator_styles: rows[0].narrator_styles || [],
			narrator_lang: rows[0].narrator_lang || 'sk'
		});
	} catch (err) {
		console.error('[Prefs] get failed:', err.message);
		res.status(500).json({ error: 'Nepodarilo sa načítať preferencie', code: 'PREFS_GET_ERROR' });
	}
});

app.patch('/api/user/preferences', async (req, res) => {
	if (!coinApiReady()) return respondCoinApiDisabled(res);
	const user = await requireSupabaseUser(req, res);
	if (!user) return;
	const { narrator_styles, narrator_lang } = req.body || {};
	const VALID_LANGS   = ['sk', 'cs', 'de', 'en', 'es'];
	const VALID_STYLES  = ['sangvinik', 'flegmatik', 'cholerik', 'melancholik', 'genz'];
	const updates = [];
	const params  = [user.id]; // $1 is always user_id
	if (narrator_styles !== undefined) {
		if (!Array.isArray(narrator_styles)) return res.status(400).json({ error: 'narrator_styles musí byť pole', code: 'INVALID_STYLES' });
		const filtered = narrator_styles.filter(s => VALID_STYLES.includes(s));
		params.push(filtered);
		updates.push(`narrator_styles = $${params.length}`);
	}
	if (narrator_lang !== undefined) {
		if (!VALID_LANGS.includes(narrator_lang)) return res.status(400).json({ error: 'Neplatný jazyk', code: 'INVALID_LANG' });
		params.push(narrator_lang);
		updates.push(`narrator_lang = $${params.length}`);
	}
	if (updates.length === 0) return res.json({ ok: true });
	try {
		const result = await queryCoinsDb(
			`UPDATE public.profiles SET ${updates.join(', ')} WHERE id = $1`,
			params
		);
		if (result.rowCount === 0) {
			console.warn('[Prefs] patch found no profile row for user:', user.id);
			return res.status(404).json({ error: 'Profil nenájdený', code: 'PROFILE_NOT_FOUND' });
		}
		res.json({ ok: true });
	} catch (err) {
		console.error('[Prefs] patch failed:', err.message);
		res.status(500).json({ error: 'Nepodarilo sa uložiť preferencie', code: 'PREFS_PATCH_ERROR' });
	}
});

// ─── Pripravené zaujímavosti pre vypraváča ───
let narratorFacts = { sk: [], cs: [], de: [], en: [], es: [] };
try {
	const factsPath = path.join(__dirname, 'data', 'narrator-facts.json');
	narratorFacts = JSON.parse(fs.readFileSync(factsPath, 'utf-8'));
} catch (e) { console.warn('[API] narrator-facts.json not loaded:', e.message); }

const FALLBACK_FACTS = {
	sk: ['Medúzy existujú na Zemi už viac ako 650 miliónov rokov – sú staršie ako dinosaury!', 'Včely komunikujú tancom.'],
	cs: ['Medúzy existují na Zemi už více než 650 milionů let – jsou starší než dinosauři!', 'Včely komunikují tancem.'],
	de: ['Quallen gibt es seit über 650 Millionen Jahren auf der Erde – älter als Dinosaurier!', 'Bienen kommunizieren durch Tanz.'],
	en: ['Jellyfish have existed on Earth for over 650 million years – older than dinosaurs!', 'Bees communicate through dance.'],
	es: ['Las medusas existen en la Tierra desde hace más de 650 millones de años.', 'Las abejas se comunican bailando.']
};
function getRandomLocalFact(lang) {
	const arr = narratorFacts[lang] || narratorFacts.sk;
	if (arr && arr.length > 0) return arr[Math.floor(Math.random() * arr.length)];
	const fallback = FALLBACK_FACTS[lang] || FALLBACK_FACTS.sk;
	return fallback[Math.floor(Math.random() * fallback.length)];
}

// ─── RVP CZ — obsah pre vzdelávacie zaujímavosti ───
let rvpData = null;
let rvpSummary = '';
try {
	const rvpPath = path.join(__dirname, 'data', 'rvp.json');
	rvpData = JSON.parse(fs.readFileSync(rvpPath, 'utf-8'));
	const parts = [];
	if (rvpData.kompetence) {
		for (const [k, v] of Object.entries(rvpData.kompetence)) {
			parts.push(`${v.nazev}: ${v.popis}`);
			if (v.indikatory?.length) parts.push('  ' + v.indikatory.slice(0, 3).join('; '));
		}
	}
	if (rvpData.vzdelavaci_oblasti) {
		for (const [k, v] of Object.entries(rvpData.vzdelavaci_oblasti)) {
			parts.push(`${v.nazev} — predmety: ${(v.predmety || []).join(', ')}`);
		}
	}
	if (rvpData.prurezova_temata) {
		parts.push('Průřezová témata: ' + Object.values(rvpData.prurezova_temata).join(', '));
	}
	rvpSummary = parts.join('\n');
	if (rvpSummary.length > 4000) rvpSummary = rvpSummary.substring(0, 4000) + '…';
	console.log('[API] RVP CZ načítaný pre random-fact.');
} catch (e) { console.warn('[API] rvp.json not loaded:', e.message); }

// ─── Debug: test OpenAI pre vypraváča ───
app.get('/api/random-fact-test', async (req, res) => {
	const key = process.env.OPENAI_API_KEY;
	const hasKey = key && key !== 'sk-your-openai-api-key-here';
	if (!hasKey) {
		return res.json({ ok: false, error: 'OPENAI_API_KEY nie je nastavený v .env' });
	}
	try {
		const client = new OpenAI({ apiKey: key });
		const { data } = await client.chat.completions.create({
			model: 'gpt-4o-mini',
			max_tokens: 50,
			messages: [{ role: 'user', content: 'Say hello in one word.' }]
		});
		const choice = data?.choices?.[0];
		const text = choice?.message?.content?.trim();
		const finishReason = choice?.finish_reason;
		return res.json({ ok: true, model: 'gpt-4o-mini', response: text, finish_reason: finishReason, raw: !!choice });
	} catch (err) {
		return res.json({ ok: false, error: err.message, code: err?.code });
	}
});

// ─── Narrator oblasti (pre výber v UI) ───
app.get('/api/narrator-areas', (req, res) => {
	const areas = [{ id: '', name: 'Náhodná oblasť' }];
	if (rvpData?.vzdelavaci_oblasti) {
		for (const [id, v] of Object.entries(rvpData.vzdelavaci_oblasti)) {
			areas.push({ id, name: v.nazev });
		}
	}
	if (rvpData?.kompetence) {
		for (const [id, v] of Object.entries(rvpData.kompetence)) {
			areas.push({ id: 'komp-' + id, name: v.nazev });
		}
	}
	if (rvpData?.prurezova_temata) {
		for (const [id, name] of Object.entries(rvpData.prurezova_temata)) {
			areas.push({ id: 'tema-' + id, name });
		}
	}
	res.json({ areas });
});

// ─── Random educational fact (AI vypraváč) — GPT-5.4 + RVP CZ + výber oblasti ───
app.get('/api/random-fact', async (req, res) => {
	const lang = (req.query.lang || 'sk').slice(0, 2);
	const areaId = (req.query.area || '').trim();
		const styleParam = (req.query.style || '').toLowerCase().trim();
		const styleList = styleParam ? styleParam.split(/[,\s]+/).filter(Boolean) : [];
	const effectiveKey = process.env.OPENAI_API_KEY;
	const hasKey = effectiveKey && effectiveKey !== 'sk-your-openai-api-key-here';

	if (!hasKey) {
		const fact = getRandomLocalFact(lang);
		console.log('[API] random-fact: no API key, local fact');
		return res.json({ fact, source: 'local' });
	}

	// OpenAI API — GPT-5.4 (Chat) pre generovanie, TTS pre čítanie
	if (!openai) openai = new OpenAI({ apiKey: effectiveKey });
	const langNames = { sk: 'Slovenčina', cs: 'Čeština', de: 'Deutsch', en: 'English', es: 'Español' };
	const langName = langNames[lang] || 'Slovenčina';

	let areaContext = '';
	if (areaId && rvpData) {
		if (areaId.startsWith('komp-')) {
			const k = areaId.replace('komp-', '');
			const v = rvpData.kompetence?.[k];
			if (v) areaContext = `\n\nVYBRANÁ OBLAST: ${v.nazev}\nPopis: ${v.popis}\nIndikátory: ${(v.indikatory || []).slice(0, 5).join('; ')}\n\nTvoja zaujímavosť MUSÍ vychádzať výhradne z tejto oblasti.`;
		} else if (areaId.startsWith('tema-')) {
			const k = areaId.replace('tema-', '');
			const name = rvpData.prurezova_temata?.[k];
			if (name) areaContext = `\n\nVYBRANÁ OBLAST: ${name}\n\nTvoja zaujímavosť MUSÍ vychádzať výhradne z tejto oblasti.`;
		} else {
			const v = rvpData.vzdelavaci_oblasti?.[areaId];
			if (v) areaContext = `\n\nVYBRANÁ OBLAST: ${v.nazev}\nPredmety: ${(v.predmety || []).join(', ')}\n\nTvoja zaujímavosť MUSÍ vychádzať výhradne z tejto oblasti.`;
		}
	} else {
		areaContext = rvpSummary
			? `\n\nVyber NÁHODNE jednu z týchto oblastí RVP CZ a vytvor krátku zaujímavosť:\n${rvpSummary}`
			: '';
	}

	// Použi spoľahlivé modely — gpt-4o-mini je najdostupnejší
	const modelsToTry = ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo', 'gpt-3.5-turbo'];
	let lastError = null;
	for (const factModel of modelsToTry) {
		try {
			const langMap = { sk: 'Slovak', cs: 'Czech', en: 'English', es: 'Spanish' };
			const tgtLang = langMap[lang] || 'Czech';
			const STYLE_HINTS = {
				genz: 'Use Gen Z slang and casual vocabulary. Same educational content, different delivery. EN: "lowkey", "literally", "vibe", "no cap", "slay", "fr". CZ/SK: "v pohodě", "lit", "based", "lowkey", "to je vibe", "žádný cap". Keep the fact accurate, just make it sound like a Gen Z friend.',
				sangvinik: 'Behave like a SANGUINE: optimistic, cheerful, enthusiastic, energetic, social. Use exclamation marks, positive words, show excitement. Sound like a friendly, upbeat person sharing a fun fact.',
				flegmatik: 'Behave like a PHLEGMATIC: calm, relaxed, patient, peaceful, easy-going. Speak slowly and gently. Use soft, reassuring tone. No rush, no drama.',
				cholerik: 'Behave like a CHOLERIC: direct, decisive, dynamic, strong-willed, confident. Be concise and to the point. Use short, punchy sentences. Sound assertive and determined.',
				melancholik: 'Behave like a MELANCHOLIC: thoughtful, introspective, sensitive, analytical, detail-oriented. Reflect on the fact. Use nuanced language. Sound contemplative and deep.'
			};
			const envStyle = (process.env.NARRATOR_STYLE || '').toLowerCase();
			const effectiveStyles = styleList.length ? styleList : (envStyle ? [envStyle] : []);
			const styleParts = effectiveStyles
				.map(s => STYLE_HINTS[s])
				.filter(Boolean);
			const styleHint = styleParts.length
				? ` PERSONALITY/STYLE (combine these traits in your delivery): ${styleParts.join(' ALSO: ')}`
				: '';
			const factOpts = {
				model: factModel,
				temperature: 0.9,
				max_tokens: 150,
				messages: [{
					role: 'system',
					content: `You are a friendly educational narrator. Reply with ONE short surprising educational fact only. 1-3 sentences. Write in ${tgtLang}. No quotes or preamble.${styleHint}`
				}, {
					role: 'user',
					content: areaId ? 'One interesting fact from the selected topic.' : 'One random educational fact for children.'
				}]
			};
			if (areaContext) {
				factOpts.messages[1].content = areaContext.slice(0, 300) + '\n\nGive one fact from above.';
			}
			const completion = await openai.chat.completions.create(factOpts);
			const choice = completion?.choices?.[0];
			const msg = choice?.message;
			let fact = msg?.content;
			if (Array.isArray(fact)) fact = fact.map(p => p?.text || p?.content).filter(Boolean).join(' ');
			fact = (fact || '').toString().trim();
			if (fact) {
				console.log('[API] random-fact: OpenAI OK', factModel);
				return res.json({ fact, source: 'openai' });
			}
			if (choice) {
				lastError = `Prázdna odpoveď (finish: ${choice.finish_reason || '?'})`;
				console.warn('[API] random-fact', factModel, lastError, 'msg keys:', msg ? Object.keys(msg) : []);
			}
		} catch (err) {
			lastError = err.message || String(err);
			console.error('[API] random-fact', factModel, 'CHYBA:', lastError);
		}
	}

	// Fallback na lokál — vráť aj chybu pre debug
	const fact = getRandomLocalFact(lang);
	console.error('[API] random-fact: VŠETKY modely zlyhali, fallback local. Posledná chyba:', lastError);
	res.json({ fact, source: 'local', _debug: lastError });
});

// ─── TTS (Text-to-Speech) — intonácia podľa typu osobnosti ───
const TTS_VOICES = ['marin', 'cedar', 'onyx', 'sage', 'coral', 'nova', 'alloy'];
const TTS_STYLE_CONFIG = {
	sangvinik: { voice: 'coral', speed: 1.15, instructions: 'Speak enthusiastically and energetically. Warm, upbeat tone. Slightly faster pace. Expressive intonation with excitement.' },
	flegmatik: { voice: 'sage', speed: 0.9, instructions: 'Speak calmly and gently. Slow, relaxed pace. Soothing, patient tone. Peaceful delivery.' },
	cholerik: { voice: 'onyx', speed: 1.2, instructions: 'Speak with confidence and assertiveness. Direct, punchy delivery. Clear and decisive. Strong, determined tone.' },
	melancholik: { voice: 'cedar', speed: 0.92, instructions: 'Speak thoughtfully and reflectively. Gentle, nuanced tone. Slightly slower, contemplative pace. Introspective delivery.' },
	genz: { voice: 'nova', speed: 1.05, instructions: 'Speak casually and conversationally. Relaxed, friendly tone. Natural, laid-back delivery.' }
};
app.post('/api/tts', async (req, res) => {
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey || apiKey === 'sk-your-openai-api-key-here') {
		return res.status(503).json({ error: 'TTS nie je nakonfigurovaný. Nastav OPENAI_API_KEY.' });
	}
	let body;
	try {
		body = typeof req.body === 'object' ? req.body : {};
	} catch {
		return res.status(400).json({ error: 'Neplatný JSON' });
	}
	const text = (body.text || '').trim();
	if (!text) return res.status(400).json({ error: "Pole 'text' je povinné" });
	const truncated = text.length > 4096 ? text.slice(0, 4096) : text;
	const styles = Array.isArray(body.styles) ? body.styles : [];
	let voice = TTS_VOICES.includes(body.voice) ? body.voice : 'marin';
	let speed = 1;
	let instructions = 'Speak in a calm, engaging narrative tone like a storyteller. Moderate pace, clear pronunciation.';
	if (styles.length > 0) {
		const cfg = TTS_STYLE_CONFIG[styles[0]];
		if (cfg) {
			voice = cfg.voice;
			speed = cfg.speed;
			instructions = cfg.instructions;
			if (styles.length > 1) {
				instructions += ' Also incorporate: ' + styles.slice(1).map(s => TTS_STYLE_CONFIG[s]?.instructions?.split('.')[0] || s).join('. ');
			}
		}
	}
	try {
		const response = await fetch('https://api.openai.com/v1/audio/speech', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				model: process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
				voice,
				input: truncated,
				speed,
				instructions,
				response_format: 'mp3'
			})
		});
		if (!response.ok) {
			const errBody = await response.text().catch(() => '');
			console.error('[TTS] OpenAI:', response.status, errBody.slice(0, 200));
			return res.status(response.status >= 500 ? 502 : response.status).json({ error: `TTS chyba: ${response.status}` });
		}
		const buf = await response.arrayBuffer();
		res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, max-age=3600' });
		res.send(Buffer.from(buf));
	} catch (e) {
		console.error('[TTS]', e.message);
		res.status(502).json({ error: 'Nepodarilo sa vygenerovať audio.' });
	}
});

// ─── Status endpoint ───
app.get('/api/status', (req, res) => {
	const hasKey = !!(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'sk-your-openai-api-key-here');
	res.json({
		status: 'ok',
		hasApiKey: hasKey,
		model: process.env.OPENAI_MODEL || 'gpt-4o',
		engine: openai ? 'ai' : 'local',
		randomFactSource: hasKey ? 'openai' : 'local',
		knowledge: {
			fileCount: knowledgeCache.length,
			totalChars: knowledgeSummary.length
		}
	});
});

// ─── App chooser page ───
app.get('/choose.html', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'choose.html')));

// ─── gIVEMEEDU frontend pages ───
app.get('/edu', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'edu', 'index.html')));
app.get('/edu/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'edu', 'index.html')));
app.get('/edu/index.html', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'edu', 'index.html')));
app.get('/edu/classes.html', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'edu', 'classes.html')));
app.get('/edu/gradebook.html', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'edu', 'gradebook.html')));
app.get('/edu/attendance.html', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'edu', 'attendance.html')));
app.get('/edu/members.html', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'edu', 'members.html')));

// ─── Shareable game page — serves game.html for any valid UUID path ───
app.get('/game/:id', (req, res) => {
	const { id } = req.params;
	if (!id || !/^[0-9a-f-]{36}$/.test(id)) {
		return res.status(404).send('Not found');
	}
	res.sendFile(path.join(PUBLIC_DIR, 'game.html'));
});

// ─── Statický file serving (po API route, aby /api/* fungovalo) ───
app.use(express.static(PUBLIC_DIR));

// ─── Spustenie servera (lokálne) / export pre Vercel ───
const PORT = process.env.PORT || 3000;
if (!process.env.VERCEL) {
	app.listen(PORT, () => {
		const hasKey = !!(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'sk-your-openai-api-key-here');
		console.log(`\n╔════════════════════════════════════════╗`);
		console.log(`║  gIVEMEGAME.IO server bežiaci         ║`);
		console.log(`║  http://localhost:${PORT}                 ║`);
		console.log(`║  API: /api/generate-game               ║`);
		console.log(`║  API: /api/random-fact (vypraváč)      ║`);
		console.log(`║  OpenAI: ${hasKey ? '✅ pripojené' : '❌ nie je kľúč'}               ║`);
		console.log(`║  Vypraváč: ${hasKey ? '🤖 AI (OpenAI)' : '📋 Lokál'}                  ║`);
		console.log(`╚════════════════════════════════════════╝\n`);
	});
}
module.exports = app;
