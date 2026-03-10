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

const app = express();
app.use(cors());
app.use(express.json());

// Redirect root to login page (MUST be before static middleware)
app.get('/', (req, res) => {
	res.sendFile(path.join(__dirname, 'login.html'));
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
		fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true });
		console.log('[Knowledge] Priečinok "source of knowledge" vytvorený.');
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
// Load on startup + watch for changes
loadKnowledgeBase();
fs.watch(KNOWLEDGE_DIR, { persistent: false }, () => {
	console.log('[Knowledge] Zmena detekovaná — reloadujem...');
	setTimeout(loadKnowledgeBase, 500); // debounce
});

// ─── Statický file serving ───
app.use(express.static(path.join(__dirname)));

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
let sampleGameJSON = '';
try {
	const games = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'games.json'), 'utf-8'));
	if (games.length > 0) {
		sampleGameJSON = JSON.stringify(games[0], null, 2);
	}
} catch (err) {
	console.warn('[Server] Nepodarilo sa načítať vzorový game:', err.message);
}

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

	// ── Facilitator description / custom instructions ──
	if (filters.description && filters.description.trim()) {
		constraints.push(`FACILITATOR NOTE — the person creating this activity wrote the following custom instructions. You MUST incorporate this into the game design:\n"${filters.description.trim()}"\nAdapt these notes using sound pedagogical approaches. Make the game attractive for Gen Z — gamified, authentic, relatable. Do NOT just copy the text literally; weave it creatively into the activity design.`);
	}

	return constraints.join('\n');
}

// ─── Systémový prompt ───
function buildSystemPrompt(aiLanguage) {
	const lang = aiLanguage || 'Czech';
	return `You are an intelligent educational game & activity generator.
You create games for school settings, team building, reflection, cooking, meditation, and fun.

RULES:
- Generate ONE UNIQUE, ORIGINAL game — do not recreate well-known games.
- The game must be practical, immediately playable, and described in detail.
- Instructions must be clear, step-by-step, so a facilitator can use them right away.
- Materials must be commonly available (paper, ball, markers...).
- Always include reflection prompts and safety notes.
- If mode is "classroom", include full RVP ZV mapping (competences, areas, cross-topics).
- If mode is "cooking", the game MUST be a cooking/recipe activity.
- If mode is "meditation", the game MUST be a mindfulness/wellness exercise.
- Respond ONLY with a valid JSON object — no markdown, no comments.
- WRITE EVERYTHING IN ${lang.toUpperCase()}.

CRITICAL — CONSTRAINT COMPLIANCE:
The user specifies MANDATORY constraints below. You MUST satisfy ALL of them.
Before outputting JSON, mentally verify:
✓ playerCount.min and playerCount.max fall within the specified player range
✓ duration.min and duration.max fall within the specified time range
✓ setting matches the specified environment (indoor/outdoor)
✓ mode matches the specified mode
✓ The game's THEME and AESTHETIC match the mode (circus=circus theme, cooking=food theme, etc.)
✓ If activity is "solo", playerCount MUST be {min:1, max:1}
If ANY constraint fails, regenerate before responding.

RESPONSE FORMAT — exactly this JSON shape:
${sampleGameJSON}

IMPORTANT: Generate "id" as "ai-" + random 6-character code. All fields are required.${knowledgeSummary ? `

═══ SOURCE OF KNOWLEDGE ═══
The following reference material was uploaded by the facilitator. Use it to ENRICH and CUSTOMIZE the generated game.
Draw from these files for themes, vocabulary, facts, scenarios, or rules — but always respect the MANDATORY CONSTRAINTS above.

${knowledgeSummary}
═══ END SOURCE OF KNOWLEDGE ═══` : ''}`;
}

// ─── API endpoint ───
app.post('/api/generate-game', async (req, res) => {
	const { filters } = req.body;

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

	const filterDescription = buildFilterDescription(filters || {});
	const aiLanguage = (filters && filters.aiLanguage) || 'Czech';
	const model = process.env.OPENAI_MODEL || 'gpt-5-mini';
	const maxTokens = parseInt(process.env.OPENAI_MAX_TOKENS) || 5000;
	const temperature = parseFloat(process.env.OPENAI_TEMPERATURE) || 0.8;

	console.log(`[API] Generujem hru: model=${model}, filters:`, filters);

	try {
		const response = await openai.chat.completions.create({
			model,
			max_tokens: maxTokens,
			temperature,
			messages: [
				{ role: 'system', content: buildSystemPrompt(aiLanguage) },
				{
					role: 'user',
					content: `Generate one original game/activity. You MUST satisfy ALL of the following MANDATORY CONSTRAINTS:\n\n${filterDescription}\n\nRespond with ONE JSON object. Write all content in ${aiLanguage}. Double-check every constraint before responding.`
				}
			]
		});

		const content = response.choices[0]?.message?.content;
		if (!content) {
			throw new Error('Prázdna odpoveď z OpenAI');
		}

		// Parsovanie JSON z odpovede (očistíme prípadný markdown wrapper)
		let gameJSON = content.trim();
		if (gameJSON.startsWith('```')) {
			gameJSON = gameJSON.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
		}

		const game = JSON.parse(gameJSON);

		console.log(`[API] Hra vygenerovaná: "${game.title}"`);

		// Pridáme metadata
		game._engine = 'ai';
		game._model = model;
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
			return res.status(502).json({ error: 'AI vrátilo neplatný JSON. Skúste znova.', code: 'PARSE_ERROR' });
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

// ─── Status endpoint ───
app.get('/api/status', (req, res) => {
	res.json({
		status: 'ok',
		hasApiKey: !!(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'sk-your-openai-api-key-here'),
		model: process.env.OPENAI_MODEL || 'gpt-5-mini',
		engine: openai ? 'ai' : 'local',
		knowledge: {
			fileCount: knowledgeCache.length,
			totalChars: knowledgeSummary.length
		}
	});
});

// ─── Spustenie servera ───
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
	console.log(`\n╔════════════════════════════════════════╗`);
	console.log(`║  gIVEMEGAME.IO server bežiaci         ║`);
	console.log(`║  http://localhost:${PORT}                 ║`);
	console.log(`║  API: /api/generate-game               ║`);
	console.log(`║  OpenAI: ${openai ? '✅ pripojené' : '❌ nie je kľúč'}               ║`);
	console.log(`╚════════════════════════════════════════╝\n`);
});
