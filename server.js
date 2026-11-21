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
const { createAssessmentRouter } = require('./lib/assessment-routes');
const { createInstitutionRouter } = require('./lib/institution-routes');
const { buildSupabasePublicConfig, renderSupabaseConfigScript, extraCspOrigin } = require('./lib/supabase-public-config');
const {
	VALID_AVATAR_IDS,
	RPG_ELIGIBLE_ROLES,
	isValidAvatarId,
	getAvatarManifest,
	getAvatarById,
	RPG_AVATAR_SWITCH_COST,
} = require('./lib/rpg-avatars');
const { getTalentManifest, getTalentById, talentIdsToTalents, validatePrerequisite } = require('./lib/rpg-talents');
const { computeRpgLevel, getEffectiveStats, awardXpInTransaction, computeSoloXpFromDurationMax } = require('./lib/rpg-progression');
const {
	XP_BOOST_ITEM_ID,
	XP_BOOST_MULTIPLIER,
	XP_BOOST_USES,
	PHOTO_VERIFY_DAILY_ATTEMPTS,
	PHOTO_VERIFY_DAILY_REWARDS,
	buildCompletionValidation,
	startSessionAndCharge,
	resolveSoloXpMultiplier,
	countRemainingBoostUses,
	photoVerifyAttemptAllowed,
	photoVerifyRewardAllowed,
} = require('./lib/session-economy');
const {
	getUserBillingState,
	hasPaidAccess,
	getUserPlan,
	PLAN_PRO,
	billingConfiguration,
	billingReady,
	billingWebhookAvailable,
	billingEventUserId,
	getStripe,
	FREE_LIMITS,
	applyLevelCap,
	hasIntegrationOwnershipEvidence,
	ensureCustomer,
	normalizeConsentIp,
	persistBillingConsent,
	withSubscriptionAdvisoryLock,
	processSubscriptionEvent,
	getEffectiveTier
} = require('./lib/billing');
const { entitlementsForPlan, nextUtcMidnightIso } = require('./lib/plan-entitlements');
const {
	getAiGenerationsTodayUtc,
	incrementAiGenerationsSuccess,
	countRobotChallengesLast24h,
	countSoloCompletionsLast24h,
} = require('./lib/plan-usage');
const {
	parseLimit,
	createDailyCounter,
	admitAiGeneration,
	hashIp,
	cleanText,
	sanitizeGenerateFilters,
	sanitizeRemix,
	resolveOutputLanguage,
	isAuthOutage,
	createCachedProbe,
	cacheControlForPath,
} = require('./lib/ai-guard');
const { validateCoinLog, validateDonation, STARTER_GRANT_COINS } = require('./lib/coin-log-policy');
const { applyCoinLogEntry, grantStarterCoins, applyRobotChallenge, applyDonation } = require('./lib/coin-ledger');
const PlayTickets = require('./lib/play-tickets');
const { GAME_COMPETENCY_TO_STAT, getAttributeManifest } = require('./lib/attribute-map');
const FilterPresets = require('./lib/filter-presets');
const {
	enforceConstraints,
	applyMethodologyFallback,
	validateGame,
	buildRepairPrompt,
	buildSystemPrompt,
	buildUserPrompt,
	formatUsageLog
} = require('./lib/game-prompt');
const { selectMethodologies } = require('./lib/methodologies');

// Free-tier soft cap (M7): applyLevelCap from lib/billing.js. Talents/perks gated by level
// stay locked past the cap until the user upgrades.

const SESSION_JOIN_COST = 100;
const COMPLETION_BONUS  = 100;
/** Solo: bonus po úspešnom AI overení fotky (musí sedieť s /api/status verificationPhotoBonus). */
const VERIFICATION_XP_BONUS   = 100;
const VERIFICATION_COIN_BONUS = 75;
const JOIN_CODE_CHARS   = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const JOIN_CODE_LENGTH  = 6;

// ─── RPG XP award amounts ───────────────────────────────────────────────────
// XP is awarded server-side only. No public endpoint.
// Solo completion XP scales with game duration (see computeSoloXpFromDurationMax).
// Rate limiting: solo completions per 24h — Free vs Pro (plan-entitlements).
const TALENT_XP_AWARD  = 25;  // per talent unlock (idempotent via UNIQUE constraint)
const SESSION_XP_AWARD = 75;  // per multiplayer session completion (reflection_done guard)
const ROBOT_XP_AWARD   = 30;  // per robot challenge completion (completions per 24h capped by plan, M5)

// ─── Reward validation constants ───
const VALID_COMPETENCY_KEYS = PlayTickets.VALID_GAME_COMPETENCIES;
// One competency → stat map for the whole app (lib/attribute-map.js).
const GAME_KOMP_TO_STAT = GAME_COMPETENCY_TO_STAT;
const MIN_SESSION_DURATION_FLOOR = 3;    // minutes — absolute minimum even if game.duration.min is lower
const MIN_SESSION_DURATION_FALLBACK = 5; // minutes — used when game has no duration.min
const HOST_COOLDOWN_MAX  = 5;            // max completed sessions per host per rolling hour
// Solo completions / 24h — Free vs Pro: see lib/plan-entitlements.js (soloCompletionsPer24h)

const app = express();
// Trust proxy for correct req.ip behind Vercel/nginx
app.set('trust proxy', 1);

// ─── CORS ─────────────────────────────────────────────────────────────────────
// Restrict to explicit origin allowlist. Set ALLOWED_ORIGINS in Vercel env vars
// as a comma-separated list, e.g. "https://givemegame.io,https://www.givemegame.io"
// Falls back to wildcard only when the env var is absent (local dev only).
const _allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
  : null;
app.use(cors({
  origin: _allowedOrigins
    ? (origin, cb) => {
        // Allow server-to-server requests (no Origin header) and listed origins
        if (!origin || _allowedOrigins.includes(origin)) return cb(null, true);
        cb(new Error(`CORS: origin ${origin} not allowed`));
      }
    : '*',
  credentials: false,
}));

// Stripe webhook — RAW body parser scoped iba na webhook path (PRED express.json).
// Handler route je definovaný nižšie v súbore; tu len presmerujeme body na Buffer.
app.use('/api/billing/stripe-webhook', express.raw({ type: 'application/json' }));

app.use(express.json());

// ─── Security headers ──────────────────────────────────────────────────────
// Applied to every response. CSP uses 'unsafe-inline' because the current
// frontend uses inline <script> blocks — tighten by moving to external .js
// files in Sprint 2 to enable a nonce-based CSP.
// Browser Supabase config (GET /supabase-config.js). A local Supabase stack
// (http://127.0.0.1:55321) is not covered by https://*.supabase.co, so its
// origin is added to img-src/connect-src only when configured.
const SUPABASE_PUBLIC_CONFIG = buildSupabasePublicConfig(process.env);
const SUPABASE_PUBLIC_CONFIG_JS = renderSupabaseConfigScript(SUPABASE_PUBLIC_CONFIG);
const SUPABASE_EXTRA_CSP_ORIGIN = extraCspOrigin(SUPABASE_PUBLIC_CONFIG);
const SUPABASE_CSP_SOURCES = SUPABASE_EXTRA_CSP_ORIGIN
  ? `https://*.supabase.co ${SUPABASE_EXTRA_CSP_ORIGIN}`
  : 'https://*.supabase.co';

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // SAMEORIGIN instead of DENY: the profile modal embeds gIVEME/index.html
  // in an iframe from the same origin, so DENY would break it.
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // HSTS: tell browsers to use HTTPS for 2 years. Vercel enforces HTTPS at the
  // CDN edge, but setting this header ensures the browser won't downgrade on
  // subsequent requests even if a redirect chain breaks.
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' cdn.jsdelivr.net",
    // Bootstrap Icons CSS (cdn.jsdelivr.net) + Google Fonts stylesheet
    "style-src 'self' 'unsafe-inline' cdn.jsdelivr.net fonts.googleapis.com",
    `img-src 'self' data: ${SUPABASE_CSP_SOURCES} https://lh3.googleusercontent.com`,
    `connect-src 'self' ${SUPABASE_CSP_SOURCES}`,
    // Google Fonts files (gstatic) + Bootstrap Icons font files (jsdelivr)
    "font-src 'self' fonts.gstatic.com cdn.jsdelivr.net",
    // 'self' allows same-origin iframes (gIVEME social network in profile modal)
    "frame-src 'self'",
    "frame-ancestors 'self'",
    "form-action 'self'",
    "base-uri 'self'",
  ].join('; '));
  next();
});

// Public Supabase config for the browser (anon key is public by design).
app.get('/supabase-config.js', (req, res) => {
	res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
	res.setHeader('Cache-Control', 'no-cache');
	res.send(SUPABASE_PUBLIC_CONFIG_JS);
});

// Favicon — predchádza 404
app.get('/favicon.ico', (req, res) => {
	const icon = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
	res.type('image/png').send(icon);
});

// Root: SEO landing (home.html). /login.html ostáva pre prihlasovanie,
// /index.html je samotná aplikácia. Landing má „Try free" CTA s prechodom na /index.html.
const PUBLIC_DIR = path.join(__dirname, 'public');
app.get('/', (req, res) => {
	res.sendFile(path.join(PUBLIC_DIR, 'home.html'));
});
app.get('/login', (req, res) => {
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
			ssl: SUPABASE_DB_URL.includes('supabase.co') ? { rejectUnauthorized: false } : undefined,
			// Fail fast instead of hanging until Vercel's 60 s maxDuration.
			connectionTimeoutMillis: 5000,
			idleTimeoutMillis: 10000,
			// Client-side query timeout. A server-side statement_timeout startup parameter
			// can be rejected by Supabase's transaction pooler (port 6543).
			query_timeout: 10000
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

const SUPABASE_AUTH_TIMEOUT_MS = 5000;

/**
 * Verify a Supabase access token. Throws on failure; errors caused by an
 * outage (network, timeout, 429/5xx) carry `authUnavailable = true` so callers
 * can answer 503 instead of blaming the user's token.
 */
async function fetchSupabaseUser(accessToken) {
	if (!accessToken || !SUPABASE_AUTH_ENDPOINT || !SUPABASE_ANON_KEY) return null;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), SUPABASE_AUTH_TIMEOUT_MS);
	let resp;
	try {
		resp = await fetch(SUPABASE_AUTH_ENDPOINT, {
			headers: {
				apikey: SUPABASE_ANON_KEY,
				Authorization: `Bearer ${accessToken}`
			},
			signal: controller.signal
		});
	} catch (fetchErr) {
		clearTimeout(timer);
		const err = new Error(`Supabase user lookup unreachable: ${fetchErr.name || 'Error'}`);
		err.authUnavailable = isAuthOutage({ error: fetchErr });
		throw err;
	}
	try {
		if (!resp.ok) {
			const errText = await resp.text().catch(() => '');
			const err = new Error(`Supabase user lookup failed (${resp.status}) ${errText.slice(0, 200)}`);
			err.status = resp.status;
			err.authUnavailable = isAuthOutage({ status: resp.status });
			throw err;
		}
		const data = await resp.json();
		return { id: data.id, email: data.email || null, raw: data };
	} finally {
		clearTimeout(timer);
	}
}

function respondAuthUnavailable(res) {
	return res.status(503).json({
		error: 'Overenie prihlásenia je dočasne nedostupné. Skúste znova o chvíľu.',
		code: 'AUTH_UNAVAILABLE'
	});
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
		if (err.authUnavailable) {
			console.warn('[Auth] Supabase verification unavailable:', err.message.slice(0, 120));
			respondAuthUnavailable(res);
			return null;
		}
		const status = err.status === 401 || err.message.includes('401') ? 401 : 403;
		res.status(status).json({ error: 'Neplatný Supabase token', code: 'INVALID_TOKEN' });
		return null;
	}
}

/**
 * Like optionalSupabaseUser, but rethrows outage errors (err.authUnavailable)
 * so the caller can answer 503 instead of silently downgrading a logged-in
 * user to guest. Invalid tokens still resolve to null.
 */
async function optionalSupabaseUserStrict(req) {
	const authHeader = req.headers.authorization || '';
	if (!authHeader.startsWith('Bearer ')) return null;
	const token = authHeader.slice(7).trim();
	if (!token) return null;
	try {
		const user = await fetchSupabaseUser(token);
		return user || null;
	} catch (err) {
		if (err.authUnavailable) throw err;
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
	// Tighter body-size limit for EDU routes (student notes, grade values, names).
	// 20kb is generous for any valid EDU payload. Does not affect game routes above.
	app.use('/api/edu', express.json({ limit: '20kb' }));
	app.use('/api/edu', eduRouter);
	console.log('[EDU] gIVEMEEDU API mounted at /api/edu/*');
} else {
	console.warn('[EDU] gIVEMEEDU API disabled — SUPABASE_DB_URL not set.');
}

// ─── INVOK Pre/Post Assessment routes ───
// Mounted at /api/* (specific paths, not /api/assessments/* alone, because the
// router also owns /api/assessment-attempts/* and /api/assessment-results/*).
// Body size capped — assessment payloads (questions + answers) can be larger
// than EDU but still bounded.
if (coinsDbPool) {
	const assessmentRouter = createAssessmentRouter({
		pool: coinsDbPool,
		requireSupabaseUser
	});
	// 200kb covers up to ~100 questions with text bodies; bigger would be abuse.
	app.use(['/api/assessments', '/api/assessment-attempts', '/api/assessment-results'],
		express.json({ limit: '200kb' }));
	app.use('/api', assessmentRouter);
	console.log('[Assess] INVOK assessment API mounted at /api/assessments/*');
} else {
	console.warn('[Assess] Assessment API disabled — SUPABASE_DB_URL not set.');
}

// ─── INVOK Institution reporting routes ───────────────────────────────
if (coinsDbPool) {
	const institutionRouter = createInstitutionRouter({
		pool: coinsDbPool,
		requireSupabaseUser
	});
	// Institution responses are JSON-only (no file uploads); cap at 20kb.
	app.use('/api/institution', express.json({ limit: '20kb' }));
	app.use('/api/institution', institutionRouter);
	console.log('[Inst] INVOK institution API mounted at /api/institution/*');
} else {
	console.warn('[Inst] Institution API disabled — SUPABASE_DB_URL not set.');
}

// ─── OpenAI klient ───
let openai = null;

// Vercel maxDuration is 60 s — keep a single OpenAI call well below that.
const OPENAI_TIMEOUT_MS = 25000;
const OPENAI_MAX_RETRIES = 1;

function createOpenAIClient(apiKey) {
	return new OpenAI({ apiKey, timeout: OPENAI_TIMEOUT_MS, maxRetries: OPENAI_MAX_RETRIES });
}

function initOpenAI(apiKey) {
	if (!apiKey || apiKey === 'sk-your-openai-api-key-here') {
		console.warn('[Server] OpenAI API kľúč nie je nastavený.');
		return false;
	}
	openai = createOpenAIClient(apiKey);
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

// Prompt building, validation and enforcement live in lib/game-prompt.js (Phase 4).

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
async function callRepairAPI(brokenOutput, errors, useModel, aiLanguage, requestOptions) {
	const prompt = buildRepairPrompt(brokenOutput, errors, aiLanguage);

	return openai.chat.completions.create({
		model: useModel,
		temperature: 0.3,
		max_tokens: 3000,
		messages: [
			{ role: 'system', content: 'You are a JSON repair assistant. Your only job is to fix validation errors in game JSON objects. Return only valid JSON.' },
			{ role: 'user', content: prompt }
		]
	}, requestOptions);
}

// Computed once at startup — identical string every call → OpenAI prompt cache activates.
const STATIC_SYSTEM_PROMPT = buildSystemPrompt();

// ─── Rate limit for /api/generate-game (per-IP or per-user; limits z plan-entitlements) ───
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const generateGameRateMap = new Map(); // key -> { count, resetAt }

function cleanupRateLimitMap() {
	const now = Date.now();
	for (const [key, data] of generateGameRateMap.entries()) {
		if (data.resetAt < now) generateGameRateMap.delete(key);
	}
}
const generateGameRateLimitCleanupTimer = setInterval(cleanupRateLimitMap, 60 * 1000);
generateGameRateLimitCleanupTimer.unref();

// ─── Daily AI caps (per-instance, in-memory SOFT caps) ───
// Each Vercel instance keeps its own counters, so the effective ceiling is
// limit × warm instances; the real hard ceiling is the OpenAI project budget.
// Logged-in users with a DB connection are capped by plan_usage_daily instead
// of the guest counter; the global breaker covers every generation.
const GUEST_AI_DAILY_LIMIT = parseLimit(process.env.GUEST_AI_DAILY_LIMIT, 5);
const AI_GLOBAL_DAILY_LIMIT = parseLimit(process.env.AI_GLOBAL_DAILY_LIMIT, 300);
const guestAiDailyCounter = createDailyCounter({ limit: GUEST_AI_DAILY_LIMIT });
const globalAiDailyCounter = createDailyCounter({ limit: AI_GLOBAL_DAILY_LIMIT });

function clientIp(req) {
	return req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
}

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
	const ip = clientIp(req);
	let limit = entitlementsForPlan(false).generatePerMinute;
	let key = `ip:${ip}`;
	let user = null;
	try {
		user = await optionalSupabaseUserStrict(req);
	} catch (e) {
		console.warn('[GenerateGame] auth unavailable:', e.message.slice(0, 120));
		return respondAuthUnavailable(res);
	}
	req.genUser = user;
	try {
		if (user && coinsDbPool) {
			key = `user:${user.id}`;
			const state = await getUserBillingState(coinsDbPool, user.id);
			limit = entitlementsForPlan(hasPaidAccess(state)).generatePerMinute;
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
	const body = req.body || {};

	// ─── Input limits: filters go straight into the prompt ───
	const sanitized = sanitizeGenerateFilters(body.filters);
	if (!sanitized.ok) {
		return res.status(sanitized.status).json({ error: sanitized.error, code: sanitized.code });
	}
	const filters = sanitized.filters;
	const remix = sanitizeRemix(body.remix);

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
		openai = createOpenAIClient(effectiveKey);
	}

	const genUser = req.genUser || null;
	let genPaid = false;
	if (genUser && coinsDbPool) {
		try {
			const st = await getUserBillingState(coinsDbPool, genUser.id);
			genPaid = hasPaidAccess(st);
		} catch (e) {
			console.error('[GenerateGame] billing state check failed:', e.message);
			return res.status(503).json({ error: 'Databáza je dočasne nedostupná. Skúste znova o chvíľu.', code: 'DB_UNAVAILABLE' });
		}
	}
	const genEnt = entitlementsForPlan(genPaid);
	if (genUser && coinsDbPool && genEnt.aiGamesPerUtcDay != null) {
		try {
			const usedAi = await getAiGenerationsTodayUtc(coinsDbPool, genUser.id);
			if (usedAi >= genEnt.aiGamesPerUtcDay) {
				return res.status(429).json({
					error: `Denný limit AI hier: ${usedAi}/${genEnt.aiGamesPerUtcDay} (UTC deň). Obnoví sa o polnoci UTC alebo predplaťte Pro učiteľ.`,
					code: 'PLAN_AI_DAILY_LIMIT',
					limit: genEnt.aiGamesPerUtcDay,
					used: usedAi,
					resetsAtUtc: nextUtcMidnightIso()
				});
			}
		} catch (e) {
			// Fail closed: without the usage count we cannot enforce the plan quota.
			console.error('[GenerateGame] plan_usage_daily check failed:', e.message);
			return res.status(503).json({ error: 'Databáza je dočasne nedostupná. Skúste znova o chvíľu.', code: 'DB_UNAVAILABLE' });
		}
	}

	// ─── Guest daily cap + global daily breaker (consumed only when admitted) ───
	const isGuest = !(genUser && coinsDbPool);
	const admission = admitAiGeneration({
		globalCounter: globalAiDailyCounter,
		guestCounter: guestAiDailyCounter,
		isGuest,
		ipKey: `ip:${clientIp(req)}`
	});
	if (!admission.ok) {
		console.warn(`[GenerateGame] ${admission.body.code} ip=${hashIp(clientIp(req))}`);
		return res.status(admission.status).json(admission.body);
	}

	const f = filters;
	// Output language: honour lang / language code from the request, default sk.
	const { code: langCode, name: aiLanguage } = resolveOutputLanguage(f);

	// ─── RPG avatar stats for personalized generation ───────────────
	let rpgProfileBlock = '';
	try {
		if (genUser && coinsDbPool) {
			const { rows: pRows } = await queryCoinsDb(
				`SELECT rpg_avatar_id, COALESCE(rpg_xp, 0)::int AS rpg_xp FROM public.profiles WHERE id = $1`,
				[genUser.id]
			);
			const p = pRows[0];
			if (p?.rpg_avatar_id) {
				const avatarEntry = getAvatarById(p.rpg_avatar_id);
				const { rows: uRows } = await queryCoinsDb(
					`SELECT talent_id FROM public.rpg_user_talents WHERE user_id = $1`, [genUser.id]
				);
				const tManifest = getTalentManifest();
				const uTalents = uRows.map(r => tManifest.find(t => t.id === r.talent_id)).filter(Boolean);
				const stats = getEffectiveStats(p.rpg_avatar_id, uTalents);
				const prog = computeRpgLevel(p.rpg_xp || 0);
				const sLines = Object.entries(stats.effective).map(([k, v]) => `  ${k}: ${v}`).join('\n');
				rpgProfileBlock = `
══════════════════════════════════════
RPG PROFIL HRÁČA (personalizácia):
══════════════════════════════════════
Trieda: ${avatarEntry?.label || 'Unknown'} (${avatarEntry?.theme || '-'})
Level: ${prog.level}
Atribúty (effective):
${sLines}

Prispôsob hru silným stránkam hráča:
- Vysoký insight/focus → zaraď analytické výzvy, pozorovanie, hádanky
- Vysoká creativity → zaraď tvorivé úlohy, improvizáciu, dizajn
- Vysoká communication → zaraď diskusie, tímovú komunikáciu, prezentovanie
- Vysoká resilience → zaraď výzvy na vytrvalosť, zvládanie stresu, adaptáciu
- Vysoká strategy → zaraď plánovanie, stratégiu, logické úlohy
NEPREHÁŇAJ personalizáciu — jemne uprednostni aktivity ladené s najvyššími statmi.
══════════════════════════════════════`;
			}
		}
	} catch (e) { /* non-critical — generate without personalization */ }

	// Methodology pick: 1-2 catalogue entries per mode/duration/age (random tie-break for variety).
	const methodologyPicks = selectMethodologies(f, { rng: Math.random });
	const userContent = buildUserPrompt({
		filters: f, aiLanguage, langCode, picks: methodologyPicks, rpgProfileBlock, knowledgeSummary, remix
	});

	const FALLBACK_MODEL = 'gpt-4o-mini';
	// Repair always uses the cheaper mini model — fast, low-cost, sufficient for structural fixes.
	const REPAIR_MODEL = 'gpt-4o-mini';
	const model = process.env.OPENAI_MODEL || 'gpt-4o';
	const fallbackModel = model !== FALLBACK_MODEL ? FALLBACK_MODEL : 'gpt-4o';
	// 3000: room for the Game Pack fields (playerBrief, lessonFlow) without truncated JSON.
	const maxTokens = parseInt(process.env.OPENAI_MAX_TOKENS) || 3000;
	const temperature = parseFloat(process.env.OPENAI_TEMPERATURE) || 0.8;

	console.log(`[API] Generujem hru: model=${model}, filters:`, JSON.stringify(filters, null, 0));

	// Models that support response_format: json_object.
	// Keeps the JSON guarantee at the API level — eliminates parse failures upstream.
	function supportsJsonFormat(modelId) {
		return /^gpt-4o|^gpt-4-turbo|^gpt-3\.5-turbo-(?:1106|0125|16k)/.test(modelId);
	}

	// One shared time budget for every OpenAI call in this request (main, 404 fallback,
	// repair), so the chain finishes before Vercel's 60 s maxDuration kills it.
	const genDeadline = Date.now() + 50000;
	const genRequestOptions = () => ({ timeout: Math.max(3000, genDeadline - Date.now()), maxRetries: 0 });

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
		return openai.chat.completions.create(opts, genRequestOptions());
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

		// Token usage incl. prompt-cache hits (static system prompt prefix).
		const usageLine = formatUsageLog(response.usage);
		if (usageLine) console.log(`[API] usage ${usageLine} (model: ${usedModel})`);

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
			const repairResp = await callRepairAPI(content, ['Output is not valid JSON — fix it'], REPAIR_MODEL, aiLanguage, genRequestOptions());
			const repairContent = repairResp.choices[0]?.message?.content || '';
			game = JSON.parse(extractJSON(repairContent)); // throws SyntaxError if still broken
		}

		// Cheap server-side fixes first (preset ranges, stupeň, methodology) so
		// they never cost a repair call.
		applyMethodologyFallback(game, methodologyPicks);
		enforceConstraints(game, f);

		// ── Step 3: Validate schema — if invalid, try one repair call ──
		let validationErrors = validateGame(game);
		if (validationErrors.length > 0) {
			console.warn(`[API] Validácia zlyhala (${validationErrors.length} chýb), skúšam repair...`, validationErrors);
			const repairResp = await callRepairAPI(gameJSON, validationErrors, REPAIR_MODEL, aiLanguage, genRequestOptions());
			const repairContent = repairResp.choices[0]?.message?.content || '';
			const repairedGame = JSON.parse(extractJSON(repairContent));
			applyMethodologyFallback(repairedGame, methodologyPicks);
			enforceConstraints(repairedGame, f);
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

		if (genUser && coinsDbPool) {
			try {
				await incrementAiGenerationsSuccess(coinsDbPool, genUser.id);
			} catch (e) {
				console.warn('[GenerateGame] plan_usage_daily increment:', e.message);
			}
		}

		// Phase 5: the server keeps its own copy of the game as a play ticket.
		// Completion later sends only this id, so a forged game_json earns nothing.
		if (genUser && coinsDbPool && PlayTickets.playTicketsEnabled()) {
			const ticketId = await PlayTickets.issueGenerationTicket(coinsDbPool, genUser.id, game, f.mode);
			if (ticketId) game._play_ticket = ticketId;
		}

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
			`SELECT id, amount, action, metadata, created_at\n			 FROM public.coin_transactions\n			 WHERE user_id = $1 AND action <> 'photo_verify_attempt'\n			 ORDER BY created_at DESC\n			 LIMIT $2`,
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
	const checked = validateCoinLog(req.body);
	if (!checked.ok) {
		return res.status(400).json({ error: checked.error, code: checked.code });
	}
	const { amount, action: actionTrim, metadata } = checked;
	if (actionTrim === 'robot_challenge') return handleRobotChallengeLog(res, user, amount, metadata);
	// C2: the server applies the event to profiles.coins (the browser can no
	// longer write it). Rewards are capped per day, spends need the balance.
	let client;
	try {
		client = await coinsDbPool.connect();
		await client.query('BEGIN');
		const result = await applyCoinLogEntry(client, {
			userId: user.id, action: actionTrim, amount, metadata: metadata || null,
		});
		if (result.status !== 'ok') {
			await client.query('ROLLBACK');
			if (result.status === 'capped') {
				return res.status(429).json({
					error: 'Denný limit odmien z tejto aktivity dosiahnutý',
					code: 'COIN_DAILY_CAP', balance: result.balance, cap: result.cap
				});
			}
			if (result.status === 'insufficient') {
				return res.status(402).json({
					error: 'Nedostatok coinov', code: 'INSUFFICIENT_COINS',
					balance: result.balance, required: result.required
				});
			}
			return res.status(409).json({ error: 'Profil nenájdený', code: 'NO_PROFILE' });
		}

		await client.query('COMMIT');

		res.json({ ok: true, credited: result.credited, balance: result.balance });
	} catch (err) {
		if (client) { try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ } }
		console.error('[Coins] log insert failed:', err.message);
		res.status(500).json({ error: 'Nepodarilo sa zaznamenať transakciu', code: 'LOG_ERROR' });
	} finally {
		if (client) client.release();
	}
});

/**
 * M5: a robot challenge completion. The completion limit (rows per 24 h,
 * every plan) is checked inside the transaction under the profile lock; the
 * XP is awarded once per accepted completion in the same transaction, and a
 * completion past the daily coin cap still counts and still earns its XP.
 */
async function handleRobotChallengeLog(res, user, amount, metadata) {
	let completionLimit = entitlementsForPlan(false).robotCompletionsPer24h;
	try {
		const bill = await getUserBillingState(coinsDbPool, user.id);
		completionLimit = entitlementsForPlan(hasPaidAccess(bill)).robotCompletionsPer24h;
	} catch (e) {
		// Fail closed: without billing state the free limit applies.
		console.warn('[Coins] robot_challenge plan check:', e.message);
	}
	let client;
	try {
		client = await coinsDbPool.connect();
		await client.query('BEGIN');
		const result = await applyRobotChallenge(client, {
			userId: user.id, amount, metadata: metadata || null, completionLimit,
		});
		if (result.status === 'limit') {
			await client.query('ROLLBACK');
			return res.status(429).json({
				error: `Limit Robot Challenge: ${result.used}/${result.limit} za 24 h.`,
				code: 'ROBOT_DAILY_LIMIT', limit: result.limit, used: result.used, balance: result.balance
			});
		}
		if (result.status !== 'ok') {
			await client.query('ROLLBACK');
			return res.status(409).json({ error: 'Profil nenájdený', code: 'NO_PROFILE' });
		}
		await awardXpInTransaction(client, user.id, ROBOT_XP_AWARD, 'robot_challenge');
		await client.query('COMMIT');
		res.json({
			ok: true, credited: result.credited, balance: result.balance,
			capped: result.capped, xp_awarded: ROBOT_XP_AWARD,
			completions: result.completions, limit: completionLimit
		});
	} catch (err) {
		if (client) { try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ } }
		console.error('[Coins] robot_challenge failed:', err.message);
		res.status(500).json({ error: 'Nepodarilo sa zaznamenať transakciu', code: 'LOG_ERROR' });
	} finally {
		if (client) client.release();
	}
}

// gIVEME coin donation: one transaction debits the donor, inserts the
// donation row (its trigger credits the author) and writes both ledger rows.
// Browsers can no longer insert giveme_coin_donations directly (037).
app.post('/api/giveme/donate', async (req, res) => {
	if (!coinApiReady()) return respondCoinApiDisabled(res);
	const user = await requireSupabaseUser(req, res);
	if (!user) return;
	const checked = validateDonation(req.body);
	if (!checked.ok) return res.status(400).json({ error: checked.error, code: checked.code });
	let client;
	try {
		client = await coinsDbPool.connect();
		await client.query('BEGIN');
		const result = await applyDonation(client, { donorId: user.id, postId: checked.postId, amount: checked.amount });
		if (result.status !== 'ok') {
			await client.query('ROLLBACK');
			if (result.status === 'insufficient') {
				return res.status(402).json({ error: 'Nedostatok coinov', code: 'INSUFFICIENT_COINS', balance: result.balance, required: result.required });
			}
			if (result.status === 'capped') {
				return res.status(429).json({ error: 'Denný limit darovania dosiahnutý', code: 'DONATION_DAILY_CAP', balance: result.balance, cap: result.cap, sent_today: result.sentToday });
			}
			if (result.status === 'self') return res.status(400).json({ error: 'Nemôžeš darovať sám sebe', code: 'SELF_DONATION' });
			if (result.status === 'no_post') return res.status(404).json({ error: 'Príspevok nenájdený', code: 'NO_POST' });
			return res.status(409).json({ error: 'Profil nenájdený', code: 'NO_PROFILE' });
		}
		await client.query('COMMIT');
		res.json({ ok: true, donated: checked.amount, balance: result.balance });
	} catch (err) {
		if (client) { try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ } }
		console.error('[gIVEME] donation failed:', err.message);
		res.status(500).json({ error: 'Nepodarilo sa odoslať coiny', code: 'DONATION_ERROR' });
	} finally {
		if (client) client.release();
	}
});

// One-time starter coins for a brand-new signed-in account. The guest
// practice wallet (localStorage) is never merged into the server balance.
app.post('/api/coins/starter-grant', async (req, res) => {
	if (!coinApiReady()) return respondCoinApiDisabled(res);
	const user = await requireSupabaseUser(req, res);
	if (!user) return;
	let client;
	try {
		client = await coinsDbPool.connect();
		await client.query('BEGIN');
		const result = await grantStarterCoins(client, user.id, STARTER_GRANT_COINS);
		await client.query('COMMIT');
		res.json({ granted: result.granted, balance: result.balance });
	} catch (err) {
		if (client) { try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ } }
		console.error('[Coins] starter grant failed:', err.message);
		res.status(500).json({ error: 'Nepodarilo sa pripísať štartovacie coiny', code: 'STARTER_GRANT_ERROR' });
	} finally {
		if (client) client.release();
	}
});

// ─── Billing API ───

function billingCheckoutAvailable() {
	return coinApiReady() && billingReady();
}

/** Verejný endpoint — žiadne tajomstvá; UI vie či je platba zapnutá a kontakt na podporu. */
app.get('/api/billing/public-config', (req, res) => {
	res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
	const support = (process.env.BILLING_SUPPORT_EMAIL || '').trim();
	const config = billingConfiguration();
	const checkoutAvailable = billingCheckoutAvailable();
	res.json({
		// Compatibility field now describes the supported secure Checkout path.
		// The legacy Payment Link endpoint remains retired.
		upgradeAvailable: checkoutAvailable,
		legacyPaymentLinkRetired: true,
		checkoutPath: '/pricing.html',
		subscriptionBillingEnabled: checkoutAvailable,
		billingMessage: checkoutAvailable
			? null
			: 'Online platby jsou dočasně nedostupné. Zkuste to prosím později nebo kontaktujte podporu.',
		supportEmail: support || null,
		proPlanLabel: 'Pro Teacher Monthly',
		legal: {
			termsUrl: config.legal.termsUrl,
			privacyUrl: config.legal.privacyUrl,
			contactUrl: config.legal.contactUrl,
			tosVersion: config.legal.tosVersion,
			privacyVersion: config.legal.privacyVersion,
		}
	});
});

app.get('/api/billing/state', async (req, res) => {
	if (!coinApiReady()) return res.status(503).json({ error: 'Service unavailable', code: 'DB_UNAVAILABLE' });
	const user = await requireSupabaseUser(req, res);
	if (!user) return;
	try {
		const state = await getUserBillingState(coinsDbPool, user.id);
		const planCode = getUserPlan(state);
		const paid = hasPaidAccess(state);
		const ent = entitlementsForPlan(paid);
		let aiUsed = 0;
		let robotUsed = 0;
		let soloUsed = 0;
		try {
			aiUsed = await getAiGenerationsTodayUtc(coinsDbPool, user.id);
		} catch (e) {
			console.warn('[Billing] ai usage:', e.message);
		}
		try {
			robotUsed = await countRobotChallengesLast24h(coinsDbPool, user.id);
		} catch (e) {
			console.warn('[Billing] robot usage:', e.message);
		}
		try {
			soloUsed = await countSoloCompletionsLast24h(coinsDbPool, user.id);
		} catch (e) {
			console.warn('[Billing] solo usage:', e.message);
		}
		res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
		res.json({
			planCode,
			hasPaidAccess: paid,
			billingNote: state?.billing_note || null,
			entitlements: {
				givemeSocial: ent.givemeSocial,
				smartaOpenAiAndTts: ent.smartaOpenAiAndTts,
				aiGamesPerUtcDay: ent.aiGamesPerUtcDay,
				robotCompletionsPer24h: ent.robotCompletionsPer24h,
				soloCompletionsPer24h: ent.soloCompletionsPer24h,
				generatePerMinute: ent.generatePerMinute
			},
			usage: {
				aiGenerationsUtcDay: aiUsed,
				robotCompletions24h: robotUsed,
				soloCompletions24h: soloUsed,
				resetsAiUtc: nextUtcMidnightIso()
			}
		});
	} catch (err) {
		console.error('[Billing] state failed:', err.message);
		res.status(500).json({ error: 'Failed to load billing state', code: 'BILLING_ERROR' });
	}
});

app.get('/api/billing/upgrade-url', async (req, res) => {
	res.status(410).json({
		error: 'Tento způsob platby už není podporován. Použijte zabezpečený výběr plánu.',
		code: 'LEGACY_PAYMENT_LINK_RETIRED',
		checkoutPath: '/pricing.html'
	});
});

// ═══════════════════════════════════════════════════════════════════
// Subscription-based billing (tier system, Stripe Checkout + Webhooks)
// ═══════════════════════════════════════════════════════════════════

// GET /api/billing/tier — aktuálny efektívny tier + detaily subscription
app.get('/api/billing/tier', async (req, res) => {
	if (!coinApiReady()) return res.status(503).json({ error: 'Service unavailable' });
	const user = await requireSupabaseUser(req, res);
	if (!user) return;
	try {
		const tier = await getEffectiveTier(coinsDbPool, user.id);
		const { rows } = await coinsDbPool.query(
			`SELECT tier AS sub_tier, status, current_period_end, cancel_at_period_end, trial_end
			 FROM public.billing_subscriptions
			 WHERE user_id = $1
			 ORDER BY
			   CASE WHEN status IN ('active', 'trialing') THEN 0 ELSE 1 END,
			   CASE tier WHEN 'school' THEN 2 WHEN 'teacher' THEN 1 ELSE 0 END DESC,
			   updated_at DESC
			 LIMIT 1`,
			[user.id]
		);
		res.json({
			tier,
			subscription: rows[0] || null,
			free_limits: FREE_LIMITS,
			billing_configured: billingCheckoutAvailable()
		});
	} catch (err) {
		console.error('[Billing] tier fetch failed:', err.message);
		res.status(500).json({ error: 'Tier fetch failed' });
	}
});

// POST /api/billing/checkout — vytvorí Stripe Checkout Session
// Body: {
//   plan: 'teacher_monthly' | 'teacher_yearly',
//   withdrawalConsent: true   // povinné — používateľ súhlasí s okamžitým plnením
// }
app.post('/api/billing/checkout', async (req, res) => {
	const config = billingConfiguration();
	if (!billingCheckoutAvailable()) {
		console.error('[Billing] checkout disabled; missing or invalid configuration:', config.missing.join(', '));
		return res.status(503).json({
			error: 'Online platby jsou dočasně nedostupné.',
			code: 'BILLING_DISABLED'
		});
	}
	const user = await requireSupabaseUser(req, res);
	if (!user) return;

	const { plan, withdrawalConsent } = req.body || {};
	if (!['teacher_monthly', 'teacher_yearly'].includes(plan)) {
		return res.status(400).json({ error: 'Neplatný plán.', code: 'BAD_PLAN' });
	}
	const priceId = config.prices[plan];
	if (!priceId) return res.status(400).json({ error: 'Neplatný plán.', code: 'BAD_PLAN' });
	const requestId = req.get('Idempotency-Key');
	if (!requestId || !/^[A-Za-z0-9_-]{8,100}$/.test(requestId)) {
		return res.status(400).json({ error: 'Neplatný požadavek na platbu.', code: 'INVALID_REQUEST_ID' });
	}

	// § 1837 OZ — bez výslovného súhlasu nepustíme platbu
	if (withdrawalConsent !== true) {
		return res.status(400).json({
			error: 'Pro pokračování je nutné potvrdit souhlas se zahájením plnění před uplynutím lhůty pro odstoupení.',
			code: 'WITHDRAWAL_CONSENT_REQUIRED'
		});
	}

	try {
		// Ulož consent PRED vytvorením Checkout session (audit trail)
		const ip = normalizeConsentIp(req.ip);
		await persistBillingConsent(coinsDbPool, user.id, ip);

		const customerId = await ensureCustomer(coinsDbPool, user);
		const origin = config.origin;
		const session = await getStripe().checkout.sessions.create({
			mode: 'subscription',
			customer: customerId,
			line_items: [{ price: priceId, quantity: 1 }],
			subscription_data: {
				metadata: {
					supabase_user_id: user.id,
					plan,
					tos_version: config.legal.tosVersion,
					privacy_version: config.legal.privacyVersion
				}
			},
			allow_promotion_codes: true,
			billing_address_collection: 'auto',
			automatic_tax: { enabled: true },
			success_url: `${origin}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
			cancel_url:  `${origin}/pricing.html?canceled=1`,
			client_reference_id: user.id,
			metadata: {
				supabase_user_id: user.id,
				plan,
				tos_version: config.legal.tosVersion,
				privacy_version: config.legal.privacyVersion,
				withdrawal_consent: 'true'
			}
		}, { idempotencyKey: `checkout_${user.id}_${requestId}` });
		res.json({ url: session.url });
	} catch (err) {
		console.error('[Billing] checkout failed:', err.message);
		res.status(500).json({ error: 'Platbu se nepodařilo zahájit.', code: 'CHECKOUT_ERROR' });
	}
});

// GET /api/billing/legal-versions — frontend zobrazí aktuálne verzie v consent modale
app.get('/api/billing/legal-versions', (req, res) => {
	const config = billingConfiguration();
	res.json({
		tos_version: config.legal.tosVersion,
		privacy_version: config.legal.privacyVersion,
		withdrawal_text: config.legal.withdrawalText,
		terms_url: config.legal.termsUrl,
		privacy_url: config.legal.privacyUrl,
		contact_url: config.legal.contactUrl,
		billing_enabled: billingCheckoutAvailable(),
	});
});

// POST /api/billing/portal — Customer Portal (manage subscription, cancel, update card)
app.post('/api/billing/portal', async (req, res) => {
	if (!coinApiReady()) {
		return res.status(503).json({ error: 'Správa předplatného je dočasně nedostupná.', code: 'DB_UNAVAILABLE' });
	}
	const config = billingConfiguration();
	if (!billingReady()) {
		console.error('[Billing] portal disabled; missing or invalid configuration:', config.missing.join(', '));
		return res.status(503).json({ error: 'Správa předplatného je dočasně nedostupná.', code: 'BILLING_DISABLED' });
	}
	const user = await requireSupabaseUser(req, res);
	if (!user) return;
	try {
		const { rows } = await coinsDbPool.query(
			`SELECT stripe_customer_id FROM public.billing_subscriptions
			 WHERE user_id = $1 LIMIT 1`,
			[user.id]
		);
		if (!rows[0]?.stripe_customer_id) {
			return res.status(404).json({ error: 'Nemáš aktívne predplatné', code: 'NO_CUSTOMER' });
		}
		const portal = await getStripe().billingPortal.sessions.create({
			customer: rows[0].stripe_customer_id,
			return_url: `${config.origin}/account.html`
		});
		res.json({ url: portal.url });
	} catch (err) {
		console.error('[Billing] portal failed:', err.message);
		res.status(500).json({ error: 'Správu předplatného se nepodařilo otevřít.', code: 'PORTAL_ERROR' });
	}
});

function stripeObjectId(value) {
	return typeof value === 'string' ? value : value?.id || null;
}

async function billingCustomerOwner(customerId, queryable = coinsDbPool) {
	if (!customerId) return null;
	const { rows } = await queryable.query(
		`SELECT user_id FROM public.billing_subscriptions
		 WHERE stripe_customer_id = $1
		 GROUP BY user_id
		 LIMIT 2`,
		[customerId]
	);
	if (rows.length > 1) {
		const error = new Error('Conflicting billing ownership signals');
		error.code = 'BILLING_OWNERSHIP_CONFLICT';
		throw error;
	}
	return rows[0]?.user_id || null;
}

async function durableBillingSubscription(subscriptionId, queryable = coinsDbPool) {
	if (!subscriptionId) return null;
	const { rows } = await queryable.query(
		`SELECT user_id, tier, stripe_customer_id, stripe_subscription_id, stripe_price_id,
		        EXTRACT(EPOCH FROM current_period_start)::double precision AS current_period_start,
		        EXTRACT(EPOCH FROM current_period_end)::double precision AS current_period_end,
		        cancel_at_period_end,
		        EXTRACT(EPOCH FROM trial_end)::double precision AS trial_end
		 FROM public.billing_subscriptions
		 WHERE stripe_subscription_id = $1
		 LIMIT 1`,
		[subscriptionId]
	);
	return rows[0] || null;
}

function billingOwnershipConflict(message = 'Conflicting billing ownership signals') {
	const error = new Error(message);
	error.code = 'BILLING_OWNERSHIP_CONFLICT';
	return error;
}

function reconcileDurableOwner(userId, durableSubscription) {
	if (!durableSubscription) return userId;
	const durableUserId = billingEventUserId(
		{ metadata: { supabase_user_id: durableSubscription.user_id } },
		'customer.subscription.updated',
		true
	);
	if (!durableUserId) {
		const error = new Error('Durable billing subscription has no valid owner');
		error.code = 'UNRESOLVED_BILLING_USER';
		throw error;
	}
	if (userId && userId !== durableUserId) throw billingOwnershipConflict();
	return userId || durableUserId;
}

function canceledDurableSubscription(durableSubscription) {
	return {
		id: durableSubscription.stripe_subscription_id,
		object: 'subscription',
		customer: durableSubscription.stripe_customer_id,
		status: 'canceled',
		metadata: { supabase_user_id: durableSubscription.user_id },
		cancel_at_period_end: false,
		trial_end: durableSubscription.trial_end ?? null,
		items: {
			data: [{
				price: { id: durableSubscription.stripe_price_id },
				current_period_start: durableSubscription.current_period_start ?? null,
				current_period_end: durableSubscription.current_period_end ?? null,
			}],
		},
	};
}

function billingMutationSubscriptionId(eventType, object) {
	if (eventType === 'checkout.session.completed') return stripeObjectId(object?.subscription);
	if (
		eventType === 'customer.subscription.created'
		|| eventType === 'customer.subscription.updated'
		|| eventType === 'customer.subscription.deleted'
	) return stripeObjectId(object?.id);
	return null;
}

function isMissingStripeSubscription(error) {
	return error?.code === 'resource_missing'
		&& (error?.statusCode === undefined || error.statusCode === 404);
}

async function retrieveCanonicalSubscription(stripe, subscriptionId, eventType, deletedSnapshot) {
	try {
		const subscription = await stripe.subscriptions.retrieve(subscriptionId);
		if (!subscription || subscription.id !== subscriptionId) {
			const error = new Error('Stripe returned an invalid subscription snapshot');
			error.code = 'INVALID_STRIPE_SUBSCRIPTION';
			throw error;
		}
		return subscription;
	} catch (error) {
		if (eventType === 'customer.subscription.deleted' && isMissingStripeSubscription(error)) {
			return deletedSnapshot;
		}
		throw error;
	}
}

// POST /api/billing/stripe-webhook — spracuje Stripe udalosti
// Raw body parser je aplikovaný vyššie na /api/billing/stripe-webhook
app.post('/api/billing/stripe-webhook', async (req, res) => {
	const config = billingConfiguration();
	if (!billingWebhookAvailable(coinsDbPool)) {
		console.error(
			'[Billing] webhook disabled; database ready:',
			Boolean(coinsDbPool),
			'missing or invalid runtime configuration:',
			config.webhookMissing.join(', ')
		);
		return res.status(503).json({ error: 'Billing unavailable' });
	}
	const stripe = getStripe();
	const sig = req.headers['stripe-signature'];

	let event;
	try {
		event = stripe.webhooks.constructEvent(req.body, sig, config.webhookSecret);
	} catch (err) {
		console.error('[Billing] webhook signature failed:', err.message);
		return res.status(400).json({ error: 'Invalid webhook signature' });
	}

	try {
		const obj = event.data.object;
		const eventCustomerId = stripeObjectId(obj?.customer);
		const subscriptionId = billingMutationSubscriptionId(event.type, obj);
		const isMutationEvent = event.type === 'checkout.session.completed'
			|| event.type === 'customer.subscription.created'
			|| event.type === 'customer.subscription.updated'
			|| event.type === 'customer.subscription.deleted';
		const knownCustomerUserId = await billingCustomerOwner(eventCustomerId);
		const durableSubscription = isMutationEvent && subscriptionId
			? await durableBillingSubscription(subscriptionId)
			: null;
		const integrationOwned = hasIntegrationOwnershipEvidence(obj, Boolean(knownCustomerUserId))
			|| Boolean(durableSubscription);
		let userId = billingEventUserId(obj, event.type, integrationOwned, knownCustomerUserId);
		userId = reconcileDurableOwner(userId, durableSubscription);
		if (
			durableSubscription?.stripe_customer_id
			&& eventCustomerId
			&& durableSubscription.stripe_customer_id !== eventCustomerId
		) throw billingOwnershipConflict('Conflicting billing customer signals');

		if (isMutationEvent && integrationOwned && !subscriptionId) {
			const error = new Error('Integration billing event has no subscription');
			error.code = 'MISSING_STRIPE_SUBSCRIPTION';
			throw error;
		}

		let result;
		if (isMutationEvent && integrationOwned) {
			result = await withSubscriptionAdvisoryLock(coinsDbPool, subscriptionId, async (client) => {
				// Ownership and local state may have changed while this request waited.
				const lockedDurableSubscription = await durableBillingSubscription(subscriptionId, client);
				let lockedKnownCustomerUserId = await billingCustomerOwner(eventCustomerId, client);
				let lockedIntegrationOwned = hasIntegrationOwnershipEvidence(obj, Boolean(lockedKnownCustomerUserId))
					|| Boolean(lockedDurableSubscription);
				let lockedUserId = billingEventUserId(
					obj,
					event.type,
					lockedIntegrationOwned,
					lockedKnownCustomerUserId
				);
				lockedUserId = reconcileDurableOwner(lockedUserId, lockedDurableSubscription);
				if (
					lockedDurableSubscription?.stripe_customer_id
					&& eventCustomerId
					&& lockedDurableSubscription.stripe_customer_id !== eventCustomerId
				) throw billingOwnershipConflict('Conflicting billing customer signals');

				let subscription = null;
				let trustedTier;
				try {
					subscription = await retrieveCanonicalSubscription(
						stripe,
						subscriptionId,
						event.type,
						event.type === 'customer.subscription.deleted' ? obj : null
					);
				} catch (error) {
					const reconcileMissing = isMissingStripeSubscription(error)
						&& (event.type === 'customer.subscription.updated' || event.type === 'checkout.session.completed');
					if (!reconcileMissing) throw error;
					if (lockedDurableSubscription) {
						subscription = canceledDurableSubscription(lockedDurableSubscription);
						trustedTier = lockedDurableSubscription.tier;
					}
				}

				if (subscription) {
					const canonicalCustomerId = stripeObjectId(subscription.customer);
					if (eventCustomerId && canonicalCustomerId && eventCustomerId !== canonicalCustomerId) {
						throw billingOwnershipConflict('Conflicting billing customer signals');
					}
					const canonicalKnownCustomerUserId = canonicalCustomerId === eventCustomerId
						? lockedKnownCustomerUserId
						: await billingCustomerOwner(canonicalCustomerId, client);
					lockedIntegrationOwned = hasIntegrationOwnershipEvidence(
						subscription,
						Boolean(canonicalKnownCustomerUserId)
					) || Boolean(lockedDurableSubscription);
					const canonicalUserId = billingEventUserId(
						subscription,
						'customer.subscription.updated',
						lockedIntegrationOwned,
						canonicalKnownCustomerUserId
					);
					if (lockedUserId && canonicalUserId && lockedUserId !== canonicalUserId) {
						throw billingOwnershipConflict();
					}
					lockedUserId = lockedUserId || canonicalUserId;
				}

				return processSubscriptionEvent(
					coinsDbPool,
					event,
					subscription,
					lockedUserId,
					process.env,
					{ client, integrationOwned: lockedIntegrationOwned, trustedTier }
				);
			});
		} else {
			if (event.type === 'invoice.payment_failed') {
				// A subscription update is authoritative for entitlement changes.
				console.log(`[Billing] payment_failed for user ${userId} sub ${obj.subscription}`);
			}
			result = await processSubscriptionEvent(
				coinsDbPool,
				event,
				null,
				userId,
				process.env,
				{ integrationOwned }
			);
		}
		res.json({ received: true, duplicate: result.duplicate });
	} catch (err) {
		console.error('[Billing] webhook handler failed:', err.message);
		res.status(500).json({ error: 'Webhook processing failed' });
	}
});

// ─── Mode-click coin award — server-authoritative with daily cap ───
// Client calls this instead of awarding locally; server checks daily total and
// atomically logs + credits. Returns 429 when cap is reached (no award).
const MODE_CLICK_DAILY_CAP = 200;
const MODE_CLICK_AMOUNT    = 1;

app.post('/api/coins/award-mode-click', async (req, res) => {
	if (!coinApiReady()) return respondCoinApiDisabled(res);
	const user = await requireSupabaseUser(req, res);
	if (!user) return;

	let client;
	try {
		client = await coinsDbPool.connect();
		await client.query('BEGIN');
		// The profile row lock serialises parallel clicks so the cap holds.
		const { rows: prof } = await client.query(
			'SELECT COALESCE(coins, 0)::int AS coins FROM public.profiles WHERE id = $1 FOR UPDATE',
			[user.id]
		);
		if (!prof.length) {
			await client.query('ROLLBACK');
			return res.status(409).json({ error: 'Profil nenájdený', code: 'NO_PROFILE' });
		}

		// Sum today's mode_click earnings for this user (UTC day boundary)
		const { rows } = await client.query(
			`SELECT COALESCE(SUM(amount), 0)::int AS daily_total
			 FROM public.coin_transactions
			 WHERE user_id = $1 AND action = 'mode_click'
			   AND created_at >= CURRENT_DATE`,
			[user.id]
		);
		const dailyTotal = rows[0]?.daily_total || 0;

		if (dailyTotal >= MODE_CLICK_DAILY_CAP) {
			await client.query('ROLLBACK');
			return res.status(429).json({
				awarded: false,
				reason: 'Daily cap reached',
				code: 'MODE_CLICK_DAILY_CAP',
				daily_total: dailyTotal,
				cap: MODE_CLICK_DAILY_CAP,
				balance: prof[0].coins
			});
		}

		await client.query(
			'INSERT INTO public.coin_transactions (user_id, amount, action) VALUES ($1, $2, $3)',
			[user.id, MODE_CLICK_AMOUNT, 'mode_click']
		);
		const { rows: upd } = await client.query(
			'UPDATE public.profiles SET coins = COALESCE(coins, 0) + $1 WHERE id = $2 RETURNING coins',
			[MODE_CLICK_AMOUNT, user.id]
		);
		await client.query('COMMIT');

		res.json({
			awarded: true,
			amount: MODE_CLICK_AMOUNT,
			daily_total: dailyTotal + MODE_CLICK_AMOUNT,
			cap: MODE_CLICK_DAILY_CAP,
			balance: upd[0]?.coins ?? null
		});
	} catch (err) {
		if (client) { try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ } }
		console.error('[Coins] award-mode-click failed:', err.message);
		res.status(500).json({ error: 'Nepodarilo sa udeliť mode_click coin', code: 'AWARD_ERROR' });
	} finally {
		if (client) client.release();
	}
});

// ─── Shop purchase — server-validated items (XP potions, etc.) ───
const SHOP_SERVER_ITEMS = {
	xp_potion_500: { cost: 5000, xp: 500, label: 'XP Potion (+500 XP)' },
	// H3: sold on the server so solo completion can prove the boost from the
	// ledger (metadata.boost_uses); /api/coins/log refuses this action.
	[XP_BOOST_ITEM_ID]: {
		cost: 1500, xp: 0, label: '2× XP Boost',
		boost: { multiplier: XP_BOOST_MULTIPLIER, uses: XP_BOOST_USES },
	},
};

app.post('/api/shop/purchase', async (req, res) => {
	if (!coinApiReady()) return respondCoinApiDisabled(res);
	const user = await requireSupabaseUser(req, res);
	if (!user) return;

	const { item_id } = req.body || {};
	const item = typeof item_id === 'string' && Object.hasOwn(SHOP_SERVER_ITEMS, item_id)
		? SHOP_SERVER_ITEMS[item_id] : null;
	if (!item) return res.status(400).json({ error: 'Neznámy item', code: 'UNKNOWN_ITEM' });

	let client;
	try {
		client = await coinsDbPool.connect();
		await client.query('BEGIN');

		const { rows } = await client.query(
			'SELECT COALESCE(coins, 0)::int AS coins, COALESCE(rpg_xp, 0)::int AS rpg_xp FROM public.profiles WHERE id = $1 FOR UPDATE',
			[user.id]
		);
		const coins = rows[0]?.coins || 0;
		if (coins < item.cost) {
			await client.query('ROLLBACK');
			return res.status(400).json({ error: 'Nedostatok coinov', code: 'INSUFFICIENT_COINS', required: item.cost, current: coins });
		}

		const levelBefore = computeRpgLevel(rows[0]?.rpg_xp || 0).level;

		await client.query('UPDATE public.profiles SET coins = coins - $1 WHERE id = $2', [item.cost, user.id]);
		await client.query(
			'INSERT INTO public.coin_transactions (user_id, amount, action, metadata) VALUES ($1, $2, $3, $4)',
			[user.id, -item.cost, `shop_${item_id}`, JSON.stringify({
				item_id,
				label: item.label,
				...(item.boost ? { boost_uses: item.boost.uses, boost_multiplier: item.boost.multiplier } : {}),
			})]
		);

		let rpgXpGained = 0, rpgLevel = levelBefore, rpgLevelUp = false;
		if (item.xp > 0) {
			const result = await awardXpInTransaction(client, user.id, item.xp, `shop_${item_id}`);
			rpgXpGained = item.xp;
			rpgLevel = result.level;
			rpgLevelUp = result.level > levelBefore;
		}

		await client.query('COMMIT');

		const { rows: afterRows } = await client.query('SELECT COALESCE(coins,0)::int AS coins FROM public.profiles WHERE id = $1', [user.id]);
		res.json({
			ok: true,
			new_balance: afterRows[0]?.coins ?? (coins - item.cost),
			rpg_xp_gained: rpgXpGained,
			rpg_level: rpgLevel,
			rpg_level_up: rpgLevelUp,
		});
	} catch (err) {
		if (client) { try { await client.query('ROLLBACK'); } catch (_) {} }
		console.error('[Shop] purchase failed:', err.message);
		res.status(500).json({ error: 'Nákup zlyhal', code: 'PURCHASE_ERROR' });
	} finally {
		if (client) client.release();
	}
});

// ─── Photo verification — AI checks if the uploaded photo matches the game challenge ───
app.post('/api/verify-completion', async (req, res) => {
	const user = await requireSupabaseUser(req, res);
	if (!user) return;

	const { photo_base64 } = req.body || {};
	const rawChallenge = (req.body || {}).challenge_description;
	const rawTitle = (req.body || {}).game_title;
	if (typeof photo_base64 !== 'string' || typeof rawChallenge !== 'string' || !photo_base64 || !rawChallenge.trim()
		|| (rawTitle != null && typeof rawTitle !== 'string')) {
		return res.status(400).json({ error: 'Chýba fotka alebo popis výzvy', code: 'MISSING_DATA' });
	}
	// Free text goes into the vision prompt — clamp like generate-game filters.
	const challenge_description = cleanText(rawChallenge);
	const game_title = rawTitle ? cleanText(rawTitle) : '';

	// Limit base64 size (~5 MB image → ~6.7 MB base64)
	if (photo_base64.length > 8_000_000) {
		return res.status(400).json({ error: 'Fotka je príliš veľká (max 5 MB)', code: 'PHOTO_TOO_LARGE' });
	}

	// H4: every call is a paid gpt-4o vision request. Record the attempt first,
	// then count today's attempts including this one (insert-then-count is
	// safe under parallel requests). Without the DB there is no way to cap
	// per user, so the route refuses instead of running uncapped.
	if (!coinApiReady()) return respondCoinApiDisabled(res);
	try {
		await queryCoinsDb(
			`INSERT INTO public.coin_transactions (user_id, amount, action, metadata)
			 VALUES ($1, 0, 'photo_verify_attempt', $2)`,
			[user.id, JSON.stringify({ game_title: game_title || null })]
		);
		const { rows: attemptRows } = await queryCoinsDb(
			`SELECT COUNT(*)::int AS cnt FROM public.coin_transactions
			 WHERE user_id = $1 AND action = 'photo_verify_attempt' AND created_at >= CURRENT_DATE`,
			[user.id]
		);
		const attempts = attemptRows[0]?.cnt || 0;
		if (!photoVerifyAttemptAllowed(attempts)) {
			return res.status(429).json({
				error: `Denný limit overení fotky dosiahnutý (${PHOTO_VERIFY_DAILY_ATTEMPTS}). Skús to zajtra.`,
				code: 'PHOTO_VERIFY_DAILY_CAP',
				limit: PHOTO_VERIFY_DAILY_ATTEMPTS
			});
		}
	} catch (err) {
		console.error('[Verify] attempt cap check failed:', err.message);
		return res.status(500).json({ error: 'Kontrola limitu zlyhala', code: 'COOLDOWN_CHECK_ERROR' });
	}

	try {
		const visionResp = await openai.chat.completions.create({
			model: 'gpt-4o',
			max_tokens: 300,
			messages: [{
				role: 'user',
				content: [
					{
						type: 'text',
						text: `You are a game completion verifier. The player played a game called "${game_title || 'Unknown'}".
The verification challenge was: "${challenge_description}"
Look at the uploaded photo and determine if it matches the challenge. Be generous — if the photo shows reasonable evidence of the activity, approve it.
Respond with ONLY a JSON object: {"verified": true/false, "confidence": 0-100, "feedback": "short message for the player"}`
					},
					{
						type: 'image_url',
						image_url: { url: photo_base64, detail: 'low' }
					}
				]
			}]
		});

		const raw = (visionResp.choices?.[0]?.message?.content || '').trim();
		let result;
		try {
			const jsonMatch = raw.match(/\{[\s\S]*\}/);
			result = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
		} catch {
			result = { verified: false, confidence: 0, feedback: 'Nepodarilo sa vyhodnotiť fotku' };
		}

		// Award bonus XP + gIVEMECOIN if verified
		let bonusXp = 0;
		let bonusCoins = 0;
		let rpgLevel = null;
		let rpgLevelUp = false;
		let rewardCapped = false;
		if (result.verified && coinApiReady()) {
			try {
				const client = await coinsDbPool.connect();
				try {
					await client.query('BEGIN');
					// FOR UPDATE serialises parallel verifications of one user so the
					// daily reward count below cannot be exceeded.
					const { rows: pre } = await client.query(
						'SELECT COALESCE(rpg_xp,0)::int AS rpg_xp FROM public.profiles WHERE id = $1 FOR UPDATE', [user.id]
					);
					const { rows: rewardRows } = await client.query(
						`SELECT COUNT(*)::int AS cnt FROM public.coin_transactions
						 WHERE user_id = $1 AND action = 'photo_verify_bonus' AND created_at >= CURRENT_DATE`,
						[user.id]
					);
					if (!photoVerifyRewardAllowed(rewardRows[0]?.cnt || 0)) {
						rewardCapped = true;
						throw Object.assign(new Error('photo reward daily cap'), { rewardCapped: true });
					}
					const levelBefore = computeRpgLevel(pre[0]?.rpg_xp || 0).level;
					const xpResult = await awardXpInTransaction(client, user.id, VERIFICATION_XP_BONUS, 'photo_verify');
					bonusXp = VERIFICATION_XP_BONUS;
					rpgLevel = xpResult.level;
					rpgLevelUp = xpResult.level > levelBefore;
					await client.query(
						'UPDATE public.profiles SET coins = COALESCE(coins, 0) + $1 WHERE id = $2',
						[VERIFICATION_COIN_BONUS, user.id]
					);
					await client.query(
						'INSERT INTO public.coin_transactions (user_id, amount, action, metadata) VALUES ($1, $2, $3, $4)',
						[
							user.id,
							VERIFICATION_COIN_BONUS,
							'photo_verify_bonus',
							JSON.stringify({ game_title: game_title || null, xp_bonus: VERIFICATION_XP_BONUS })
						]
					);
					bonusCoins = VERIFICATION_COIN_BONUS;
					await client.query('COMMIT');
				} catch (e) {
					try { await client.query('ROLLBACK'); } catch (_) {}
					// Nothing was committed, so nothing may be reported as awarded.
					bonusXp = 0; bonusCoins = 0; rpgLevel = null; rpgLevelUp = false;
					if (!e.rewardCapped) console.error('[Verify] XP/coin award failed:', e.message);
				} finally { client.release(); }
			} catch (e) { console.error('[Verify] DB connection failed:', e.message); }
		}

		res.json({
			verified: !!result.verified,
			confidence: result.confidence || 0,
			feedback: result.feedback || '',
			bonus_xp: bonusXp,
			bonus_coins: bonusCoins,
			reward_capped: rewardCapped,
			reward_daily_limit: PHOTO_VERIFY_DAILY_REWARDS,
			rpg_level: rpgLevel,
			rpg_level_up: rpgLevelUp,
		});
	} catch (err) {
		console.error('[Verify] Vision API failed:', err.message);
		res.status(500).json({ error: 'Overenie zlyhalo', code: 'VERIFY_ERROR' });
	}
});

// ─── Solo game completion ───────────────────────────────────────────────────
// Phase 5: with PLAY_TICKETS_ENABLED (default on) the client sends ticket_id
// and the server reads duration, mode and competencies from its own ticket.
// Without a ticket the old game_json path keeps working until
// PLAY_TICKETS_LEGACY_UNTIL (two-week deprecation, see docs/ENV_SETUP.md).
app.post('/api/profile/complete-solo', async (req, res) => {
	if (!coinApiReady()) return respondCoinApiDisabled(res);
	const user = await requireSupabaseUser(req, res);
	if (!user) return;
	const body = req.body || {};
	if (PlayTickets.playTicketsEnabled()) {
		if (body.ticket_id != null) return completeSoloWithTicket(req, res, user, body.ticket_id);
		if (!PlayTickets.legacyCompleteSoloAllowed()) {
			return res.status(400).json({
				error: 'Spusti hru znova, aby sa dala odmena overiť.',
				code: 'TICKET_REQUIRED',
			});
		}
		res.set('Deprecation', 'true');
		res.set('Sunset', PlayTickets.legacyUntil().toUTCString());
	}
	return completeSoloLegacy(req, res, user);
});

/** Solo completions per rolling 24 h (Free vs Pro). Sends the error and returns false when over. */
async function checkSoloDailyLimit(user, res) {
	let soloLimit = entitlementsForPlan(false).soloCompletionsPer24h;
	try {
		const bill = await getUserBillingState(coinsDbPool, user.id);
		soloLimit = entitlementsForPlan(hasPaidAccess(bill)).soloCompletionsPer24h;
		const { rows: soloRows } = await queryCoinsDb(
			`SELECT COUNT(*)::int AS cnt FROM public.coin_transactions
			 WHERE user_id = $1 AND action = 'solo_complete'
			   AND created_at > NOW() - INTERVAL '24 hours'`,
			[user.id]
		);
		if ((soloRows[0]?.cnt || 0) >= soloLimit) {
			res.status(429).json({
				error: `Denný limit solo hier dosiahnutý (${soloRows[0].cnt}/${soloLimit}). Obnoví sa za 24 h od poslednej hry alebo predplaťte Pro učiteľ.`,
				code: 'SOLO_DAILY_LIMIT',
				limit: soloLimit,
				used: soloRows[0].cnt
			});
			return false;
		}
	} catch (e) {
		console.error('[Completion] solo cooldown check failed:', e.message);
		res.status(500).json({ error: 'Kontrola limitu zlyhala', code: 'COOLDOWN_CHECK_ERROR' });
		return false;
	}
	return true;
}

/** Effective stats after an award (cosmetic; runs in a savepoint so it cannot abort the award). */
async function readSoloStatsAfter(client, userId) {
	let statsAfter = {};
	await client.query('SAVEPOINT solo_stats');
	try {
		const { rows: profileAfter } = await client.query(
			'SELECT rpg_avatar_id FROM public.profiles WHERE id = $1', [userId]
		);
		const classId = profileAfter[0]?.rpg_avatar_id || null;
		if (classId) {
			const { rows: tRows } = await client.query(
				'SELECT talent_id FROM public.rpg_user_talents WHERE user_id = $1', [userId]
			);
			// M4: map ids to talent objects; the card reads flat stat values.
			statsAfter = getEffectiveStats(classId, talentIdsToTalents(tRows.map(r => r.talent_id))).effective;
		}
		await client.query('RELEASE SAVEPOINT solo_stats');
	} catch (_) {
		await client.query('ROLLBACK TO SAVEPOINT solo_stats');
	}
	return statsAfter;
}

async function completeSoloWithTicket(req, res, user, ticketId) {
	if (!PlayTickets.isTicketId(ticketId)) {
		return res.status(400).json({ error: 'Neplatný lístok hry', code: 'INVALID_TICKET' });
	}
	if (!(await checkSoloDailyLimit(user, res))) return;

	let client;
	let done = false;
	const fail = async (status, payload) => {
		done = true;
		try { await client.query('ROLLBACK'); } catch (_) {}
		return res.status(status).json(payload);
	};
	try {
		client = await coinsDbPool.connect();
		await client.query('BEGIN');
		// Profile lock first (same order as the legacy path) serialises a user's completions.
		const { rows: preRows } = await client.query(
			'SELECT COALESCE(rpg_xp, 0)::int AS rpg_xp FROM public.profiles WHERE id = $1 FOR UPDATE',
			[user.id]
		);
		if (!preRows.length) return await fail(404, { error: 'Profil nenájdený', code: 'NO_PROFILE' });
		const levelBefore = computeRpgLevel(preRows[0].rpg_xp).level;

		const ticket = await PlayTickets.lockTicket(client, user.id, ticketId);
		if (!ticket) return await fail(404, { error: 'Lístok hry sa nenašiel', code: 'TICKET_NOT_FOUND' });
		if (ticket.completed_at) return await fail(409, { error: 'Za túto hru už si odmenu dostal/a', code: 'TICKET_USED' });
		if (!ticket.started_at) return await fail(409, { error: 'Hra ešte nebola spustená', code: 'TICKET_NOT_STARTED' });

		const gate = validateDurationGate(ticket.started_at, { duration: { min: ticket.duration_min } });
		if (!gate.pass) {
			return await fail(400, {
				error: 'Hra trvala príliš krátko na odmenu',
				code: 'DURATION_TOO_SHORT',
				duration_actual_min: gate.validation.duration_actual_min,
				duration_required_min: gate.validation.duration_required_min,
			});
		}
		if (await PlayTickets.overlapsCompletedTicket(client, user.id, ticket)) {
			return await fail(409, { error: 'Naraz sa dá hrať len jedna hra', code: 'TICKET_OVERLAP' });
		}

		// H3: the boost comes from server-sold xp_boost_2x uses in the ledger, never from the client.
		const xpMul = resolveSoloXpMultiplier(XP_BOOST_MULTIPLIER, await countRemainingBoostUses(client, user.id));
		const reward = PlayTickets.computeTicketReward({
			durationMax: ticket.duration_max,
			elapsedMin: gate.validation.duration_actual_min,
			reflected: Boolean(ticket.reflection_id),
			multiplier: xpMul,
			mode: ticket.mode,
			kompetence: ticket.kompetence,
		});
		if (!(await PlayTickets.markTicketCompleted(client, user.id, ticket.id, reward))) {
			return await fail(409, { error: 'Za túto hru už si odmenu dostal/a', code: 'TICKET_USED' });
		}

		await client.query(
			'UPDATE public.profiles SET coins = COALESCE(coins, 0) + $1 WHERE id = $2',
			[COMPLETION_BONUS, user.id]
		);
		await client.query(
			'INSERT INTO public.coin_transactions (user_id, amount, action, metadata) VALUES ($1, $2, $3, $4)',
			[user.id, COMPLETION_BONUS, 'solo_complete', JSON.stringify({
				ticket_id: ticket.id,
				mode: ticket.mode,
				kompetence_keys: ticket.kompetence,
				duration_max: ticket.duration_max,
				xp_multiplier: reward.xp_multiplier,
				reflection: Boolean(ticket.reflection_id),
			})]
		);
		const { rpg_xp, level: rpg_level } = await awardXpInTransaction(
			client, user.id, reward.total_xp, reward.xp_multiplier > 1 ? 'solo_ticket_boosted' : 'solo_ticket'
		);
		await PlayTickets.addStatXp(client, user.id, reward.stat_xp);
		const statsAfter = await readSoloStatsAfter(client, user.id);
		await client.query('COMMIT');
		done = true;

		res.json({
			ok: true,
			ticket_id: ticket.id,
			mode: ticket.mode,
			rpg_xp_gained: reward.total_xp,
			participation_xp: reward.participation_xp,
			reflection_bonus_xp: reward.reflection_bonus_xp,
			reflection_counted: Boolean(ticket.reflection_id),
			xp_multiplier_applied: reward.xp_multiplier,
			coins_awarded: COMPLETION_BONUS,
			rpg_xp,
			rpg_level,
			rpg_level_up: rpg_level > levelBefore,
			trained_stats: reward.trained_stats,
			stat_xp_gained: reward.stat_xp,
			stats_after: statsAfter,
		});
	} catch (err) {
		if (client && !done) { try { await client.query('ROLLBACK'); } catch (_) {} }
		console.error('[Completion] ticket complete failed:', err.message);
		if (!res.headersSent) res.status(500).json({ error: 'Nepodarilo sa udeliť body', code: 'AWARD_ERROR' });
	} finally {
		if (client) client.release();
	}
}

/** Pre-ticket path: trusts game_json (H3 clamp only). Removed after PLAY_TICKETS_LEGACY_UNTIL. */
async function completeSoloLegacy(req, res, user) {
	const { game_json } = req.body || {};
	const kompetence = game_json?.rvp?.kompetence;
	if (!Array.isArray(kompetence) || kompetence.length === 0) {
		return res.status(400).json({ error: 'game_json.rvp.kompetence je povinné', code: 'MISSING_COMPETENCIES' });
	}

	if (!(await checkSoloDailyLimit(user, res))) return;

	// Atomically: award coins + RPG XP (kompetencie z hry ostávajú len v game_json / RVP — bez samostatných „kompetenčných bodov“)
	const validKomps = kompetence.filter(k => VALID_COMPETENCY_KEYS.includes(k));
	let soloClient;
	try {
		soloClient = await coinsDbPool.connect();
		await soloClient.query('BEGIN');

		// FOR UPDATE serialises parallel completions of the same user, so the
		// boost-use count below cannot be spent twice.
		const { rows: preRows } = await soloClient.query(
			'SELECT COALESCE(rpg_xp, 0)::int AS rpg_xp FROM public.profiles WHERE id = $1 FOR UPDATE',
			[user.id]
		);
		const levelBefore = computeRpgLevel(preRows[0]?.rpg_xp || 0).level;

		// H3 (short term): the client's xp_multiplier only applies while the
		// ledger holds unused, server-sold xp_boost_2x uses; otherwise it is 1.
		const remainingBoostUses = parseInt(req.body.xp_multiplier, 10) > 1
			? await countRemainingBoostUses(soloClient, user.id)
			: 0;
		const xpMul = resolveSoloXpMultiplier(req.body.xp_multiplier, remainingBoostUses);

		// Award completion bonus coins
		await soloClient.query(
			'UPDATE public.profiles SET coins = COALESCE(coins, 0) + $1 WHERE id = $2',
			[COMPLETION_BONUS, user.id]
		);
		await soloClient.query(
			'INSERT INTO public.coin_transactions (user_id, amount, action, metadata) VALUES ($1, $2, $3, $4)',
			[user.id, COMPLETION_BONUS, 'solo_complete', JSON.stringify({
				kompetence_keys: validKomps,
				duration_max: game_json?.duration?.max ?? null,
				xp_multiplier: xpMul,
			})]
		);

		// Award RPG XP — amount depends on activity length; xp_multiplier from shop boosts.
		// Multi-competency bonus: games that train multiple competencies get +15% per extra (cap at 150 base).
		const rawXp = computeSoloXpFromDurationMax(game_json?.duration?.max);
		const kompBonus = 1 + 0.15 * Math.max(0, validKomps.length - 1);
		const scaledXp = Math.min(150, Math.round(rawXp * kompBonus));
		const soloXpAward = scaledXp * xpMul;
		const { rpg_xp, level: rpg_level } = await awardXpInTransaction(
			soloClient, user.id, soloXpAward, xpMul > 1 ? 'solo_complete_boosted' : 'solo_complete'
		);
		const rpg_level_up = rpg_level > levelBefore;

		// Compute which stats this game trains and the user's effective stats after XP
		const trainedStats = [...new Set(validKomps.map(k => GAME_KOMP_TO_STAT[k]).filter(Boolean))];
		const statsAfter = await readSoloStatsAfter(soloClient, user.id);

		await soloClient.query('COMMIT');

		res.json({
			ok: true,
			rpg_xp_gained: soloXpAward,
			xp_multiplier_applied: xpMul,
			rpg_xp,
			rpg_level,
			rpg_level_up,
			trained_stats: trainedStats,
			stats_after: statsAfter,
			legacy: true,
		});
	} catch (err) {
		if (soloClient) { try { await soloClient.query('ROLLBACK'); } catch (_) {} }
		console.error('[Completion] solo complete failed:', err.message);
		res.status(500).json({ error: 'Nepodarilo sa udeliť body', code: 'AWARD_ERROR' });
	} finally {
		if (soloClient) soloClient.release();
	}
}

// ─── Play tickets (Phase 5) ─────────────────────────────────────────────────
// POST /api/play/start           { ticket_id } | { game_id } | { public_id }
// POST /api/play/:ticket/reflect { ratings, texts } — quality gate → +25 % bonus
// GET  /api/play/attributes      stat XP, per-competency counts, mode rationale

function playTicketsGuard(res) {
	if (!PlayTickets.playTicketsEnabled()) {
		res.status(404).json({ error: 'Funkcia nie je zapnutá', code: 'PLAY_TICKETS_DISABLED' });
		return false;
	}
	if (!coinApiReady()) { respondCoinApiDisabled(res); return false; }
	return true;
}

app.post('/api/play/start', async (req, res) => {
	if (!playTicketsGuard(res)) return;
	const user = await requireSupabaseUser(req, res);
	if (!user) return;
	const { ticket_id, game_id, public_id } = req.body || {};
	try {
		if (ticket_id != null) {
			if (!PlayTickets.isTicketId(ticket_id)) {
				return res.status(400).json({ error: 'Neplatný lístok hry', code: 'INVALID_TICKET' });
			}
			const r = await PlayTickets.startTicket(coinsDbPool, user.id, ticket_id);
			if (r.status === 'not_found') return res.status(404).json({ error: 'Lístok hry sa nenašiel', code: 'TICKET_NOT_FOUND' });
			if (r.status === 'completed') return res.status(409).json({ error: 'Za túto hru už si odmenu dostal/a', code: 'TICKET_USED' });
			return res.json({ ok: true, ticket_id: r.id, started_at: r.started_at });
		}

		// Library game (own saved game or a shared public link): the server
		// copies its stored game_json into a new ticket and starts it now.
		const byPublic = game_id == null && public_id != null;
		const ref = byPublic ? public_id : game_id;
		if (!PlayTickets.isTicketId(ref)) {
			return res.status(400).json({ error: 'Chýba hra na spustenie', code: 'MISSING_GAME' });
		}
		if ((await PlayTickets.libraryTicketsToday(coinsDbPool, user.id)) >= PlayTickets.MAX_LIBRARY_TICKETS_PER_DAY) {
			return res.status(429).json({ error: 'Dnes si spustil/a už veľa hier. Skús to zajtra.', code: 'TICKET_DAILY_LIMIT' });
		}
		const { rows } = await queryCoinsDb(
			byPublic
				? 'SELECT mode, game_json FROM public.saved_games WHERE public_token = $1 LIMIT 1'
				: 'SELECT mode, game_json FROM public.saved_games WHERE id = $1 AND user_id = $2 LIMIT 1',
			byPublic ? [ref] : [ref, user.id]
		);
		if (!rows.length || !rows[0].game_json) return res.status(404).json({ error: 'Hra nenájdená', code: 'NOT_FOUND' });
		const row = await PlayTickets.insertTicket(coinsDbPool, user.id, rows[0].game_json, {
			source: 'library', mode: rows[0].mode, start: true,
		});
		res.json({ ok: true, ticket_id: row.id, started_at: row.started_at });
	} catch (err) {
		console.error('[Play] start failed:', err.message);
		res.status(500).json({ error: 'Hru sa nepodarilo spustiť', code: 'TICKET_ERROR' });
	}
});

app.post('/api/play/:ticket/reflect', async (req, res) => {
	if (!playTicketsGuard(res)) return;
	const user = await requireSupabaseUser(req, res);
	if (!user) return;
	const ticketId = req.params.ticket;
	if (!PlayTickets.isTicketId(ticketId)) {
		return res.status(400).json({ error: 'Neplatný lístok hry', code: 'INVALID_TICKET' });
	}
	let client;
	let open = false;
	try {
		client = await coinsDbPool.connect();
		await client.query('BEGIN');
		open = true;
		const finish = async (status, payload) => {
			open = false;
			await client.query(status === 200 ? 'COMMIT' : 'ROLLBACK');
			return res.status(status).json(payload);
		};
		const ticket = await PlayTickets.lockTicket(client, user.id, ticketId);
		if (!ticket) return await finish(404, { error: 'Lístok hry sa nenašiel', code: 'TICKET_NOT_FOUND' });
		if (!ticket.started_at) return await finish(409, { error: 'Hra ešte nebola spustená', code: 'TICKET_NOT_STARTED' });
		if (ticket.completed_at) return await finish(409, { error: 'Reflexiu napíš pred ukončením hry', code: 'TICKET_USED' });
		if (ticket.reflection_id) return await finish(409, { error: 'Reflexiu k tejto hre už máš', code: 'REFLECTION_EXISTS' });

		const previous = await PlayTickets.recentReflectionTexts(client, user.id);
		const check = PlayTickets.validateReflection(req.body || {}, ticket.kompetence, previous);
		if (!check.ok) {
			return await finish(422, {
				error: 'Reflexia nespĺňa podmienky bonusu',
				code: check.code,
				field: check.field || null,
				min_chars: PlayTickets.REFLECTION_MIN_CHARS,
			});
		}
		const reflectionId = await PlayTickets.insertReflection(client, user.id, ticket.id, check);
		return await finish(200, { ok: true, reflection_id: reflectionId, bonus_rate: PlayTickets.REFLECTION_BONUS_RATE });
	} catch (err) {
		if (client && open) { try { await client.query('ROLLBACK'); } catch (_) {} }
		console.error('[Play] reflect failed:', err.message);
		if (!res.headersSent) res.status(500).json({ error: 'Reflexiu sa nepodarilo uložiť', code: 'REFLECTION_ERROR' });
	} finally {
		if (client) client.release();
	}
});

app.get('/api/play/attributes', async (req, res) => {
	const manifest = getAttributeManifest();
	if (!PlayTickets.playTicketsEnabled() || !coinApiReady()) {
		return res.json({ enabled: false, manifest, stat_xp: {}, competencies: [], games: 0, reflected: 0 });
	}
	const user = await requireSupabaseUser(req, res);
	if (!user) return;
	try {
		const data = await PlayTickets.readPlayAttributes(coinsDbPool, user.id);
		res.json({ enabled: true, manifest, ...data });
	} catch (err) {
		console.error('[Play] attributes failed:', err.message);
		res.status(500).json({ error: 'Nepodarilo sa načítať atribúty', code: 'ATTRIBUTES_ERROR' });
	}
});

// ─── Get RPG stats for authenticated user (replaced legacy competency_points) ───
app.get('/api/profile/competencies', async (req, res) => {
	if (!coinApiReady()) return respondCoinApiDisabled(res);
	const user = await requireSupabaseUser(req, res);
	if (!user) return;
	try {
		const { rows: profileRows } = await queryCoinsDb(
			`SELECT COALESCE(rpg_xp, 0)::int AS rpg_xp, rpg_avatar_id FROM public.profiles WHERE id = $1`,
			[user.id]
		);
		const profile = profileRows[0] || {};
		const classId = profile.rpg_avatar_id || null;
		const { rows: unlockedRows } = await queryCoinsDb(
			`SELECT talent_id FROM public.rpg_user_talents WHERE user_id = $1`, [user.id]
		);
		const unlocked = unlockedRows.map(r => r.talent_id);
		const talentManifest = getTalentManifest();
		const unlockedTalents = unlocked.map(id => talentManifest.find(t => t.id === id)).filter(Boolean);
		const stats = getEffectiveStats(classId, unlockedTalents);
		const progression = computeRpgLevel(profile.rpg_xp || 0);
		res.json({ stats, progression, class_id: classId });
	} catch (err) {
		console.error('[RPG Stats] fetch failed:', err.message);
		res.status(500).json({ error: 'Nepodarilo sa načítať RPG štatistiky', code: 'STATS_ERROR' });
	}
});

// ─── Teacher analytics — aggregated stats for the authenticated user ───
// Reads profiles (games_generated, rpg_xp) + coin_transactions aggregate.
app.get('/api/profile/analytics', async (req, res) => {
	if (!coinApiReady()) return respondCoinApiDisabled(res);
	const user = await requireSupabaseUser(req, res);
	if (!user) return;

	try {
		// 1. Profile row — games_generated, games_exported, competency_points
		const { rows: profRows } = await queryCoinsDb(
			`SELECT COALESCE(games_generated, 0)::int AS games_generated,
			        COALESCE(games_exported,  0)::int AS games_exported,
			        COALESCE(rpg_xp, 0)::int AS rpg_xp
			 FROM public.profiles WHERE id = $1`,
			[user.id]
		);
		const prof = profRows[0] || {};
		const rpgXpRaw = parseInt(prof.rpg_xp, 10) || 0;
		const rpgProg = computeRpgLevel(rpgXpRaw);

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

		// 3. Dominant mode: inferred from solo vs session completions
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
			rpg_xp:                 rpgXpRaw,
			rpg_level:              rpgProg.level,
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

	// M9: the join-code lookup hits the DB too, so it must sit inside the try —
	// Express 4 does not catch a rejected async handler and the request hangs.
	try {
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
	let client;
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

		// M1 + H1: status compare-and-swap and conditional charges in one
		// transaction. A second /start charges nobody; a participant without
		// enough coins is skipped and stays unpaid (never rewarded).
		client = await coinsDbPool.connect();
		await client.query('BEGIN');
		const result = await startSessionAndCharge(client, {
			sessionId: sess.id,
			hostId: user.id,
			code,
			cost: SESSION_JOIN_COST,
			timerEndsAt,
		});
		if (!result.started) {
			await client.query('ROLLBACK');
			return res.status(409).json({ error: 'Session už beží', code: 'ALREADY_STARTED' });
		}
		await client.query('COMMIT');

		res.json({
			ok: true,
			timer_ends_at: timerEndsAt,
			participants_charged: result.charged.length,
			participants_unpaid: result.unpaid.length,
		});
	} catch (err) {
		if (client) { try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ } }
		console.error('[Sessions] start failed:', err.message);
		res.status(500).json({ error: 'Nepodarilo sa štartovať session', code: 'START_ERROR' });
	} finally {
		if (client) client.release();
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
		const awardedMarker = { rpg: true, kompetence_keys: kompetence };

		// ─── Transactional reward loop ─────────────────────────────────
		// All awards are wrapped in a single DB transaction to prevent
		// partial awarding on crash/error (atomicity guarantee).
		const client = await coinsDbPool.connect();
		let participantsRewarded = 0;
		let myRpgLevelUp = false;
		let myXpGained = 0;
		try {
			await client.query('BEGIN');

			// M2: only participants who actually paid at /start are rewarded; a
			// join that raced the start (or a skipped, unpaid player) is not.
			const { rows: parts } = await client.query(
				`SELECT user_id FROM public.session_participants
				 WHERE session_id = $1 AND reflection_done = true AND awarded_competencies IS NULL
				   AND coins_paid > 0`,
				[sess.id]
			);

			for (const p of parts) {
				const { rows: preXpRows } = await client.query(
					'SELECT COALESCE(rpg_xp, 0)::int AS rpg_xp FROM public.profiles WHERE id = $1 FOR UPDATE',
					[p.user_id]
				);
				const levelBefore = computeRpgLevel(preXpRows[0]?.rpg_xp || 0).level;

				await client.query(
					`UPDATE public.session_participants
					 SET awarded_competencies = $1 WHERE session_id = $2 AND user_id = $3`,
					[JSON.stringify(awardedMarker), sess.id, p.user_id]
				);

				const { rowCount: coinRows } = await client.query(
					'UPDATE public.profiles SET coins = COALESCE(coins,0) + $1 WHERE id = $2',
					[COMPLETION_BONUS, p.user_id]
				);
				if (coinRows === 0) {
					await client.query(
						'INSERT INTO public.profiles (id, coins) VALUES ($1, $2)',
						[p.user_id, COMPLETION_BONUS]
					);
				}
				await client.query(
					'INSERT INTO public.coin_transactions (user_id, amount, action, metadata) VALUES ($1, $2, $3, $4)',
					[p.user_id, COMPLETION_BONUS, 'session_complete', JSON.stringify({ session_code: code, kompetence_keys: kompetence })]
				);

				const { level: rpgLvlAfter } = await awardXpInTransaction(client, p.user_id, SESSION_XP_AWARD, 'session_complete');
				if (p.user_id === user.id) {
					myXpGained = SESSION_XP_AWARD;
					myRpgLevelUp = rpgLvlAfter > levelBefore;
				}
			}
			participantsRewarded = parts.length;

			// Write audit trail + mark completed (inside transaction)
			// C1: required values come from the gate results (requiredMin /
			// requiredPlayers only exist inside lib/reward-validation.js).
			const validation = buildCompletionValidation({
				durationValidation: durResult.validation,
				participantValidation: partResult.validation,
				hostSessionsLastHour,
				competencies: kompetence,
				participantsRewarded: parts.length,
			});
			await client.query(
				`UPDATE public.sessions SET status = 'completed', completed_at = NOW(), reward_validation = $1 WHERE id = $2`,
				[JSON.stringify(validation), sess.id]
			);

			await client.query('COMMIT');

			// Compute trained stats and effective stats for the host (cosmetic)
			const sessionTrainedStats = [...new Set(kompetence.map(k => GAME_KOMP_TO_STAT[k]).filter(Boolean))];
			let sessionStatsAfter = {};
			try {
				const { rows: hostProfile } = await queryCoinsDb(
					'SELECT rpg_avatar_id FROM public.profiles WHERE id = $1', [user.id]
				);
				const hClassId = hostProfile[0]?.rpg_avatar_id || null;
				if (hClassId) {
					const { rows: hTalRows } = await queryCoinsDb(
						'SELECT talent_id FROM public.rpg_user_talents WHERE user_id = $1', [user.id]
					);
					// M4: getEffectiveStats needs talent objects, not ids; the card
					// reads flat stat values.
					sessionStatsAfter = getEffectiveStats(hClassId, talentIdsToTalents(hTalRows.map(r => r.talent_id))).effective;
				}
			} catch (_) { /* non-critical */ }

			res.json({
				ok: true,
				awarded: awardedMarker,
				participants_rewarded: participantsRewarded,
				validation,
				my_level_changes: {},
				my_rpg_level_up: myRpgLevelUp,
				rpg_xp_gained: myXpGained,
				trained_stats: sessionTrainedStats,
				stats_after: sessionStatsAfter,
			});
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

// ─── Session reward: participant fetches their own RPG reward status ───
// Only returns data for the authenticated requesting user — never exposes others.
app.get('/api/sessions/:code/my-reward', async (req, res) => {
	if (!coinApiReady()) return respondCoinApiDisabled(res);
	const user = await requireSupabaseUser(req, res);
	if (!user) return;

	const code = (req.params.code || '').toUpperCase().trim();
	try {
		const { rows: sessRows } = await queryCoinsDb(
			'SELECT id, status FROM public.sessions WHERE join_code = $1', [code]
		);
		if (!sessRows.length) return res.status(404).json({ error: 'Session nenájdená', code: 'NOT_FOUND' });
		const sess = sessRows[0];
		if (sess.status !== 'completed') {
			return res.status(400).json({ error: 'Session ešte nie je dokončená', code: 'NOT_COMPLETED' });
		}

		const { rows: partRows } = await queryCoinsDb(
			`SELECT awarded_competencies FROM public.session_participants
			 WHERE session_id = $1 AND user_id = $2`,
			[sess.id, user.id]
		);
		if (!partRows.length) return res.status(404).json({ error: 'Nie si účastníkom tejto session', code: 'NOT_PARTICIPANT' });

		const awarded = partRows[0].awarded_competencies || {};
		res.json({ awarded, rpg: true });
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

// ─── RPG Avatar API ───
// Gated behind school membership — only users inside a school with a valid
// Sprint 1 role (admin/teacher/student) can select an RPG avatar.
// Avatar manifest loaded from lib/rpg-avatars.js (single source of truth).

// Simple in-memory rate limiter for RPG avatar changes (per-user)
const _rpgAvatarBuckets = new Map();
function rpgRateLimit(userId, maxReqs, windowMs) {
  const key = `rpg-avatar:${userId}`;
  const now = Date.now();
  const bucket = _rpgAvatarBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    _rpgAvatarBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= maxReqs) return false;
  bucket.count++;
  return true;
}

// Helper: fetch user's school membership (reused by GET and PATCH)
async function _rpgGetMembership(userId) {
  const { rows } = await queryCoinsDb(
    `SELECT sm.role, s.name AS school_name
     FROM public.edu_school_memberships sm
     JOIN public.edu_schools s ON s.id = sm.school_id
     WHERE sm.user_id = $1 AND sm.archived_at IS NULL
     LIMIT 1`,
    [userId]
  );
  if (rows.length === 0) return null;
  const m = rows[0];
  return RPG_ELIGIBLE_ROLES.includes(m.role) ? m : null;
}

app.get('/api/rpg/avatar', async (req, res) => {
  if (!coinApiReady()) return respondCoinApiDisabled(res);
  const user = await requireSupabaseUser(req, res);
  if (!user) return;
  try {
    // Permisívne: každý prihlásený užívateľ má prístup k RPG avataru.
    // School membership je len bonusový kontext (rola + meno školy).
    const membership = await _rpgGetMembership(user.id);
    const { rows: profileRows } = await queryCoinsDb(
      `SELECT rpg_avatar_id, COALESCE(coins, 0)::int AS coins FROM public.profiles WHERE id = $1`,
      [user.id]
    );
    const currentAvatarId = profileRows[0]?.rpg_avatar_id || null;
    const coins = profileRows[0]?.coins ?? 0;
    res.json({
      eligible: true,
      role: membership ? membership.role : 'player',
      school_name: membership ? membership.school_name : null,
      current_avatar_id: currentAvatarId,
      coins,
      avatar_switch_cost: RPG_AVATAR_SWITCH_COST,
      available: getAvatarManifest(),
    });
  } catch (err) {
    console.error('[RPG] GET /api/rpg/avatar error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

app.patch('/api/rpg/avatar', async (req, res) => {
  if (!coinApiReady()) return respondCoinApiDisabled(res);
  const user = await requireSupabaseUser(req, res);
  if (!user) return;
  try {
    // Permisívne: avatar môže zmeniť každý prihlásený (nevyžadujeme EDU členstvo).
    // Rate limit: 10 avatar changes per 15 minutes per user
    if (!rpgRateLimit(user.id, 10, 15 * 60 * 1000)) {
      return res.status(429).json({ error: 'Príliš veľa zmien avatara. Skúste neskôr.' });
    }
    const { avatar_id } = req.body || {};
    if (!isValidAvatarId(avatar_id)) {
      return res.status(400).json({ error: `Neplatný avatar. Povolené: ${VALID_AVATAR_IDS.join(', ')} alebo null` });
    }

    const client = await coinsDbPool.connect();
    try {
      await client.query('BEGIN');

      const { rows: profileRows } = await client.query(
        `SELECT COALESCE(coins, 0)::int AS coins, rpg_avatar_id FROM public.profiles WHERE id = $1 FOR UPDATE`,
        [user.id]
      );
      const profile = profileRows[0];
      if (!profile) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Profil nenájdený' });
      }

      let coins = profile.coins;
      const cur = profile.rpg_avatar_id;

      // Deselect (null) — free
      if (avatar_id === null) {
        await client.query(
          `UPDATE public.profiles SET rpg_avatar_id = NULL, updated_at = now() WHERE id = $1`,
          [user.id]
        );
        await client.query('COMMIT');
        return res.json({
          ok: true,
          avatar_id: null,
          coins_remaining: coins,
          cost_paid: 0,
        });
      }

      // Same avatar — no charge
      if (avatar_id === cur) {
        await client.query('COMMIT');
        return res.json({
          ok: true,
          avatar_id,
          coins_remaining: coins,
          cost_paid: 0,
        });
      }

      // Switch / first pick — charge RPG_AVATAR_SWITCH_COST
      if (coins < RPG_AVATAR_SWITCH_COST) {
        await client.query('ROLLBACK');
        return res.status(402).json({
          error: `Nedostatok coinov. Zmena avatara stojí ${RPG_AVATAR_SWITCH_COST} gIVEMECOIN.`,
          code: 'INSUFFICIENT_COINS',
          required: RPG_AVATAR_SWITCH_COST,
          coins,
        });
      }

      const newBal = coins - RPG_AVATAR_SWITCH_COST;
      await client.query(
        `UPDATE public.profiles SET rpg_avatar_id = $1, coins = $2, updated_at = now() WHERE id = $3`,
        [avatar_id, newBal, user.id]
      );
      await client.query(
        `INSERT INTO public.coin_transactions (user_id, amount, action, metadata)
         VALUES ($1, $2, 'rpg_avatar_change', $3)`,
        [user.id, -RPG_AVATAR_SWITCH_COST, JSON.stringify({ to: avatar_id, from: cur })]
      );

      await client.query('COMMIT');
      res.json({
        ok: true,
        avatar_id,
        coins_remaining: newBal,
        cost_paid: RPG_AVATAR_SWITCH_COST,
      });
    } catch (txErr) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw txErr;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[RPG] PATCH /api/rpg/avatar error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// _rpgAvatarBuckets is module-scoped. Rate limit tested via HTTP 429 response.

// ─── RPG Talent Tree API ────────────────────────────────────────────────────

// GET /api/rpg/talents
// Returns the full talent manifest for the user's current avatar class
// plus their already-unlocked talent IDs and current coin balance.
app.get('/api/rpg/talents', async (req, res) => {
  if (!coinApiReady()) return respondCoinApiDisabled(res);
  const user = await requireSupabaseUser(req, res);
  if (!user) return;
  try {
    const membership = await _rpgGetMembership(user.id);
    // Return manifest even for non-members so CTA renders; class_id = null signals no avatar
    const { rows: profileRows } = await queryCoinsDb(
      `SELECT COALESCE(coins, 0) AS coins, rpg_avatar_id, COALESCE(rpg_xp, 0) AS rpg_xp
         FROM public.profiles WHERE id = $1`,
      [user.id]
    );
    const profile = profileRows[0] || {};
    const class_id = membership ? (profile.rpg_avatar_id || null) : null;
    const avatarEntry = class_id ? getAvatarById(class_id) : null;
    const avatar_meta = avatarEntry
      ? {
          theme: avatarEntry.theme,
          flavor: avatarEntry.flavor,
          label: avatarEntry.label,
        }
      : null;

    // Fetch unlocked talent IDs for this user
    const { rows: unlockedRows } = await queryCoinsDb(
      `SELECT talent_id FROM public.rpg_user_talents WHERE user_id = $1`,
      [user.id]
    );
    const unlocked = unlockedRows.map(r => r.talent_id);

    // Compute RPG progression and effective stats from unlocked talents
    const tier = await getEffectiveTier(coinsDbPool, user.id).catch(() => 'free');
    const progression = applyLevelCap(computeRpgLevel(profile.rpg_xp || 0), tier);
    const talentManifest = getTalentManifest();
    const unlockedTalents = unlocked
      .map(id => talentManifest.find(t => t.id === id))
      .filter(Boolean);
    const stats = getEffectiveStats(class_id, unlockedTalents);

    res.json({
      eligible:    true,
      class_id,
      role:        membership?.role        || 'player',
      school_name: membership?.school_name || null,
      coins:       profile.coins || 0,
      avatar_meta,
      avatar_switch_cost: RPG_AVATAR_SWITCH_COST,
      talents:     talentManifest,
      unlocked,
      progression,
      stats,
    });
  } catch (err) {
    console.error('[RPG] GET /api/rpg/talents error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/rpg/talents/unlock
// Atomically deducts coins and records the talent unlock.
app.post('/api/rpg/talents/unlock', async (req, res) => {
  if (!coinApiReady()) return respondCoinApiDisabled(res);
  const user = await requireSupabaseUser(req, res);
  if (!user) return;
  try {
    const membership = await _rpgGetMembership(user.id);
    if (!membership) {
      return res.status(403).json({ error: 'Musíš byť členom školy.' });
    }

    const { talent_id } = req.body || {};
    const talentId = parseInt(talent_id, 10);
    const talent = getTalentById(talentId);
    if (!talent) {
      return res.status(400).json({ error: 'Neplatný talent_id' });
    }

    // Open a dedicated client for the transaction
    const client = await coinsDbPool.connect();
    try {
      await client.query('BEGIN');

      // Lock the profile row to serialize concurrent unlock requests
      const { rows: profileRows } = await client.query(
        `SELECT COALESCE(coins, 0) AS coins, rpg_avatar_id FROM public.profiles WHERE id = $1 FOR UPDATE`,
        [user.id]
      );
      const profile = profileRows[0];
      if (!profile) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Profil nenájdený' });
      }

      // Must have the correct avatar class
      if (profile.rpg_avatar_id !== talent.class_id) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Tento talent patrí inej triede avatara.' });
      }

      // Already unlocked?
      const { rows: existingRows } = await client.query(
        `SELECT 1 FROM public.rpg_user_talents WHERE user_id = $1 AND talent_id = $2`,
        [user.id, talentId]
      );
      if (existingRows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Talent je už odomknutý.' });
      }

      // Prerequisite check (read unlocked list inside transaction)
      const { rows: unlockedRows } = await client.query(
        `SELECT talent_id FROM public.rpg_user_talents WHERE user_id = $1`,
        [user.id]
      );
      const unlockedIds = unlockedRows.map(r => r.talent_id);
      const prereq = validatePrerequisite(talentId, unlockedIds);
      if (!prereq.ok) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: prereq.reason });
      }

      // Affordable?
      if (profile.coins < talent.coin_cost) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Nedostatok coinov. Potrebuješ ${talent.coin_cost}, máš ${profile.coins}.` });
      }

      // 1) Deduct coins
      const { rows: updatedProfile } = await client.query(
        `UPDATE public.profiles SET coins = coins - $1, updated_at = now()
         WHERE id = $2 RETURNING COALESCE(coins, 0) AS coins`,
        [talent.coin_cost, user.id]
      );

      // 2) Log coin transaction
      await client.query(
        `INSERT INTO public.coin_transactions (user_id, amount, action, metadata)
         VALUES ($1, $2, 'talent_unlock', $3)`,
        [user.id, -talent.coin_cost, JSON.stringify({ talent_id: talentId, talent_name: talent.name })]
      );

      // 3) Record unlock (UNIQUE constraint provides idempotency)
      await client.query(
        `INSERT INTO public.rpg_user_talents (user_id, talent_id) VALUES ($1, $2)`,
        [user.id, talentId]
      );

      // 4) Award RPG XP (idempotent: rpg_user_talents UNIQUE prevents double unlock)
      const { rpg_xp, level: rpg_level } = await awardXpInTransaction(
        client, user.id, TALENT_XP_AWARD, `talent_unlock:${talentId}`
      );

      await client.query('COMMIT');

      res.json({
        ok: true,
        talent_id: talentId,
        coins_remaining: updatedProfile[0]?.coins ?? (profile.coins - talent.coin_cost),
        rpg_xp_gained: TALENT_XP_AWARD,
        rpg_xp,
        rpg_level,
      });
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[RPG] POST /api/rpg/talents/unlock error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// Level-based IRL perks (see migration 025)
// Student side: list perks with unlock/cooldown status, claim a perk.
// Teacher side: see pending requests in own school, approve/reject.
// ═══════════════════════════════════════════════════════════════════

async function getUserSchoolMembership(userId) {
	try {
		const { rows } = await queryCoinsDb(
			`SELECT school_id, role FROM public.edu_school_memberships
			 WHERE user_id = $1 AND archived_at IS NULL
			 ORDER BY joined_at ASC LIMIT 1`,
			[userId]
		);
		return rows[0] || null;
	} catch { return null; }
}

// GET /api/rpg/perks — list perks with per-user unlock + cooldown status
app.get('/api/rpg/perks', async (req, res) => {
	if (!coinApiReady()) return respondCoinApiDisabled(res);
	const user = await requireSupabaseUser(req, res);
	if (!user) return;

	try {
		const { rows: profRows } = await queryCoinsDb(
			'SELECT COALESCE(rpg_xp, 0)::int AS rpg_xp FROM public.profiles WHERE id = $1', [user.id]
		);
		const tier = await getEffectiveTier(coinsDbPool, user.id).catch(() => 'free');
		const { level } = applyLevelCap(computeRpgLevel(profRows[0]?.rpg_xp || 0), tier);

		const { rows: perks } = await queryCoinsDb(
			`SELECT level, perk_key, icon, title, description, cooldown_hours, duration_minutes
			 FROM public.rpg_level_perks ORDER BY level ASC`
		);

		const { rows: recentUses } = await queryCoinsDb(
			`SELECT DISTINCT ON (perk_key) perk_key, status, claimed_at, decided_at, teacher_note
			 FROM public.rpg_perk_uses
			 WHERE user_id = $1 AND status IN ('pending','approved','auto_approved')
			 ORDER BY perk_key, claimed_at DESC`,
			[user.id]
		);
		const useByKey = Object.fromEntries(recentUses.map(u => [u.perk_key, u]));

		const now = Date.now();
		const items = perks.map(p => {
			const u = useByKey[p.perk_key];
			let cooldownLeftMs = 0;
			if (u && (u.status === 'approved' || u.status === 'auto_approved')) {
				const base = new Date(u.decided_at || u.claimed_at).getTime();
				cooldownLeftMs = Math.max(0, base + p.cooldown_hours * 3600000 - now);
			}
			return {
				level: p.level,
				perk_key: p.perk_key,
				icon: p.icon,
				title: p.title,
				description: p.description,
				cooldown_hours: p.cooldown_hours,
				duration_minutes: p.duration_minutes,
				unlocked: level >= p.level,
				pending: u?.status === 'pending',
				cooldown_left_ms: cooldownLeftMs,
				last_used_at: u?.decided_at || u?.claimed_at || null,
				teacher_note: u?.teacher_note || null,
			};
		});

		res.json({ user_level: level, perks: items });
	} catch (err) {
		console.error('[Perks] GET failed:', err.message);
		res.status(500).json({ error: 'Nepodarilo sa načítať odmeny', code: 'PERKS_FETCH_ERROR' });
	}
});

// POST /api/rpg/perks/:key/use — student claims a perk
app.post('/api/rpg/perks/:key/use', async (req, res) => {
	if (!coinApiReady()) return respondCoinApiDisabled(res);
	const user = await requireSupabaseUser(req, res);
	if (!user) return;

	const perkKey = String(req.params.key || '').trim();
	if (!perkKey) return res.status(400).json({ error: 'Chýba perk_key', code: 'MISSING_KEY' });

	try {
		const { rows: perkRows } = await queryCoinsDb(
			`SELECT level, perk_key, title, cooldown_hours FROM public.rpg_level_perks WHERE perk_key = $1`,
			[perkKey]
		);
		if (!perkRows.length) return res.status(404).json({ error: 'Perk neexistuje', code: 'PERK_NOT_FOUND' });
		const perk = perkRows[0];

		const { rows: profRows } = await queryCoinsDb(
			'SELECT COALESCE(rpg_xp, 0)::int AS rpg_xp FROM public.profiles WHERE id = $1', [user.id]
		);
		const tier = await getEffectiveTier(coinsDbPool, user.id).catch(() => 'free');
		const { level } = applyLevelCap(computeRpgLevel(profRows[0]?.rpg_xp || 0), tier);
		if (level < perk.level) {
			return res.status(403).json({
				error: `Perk sa odomkne na leveli ${perk.level}. Máš ${level}.`,
				code: 'LEVEL_TOO_LOW'
			});
		}

		// Block if there's already a pending request OR active cooldown
		const { rows: existing } = await queryCoinsDb(
			`SELECT status, claimed_at, decided_at
			 FROM public.rpg_perk_uses
			 WHERE user_id = $1 AND perk_key = $2
			 ORDER BY claimed_at DESC LIMIT 1`,
			[user.id, perkKey]
		);
		if (existing.length) {
			const last = existing[0];
			if (last.status === 'pending') {
				return res.status(409).json({
					error: 'Žiadosť o tento perk ešte čaká na učiteľa.',
					code: 'ALREADY_PENDING'
				});
			}
			if (last.status === 'approved' || last.status === 'auto_approved') {
				const base = new Date(last.decided_at || last.claimed_at).getTime();
				const left = base + perk.cooldown_hours * 3600000 - Date.now();
				if (left > 0) {
					return res.status(429).json({
						error: `Cooldown beží — skús to znova za ${Math.ceil(left / 3600000)} h.`,
						code: 'COOLDOWN_ACTIVE',
						cooldown_left_ms: left
					});
				}
			}
		}

		const membership = await getUserSchoolMembership(user.id);
		const inEduSchool = !!membership && membership.role === 'student';
		const initialStatus = inEduSchool ? 'pending' : 'auto_approved';
		const schoolId = membership?.school_id || null;

		const { rows: insRows } = await queryCoinsDb(
			`INSERT INTO public.rpg_perk_uses (user_id, perk_key, status, school_id, decided_at)
			 VALUES ($1, $2, $3, $4, CASE WHEN $3 = 'auto_approved' THEN now() ELSE NULL END)
			 RETURNING id, status, claimed_at, decided_at`,
			[user.id, perkKey, initialStatus, schoolId]
		);

		res.json({
			ok: true,
			claim_id: insRows[0].id,
			status: insRows[0].status,
			needs_approval: initialStatus === 'pending',
			perk_title: perk.title
		});
	} catch (err) {
		// M6: the partial unique index (migration 036) rejects a second
		// pending claim that raced past the check above.
		if (err.code === '23505') {
			return res.status(409).json({
				error: 'Žiadosť o tento perk ešte čaká na učiteľa.',
				code: 'ALREADY_PENDING'
			});
		}
		console.error('[Perks] POST use failed:', err.message);
		res.status(500).json({ error: 'Nepodarilo sa uplatniť perk', code: 'PERK_USE_ERROR' });
	}
});

// GET /api/edu/perk-requests — teachers see pending claims from their school
app.get('/api/edu/perk-requests', async (req, res) => {
	if (!coinApiReady()) return respondCoinApiDisabled(res);
	const user = await requireSupabaseUser(req, res);
	if (!user) return;

	try {
		const membership = await getUserSchoolMembership(user.id);
		if (!membership || !['teacher', 'admin'].includes(membership.role)) {
			return res.status(403).json({ error: 'Len učiteľ/admin môže vidieť žiadosti', code: 'NOT_TEACHER' });
		}

		const { rows } = await queryCoinsDb(
			`SELECT pu.id, pu.user_id, pu.perk_key, pu.claimed_at, pu.status,
			        p.title AS perk_title, p.icon AS perk_icon, p.description AS perk_description,
			        p.duration_minutes, p.level AS perk_level,
			        pr.display_name AS student_name, pr.email AS student_email
			 FROM public.rpg_perk_uses pu
			 JOIN public.rpg_level_perks p ON p.perk_key = pu.perk_key
			 LEFT JOIN public.profiles pr ON pr.id = pu.user_id
			 WHERE pu.school_id = $1 AND pu.status = 'pending'
			 ORDER BY pu.claimed_at ASC`,
			[membership.school_id]
		);
		res.json({ requests: rows });
	} catch (err) {
		console.error('[Perks] teacher GET failed:', err.message);
		res.status(500).json({ error: 'Nepodarilo sa načítať žiadosti', code: 'FETCH_ERROR' });
	}
});

// POST /api/edu/perk-requests/:id/decide — teacher approves or rejects
app.post('/api/edu/perk-requests/:id/decide', async (req, res) => {
	if (!coinApiReady()) return respondCoinApiDisabled(res);
	const user = await requireSupabaseUser(req, res);
	if (!user) return;

	const claimId = String(req.params.id || '').trim();
	const { decision, note } = req.body || {};
	if (!['approve', 'reject'].includes(decision)) {
		return res.status(400).json({ error: 'decision musí byť approve alebo reject', code: 'BAD_DECISION' });
	}
	const teacherNote = typeof note === 'string' ? note.slice(0, 300) : null;

	try {
		const membership = await getUserSchoolMembership(user.id);
		if (!membership || !['teacher', 'admin'].includes(membership.role)) {
			return res.status(403).json({ error: 'Len učiteľ/admin môže rozhodovať', code: 'NOT_TEACHER' });
		}

		const newStatus = decision === 'approve' ? 'approved' : 'rejected';
		const { rows } = await queryCoinsDb(
			`UPDATE public.rpg_perk_uses
			    SET status = $1, decided_by = $2, decided_at = now(), teacher_note = $3
			  WHERE id = $4 AND school_id = $5 AND status = 'pending'
			  RETURNING id, user_id, perk_key, status, decided_at`,
			[newStatus, user.id, teacherNote, claimId, membership.school_id]
		);
		if (!rows.length) {
			return res.status(404).json({ error: 'Žiadosť nenájdená alebo už rozhodnutá', code: 'NOT_FOUND' });
		}
		res.json({ ok: true, claim: rows[0] });
	} catch (err) {
		console.error('[Perks] teacher decide failed:', err.message);
		res.status(500).json({ error: 'Rozhodnutie zlyhalo', code: 'DECIDE_ERROR' });
	}
});

// GET /api/edu/students/:userId/rpg — teacher views a student's RPG profile
// Gated: caller must be teacher/admin in the SAME school as the student.
app.get('/api/edu/students/:userId/rpg', async (req, res) => {
	if (!coinApiReady()) return respondCoinApiDisabled(res);
	const user = await requireSupabaseUser(req, res);
	if (!user) return;

	const studentId = String(req.params.userId || '').trim();
	if (!studentId) return res.status(400).json({ error: 'userId required', code: 'BAD_INPUT' });

	try {
		const membership = await getUserSchoolMembership(user.id);
		if (!membership || !['teacher', 'admin'].includes(membership.role)) {
			return res.status(403).json({ error: 'Len učiteľ/admin', code: 'NOT_TEACHER' });
		}

		const { rows: studentMem } = await queryCoinsDb(
			`SELECT role FROM public.edu_school_memberships
			 WHERE user_id = $1 AND school_id = $2 LIMIT 1`,
			[studentId, membership.school_id]
		);
		if (!studentMem.length) {
			return res.status(404).json({ error: 'Žiak nie je v tvojej škole', code: 'NOT_IN_SCHOOL' });
		}

		const { rows: profRows } = await queryCoinsDb(
			`SELECT COALESCE(rpg_xp,0)::int AS rpg_xp,
			        rpg_avatar_id,
			        COALESCE(games_generated,0)::int AS games_generated,
			        display_name, email, avatar_url
			 FROM public.profiles WHERE id = $1`,
			[studentId]
		);
		const prof = profRows[0] || {};
		const progression = computeRpgLevel(prof.rpg_xp || 0);

		const { rows: talentRows } = await queryCoinsDb(
			`SELECT talent_id FROM public.rpg_user_talents WHERE user_id = $1`, [studentId]
		);
		const unlocked = talentRows.map(r => r.talent_id);
		const talentManifest = getTalentManifest();
		const unlockedTalents = unlocked.map(id => talentManifest.find(t => t.id === id)).filter(Boolean);
		const stats = getEffectiveStats(prof.rpg_avatar_id || null, unlockedTalents);

		const { rows: perkRows } = await queryCoinsDb(
			`SELECT p.level, p.perk_key, p.icon, p.title, p.description,
			        (p.level <= $2) AS unlocked,
			        (SELECT status FROM public.rpg_perk_uses
			           WHERE user_id = $1 AND perk_key = p.perk_key
			           ORDER BY claimed_at DESC LIMIT 1) AS last_status,
			        (SELECT claimed_at FROM public.rpg_perk_uses
			           WHERE user_id = $1 AND perk_key = p.perk_key
			           ORDER BY claimed_at DESC LIMIT 1) AS last_claimed_at
			 FROM public.rpg_level_perks p ORDER BY p.level ASC`,
			[studentId, progression.level]
		);

		res.json({
			student: {
				id: studentId,
				display_name: prof.display_name,
				email: prof.email,
				avatar_url: prof.avatar_url,
				class_id: prof.rpg_avatar_id || null,
				games_generated: prof.games_generated || 0
			},
			progression,
			stats,
			talents: unlockedTalents.map(t => ({ id: t.id, title: t.title, branch: t.branch })),
			perks: perkRows
		});
	} catch (err) {
		console.error('[EDU] student RPG fetch failed:', err.message);
		res.status(500).json({ error: 'Načítanie zlyhalo', code: 'FETCH_ERROR' });
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

	let smartaPaid = false;
	try {
		const u = await optionalSupabaseUser(req);
		if (u && coinsDbPool) {
			const st = await getUserBillingState(coinsDbPool, u.id);
			smartaPaid = hasPaidAccess(st);
		}
	} catch (e) {
		console.warn('[API] random-fact billing:', e.message);
	}

	if (!hasKey) {
		const fact = getRandomLocalFact(lang);
		console.log('[API] random-fact: no API key, local fact');
		return res.json({ fact, source: 'local' });
	}

	// Free / neprihlásený: len lokálne fakty (OpenAI Smarta = Pro)
	if (!smartaPaid) {
		const fact = getRandomLocalFact(lang);
		return res.json({
			fact,
			source: 'local',
			planGate: 'smarta_pro_only',
			hint: 'AI Smarta (OpenAI) je v pláne Pro učiteľ — tu je lokálna zaujímavosť; hlas cez Web Speech.'
		});
	}

	// OpenAI API — GPT-5.4 (Chat) pre generovanie, TTS pre čítanie
	if (!openai) openai = createOpenAIClient(effectiveKey);
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
			const langMap = { sk: 'Slovak', cs: 'Czech', de: 'German', en: 'English', es: 'Spanish', tr: 'Turkish' };
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
	const ttsUser = await optionalSupabaseUser(req);
	if (!ttsUser) {
		return res.status(401).json({
			error: 'OpenAI TTS vyžaduje prihlásenie. Prihlás sa cez Google alebo použi Web Speech.',
			code: 'AUTH_REQUIRED_TTS'
		});
	}
	if (coinsDbPool) {
		try {
			const st = await getUserBillingState(coinsDbPool, ttsUser.id);
			if (!hasPaidAccess(st)) {
				return res.status(403).json({
					error: 'OpenAI hlas (TTS) je len v pláne Pro učiteľ. Použi Web Speech v prehliadači.',
					code: 'PLAN_TTS_PRO_ONLY'
				});
			}
		} catch (e) {
			console.warn('[TTS] billing check:', e.message);
			return res.status(503).json({ error: 'Nepodarilo sa overiť plán', code: 'BILLING_ERROR' });
		}
	}

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
			signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
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
// Cheap DB liveness probe: SELECT 1, 2 s timeout, cached 30 s. Reports only
// 'ok' | 'down' | 'disabled' — never connection details.
const dbHealthProbe = coinsDbPool
	? createCachedProbe({ probe: () => coinsDbPool.query('SELECT 1'), ttlMs: 30000, timeoutMs: 2000 })
	: null;

app.get('/api/status', async (req, res) => {
	const hasKey = !!(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'sk-your-openai-api-key-here');
	const db = dbHealthProbe ? await dbHealthProbe() : 'disabled';
	res.json({
		status: 'ok',
		db,
		hasApiKey: hasKey,
		model: process.env.OPENAI_MODEL || 'gpt-4o',
		engine: openai ? 'ai' : 'local',
		randomFactSource: hasKey ? 'openai' : 'local',
		verificationPhotoBonus: {
			xp: VERIFICATION_XP_BONUS,
			coins: VERIFICATION_COIN_BONUS
		},
		knowledge: {
			fileCount: knowledgeCache.length,
			totalChars: knowledgeSummary.length
		}
	});
});

// ─── App chooser page ───
app.get('/choose.html', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'choose.html')));

// ─── gIVEMEEDU frontend pages ───
app.get('/student', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'student', 'index.html')));
app.get('/student/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'student', 'index.html')));
app.get('/edu', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'edu', 'index.html')));
app.get('/edu/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'edu', 'index.html')));
app.get('/edu/index.html', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'edu', 'index.html')));
app.get('/edu/classes.html', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'edu', 'classes.html')));
app.get('/edu/gradebook.html', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'edu', 'gradebook.html')));
app.get('/edu/attendance.html', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'edu', 'attendance.html')));
app.get('/edu/members.html', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'edu', 'members.html')));

// ─── INVOK institution dashboard ───
app.get('/institution', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'institution', 'index.html')));
app.get('/institution/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'institution', 'index.html')));

// ─── Shareable game page — serves game.html for any valid UUID path ───
app.get('/game/:id', (req, res) => {
	const { id } = req.params;
	if (!id || !/^[0-9a-f-]{36}$/.test(id)) {
		return res.status(404).send('Not found');
	}
	res.sendFile(path.join(PUBLIC_DIR, 'game.html'));
});

// ─── Statický file serving (po API route, aby /api/* fungovalo) ───
// HTML always revalidates; versioned assets (?v=N) are cached for 1 h.
app.use(express.static(PUBLIC_DIR, {
	setHeaders(res, filePath) {
		const cc = cacheControlForPath(filePath);
		if (cc) res.setHeader('Cache-Control', cc);
	}
}));

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
