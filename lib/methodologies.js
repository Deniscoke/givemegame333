'use strict';

/**
 * gIVEMEGAME.IO — methodology catalogue for game generation.
 *
 * The full catalogue text goes into the STATIC system prompt (cacheable).
 * The per-request user message only names the 1-2 picked ids plus a short
 * "apply" hint, so prompt growth per request stays small.
 *
 * Each entry: id, name, idea (one line, shown in the catalogue), apply (how
 * to use it in a short game, sent only when picked), and fit tables:
 * modes, durations (speedrun|classic|marathon) and ageBands (filter-presets).
 */

const { AGE_BANDS, resolveDurationKey, normalizeAgeRange } = require('./filter-presets');

const ALL_BANDS = Object.freeze(Object.keys(AGE_BANDS));
const ALL_DURATIONS = Object.freeze(['speedrun', 'classic', 'marathon']);

const METHODOLOGIES = Object.freeze([
	{
		id: 'energizer',
		name: 'Energizer',
		idea: 'a 2-5 min burst of movement or laughter; rules in one sentence, zero setup',
		apply: 'One catchy mechanic, rules in 1 sentence, no materials, start within 30 s.',
		modes: ['party', 'classroom', 'circus', 'online'],
		durations: ['speedrun'],
		ageBands: ALL_BANDS
	},
	{
		id: 'cooperative',
		name: 'Cooperative games',
		idea: 'the group wins or loses together; no elimination, everyone stays in play',
		apply: 'Shared goal against the clock or a puzzle; nobody sits out.',
		modes: ['party', 'classroom', 'circus', 'reflection', 'online'],
		durations: ALL_DURATIONS,
		ageBands: ALL_BANDS
	},
	{
		id: 'kolb',
		name: 'Experiential learning (Kolb)',
		idea: 'do → reflect → make sense → try again, better',
		apply: 'Play a round, take a 1-minute "what happened?", then a second improved round.',
		modes: ['party', 'classroom', 'circus', 'cooking', 'reflection'],
		durations: ['classic', 'marathon'],
		ageBands: ALL_BANDS
	},
	{
		id: 'scout-patrol',
		name: 'Scout patrol method (Junák)',
		idea: 'small patrols of 4-8 with rotating roles, a story frame and learning by doing',
		apply: 'Split into patrols with roles (leader, scout, scribe) inside a short story quest.',
		modes: ['party', 'classroom'],
		durations: ['classic', 'marathon'],
		ageBands: ['8-11', '11-15', '15-19']
	},
	{
		id: 'scout-games',
		name: 'Scouting games',
		idea: "observation and field games: Kim's game, tracking signs, stalking, orientation",
		apply: "Use a Kim's-game memory twist, trail signs or a quiet stalking round.",
		modes: ['party', 'classroom', 'circus'],
		durations: ALL_DURATIONS,
		ageBands: ALL_BANDS
	},
	{
		id: 'outdoor-adventure',
		name: 'Outdoor / adventure education (Hahn)',
		idea: 'a real but safe challenge; "challenge by choice"; comfort → stretch zone',
		apply: 'Give a doable physical or problem challenge; each player picks their own stretch level.',
		modes: ['party', 'circus', 'classroom'],
		durations: ['classic', 'marathon'],
		ageBands: ['8-11', '11-15', '15-19']
	},
	{
		id: 'drama',
		name: 'Drama in education',
		idea: 'role play, teacher in role, freeze frames, hot seating to explore a topic',
		apply: 'Use freeze frames or a hot-seat character to step into the topic.',
		modes: ['classroom', 'reflection', 'party', 'online'],
		durations: ALL_DURATIONS,
		ageBands: ALL_BANDS
	},
	{
		id: 'comenius',
		name: 'Comenius "škola hrou"',
		idea: 'learning through play and the senses, from concrete to abstract, simple to complex',
		apply: 'Start with something to touch, see or taste, then name the idea behind it.',
		modes: ['classroom', 'cooking', 'party'],
		durations: ALL_DURATIONS,
		ageBands: ['6-8', '8-11', '11-15']
	},
	{
		id: 'bloom',
		name: "Bloom's taxonomy",
		idea: 'climb from remember/understand to apply, analyse and create',
		apply: 'Finish with one task where players create or judge something, not just recall.',
		modes: ['classroom'],
		durations: ['classic', 'marathon'],
		ageBands: ['8-11', '11-15', '15-19']
	},
	{
		id: 'pbl',
		name: 'Problem-based learning (PBL)',
		idea: 'teams solve a real, open problem and show a product',
		apply: 'Pose one real problem; teams present a quick product or solution at the end.',
		modes: ['classroom', 'cooking'],
		durations: ['marathon'],
		ageBands: ['11-15', '15-19']
	},
	{
		id: 'design-thinking',
		name: 'Design thinking',
		idea: 'empathise → define → ideate → prototype → test, in fast loops',
		apply: 'Run a mini loop: interview a "user", sketch ideas, build a paper prototype, test.',
		modes: ['classroom', 'party', 'online'],
		durations: ['classic', 'marathon'],
		ageBands: ['11-15', '15-19']
	},
	{
		id: 'debrief-3q',
		name: 'What? / So what? / Now what? debrief',
		idea: 'three-step debrief: what happened, why it matters, what we do next',
		apply: 'Shape reflectionPrompts as What? → So what? → Now what?',
		modes: ['reflection', 'classroom', 'party', 'online'],
		durations: ['classic', 'marathon'],
		ageBands: ['8-11', '11-15', '15-19']
	},
	{
		id: 'intuitive',
		name: 'Intuitive pedagogy',
		idea: "read the room: follow the group's energy, improvise, keep it flexible",
		apply: 'Give the leader 1-2 options to speed up, slow down or switch the vibe.',
		modes: ['reflection', 'meditation', 'party', 'circus', 'cooking'],
		durations: ALL_DURATIONS,
		ageBands: ALL_BANDS
	},
	{
		id: 'mindful-play',
		name: 'Mindful play',
		idea: 'breath, body and senses awareness in a calm, non-competitive frame',
		apply: 'Anchor the game in breath or senses; no scores, no winners.',
		modes: ['meditation', 'reflection'],
		durations: ALL_DURATIONS,
		ageBands: ALL_BANDS
	}
].map(m => Object.freeze({
	...m,
	modes: Object.freeze([...m.modes]),
	durations: Object.freeze([...m.durations]),
	ageBands: Object.freeze([...m.ageBands])
})));

const BY_ID = new Map(METHODOLOGIES.map(m => [m.id, m]));

function getMethodology(id) {
	return BY_ID.get(id) || null;
}

/** Age bands that overlap an age range. */
function bandsForAge(min, max) {
	return ALL_BANDS.filter(key => {
		const b = AGE_BANDS[key];
		// A single age belongs to every band that contains it; a range must overlap by more than an edge.
		return min === max ? (b.min <= min && min <= b.max) : (b.min < max && b.max > min);
	});
}

/**
 * Pick 1-2 methodologies for a request.
 * Score: mode fit +3, duration fit +2, age band fit +1, misfits are
 * penalised, and +1 per dimension where the method is specific (not a
 * catch-all) so targeted methods beat generic ones. Ties keep catalogue
 * order, so the pick is deterministic unless an `rng` is passed (then ties
 * are broken randomly for variety).
 *
 * @param {{mode?:string, duration?:string, ageMin?:string|number, ageMax?:string|number}} filters
 * @param {{count?:number, rng?:() => number}} [opts]
 * @returns {Array<object>} catalogue entries
 */
function selectMethodologies(filters, opts = {}) {
	const f = filters || {};
	const count = Math.max(1, Math.min(2, opts.count || 2));
	const mode = f.mode || 'party';
	const duration = resolveDurationKey(f.duration);
	const age = normalizeAgeRange(f.ageMin, f.ageMax);
	const bands = age ? bandsForAge(age.min, age.max) : null;

	const scored = METHODOLOGIES.map((m, index) => {
		let score = 0;
		const modeFit = m.modes.includes(mode);
		const durationFit = Boolean(duration) && m.durations.includes(duration);
		const bandFit = Boolean(bands) && bands.some(b => m.ageBands.includes(b));
		if (modeFit) score += 3;
		if (durationFit) score += 2;
		if (duration && !durationFit) score -= 3;
		if (bandFit) score += 1;
		if (bands && !bandFit) score -= 2;
		// Specificity: a method made for this mode / duration / age beats a generic one.
		if (modeFit && m.modes.length <= 2) score += 1;
		if (durationFit && m.durations.length < ALL_DURATIONS.length) score += 1;
		if (bandFit && m.ageBands.length < ALL_BANDS.length) score += 1;
		return { m, score, tie: opts.rng ? opts.rng() : index };
	});
	scored.sort((a, b) => (b.score - a.score) || (a.tie - b.tie));
	return scored.slice(0, count).map(s => s.m);
}

/** Static catalogue block for the system prompt (one line per entry). */
function buildMethodologyCatalogue() {
	return METHODOLOGIES.map(m => `- ${m.id} — ${m.name}: ${m.idea}`).join('\n');
}

module.exports = {
	METHODOLOGIES,
	getMethodology,
	selectMethodologies,
	buildMethodologyCatalogue,
	bandsForAge
};
