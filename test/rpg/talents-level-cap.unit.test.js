'use strict';

// Phase 5: talent descriptions are stat-only; M7: one level-cap helper.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { RPG_TALENTS, statOnlyDescription } = require('../../lib/rpg-talents');
const { COMPETENCY_TO_STAT, TIER_BONUS, getEffectiveStats } = require('../../lib/rpg-progression');
const { applyLevelCap, FREE_LIMITS } = require('../../lib/billing');

const server = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8').replace(/\r\n/g, '\n');

function routeBody(method, route) {
	const start = server.indexOf(`app.${method}('${route}'`);
	assert.ok(start >= 0, `${method} ${route} exists`);
	const next = server.indexOf('\napp.', start + 1);
	return server.slice(start, next < 0 ? undefined : next);
}

describe('talent descriptions (stat-only)', () => {
	it('every description states exactly the stat bonus the talent gives', () => {
		assert.equal(RPG_TALENTS.length, 42);
		for (const t of RPG_TALENTS) {
			assert.match(t.description, /^\+(3|5|10) k atribútu [A-Za-zÁ-ž]+ \([^)]+\)$/, `${t.id}: ${t.description}`);
			assert.ok(t.description.startsWith(`+${TIER_BONUS[t.tier]} `), `${t.id} bonus`);
			assert.doesNotMatch(t.description, /%|coin|XP|×|2×|titul|challenge/i, `${t.id} promises no unbuilt effect`);
			const stats = getEffectiveStats(null, [t]).bonuses;
			assert.equal(stats[COMPETENCY_TO_STAT[t.competency]], TIER_BONUS[t.tier]);
		}
	});

	it('talents 201, 403 and 603 no longer promise XP or coin effects', () => {
		for (const id of [201, 403, 603]) {
			const t = RPG_TALENTS.find((x) => x.id === id);
			assert.equal(t.description, statOnlyDescription(t));
		}
		assert.throws(() => { RPG_TALENTS[0].description = 'x'; });
	});
});

describe('free-tier level cap (M7)', () => {
	it('caps free users at FREE_LIMITS.maxLevel and leaves paid tiers alone', () => {
		const prog = { level: 8, xp: 30000 };
		assert.deepEqual(applyLevelCap(prog, 'free'), { ...prog, level: FREE_LIMITS.maxLevel, capped: true, capReason: 'free_tier' });
		assert.equal(applyLevelCap(prog, null).level, FREE_LIMITS.maxLevel);
		assert.equal(applyLevelCap(prog, 'pro'), prog);
		assert.equal(applyLevelCap({ level: 2 }, 'free').capped, undefined);
		assert.equal(applyLevelCap(null, 'free'), null);
	});

	it('the three level-gated routes use the shared helper', () => {
		assert.match(routeBody('get', '/api/rpg/talents'), /applyLevelCap\(computeRpgLevel\(/);
		assert.match(routeBody('get', '/api/rpg/perks'), /applyLevelCap\(computeRpgLevel\(/);
		assert.match(routeBody('post', '/api/rpg/perks/:key/use'), /applyLevelCap\(computeRpgLevel\(/);
		assert.doesNotMatch(server, /^function applyLevelCap/m, 'no second copy in server.js');
	});
});

describe('generation issues a play ticket', () => {
	it('the generate route stores the server copy before responding', () => {
		const body = routeBody('post', '/api/generate-game');
		assert.match(body, /PlayTickets\.issueGenerationTicket\(coinsDbPool, genUser\.id, game, f\.mode\)/);
		assert.ok(body.indexOf('issueGenerationTicket') < body.lastIndexOf('res.json(game)'));
	});
});
