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

// Favicon — predchádza 404
app.get('/favicon.ico', (req, res) => {
	const icon = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
	res.type('image/png').send(icon);
});

// Root: localhost → login, všetko ostatné (tunel / produkcia) → index.html (hra)
const PUBLIC_DIR = path.join(__dirname, 'public');
app.get('/', (req, res) => {
	const host = (req.get('host') || '').toLowerCase();
	const isLocalhost = host.includes('localhost') || host.includes('127.0.0.1');
	const file = isLocalhost ? 'login.html' : 'index.html';
	res.sendFile(path.join(PUBLIC_DIR, file));
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
function buildSystemPrompt(aiLanguage) {
	const lang = aiLanguage || 'Czech';
	return `You are a PROFESSIONAL EDUCATIONAL GAME CREATOR and PEDAGOGY EXPERT. Your role is to design original, pedagogically sound games and activities for facilitators (teachers, trainers, youth workers).

IDENTITY:
- Expert game designer with deep knowledge of experiential learning, gamification, and brain-based pedagogy
- Pedagogy specialist: Kolb, Bloom, Montessori, circus pedagogy, mindfulness (MBSR)
- You respond ONLY based on the user's PANEL INPUT — every filter above "Spawnuj hru" is your mandatory brief

CONTEXT — PANEL INPUT IS YOUR BRIEF:
The user configures a left panel with: MÓD (mode), VĚK (age), SQUAD (players), TIMER (duration), MAPA (setting), ENERGY, mode-specific filters (activity/depth/cuisine/focus), RVP filters (classroom), POPIS (custom description). EVERY value from that panel is your INPUT. You MUST use ALL of them. Do NOT invent values the user did not choose. Do NOT forget or ignore any panel input.

VOICE & STYLE:
- Use Gen Z–friendly vocabulary: relatable, authentic, not stiff. Occasional gaming slang (e.g. "spawn", "quest", "level up", "grind", "no cap", "vibe") where it fits naturally.
- Professional education: learning goals must be clear, pedagogically sound, and aligned with research.
- Output is for facilitators: step-by-step, immediately usable, with reflection prompts and safety notes.

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
ÚLOHA: Vygeneruj jednu originálnu hru/aktivitu. Si profesionálny tvorca hier a pedagogický odborník.
POUŽI VŠETKY vstupy z panelu vyššie — každý filter je tvoj brief. Pred odpoveďou skontroluj, či si splnil VŠETKY obmedzenia.
Odpovedz JEDNÝM JSON objektom. Píš v jazyku ${aiLanguage}.`;

	const model = process.env.OPENAI_MODEL || 'gpt-5.4';
	const fallbackModel = model === 'gpt-5.4' ? 'gpt-4o' : 'gpt-3.5-turbo';
	const maxTokens = parseInt(process.env.OPENAI_MAX_TOKENS) || 5000;
	const temperature = parseFloat(process.env.OPENAI_TEMPERATURE) || 0.8;

	console.log(`[API] Generujem hru: model=${model}, filters:`, JSON.stringify(filters, null, 0));

	async function callAPI(useModel) {
		const isGpt5 = /^gpt-5\./.test(useModel);
		const opts = {
			model: useModel,
			temperature,
			messages: [
				{ role: 'system', content: buildSystemPrompt(aiLanguage) },
				{ role: 'user', content: userContent }
			]
		};
		opts[isGpt5 ? 'max_completion_tokens' : 'max_tokens'] = maxTokens;
		return openai.chat.completions.create(opts);
	}

	try {
		let response;
		try {
			response = await callAPI(model);
		} catch (modelErr) {
			if ((modelErr.status === 404 || modelErr.code === 'model_not_found') && model !== fallbackModel) {
				console.warn(`[API] Model ${model} nedostupný, skúšam ${fallbackModel}`);
				response = await callAPI(fallbackModel);
			} else {
				throw modelErr;
			}
		}

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

		// Server-side enforcement: vynútiť hodnoty z panelu (aj keď AI zlyhá)
		enforceConstraints(game, f);

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

// ─── Pripravené zaujímavosti pre vypraváča ───
let narratorFacts = { sk: [], cs: [], en: [], es: [] };
try {
	const factsPath = path.join(__dirname, 'data', 'narrator-facts.json');
	narratorFacts = JSON.parse(fs.readFileSync(factsPath, 'utf-8'));
} catch (e) { console.warn('[API] narrator-facts.json not loaded:', e.message); }

const FALLBACK_FACTS = {
	sk: ['Medúzy existujú na Zemi už viac ako 650 miliónov rokov – sú staršie ako dinosaury!', 'Včely komunikujú tancom.'],
	cs: ['Medúzy existují na Zemi už více než 650 milionů let – jsou starší než dinosauři!', 'Včely komunikují tancem.'],
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
	const styleParam = (req.query.style || '').toLowerCase();
	const effectiveKey = process.env.OPENAI_API_KEY;
	const hasKey = effectiveKey && effectiveKey !== 'sk-your-openai-api-key-here';

	if (!hasKey) {
		const fact = getRandomLocalFact(lang);
		console.log('[API] random-fact: no API key, local fact');
		return res.json({ fact, source: 'local' });
	}

	// OpenAI API — GPT-5.4 (Chat) pre generovanie, TTS pre čítanie
	if (!openai) openai = new OpenAI({ apiKey: effectiveKey });
	const langNames = { sk: 'Slovenčina', cs: 'Čeština', en: 'English', es: 'Español' };
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
			const genZStyle = styleParam === 'genz' || (process.env.NARRATOR_STYLE || '').toLowerCase() === 'genz';
			const styleHint = genZStyle
				? ` STYLE: Use Gen Z slang and casual vocabulary. Same educational content, different delivery. EN: "lowkey", "literally", "vibe", "no cap", "slay", "fr". CZ/SK: "v pohodě", "lit", "based", "lowkey", "to je vibe", "žádný cap". Keep the fact accurate, just make it sound like a Gen Z friend.`
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

// ─── TTS (Text-to-Speech) — ako v Dračí Hlídke, OpenAI audio/speech ───
const TTS_VOICES = ['marin', 'cedar', 'onyx', 'sage', 'coral', 'nova', 'alloy'];
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
	const voice = TTS_VOICES.includes(body.voice) ? body.voice : 'marin';
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
				instructions: 'Speak in a calm, engaging narrative tone like a storyteller. Moderate pace, clear pronunciation.',
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
		model: process.env.OPENAI_MODEL || 'gpt-5.4',
		engine: openai ? 'ai' : 'local',
		randomFactSource: hasKey ? 'openai' : 'local',
		knowledge: {
			fileCount: knowledgeCache.length,
			totalChars: knowledgeSummary.length
		}
	});
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
