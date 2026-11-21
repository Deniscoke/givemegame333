'use strict';

// Prompt snapshot + schema tests for lib/game-prompt.js and lib/methodologies.js.
// Regenerate snapshots after an intentional prompt change with:
//   UPDATE_SNAPSHOTS=1 node --test test/game-prompt.test.js
// and review the diff of test/fixtures/game-prompt-snapshots.json.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const G = require('../lib/game-prompt');
const M = require('../lib/methodologies');
const { MODES, DURATION_PRESETS, AGE_BANDS } = require('../lib/filter-presets');

const SNAPSHOT_FILE = path.join(__dirname, 'fixtures', 'game-prompt-snapshots.json');
const UPDATE = process.env.UPDATE_SNAPSHOTS === '1';
const DURATIONS = ['', ...Object.keys(DURATION_PRESETS)];

function promptParts(filters) {
	return {
		exact: G.buildExactValuesBlock(filters),
		constraints: G.buildFilterDescription(filters),
		didactic: G.buildDidacticGuidance(filters)
	};
}

function buildSnapshots() {
	const out = { system: G.buildSystemPrompt() };
	for (const mode of MODES) {
		for (const duration of DURATIONS) {
			const filters = { mode, duration, ageMin: '11', ageMax: '15', players: 'group', setting: 'any', energy: 'medium' };
			out[`${mode}|${duration || 'any'}`] = promptParts(filters);
		}
	}
	out['user|acceptance'] = G.buildUserPrompt({
		filters: { mode: 'classroom', duration: 'speedrun', ageMin: '15', ageMax: '19', players: 'pair', setting: 'any' },
		aiLanguage: 'Slovak', langCode: 'sk'
	});
	return out;
}

describe('game-prompt: snapshots per mode × duration', () => {
	const current = buildSnapshots();
	if (UPDATE) {
		fs.mkdirSync(path.dirname(SNAPSHOT_FILE), { recursive: true });
		fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(current, null, 2) + '\n');
	}
	const stored = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));

	it('covers every mode × duration combination', () => {
		assert.equal(Object.keys(stored).length, Object.keys(current).length);
	});

	for (const key of Object.keys(current)) {
		it(`matches snapshot: ${key}`, () => {
			assert.deepEqual(current[key], stored[key]);
		});
	}
});

describe('game-prompt: system prompt (static, cacheable)', () => {
	const sys = G.buildSystemPrompt();

	it('is identical on every call (prompt cache prefix)', () => {
		assert.equal(G.buildSystemPrompt(), sys);
	});

	it('stays above the 1024-token cache threshold and below a growth cap', () => {
		// ~4 chars per token: >= 4400 chars keeps it safely above 1024 tokens.
		assert.ok(sys.length >= 4400, `too short: ${sys.length}`);
		assert.ok(sys.length <= 8000, `prompt grew too much: ${sys.length}`);
	});

	it('contains the full methodology catalogue', () => {
		for (const m of M.METHODOLOGIES) assert.ok(sys.includes(`- ${m.id} — ${m.name}`), m.id);
		for (const word of ['Kolb', 'Junák', 'Hahn', 'Cooperative', 'Drama', 'Comenius', 'Bloom', 'PBL', 'Design thinking', 'So what?', 'Energizer', 'Intuitive']) {
			assert.ok(sys.includes(word), word);
		}
	});

	it('no longer tells the model to avoid scaffolding or push Gen Z slang on everyone', () => {
		assert.ok(!/AVOID:.*scaffolding/.test(sys));
		assert.ok(!sys.includes('no cap'));
	});

	it('schema asks for methodology, Game Pack fields, the online mode and the stredni stupeň', () => {
		const schema = JSON.parse(G.COMPACT_GAME_SCHEMA);
		assert.equal(typeof schema.methodology, 'string');
		assert.ok(schema.playerBrief && Array.isArray(schema.lessonFlow));
		assert.ok(schema.mode.split('|').includes('online'));
		assert.deepEqual(schema.rvp.stupen.split('|'), ['prvni', 'druhy', 'stredni']);
	});
});

describe('game-prompt: user prompt', () => {
	const base = { aiLanguage: 'Slovak', langCode: 'sk' };

	it('acceptance brief: speedrun + 15-19 + pair', () => {
		const u = G.buildUserPrompt({ ...base, filters: { mode: 'classroom', duration: 'speedrun', ageMin: '15', ageMax: '19', players: 'pair' } });
		assert.match(u, /duration: \{ min: 5, max: 10 \}/);
		assert.match(u, /playerCount: \{ min: 2, max: 2 \}/);
		assert.match(u, /ageRange: \{ min: 15, max: 19 \}/);
		assert.match(u, /rvp\.stupen: "stredni"/);
		assert.match(u, /SPEEDRUN RULE/);
		assert.match(u, /METHODOLOGY: build the game on energizer/);
	});

	it('keeps per-request growth modest (catalogue is not repeated)', () => {
		const u = G.buildUserPrompt({ ...base, filters: { mode: 'party', duration: 'classic', ageMin: '8', ageMax: '11', players: 'group' } });
		assert.ok(u.length < 4200, `user prompt too long: ${u.length}`);
		assert.ok(!u.includes('METHODOLOGY CATALOGUE'));
	});

	it('online mode gets remote-safe rules', () => {
		const c = G.buildFilterDescription({ mode: 'online' });
		assert.match(c, /remote-safe/);
		assert.match(c, /"mode" MUST be "online"/);
	});

	it('derives stupeň from age when no stupen filter is set', () => {
		assert.match(G.buildFilterDescription({ ageMin: '6', ageMax: '8' }), /rvp\.stupen: MUST be "prvni"/);
		assert.match(G.buildFilterDescription({ stupen: 'druhy', ageMin: '15', ageMax: '19' }), /rvp\.stupen: MUST be "druhy"/);
	});

	it('legacy squad/duration values still produce the new ranges', () => {
		assert.match(G.buildExactValuesBlock({ players: 'small', duration: 'quick' }), /playerCount: \{ min: 3, max: 6 \}\nduration: \{ min: 5, max: 10 \}/);
	});

	it('includes remix and knowledge blocks when given', () => {
		const u = G.buildUserPrompt({
			...base, filters: {}, knowledgeSummary: 'FACTS',
			remix: { title: 'Old', mode: 'party', kompetence: ['k-uceni'], learningGoals: ['x'] }
		});
		assert.match(u, /SOURCE OF KNOWLEDGE[\s\S]*FACTS/);
		assert.match(u, /Original game: "Old"/);
	});

	it('every language has a task block', () => {
		for (const code of ['sk', 'cs', 'en', 'de', 'es', 'tr']) assert.ok(G.TASK_BLOCKS[code], code);
	});

	it('formatUsageLog reports cached prompt tokens', () => {
		assert.equal(
			G.formatUsageLog({ prompt_tokens: 2100, completion_tokens: 900, prompt_tokens_details: { cached_tokens: 1536 } }),
			'prompt=2100 cached=1536 completion=900'
		);
		assert.equal(G.formatUsageLog({ prompt_tokens: 10 }), 'prompt=10 cached=0 completion=0');
		assert.equal(G.formatUsageLog(undefined), '');
	});
});

describe('methodologies: selection', () => {
	it('every mode × duration × age band gets 1-2 picks that fit mode and duration', () => {
		for (const mode of MODES) {
			for (const duration of Object.keys(DURATION_PRESETS)) {
				for (const band of Object.values(AGE_BANDS)) {
					const picks = M.selectMethodologies({ mode, duration, ageMin: band.min, ageMax: band.max });
					assert.ok(picks.length >= 1 && picks.length <= 2);
					assert.ok(picks[0].modes.includes(mode), `${mode}/${duration}/${band.min}: ${picks[0].id}`);
					assert.ok(picks[0].durations.includes(duration), `${mode}/${duration}/${band.min}: ${picks[0].id}`);
				}
			}
		}
	});

	it('speedrun party picks the energizer', () => {
		assert.equal(M.selectMethodologies({ mode: 'party', duration: 'speedrun' })[0].id, 'energizer');
	});

	it('teen classroom marathon reaches PBL / design thinking / Bloom', () => {
		const ids = M.selectMethodologies({ mode: 'classroom', duration: 'marathon', ageMin: 15, ageMax: 19 }).map(m => m.id);
		assert.ok(ids.some(id => ['pbl', 'design-thinking', 'bloom'].includes(id)), ids.join(','));
	});

	it('is deterministic without rng and varies ties with rng', () => {
		const f = { mode: 'party', duration: 'classic' };
		assert.deepEqual(M.selectMethodologies(f).map(m => m.id), M.selectMethodologies(f).map(m => m.id));
		const seen = new Set();
		for (let i = 0; i < 60; i++) seen.add(M.selectMethodologies(f, { rng: Math.random }).map(m => m.id).join('+'));
		assert.ok(seen.size > 1);
	});

	it('online mode has remote-safe entries', () => {
		assert.ok(M.METHODOLOGIES.filter(m => m.modes.includes('online')).length >= 3);
	});

	it('catalogue entries are well-formed and unique', () => {
		const ids = new Set();
		for (const m of M.METHODOLOGIES) {
			assert.ok(!ids.has(m.id)); ids.add(m.id);
			assert.ok(m.name && m.idea && m.apply);
			assert.ok(m.modes.every(x => MODES.includes(x)), m.id);
			assert.ok(m.durations.every(x => x in DURATION_PRESETS), m.id);
			assert.ok(m.ageBands.every(x => x in AGE_BANDS), m.id);
		}
	});

	it('bandsForAge handles single ages and ranges', () => {
		assert.deepEqual(M.bandsForAge(8, 8), ['6-8', '8-11']);
		assert.deepEqual(M.bandsForAge(8, 11), ['8-11']);
		assert.deepEqual(M.bandsForAge(6, 19), ['6-8', '8-11', '11-15', '15-19']);
	});
});

describe('game-prompt: validateGame with fixture games', () => {
	const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'generated-games.json'), 'utf8'));

	it('accepts the valid fixture games', () => {
		for (const game of fixtures.valid) assert.deepEqual(G.validateGame(game), [], game.title);
	});

	it('requires methodology', () => {
		const { methodology, ...game } = fixtures.valid[0];
		assert.ok(G.validateGame(game).includes('Missing or empty field: methodology'));
	});

	it('rejects an unknown stupeň and non-object output', () => {
		const game = { ...fixtures.valid[0], rvp: { stupen: 'treti' } };
		assert.ok(G.validateGame(game).some(e => e.startsWith('rvp.stupen')));
		assert.deepEqual(G.validateGame(null), ['Output is not a JSON object']);
		assert.deepEqual(G.validateGame([]), ['Output is not a JSON object']);
	});

	it('applyMethodologyFallback fills a missing methodology from the pick', () => {
		const { methodology, ...game } = fixtures.valid[0];
		const picks = M.selectMethodologies({ mode: 'party', duration: 'speedrun' });
		G.applyMethodologyFallback(game, picks);
		assert.equal(game.methodology, picks.map(m => m.name).join(' + '));
		assert.deepEqual(G.validateGame(game), []);
		const kept = G.applyMethodologyFallback({ methodology: 'Kolb' }, picks);
		assert.equal(kept.methodology, 'Kolb');
	});

	it('repair prompt lists methodology as required', () => {
		const p = G.buildRepairPrompt('{}', ['Missing or empty field: methodology'], 'Slovak');
		assert.match(p, /Required string fields: id, title, pitch, methodology/);
		assert.match(p, /Write ALL text content in Slovak/);
	});
});
