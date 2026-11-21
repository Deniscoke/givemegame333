'use strict';

/**
 * gIVEMEGAME.IO — prompt building, output validation and constraint
 * enforcement for POST /api/generate-game.
 *
 * Pure functions (no OpenAI / DB access) so they can be snapshot-tested.
 * All preset ranges come from lib/filter-presets.js; the methodology
 * catalogue from lib/methodologies.js.
 */

const {
	STUPNE,
	getDuration,
	getSquad,
	resolveDurationKey,
	normalizeAgeRange,
	stupenForAge,
	isMode
} = require('./filter-presets');
const { selectMethodologies, buildMethodologyCatalogue } = require('./methodologies');

// Compact schema for AI format reference. Field names + types are enough —
// sample values add noise, not signal. Game Pack fields (playerBrief,
// lessonFlow) are requested so AI games stop arriving with them empty.
const COMPACT_GAME_SCHEMA = `{"id":"ai-XXXXXX","title":"string","pitch":"string","methodology":"catalogue name(s) used","playerCount":{"min":2,"max":15},"ageRange":{"min":8,"max":15},"duration":{"min":15,"max":25},"setting":"indoor|outdoor|any","mode":"party|classroom|reflection|circus|cooking|meditation|online","energyLevel":"low|medium|high","materials":["string"],"instructions":["string"],"playerBrief":{"goal":"string","rules":["string"],"roles":["string"],"winCondition":"string"},"lessonFlow":[{"phase":"string","minutes":5,"teacherActions":["string"],"studentActions":["string"]}],"learningGoals":["string"],"reflectionPrompts":["string"],"safetyNotes":["string"],"adaptationTips":["string"],"facilitatorNotes":"string","verificationChallenge":{"description":"what to photograph as proof","hint":"short tip for a good photo"},"rvp":{"kompetence":["k-uceni"],"oblasti":["string"],"stupen":"prvni|druhy|stredni","prurezova_temata":["string"],"ocekavane_vystupy":["string"],"doporucene_hodnoceni":"string"}}`;

// ─── Mode tables (single copy) ───
const MODE_THEMES = Object.freeze({
	party: 'THEME: Party / teambuilding game. MUST be high-energy, fun, group-oriented with celebration atmosphere. Think team challenges, laughter, movement, social bonding.',
	classroom: 'THEME: Educational classroom activity tied to curriculum. MUST include clear learning outcomes and structured facilitation. Constructive, focused tone.',
	reflection: 'THEME: Reflective / calm activity. MUST be introspective, emotionally safe, gentle. Think journaling, paired sharing, mindfulness circles.',
	circus: 'THEME: Circus / performance activity. MUST involve circus-inspired mechanics — juggling metaphors, acrobatics, performance, audience, ring, clowning, balance. Activities MUST involve body movement and creativity inspired by circus arts.',
	cooking: 'THEME: Cooking / recipe-based activity. MUST involve food preparation, tasting, nutrition education, or culinary creativity. Kitchen and food themes are MANDATORY.',
	meditation: 'THEME: Mindfulness / meditation exercise. MUST focus on breathing, body awareness, visualization, or gentle yoga. The tone MUST be calm, safe, and health-focused. NO competitive elements.',
	online: 'THEME: Online / remote game played over a video call. MUST be remote-safe: every player joins from their own device and room, uses only camera, microphone, chat or objects found at home, needs no shared physical materials or touch, and survives lag (turn-taking, no split-second timing).'
});

const MODE_DIDACTICS = Object.freeze({
	party: 'Collaborative learning, team-building (Tuckman), playful competition, social bonding. Use ice-breaker mechanics, low stakes, high energy.',
	classroom: 'Structured facilitation, clear learning outcomes, formative assessment. Align with curriculum (RVP). Inquiry where it fits.',
	reflection: 'Reflective practice (Schön), emotional safety, paired/group sharing. Depth levels: light=playful check-ins; medium=guided reflection; deep=safe-space circles, journaling.',
	circus: 'Circus pedagogy: body awareness, risk-taking in safe context, performance as learning. Progressive skill-building, peer feedback.',
	cooking: 'Hands-on experiential learning, sensory engagement, practical life skills. Recipe as scaffold, tasting as assessment.',
	meditation: 'Mindfulness-based approaches (MBSR-inspired), body scan, breath awareness. No competition — contemplative, inclusive.',
	online: 'Remote facilitation: camera-on/camera-off options, chat and reactions as game input, breakout pairs, objects from home ("bring something blue"), clear turn order.'
});

// English labels for the panel summary (keeps the AI from guessing the output language).
const MODE_LABELS = Object.freeze({
	party: 'Party/teambuilding', classroom: 'Classroom/education', reflection: 'Reflection',
	circus: 'Circus', cooking: 'Cooking', meditation: 'Meditation', online: 'Online/remote'
});

const STUPEN_LABELS = Object.freeze({
	prvni: '1st level / grades 1-5 (ages 6-11)',
	druhy: '2nd level / grades 6-9 (ages 11-15)',
	stredni: 'secondary school (ages 15-19)'
});

const ACTIVITY_CONSTRAINTS = Object.freeze({
	solo: 'CONSTRAINT activity: This MUST be a SOLO / individual activity. "playerCount.min" MUST be 1, "playerCount.max" MUST be 1. ONE person plays alone.',
	pair: 'CONSTRAINT activity: This MUST be a PAIR activity. "playerCount.min" MUST be 2, "playerCount.max" MUST be 2.',
	group: 'CONSTRAINT activity: This MUST be a GROUP activity for 3–10 players.',
	mass: 'CONSTRAINT activity: This MUST be a MASS activity for 10+ players.'
});
const ACTIVITY_RANGES = Object.freeze({ solo: [1, 1], pair: [2, 2] });

const KOMPETENCE_KEYS = '[k-uceni, k-reseni-problemu, komunikativni, socialni-personalni, obcanske, pracovni, digitalni]';

const SPEEDRUN_RULE = 'SPEEDRUN RULE: at most 5 instruction steps, the core rule fits in ONE sentence, zero preparation, no or 1-2 everyday materials, playable within 30 seconds of reading.';

function isSet(v) {
	return typeof v === 'string' ? v !== '' && v !== 'any' : v !== undefined && v !== null;
}

/** RVP stupeň for the request: explicit filter wins, else derived from age. */
function resolveStupen(f) {
	if (isSet(f.stupen) && STUPNE.includes(f.stupen)) return f.stupen;
	const age = normalizeAgeRange(f.ageMin, f.ageMax);
	return age ? stupenForAge(age.min, age.max) : null;
}

// ─── Strict constraint mapping for AI ───
function buildFilterDescription(filters) {
	const f = filters || {};
	const constraints = [];

	// ── Mode → THEME directive (most important) ──
	if (f.mode) {
		constraints.push(MODE_THEMES[f.mode] || MODE_THEMES.party);
		if (isMode(f.mode)) constraints.push(`JSON field "mode" MUST be "${f.mode}".`);
	}

	// ── Age → exact range ──
	const age = normalizeAgeRange(f.ageMin, f.ageMax);
	if (age) {
		constraints.push(`CONSTRAINT ageRange: "ageRange.min" MUST be >= ${age.min} and "ageRange.max" MUST be <= ${age.max}. Do NOT generate a game for children outside ${age.min}–${age.max} years.`);
	}

	// ── Squad → exact numeric range ──
	const squad = getSquad(f.players);
	if (squad) {
		constraints.push(`CONSTRAINT playerCount: "playerCount.min" MUST be >= ${squad.min} and "playerCount.max" MUST be <= ${squad.max}. This is a ${squad.label}. Do NOT generate a game requiring more than ${squad.max} players.`);
	}

	// ── Activity type (circus) — only when no squad preset was chosen, to avoid contradictions ──
	if (isSet(f.activity) && !squad && ACTIVITY_CONSTRAINTS[f.activity]) {
		constraints.push(ACTIVITY_CONSTRAINTS[f.activity]);
	}

	// ── Duration → exact minute range ──
	const dur = getDuration(f.duration);
	if (dur) {
		constraints.push(`CONSTRAINT duration: "duration.min" MUST be >= ${dur.min} and "duration.max" MUST be <= ${dur.max}. Game MUST fit in ${dur.label}.`);
		if (resolveDurationKey(f.duration) === 'speedrun') constraints.push(SPEEDRUN_RULE);
	}

	// ── Setting ──
	if (f.setting === 'indoor' || f.setting === 'outdoor') {
		constraints.push(`CONSTRAINT setting: "setting" MUST be "${f.setting}". Do NOT suggest ${f.setting === 'indoor' ? 'outdoor' : 'indoor'} activities.`);
	} else {
		constraints.push('CONSTRAINT setting: "setting" MAY be "indoor" OR "outdoor" — user chose ANYWHERE, so game can work in either. Prefer the one that fits the activity best.');
	}

	// ── Energy ──
	if (isSet(f.energy)) {
		constraints.push(`CONSTRAINT energyLevel: "energyLevel" MUST be "${f.energy}".`);
	}

	// ── Reflection depth ──
	if (isSet(f.depth)) {
		const depthLabels = { light: 'light/playful', medium: 'moderate depth', deep: 'deep/emotional' };
		constraints.push(`CONSTRAINT emotionalDepth: "emotionalDepth" MUST be "${f.depth}" (${depthLabels[f.depth] || f.depth}).`);
	}

	// ── Cuisine type (cooking mode) ──
	if (isSet(f.cuisine)) {
		const cuisineLabels = { sweet: 'sweet/dessert', savory: 'savory/main course', healthy: 'healthy/nutritious', international: 'international/world cuisine' };
		constraints.push(`CONSTRAINT cuisine: The cooking activity MUST focus on ${cuisineLabels[f.cuisine] || f.cuisine} food.`);
	}

	// ── Focus type (meditation mode) ──
	if (isSet(f.focus)) {
		const focusLabels = { breath: 'breathing exercises', body: 'body scan / body awareness', visualization: 'guided visualization', movement: 'gentle movement / yoga' };
		constraints.push(`CONSTRAINT focus: The meditation MUST focus on ${focusLabels[f.focus] || f.focus}.`);
	}

	// ── RVP ──
	const stupen = resolveStupen(f);
	if (stupen) {
		constraints.push(`CONSTRAINT rvp.stupen: MUST be "${stupen}" (${STUPEN_LABELS[stupen]}).`);
	}
	if (isSet(f.kompetence)) {
		constraints.push(`CONSTRAINT rvp.kompetence: MUST include "${f.kompetence}" AND 1–2 additional keys from ${KOMPETENCE_KEYS} that this activity GENUINELY trains. Total 2–3 keys. Do NOT list competencies the activity does not authentically develop.`);
	} else {
		constraints.push(`CONSTRAINT rvp.kompetence: ANALYZE the activity and include 1–3 keys from ${KOMPETENCE_KEYS} that this activity GENUINELY trains. Pick the ones that truly match — DO NOT default to "k-uceni" for every game. Different activities train different competencies: movement games often train socialni-personalni + obcanske; puzzle games train k-reseni-problemu; discussion games train komunikativni; etc.`);
	}
	if (isSet(f.oblast)) {
		constraints.push(`CONSTRAINT rvp.oblasti: MUST include "${f.oblast}" in the oblasti array.`);
	}

	// ── Facilitator description / custom instructions ──
	if (f.description && f.description.trim()) {
		constraints.push(`FACILITATOR NOTE — the person creating this activity wrote the following custom instructions. You MUST incorporate this into the game design:\n"${f.description.trim()}"\nAdapt these notes using sound pedagogical approaches. Do NOT just copy the text literally; weave it creatively into the activity design.`);
	}

	return constraints.join('\n');
}

// ─── EXACT values AI MUST output ───
function buildExactValuesBlock(filters) {
	const f = filters || {};
	const lines = [];

	const squad = getSquad(f.players);
	if (squad) lines.push(`playerCount: { min: ${squad.min}, max: ${squad.max} }`);

	const dur = getDuration(f.duration);
	if (dur) lines.push(`duration: { min: ${dur.min}, max: ${dur.max} }`);

	const age = normalizeAgeRange(f.ageMin, f.ageMax);
	if (age) lines.push(`ageRange: { min: ${age.min}, max: ${age.max} }`);

	if (f.setting === 'indoor' || f.setting === 'outdoor') lines.push(`setting: "${f.setting}"`);

	const stupen = resolveStupen(f);
	if (stupen) lines.push(`rvp.stupen: "${stupen}"`);

	if (lines.length === 0) return '';
	return `\n⚠️ EXACT JSON VALUES (copy these — no other values allowed):\n${lines.join('\n')}\n`;
}

// ─── Server-side enforcement: fix the output to match the panel ───
// Mutates and returns `game`.
function enforceConstraints(game, filters) {
	if (!game || typeof game !== 'object' || Array.isArray(game)) return game;
	const f = filters || {};

	// Drop stupeň keys outside the enum (the model sometimes invents "treti").
	if (game.rvp && typeof game.rvp === 'object' && game.rvp.stupen !== undefined) {
		const keys = (Array.isArray(game.rvp.stupen) ? game.rvp.stupen : [game.rvp.stupen]).filter(k => STUPNE.includes(k));
		if (keys.length === 0) delete game.rvp.stupen;
		// Always an array: the viewers (public/game.js, games.json) expect stupen: [...].
		else game.rvp.stupen = keys;
	}

	const squad = getSquad(f.players);
	if (squad) {
		game.playerCount = { min: squad.min, max: squad.max };
	} else if (ACTIVITY_RANGES[f.activity]) {
		const [min, max] = ACTIVITY_RANGES[f.activity];
		game.playerCount = { min, max };
	}

	const dur = getDuration(f.duration);
	if (dur) game.duration = { min: dur.min, max: dur.max };

	const age = normalizeAgeRange(f.ageMin, f.ageMax);
	if (age) game.ageRange = { min: age.min, max: age.max };

	if (f.setting === 'indoor' || f.setting === 'outdoor') game.setting = f.setting;
	if (isSet(f.energy)) game.energyLevel = f.energy;
	if (isMode(f.mode)) game.mode = f.mode;

	const stupen = resolveStupen(f);
	if (stupen) {
		game.rvp = game.rvp && typeof game.rvp === 'object' && !Array.isArray(game.rvp) ? game.rvp : {};
		game.rvp.stupen = [stupen];
	}

	return game;
}

/** Fill `methodology` from the server's pick when the model left it out. */
function applyMethodologyFallback(game, picks) {
	if (!game || typeof game !== 'object') return game;
	const current = typeof game.methodology === 'string' ? game.methodology.trim() : '';
	if (!current && Array.isArray(picks) && picks.length) {
		game.methodology = picks.map(m => m.name).join(' + ');
	}
	return game;
}

// ─── Game JSON validation ───
// Returns [] if valid, or an array of human-readable error strings.
function validateGame(game) {
	const errors = [];
	if (!game || typeof game !== 'object' || Array.isArray(game)) return ['Output is not a JSON object'];

	for (const field of ['id', 'title', 'pitch', 'mode', 'setting', 'energyLevel', 'facilitatorNotes', 'methodology']) {
		if (typeof game[field] !== 'string' || !game[field].trim()) {
			errors.push(`Missing or empty field: ${field}`);
		}
	}
	if (typeof game.methodology === 'string' && game.methodology.length > 160) {
		errors.push('Field "methodology" is too long (max 160 characters)');
	}

	for (const field of ['playerCount', 'ageRange', 'duration']) {
		const obj = game[field];
		if (!obj || typeof obj.min !== 'number' || typeof obj.max !== 'number') {
			errors.push(`Invalid range object: ${field} (must be { min: number, max: number })`);
		}
	}

	for (const field of ['materials', 'instructions', 'learningGoals', 'reflectionPrompts', 'safetyNotes']) {
		if (!Array.isArray(game[field]) || game[field].length === 0) {
			errors.push(`Missing or empty array: ${field}`);
		}
	}

	if (game.title && String(game.title).trim().length < 3) {
		errors.push('Title too short (min 3 characters)');
	}

	if (Array.isArray(game.instructions) && game.instructions.length > 0) {
		if (String(game.instructions[0]).trim().length < 10) {
			errors.push('First instruction is too short to be meaningful');
		}
	}

	for (const field of ['instructions', 'learningGoals', 'reflectionPrompts']) {
		if (Array.isArray(game[field])) {
			const hollow = game[field].filter(item => !item || String(item).trim().length < 5);
			if (hollow.length > 0) {
				errors.push(`Array "${field}" contains ${hollow.length} empty or trivially short item(s)`);
			}
		}
	}

	if (game.rvp && game.rvp.stupen !== undefined) {
		const keys = Array.isArray(game.rvp.stupen) ? game.rvp.stupen : [game.rvp.stupen];
		const bad = keys.filter(k => !STUPNE.includes(k));
		if (bad.length) errors.push(`rvp.stupen must be one of ${STUPNE.join('|')}`);
	}

	return errors;
}

const REPAIR_RULES = `RULES:
- Return ONLY the fixed JSON. No markdown, no code fences, no explanation.
- Required string fields: id, title, pitch, methodology, mode, setting, energyLevel, facilitatorNotes
- Required range objects (must have min and max as numbers): playerCount, ageRange, duration
- Required non-empty arrays: materials, instructions, learningGoals, reflectionPrompts, safetyNotes
- rvp.stupen, when present, is one of: ${STUPNE.join(', ')}`;

function buildRepairPrompt(brokenOutput, errors, aiLanguage) {
	return `The following game JSON has validation errors. Fix ALL errors listed below and return ONLY a corrected valid JSON object.

ERRORS TO FIX:
${errors.join('\n')}

BROKEN OUTPUT:
${String(brokenOutput).substring(0, 4000)}

${REPAIR_RULES}
- Write ALL text content in ${aiLanguage}`;
}

// ─── Didactic guidance (per request, short: the catalogue lives in the system prompt) ───
function buildDidacticGuidance(filters, picks) {
	const f = filters || {};
	const tips = [];
	const mode = isMode(f.mode) ? f.mode : 'party';
	const chosen = Array.isArray(picks) && picks.length ? picks : selectMethodologies(f);

	tips.push(`METHODOLOGY: build the game on ${chosen.map(m => `${m.id} (${m.apply})`).join(' + ')}. Put the catalogue name(s) in "methodology".`);
	tips.push(`MODE DIDACTIC: ${MODE_DIDACTICS[mode]}`);
	// (The SPEEDRUN rule is already in the constraints block; not repeated here.)

	const age = normalizeAgeRange(f.ageMin, f.ageMax);
	if (age && age.max <= 8) tips.push('AGE: very young players — short sentences, everyday words, no slang, show-don\'t-tell rules, adult nearby.');
	else if (age && age.max <= 11) tips.push('AGE: younger players — simple words, concrete examples, light humour, no teen slang.');
	else if (age && age.min >= 15) tips.push('AGE: teens — real challenge and choice, teen-friendly wording, no childish framing.');

	if (f.depth === 'deep') tips.push('EMOTIONAL DEPTH: Create safe space for vulnerability. Use prompts that invite sharing without pressure. Facilitator notes should emphasize consent and opt-out.');
	if (f.depth === 'light') tips.push('EMOTIONAL DEPTH: Keep tone playful, avoid heavy topics. Quick check-ins, not deep dives.');
	if (f.energy === 'high') tips.push('ENERGY: Design for movement, quick transitions, physical engagement. Avoid long seated phases.');
	if (f.energy === 'low') tips.push('ENERGY: Calm, seated or slow movement. Allow thinking time, no rush.');
	if (f.setting === 'outdoor') tips.push('SETTING: Leverage nature — spatial awareness, sensory input, natural materials. Consider weather.');
	if (f.setting === 'indoor') tips.push('SETTING: Optimize for classroom/room — clear boundaries, minimal setup, furniture as props.');
	if (isSet(f.cuisine)) tips.push(`CUISINE: Focus on ${f.cuisine} — connect to nutrition, culture, or sensory learning.`);
	if (isSet(f.focus)) tips.push(`MEDITATION FOCUS: ${f.focus} — use evidence-based techniques (breath work, body scan, etc.).`);

	return tips.join('\n');
}

// ─── System prompt (static → cacheable prefix) ───
function buildSystemPrompt() {
	return `You are a CREATIVE GAME DESIGNER for facilitators (teachers, scout leaders, trainers, youth workers) working with kids and teens aged 6-18. You design SHORT, CATCHY, original games grounded in proven pedagogy, and you explain them simply, like a friendly colleague.

CRITICAL — OUTPUT LANGUAGE:
The user message specifies the target language. You MUST write ALL JSON text fields (title, pitch, instructions, goals, reflection, safety, adaptation, facilitatorNotes, etc.) in THAT language. Never mix languages. Never default to English unless explicitly told "English".

IDENTITY:
- Game designer with solid pedagogy knowledge — the method works under the hood, the text never sounds like a textbook
- You respond ONLY based on the user's PANEL INPUT — every filter above "Spawnuj hru" is your mandatory brief
- You can use professional/technical content from knowledge base — but you INTERPRET it simply and add EXAMPLES

CONTEXT — PANEL INPUT IS YOUR BRIEF:
The user configures a left panel with: MÓD (mode), VEK (age), SQUAD (players), TIMER (duration), MAPA (setting), ENERGY, mode-specific filters (activity/depth/cuisine/focus), RVP filters, POPIS (custom description). EVERY value from that panel is your INPUT. You MUST use ALL of them. Do NOT invent values the user did not choose. Do NOT forget or ignore any panel input.

METHODOLOGY CATALOGUE (ground every game in 1-2 of these; the user message names the pick):
${buildMethodologyCatalogue()}

SHORT & CATCHY:
- Title: 1-4 punchy words. Pitch: ONE sentence hook.
- Core rule explainable in one breath; 3-7 instruction steps (Speedrun: max 5).
- Start fast: setup under 2 minutes, materials everyday or none.
- One clear twist that makes it memorable.

VOICE & STYLE — SIMPLE, WARM, AGE-AWARE:
- Write like a friendly game leader, not a professor: short sentences, plain words, active verbs
- Match the players' age: no slang for under-11s; light gaming words ("quest", "level up", "spawn") are fine for older kids and teens
- Pedagogy is applied, not lectured: name the method only in "methodology" and briefly in facilitatorNotes; player-facing text stays jargon-free
- Support players step by step (easy first round, then harder) without calling it theory
- ALWAYS include CONCRETE EXAMPLES in instructions (e.g. "např. Honza hází míč Zuzce a říká její jméno")
- Learning goals: clear, phrased as "co si odnesú" — not curriculum bullet points
- Reflection prompts: ask like a friend would — "Co ti šlo najlepšie? Čo by si nabudúce urobil inak?"
- facilitatorNotes: practical tips for the leader, written like a buddy giving advice

RULES:
- Generate ONE UNIQUE, ORIGINAL game — do not recreate well-known games.
- The game must be practical and immediately playable.
- Materials must be commonly available (paper, ball, markers...).
- Always include reflection prompts (casual, friend-like) and safety notes (simple, no jargon).
- playerBrief: what players hear (goal, max 3 short rules, optional roles, win condition).
- lessonFlow: 1-4 phases whose minutes add up to at most duration.max.
- If mode is "classroom", include full RVP mapping (competences, areas, cross-topics).
- If mode is "cooking", the game MUST be a cooking/recipe activity.
- If mode is "meditation", the game MUST be a mindfulness/wellness exercise.
- If mode is "online", every mechanic MUST work over a video call with no shared physical objects.
- Respond ONLY with a valid JSON object — no markdown, no comments.
- ALWAYS include "verificationChallenge" with "description" (what players should photograph as proof they did the activity — be specific: finished result, group pose, materials used, etc.) and "hint" (short tip for a good photo).

CRITICAL — PANEL INPUT COMPLIANCE:
The user specifies MANDATORY constraints. You MUST satisfy ALL of them. Before outputting JSON, verify:
✓ playerCount, duration and ageRange fall within the specified ranges
✓ setting and mode match the panel
✓ The game's THEME and AESTHETIC match the mode (circus=circus theme, cooking=food theme, etc.)
✓ "methodology" names the catalogue method(s) the game actually uses
✓ If facilitator wrote a POPIS (description), you MUST weave it into the game design
If ANY constraint fails, regenerate before responding.

RESPONSE FORMAT — exactly this JSON shape:
${COMPACT_GAME_SCHEMA}

IMPORTANT: Generate "id" as "ai-" + random 6-character code. All fields are required.`;
}

// ─── Per-request user message ───
const PANEL_LABELS = Object.freeze({
	setting: { any: 'anywhere', indoor: 'indoor', outdoor: 'outdoor' },
	energy: { low: 'low', medium: 'medium', high: 'high' },
	activity: { solo: 'solo', pair: 'pairs', group: 'small group', mass: 'mass' },
	depth: { light: 'light', medium: 'medium', deep: 'deep' },
	cuisine: { sweet: 'sweet', savory: 'savory', healthy: 'healthy', international: 'international' },
	focus: { breath: 'breath', body: 'body', visualization: 'visualization', movement: 'movement/yoga' }
});

function buildPanelSummary(filters) {
	const f = filters || {};
	const age = normalizeAgeRange(f.ageMin, f.ageMax);
	const squad = getSquad(f.players);
	const dur = getDuration(f.duration);
	const stupen = resolveStupen(f);
	const L = PANEL_LABELS;
	return [
		'═══ LEFT PANEL INPUT (use ALL of these — they are your mandatory brief) ═══',
		'',
		`MODE: ${MODE_LABELS[f.mode] || MODE_LABELS.party} — game MUST match this style`,
		`AGE: ${age ? `${age.min}–${age.max}` : 'any'} years`,
		`PLAYERS: ${squad ? squad.label : 'any'}`,
		`DURATION: ${dur ? dur.label : 'any'}`,
		`SETTING: ${L.setting[f.setting] || 'any'}`,
		`ENERGY: ${L.energy[f.energy] || 'any'}`,
		isSet(f.activity) ? `ACTIVITY TYPE (circus): ${L.activity[f.activity] || f.activity}` : null,
		isSet(f.depth) ? `EMOTIONAL DEPTH (reflection): ${L.depth[f.depth] || f.depth}` : null,
		isSet(f.cuisine) ? `CUISINE TYPE (cooking): ${L.cuisine[f.cuisine] || f.cuisine}` : null,
		isSet(f.focus) ? `FOCUS (meditation): ${L.focus[f.focus] || f.focus}` : null,
		stupen ? `RVP LEVEL: ${STUPEN_LABELS[stupen]}` : null,
		isSet(f.kompetence) ? `RVP COMPETENCE: ${f.kompetence}` : null,
		isSet(f.oblast) ? `RVP AREA: ${f.oblast}` : null,
		f.description ? `USER DESCRIPTION (MUST incorporate): "${f.description}"` : null
	].filter(v => v !== null).join('\n');
}

const TASK_BLOCKS = Object.freeze({
	sk: 'ÚLOHA: Vygeneruj jednu originálnu, krátku a chytľavú hru/aktivitu.\nPOUŽI VŠETKY vstupy z panelu vyššie — každý filter je tvoj brief.\nŠTÝL: Píš jednoducho, uvoľnene a primerane veku hráčov, s príkladmi. Žiadny akademický žargón.\nPRÍKLADY: V inštrukciách, reflexných otázkach a poznámkach vždy uveď konkrétne príklady (napr. "Honza hádže loptu Zuzke a povie jej meno").\nPred odpoveďou skontroluj, či si splnil VŠETKY obmedzenia.\nOdpovedz JEDNÝM JSON objektom.',
	cs: 'ÚKOL: Vygeneruj jednu originální, krátkou a chytlavou hru/aktivitu.\nPOUŽIJ VŠECHNY vstupy z panelu výše — každý filtr je tvůj brief.\nSTYL: Piš jednoduše, uvolněně a přiměřeně věku hráčů, s příklady. Žádný akademický žargon.\nPŘÍKLADY: V instrukcích, reflexních otázkách a poznámkách vždy uveď konkrétní příklady (např. "Honza hází míč Zuzce a říká její jméno").\nPřed odpovědí zkontroluj, zda jsi splnil VŠECHNA omezení.\nOdpověz JEDNÍM JSON objektem.',
	en: 'TASK: Generate one original, short and catchy game/activity.\nUSE ALL inputs from the panel above — every filter is your brief.\nSTYLE: Write simply, relaxed and right for the players\' age, with examples. No academic jargon.\nEXAMPLES: In instructions, reflection prompts, and notes always include concrete examples (e.g. "John throws the ball to Sarah and says her name").\nBefore responding, verify you met ALL constraints.\nRespond with ONE JSON object.',
	de: 'AUFGABE: Generiere ein originelles, kurzes und packendes Spiel/Aktivität.\nVERWENDE ALLE Eingaben aus dem Panel oben — jeder Filter ist dein Brief.\nSTIL: Schreibe einfach, locker und altersgerecht, mit Beispielen. Kein akademischer Jargon.\nBEISPIELE: In Anweisungen, Reflexionsfragen und Notizen immer konkrete Beispiele angeben (z.B. "Hans wirft den Ball zu Petra und sagt ihren Namen").\nVor der Antwort prüfe, ob du ALLE Einschränkungen erfüllt hast.\nAntworte mit EINEM JSON-Objekt.',
	tr: 'GÖREV: Orijinal, kısa ve akılda kalıcı bir oyun/etkinlik oluştur.\nYukarıdaki paneldeki TÜM girdileri KULLAN — her filtre senin brifindir.\nSTİL: Basit, rahat ve oyuncuların yaşına uygun yaz, örneklerle. Akademik jargon yok.\nÖRNEKLER: Talimatlarda, yansıtma sorularında ve notlarda her zaman somut örnekler ver (ör. "Ali topu Ayşe\'ye atar ve onun adını söyler").\nYanıtlamadan önce TÜM kısıtlamalara uyduğunu kontrol et.\nTEK bir JSON nesnesiyle yanıt ver.',
	es: 'TAREA: Genera un juego/actividad original, corto y pegadizo.\nUSA TODAS las entradas del panel de arriba — cada filtro es tu brief.\nESTILO: Escribe simple, relajado y adecuado a la edad de los jugadores, con ejemplos. Sin jerga académica.\nEJEMPLOS: En instrucciones, preguntas de reflexión y notas siempre incluye ejemplos concretos (ej. "Juan lanza la pelota a María y dice su nombre").\nAntes de responder, verifica que cumpliste TODAS las restricciones.\nResponde con UN objeto JSON.'
});

/**
 * Assemble the user message.
 * @param {{ filters: object, aiLanguage: string, langCode: string, picks?: object[],
 *           rpgProfileBlock?: string, knowledgeSummary?: string,
 *           remix?: {title:string, mode:string, kompetence:string[], learningGoals:string[]}|null }} p
 */
function buildUserPrompt({ filters, aiLanguage, langCode, picks, rpgProfileBlock = '', knowledgeSummary = '', remix = null }) {
	const f = filters || {};
	const taskBlock = TASK_BLOCKS[langCode] || TASK_BLOCKS.sk;
	return `🌐 LANGUAGE: ${aiLanguage}. Write EVERY text field in ${aiLanguage}. Do NOT use English unless the language IS English.
══════════════════════════════════════
${buildPanelSummary(f)}
${buildExactValuesBlock(f)}
══════════════════════════════════════
MANDATORY CONSTRAINTS (do NOT forget):
══════════════════════════════════════

${buildFilterDescription(f)}

══════════════════════════════════════
DIDACTIC GUIDANCE (research-backed):
══════════════════════════════════════

${buildDidacticGuidance(f, picks)}
${rpgProfileBlock}
──────────────────────────────────────
${taskBlock}
──────────────────────────────────────
🌐 REMINDER: ALL output text MUST be in ${aiLanguage}. Title, pitch, instructions, goals, reflection — everything in ${aiLanguage}.${knowledgeSummary ? `
──────────────────────────────────────
═══ SOURCE OF KNOWLEDGE ═══
The following reference material was uploaded by the facilitator. Use it to ENRICH and CUSTOMIZE the generated game.
- You MAY use professional/technical content from these files — themes, facts, scenarios
- BUT: INTERPRET everything SIMPLY. Explain like you're telling a friend, not citing a textbook
- Add CONCRETE EXAMPLES based on the content
- Always respect the MANDATORY CONSTRAINTS above.
- WRITE THE OUTPUT IN ${aiLanguage}.

${knowledgeSummary}
═══ END SOURCE OF KNOWLEDGE ═══` : ''}${remix ? `
──────────────────────────────────────
REMIX — Create a VARIATION (don't plagiarize, just get inspired):
Original game: "${remix.title}"
Original mode: ${remix.mode || 'not specified'}
Original competences: ${remix.kompetence.join(', ') || 'not specified'}
Original learning goals: ${remix.learningGoals.join(' | ') || 'not specified'}
Keep mode, learning goals and competences. Change mechanics, materials, title, and procedure SIGNIFICANTLY.
Write the remix in ${aiLanguage}.
──────────────────────────────────────` : ''}`;
}

/**
 * One log line for an OpenAI `usage` object, including prompt-cache hits
 * (`prompt_tokens_details.cached_tokens`). Returns '' when usage is missing.
 */
function formatUsageLog(usage) {
	if (!usage || typeof usage !== 'object') return '';
	const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
	const cached = num(usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens);
	return `prompt=${num(usage.prompt_tokens)} cached=${cached} completion=${num(usage.completion_tokens)}`;
}

module.exports = {
	formatUsageLog,
	COMPACT_GAME_SCHEMA,
	MODE_THEMES,
	MODE_DIDACTICS,
	MODE_LABELS,
	STUPEN_LABELS,
	SPEEDRUN_RULE,
	TASK_BLOCKS,
	resolveStupen,
	buildFilterDescription,
	buildExactValuesBlock,
	enforceConstraints,
	applyMethodologyFallback,
	validateGame,
	buildRepairPrompt,
	buildDidacticGuidance,
	buildSystemPrompt,
	buildPanelSummary,
	buildUserPrompt
};
