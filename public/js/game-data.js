/* ═══════════════════════════════════════════════════════════════════
   gIVEMEGAME.IO — GameData module (extracted from script.js Phase 3.1)

   Dependencies (globals resolved at call-time, not load-time):
     • fetch()   — browser built-in

   Exposes: window.GameData  (also visible as global `const GameData`
            to all scripts loaded after this one in the same page)
   ═══════════════════════════════════════════════════════════════════ */

// ─────────────────────────────────────────────────
// GameData — Lokální data a procedurální engine
// ─────────────────────────────────────────────────
const GameData = (() => {
	let sampleGames = [];
	let rvpData = null;
	let loaded = false;

	async function load() {
		try {
			const [gamesRes, rvpRes] = await Promise.all([
				fetch('./data/games.json'),
				fetch('./data/rvp.json')
			]);
			sampleGames = await gamesRes.json();
			rvpData = await rvpRes.json();
			loaded = true;
			console.log(`[GameData] Načteno ${sampleGames.length} her a RVP data.`);
		} catch (err) {
			console.error('[GameData] Chyba načítání dat:', err);
			sampleGames = [];
			rvpData = null;
		}
	}

	function generate(filters) {
		if (!loaded || sampleGames.length === 0) {
			return createFallbackGame();
		}

		const scored = sampleGames.map(game => ({
			game,
			score: scoreMatch(game, filters)
		}));

		scored.sort((a, b) => b.score - a.score);

		const topPool = scored.filter(s => s.score >= scored[0].score * 0.6);
		const pick = topPool[Math.floor(Math.random() * topPool.length)];

		return { ...pick.game };
	}

	function scoreMatch(game, filters) {
		let score = 0;

		// Režim (nejvyšší priorita)
		if (filters.mode && game.mode) {
			if (game.mode === filters.mode || game.mode === 'universal') score += 6;
			else score -= 3;
		}

		// Energie
		if (filters.energy && game.energyLevel) {
			if (game.energyLevel === filters.energy) score += 4;
			else score -= 1;
		}

		// Prostředí
		if (filters.setting && filters.setting !== 'any') {
			if (game.setting === filters.setting) score += 3;
			else score -= 1;
		}

		// Věk
		if (filters.ageMin) {
			if (game.ageRange.min <= parseInt(filters.ageMin)) score += 2;
		}
		if (filters.ageMax) {
			if (game.ageRange.max >= parseInt(filters.ageMax)) score += 2;
		}

		// Počet hráčů
		if (filters.players) {
			const max = game.playerCount.max;
			if (filters.players === 'small' && max <= 8) score += 3;
			else if (filters.players === 'medium' && max <= 20 && max >= 5) score += 3;
			else if (filters.players === 'large' && max >= 15) score += 3;
		}

		// Délka
		if (filters.duration) {
			const dur = game.duration.max;
			if (filters.duration === 'quick' && dur <= 20) score += 3;
			else if (filters.duration === 'medium' && dur <= 40 && dur >= 15) score += 3;
			else if (filters.duration === 'long' && dur >= 30) score += 3;
		}

		// Typ aktivity (circus režim)
		if (filters.activity && game.activityType) {
			if (game.activityType === filters.activity) score += 4;
		}

		// Emoční hloubka (reflection režim)
		if (filters.depth && game.emotionalDepth) {
			if (game.emotionalDepth === filters.depth) score += 4;
		}

		// RVP: Stupeň
		if (filters.stupen && game.rvp) {
			if (game.rvp.stupen.includes(filters.stupen)) score += 4;
			else score -= 2;
		}

		// RVP: Kompetence
		if (filters.kompetence && game.rvp) {
			if (game.rvp.kompetence.includes(filters.kompetence)) score += 5;
			else score -= 1;
		}

		// RVP: Oblast
		if (filters.oblast && game.rvp) {
			if (game.rvp.oblasti.includes(filters.oblast)) score += 5;
			else score -= 1;
		}

		return score;
	}

	function createFallbackGame() {
		return {
			id: 'fallback-001',
			title: 'Kruh jmen',
			pitch: 'Klasická seznamovací hra, kde si hráči házejí míček a říkají jména — jednoduché, účinné a funguje kdekoli!',
			playerCount: { min: 5, max: 30 },
			ageRange: { min: 5, max: 99 },
			duration: { min: 5, max: 15 },
			setting: 'any',
			materials: ['Jeden měkký míček nebo pytlík s fazolemi'],
			instructions: [
				'Hráči stojí v kruhu.',
				'První hráč řekne své jméno a hodí míček někomu jinému.',
				'Chytající řekne „Děkuji, [jméno]!" a pak řekne své vlastní jméno a hodí míček dál.',
				'Pokračujte, dokud všichni nechytili míček alespoň jednou.',
				'Kolo 2: Zkuste si zapamatovat a říct jméno toho, komu házíte.'
			],
			learningGoals: ['zapamatování jmen', 'sociální propojení', 'aktivní naslouchání'],
			reflectionPrompts: ['Kolik jmen si pamatujete?', 'Co vám pomohlo zapamatovat si jména?'],
			safetyNotes: ['Používejte měkký míček', 'Zajistěte dostatek prostoru mezi hráči'],
			adaptationTips: ['Přidejte kategorie (oblíbené jídlo + jméno)', 'Použijte více míčků pro výzvu'],
			facilitatorNotes: 'Skvělé pro první setkání. Udržujte lehkou a hravou atmosféru. Netlačte na paměť.',
			rvp: {
				kompetence: ['komunikativni', 'socialni-personalni'],
				oblasti: ['clovek-svet'],
				stupen: ['prvni', 'druhy'],
				prurezova_temata: ['osobnostni-vychova'],
				ocekavane_vystupy: [
					'Žák se představí a aktivně naslouchá ostatním',
					'Žák spolupracuje ve skupině a respektuje pravidla'
				],
				doporucene_hodnoceni: ['slovni', 'sebahodnoceni']
			}
		};
	}

	function getRvp() { return rvpData; }
	function getAll() { return [...sampleGames]; }
	function getCount() { return sampleGames.length; }

	return { load, generate, getAll, getCount, getRvp };
})();

// Expose globally so scripts loaded after this one can reference window.GameData
window.GameData = GameData;
