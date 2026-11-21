'use strict';
// Daily XP caps in session completion must lock the profile row before the
// COUNT, otherwise parallel completions for the same player both pass the cap.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'routes', 'sessions.js'), 'utf8').replace(/\r\n/g, '\n');

describe('session completion cap locking', () => {
	it('locks each participant profile before counting session_complete rows', () => {
		const lock = src.indexOf("public.profiles WHERE id = $1 FOR UPDATE',\n\t\t\t\t\t\t[p.user_id]");
		const count = src.indexOf("action = 'session_complete' AND created_at >= CURRENT_DATE");
		assert.ok(lock > 0 && count > 0, 'both statements exist');
		assert.ok(lock < count, 'FOR UPDATE comes before the cap COUNT');
	});

	it('locks participants in a stable order', () => {
		assert.match(src, /const orderedParts = \[\.\.\.parts\]\.sort\(/);
		assert.match(src, /for \(const p of orderedParts\)/);
	});

	it('locks the host profile before counting host XP sessions', () => {
		const lock = src.indexOf("public.profiles WHERE id = $1 FOR UPDATE',\n\t\t\t\t\t\t[user.id]");
		const count = src.indexOf('host_xp_awarded > 0 AND completed_at >= CURRENT_DATE');
		assert.ok(lock > 0 && count > 0, 'both statements exist');
		assert.ok(lock < count, 'FOR UPDATE comes before the host cap COUNT');
	});
});
