'use strict';
// Level perks cost coins: debited on use outside EDU, on teacher approval in
// EDU. The debit locks the profile row and never goes below zero.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { applyPerkCharge } = require('../lib/coin-ledger');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');

function fakeClient(coins) {
	const calls = [];
	let balance = coins;
	return {
		calls,
		async query(sql, params) {
			calls.push(sql);
			if (/FOR UPDATE/.test(sql)) return { rows: balance === null ? [] : [{ coins: balance }] };
			if (/^UPDATE public\.profiles SET coins/.test(sql)) {
				const [price] = params;
				if (balance < price) return { rows: [] };
				balance -= price;
				return { rows: [{ coins: balance }] };
			}
			return { rows: [] };
		}
	};
}

describe('applyPerkCharge', () => {
	it('locks the profile, debits, writes a ledger row and the charged amount', async () => {
		const c = fakeClient(1000);
		const r = await applyPerkCharge(c, { userId: 'u', claimId: 'k', perkKey: 'phone_break', cost: 300 });
		assert.deepEqual(r, { status: 'ok', balance: 700, charged: 300 });
		assert.match(c.calls[0], /FOR UPDATE/);
		assert.ok(c.calls.some((q) => /INSERT INTO public\.coin_transactions/.test(q)));
		assert.ok(c.calls.some((q) => /SET coins_charged/.test(q)));
	});
	it('refuses when the balance is too low and writes nothing', async () => {
		const c = fakeClient(100);
		const r = await applyPerkCharge(c, { userId: 'u', claimId: 'k', perkKey: 'mentor_day', cost: 5000 });
		assert.equal(r.status, 'insufficient');
		assert.ok(!c.calls.some((q) => /INSERT INTO public\.coin_transactions/.test(q)));
	});
	it('a free perk and a missing profile', async () => {
		assert.equal((await applyPerkCharge(fakeClient(0), { userId: 'u', claimId: 'k', perkKey: 'x', cost: 0 })).charged, 0);
		assert.equal((await applyPerkCharge(fakeClient(null), { userId: 'u', claimId: 'k', perkKey: 'x', cost: 5 })).status, 'no_profile');
	});
});

describe('perk routes use the charge', () => {
	const src = read('server.js');
	it('use: outside EDU the claim insert and the debit share one transaction', () => {
		const route = src.slice(src.indexOf("app.post('/api/rpg/perks/:key/use'"), src.indexOf("app.get('/api/edu/perk-requests'"));
		assert.match(route, /code: 'INSUFFICIENT_COINS'/);
		const begin = route.indexOf("client.query('BEGIN')");
		const insert = route.indexOf('INSERT INTO public.rpg_perk_uses');
		const charge = route.indexOf('applyPerkCharge(client');
		const commit = route.indexOf("client.query('COMMIT')");
		assert.ok(begin > 0 && begin < insert && insert < charge && charge < commit);
		assert.match(route, /if \(initialStatus === 'auto_approved'\) \{\n\t+const charge = await applyPerkCharge/);
	});
	it('teacher approval debits the student; not enough coins rolls back and keeps it pending', () => {
		const route = src.slice(src.indexOf("app.post('/api/edu/perk-requests/:id/decide'"), src.indexOf("app.get('/api/edu/students/:userId/rpg'"));
		assert.match(route, /if \(newStatus === 'approved'\) \{/);
		assert.match(route, /applyPerkCharge\(client, \{ userId: rows\[0\]\.user_id/);
		assert.match(route, /STUDENT_INSUFFICIENT_COINS/);
	});
	it('migration sets a price for every perk and the card says to agree with the teacher', () => {
		const sql = read('supabase/migrations/042_perk_coin_cost.sql');
		for (const k of ['phone_break', 'micro_pause', 'own_soundtrack', 'free_seat', 'skip_task', 'topic_choice', 'second_try', 'late_start', 'mentor_day']) {
			assert.match(sql, new RegExp(`'${k}',\\s+\\d+`), k);
		}
		const ui = read('public/js/rpg-screen.js');
		assert.match(ui, /Dohodni sa s ním vopred/);
		assert.match(ui, /Použiť za \$\{cost\}/);
	});
});
