/**
 * gIVEMEGAME.IO — Game schema normalization
 * Ensures old games, fallback games, and saved games render correctly.
 * New Game Pack fields get safe defaults when absent.
 */

const DEFAULT_PLAYER_BRIEF = {
	goal: '',
	rules: [],
	roles: [],
	winCondition: ''
};

const DEFAULT_LESSON_PHASE = {
	phase: '',
	minutes: 0,
	teacherActions: [],
	studentActions: []
};

/**
 * Normalizes a game object so it has safe defaults for all Game Pack fields.
 * Does not mutate the original — returns a new object with merged defaults.
 * @param {object} game - Raw game from AI, games.json, or saved_games
 * @returns {object} Normalized game safe for rendering
 */
function normalizeGameSchema(game) {
	if (!game || typeof game !== 'object') return game;

	const g = { ...game };

	// playerBrief
	if (!g.playerBrief || typeof g.playerBrief !== 'object') {
		g.playerBrief = { ...DEFAULT_PLAYER_BRIEF };
	} else {
		g.playerBrief = {
			goal: typeof g.playerBrief.goal === 'string' ? g.playerBrief.goal : '',
			rules: Array.isArray(g.playerBrief.rules) ? g.playerBrief.rules : [],
			roles: Array.isArray(g.playerBrief.roles) ? g.playerBrief.roles : [],
			winCondition: typeof g.playerBrief.winCondition === 'string' ? g.playerBrief.winCondition : ''
		};
	}

	// lessonFlow
	if (!Array.isArray(g.lessonFlow)) {
		g.lessonFlow = [];
	} else {
		g.lessonFlow = g.lessonFlow.map(p => ({
			phase: typeof p.phase === 'string' ? p.phase : '',
			minutes: typeof p.minutes === 'number' ? p.minutes : 0,
			teacherActions: Array.isArray(p.teacherActions) ? p.teacherActions : [],
			studentActions: Array.isArray(p.studentActions) ? p.studentActions : []
		})).filter(p => p.phase || p.teacherActions?.length || p.studentActions?.length);
	}

	// teacherGuide
	if (!Array.isArray(g.teacherGuide)) {
		g.teacherGuide = [];
	}

	// adaptations (scenario + adjustment objects)
	if (!Array.isArray(g.adaptations)) {
		g.adaptations = [];
	} else {
		g.adaptations = g.adaptations
			.filter(a => a && typeof a === 'object')
			.map(a => ({
				scenario: typeof a.scenario === 'string' ? a.scenario : '',
				adjustment: typeof a.adjustment === 'string' ? a.adjustment : ''
			}))
			.filter(a => a.scenario || a.adjustment);
	}

	// riskNotes
	if (!Array.isArray(g.riskNotes)) {
		g.riskNotes = [];
	}

	// reflectionPrompts — ensure array (required by schema but old games may have it)
	if (!Array.isArray(g.reflectionPrompts)) {
		g.reflectionPrompts = [];
	}

	// adaptationTips — legacy, ensure array for renderList
	if (!Array.isArray(g.adaptationTips)) {
		g.adaptationTips = [];
	}

	return g;
}

/**
 * Check if game has any Game Pack content (to show/hide sections).
 */
function hasGamePackContent(game) {
	if (!game) return false;
	const pb = game.playerBrief;
	const hasPlayerBrief = pb && (
		(pb.goal && pb.goal.trim()) ||
		(pb.rules && pb.rules.length > 0) ||
		(pb.roles && pb.roles.length > 0) ||
		(pb.winCondition && pb.winCondition.trim())
	);
	const hasLessonFlow = Array.isArray(game.lessonFlow) && game.lessonFlow.length > 0;
	const hasTeacherGuide = Array.isArray(game.teacherGuide) && game.teacherGuide.length > 0;
	const hasAdaptations = Array.isArray(game.adaptations) && game.adaptations.length > 0;
	const hasRiskNotes = Array.isArray(game.riskNotes) && game.riskNotes.length > 0;
	return hasPlayerBrief || hasLessonFlow || hasTeacherGuide || hasAdaptations || hasRiskNotes;
}

module.exports = {
	normalizeGameSchema,
	hasGamePackContent,
	DEFAULT_PLAYER_BRIEF,
	DEFAULT_LESSON_PHASE
};
