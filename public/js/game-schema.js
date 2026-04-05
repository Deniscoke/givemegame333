/* gIVEMEGAME.IO — Client-side game schema normalization (mirrors lib/game-schema.js) */

(function () {
	function normalizeGameSchema(game) {
		if (!game || typeof game !== 'object') return game;
		const g = { ...game };

		if (!g.playerBrief || typeof g.playerBrief !== 'object') {
			g.playerBrief = { goal: '', rules: [], roles: [], winCondition: '' };
		} else {
			g.playerBrief = {
				goal: typeof g.playerBrief.goal === 'string' ? g.playerBrief.goal : '',
				rules: Array.isArray(g.playerBrief.rules) ? g.playerBrief.rules : [],
				roles: Array.isArray(g.playerBrief.roles) ? g.playerBrief.roles : [],
				winCondition: typeof g.playerBrief.winCondition === 'string' ? g.playerBrief.winCondition : ''
			};
		}

		if (!Array.isArray(g.lessonFlow)) {
			g.lessonFlow = [];
		} else {
			g.lessonFlow = g.lessonFlow.map(function (p) {
				return {
					phase: typeof p.phase === 'string' ? p.phase : '',
					minutes: typeof p.minutes === 'number' ? p.minutes : 0,
					teacherActions: Array.isArray(p.teacherActions) ? p.teacherActions : [],
					studentActions: Array.isArray(p.studentActions) ? p.studentActions : []
				};
			}).filter(function (p) {
				return p.phase || (p.teacherActions && p.teacherActions.length) || (p.studentActions && p.studentActions.length);
			});
		}

		if (!Array.isArray(g.teacherGuide)) g.teacherGuide = [];
		if (!Array.isArray(g.adaptations)) {
			g.adaptations = [];
		} else {
			g.adaptations = g.adaptations.filter(function (a) { return a && typeof a === 'object'; }).map(function (a) {
				return { scenario: typeof a.scenario === 'string' ? a.scenario : '', adjustment: typeof a.adjustment === 'string' ? a.adjustment : '' };
			}).filter(function (a) { return a.scenario || a.adjustment; });
		}
		if (!Array.isArray(g.riskNotes)) g.riskNotes = [];
		if (!Array.isArray(g.reflectionPrompts)) g.reflectionPrompts = [];
		if (!Array.isArray(g.adaptationTips)) g.adaptationTips = [];

		return g;
	}

	window.normalizeGameSchema = normalizeGameSchema;
})();
