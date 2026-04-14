/**
 * test/rpg/avatar.integration.test.js
 * Integration tests for RPG Avatar API (GET/PATCH /api/rpg/avatar)
 *
 * Tests school-membership gating, avatar validation, rate limiting,
 * and role enforcement. Uses a mock Supabase auth + mock pg pool.
 *
 * Run: node --test test/rpg/avatar.integration.test.js
 */

'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const {
  VALID_AVATAR_IDS,
  RPG_ELIGIBLE_ROLES,
  isValidAvatarId,
  getAvatarManifest,
  getAvatarById,
  RPG_AVATAR_SWITCH_COST,
} = require('../../lib/rpg-avatars');

// ─────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────
const USER_ID  = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const SCHOOL_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

// ─────────────────────────────────────────────────────────────
// Unit tests for the manifest module
// ─────────────────────────────────────────────────────────────
describe('rpg-avatars manifest', () => {
  it('VALID_AVATAR_IDS contains exactly 2-8', () => {
    assert.deepStrictEqual(VALID_AVATAR_IDS, [2, 3, 4, 5, 6, 7, 8]);
  });

  it('isValidAvatarId accepts null (deselect)', () => {
    assert.strictEqual(isValidAvatarId(null), true);
  });

  it('isValidAvatarId accepts valid IDs 2-8', () => {
    for (const id of [2, 3, 4, 5, 6, 7, 8]) {
      assert.strictEqual(isValidAvatarId(id), true, `id=${id} should be valid`);
    }
  });

  it('isValidAvatarId rejects id=1 (sprite sheet)', () => {
    assert.strictEqual(isValidAvatarId(1), false);
  });

  it('isValidAvatarId rejects id=0', () => {
    assert.strictEqual(isValidAvatarId(0), false);
  });

  it('isValidAvatarId rejects id=9', () => {
    assert.strictEqual(isValidAvatarId(9), false);
  });

  it('isValidAvatarId rejects id=999', () => {
    assert.strictEqual(isValidAvatarId(999), false);
  });

  it('isValidAvatarId rejects undefined', () => {
    assert.strictEqual(isValidAvatarId(undefined), false);
  });

  it('isValidAvatarId rejects string "2"', () => {
    assert.strictEqual(isValidAvatarId('2'), false);
  });

  it('getAvatarManifest returns 7 entries', () => {
    const manifest = getAvatarManifest();
    assert.strictEqual(manifest.length, 7);
    assert.strictEqual(manifest[0].id, 2);
    assert.strictEqual(manifest[6].id, 8);
  });

  it('each manifest entry has id, label, src, theme, flavor', () => {
    for (const a of getAvatarManifest()) {
      assert.ok(typeof a.id === 'number');
      assert.ok(typeof a.label === 'string' && a.label.length > 0);
      assert.ok(typeof a.src === 'string' && a.src.startsWith('/avatars/'));
      assert.ok(typeof a.theme === 'string' && a.theme.length > 0);
      assert.ok(typeof a.flavor === 'string' && a.flavor.length > 0);
    }
  });

  it('getAvatarById returns Sage for id 7', () => {
    const a = getAvatarById(7);
    assert.ok(a);
    assert.strictEqual(a.label, 'Sage');
    assert.strictEqual(a.theme, 'sage');
  });

  it('RPG_AVATAR_SWITCH_COST is 5000', () => {
    assert.strictEqual(RPG_AVATAR_SWITCH_COST, 5000);
  });

  it('RPG_ELIGIBLE_ROLES matches Sprint 1 roles (no parent)', () => {
    assert.deepStrictEqual(RPG_ELIGIBLE_ROLES, ['admin', 'teacher', 'student']);
    assert.ok(!RPG_ELIGIBLE_ROLES.includes('parent'));
  });
});

// ─────────────────────────────────────────────────────────────
// HTTP integration tests
// ─────────────────────────────────────────────────────────────

// Build a minimal Express server that mirrors the RPG avatar endpoints
// from server.js, but with injectable mocks (coin + avatar state).
function buildRpgServer({ authUser, membershipRole, currentAvatarId, initialCoins = 100000, updateRowCount }) {
  const _rateBuckets = new Map();
  let avatarId = currentAvatarId == null ? null : currentAvatarId;
  let coins = initialCoins;

  function rpgRateLimit(userId, maxReqs, windowMs) {
    const key = `rpg-avatar:${userId}`;
    const now = Date.now();
    const bucket = _rateBuckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      _rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (bucket.count >= maxReqs) return false;
    bucket.count++;
    return true;
  }

  async function requireSupabaseUser(req, res) {
    if (!authUser) {
      res.status(401).json({ error: 'Not authenticated' });
      return null;
    }
    return authUser;
  }

  async function getMembership(userId) {
    if (!membershipRole) return null;
    if (!RPG_ELIGIBLE_ROLES.includes(membershipRole)) return null;
    return { role: membershipRole, school_name: 'Test Skola' };
  }

  const app = express();
  app.use(express.json());

  app.get('/api/rpg/avatar', async (req, res) => {
    const user = await requireSupabaseUser(req, res);
    if (!user) return;
    const membership = await getMembership(user.id);
    const eligible = membership !== null;
    res.json({
      eligible,
      role: eligible ? membership.role : null,
      school_name: eligible ? membership.school_name : null,
      current_avatar_id: avatarId,
      coins,
      avatar_switch_cost: RPG_AVATAR_SWITCH_COST,
      available: getAvatarManifest(),
    });
  });

  app.patch('/api/rpg/avatar', async (req, res) => {
    const user = await requireSupabaseUser(req, res);
    if (!user) return;
    const membership = await getMembership(user.id);
    if (!membership) {
      return res.status(403).json({ error: 'Musíš byť členom školy pre výber avatara.' });
    }
    if (!rpgRateLimit(user.id, 10, 15 * 60 * 1000)) {
      return res.status(429).json({ error: 'Príliš veľa zmien avatara. Skúste neskôr.' });
    }
    const { avatar_id } = req.body || {};
    if (!isValidAvatarId(avatar_id)) {
      return res.status(400).json({ error: `Neplatný avatar. Povolené: ${VALID_AVATAR_IDS.join(', ')} alebo null` });
    }
    const rowCount = updateRowCount !== undefined ? updateRowCount : 1;
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Profil nenájdený' });
    }

    if (avatar_id === null) {
      avatarId = null;
      return res.json({ ok: true, avatar_id: null, coins_remaining: coins, cost_paid: 0 });
    }
    if (avatar_id === avatarId) {
      return res.json({ ok: true, avatar_id, coins_remaining: coins, cost_paid: 0 });
    }
    if (coins < RPG_AVATAR_SWITCH_COST) {
      return res.status(402).json({
        error: `Nedostatok coinov. Zmena avatara stojí ${RPG_AVATAR_SWITCH_COST} gIVEMECOIN.`,
        code: 'INSUFFICIENT_COINS',
        required: RPG_AVATAR_SWITCH_COST,
        coins,
      });
    }
    coins -= RPG_AVATAR_SWITCH_COST;
    avatarId = avatar_id;
    return res.json({
      ok: true,
      avatar_id,
      coins_remaining: coins,
      cost_paid: RPG_AVATAR_SWITCH_COST,
    });
  });

  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(res)),
        _rateBuckets,
      });
    });
  });
}

async function req(baseUrl, path, opts = {}) {
  const res = await fetch(baseUrl + path, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  let body;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

// ─────────────────────────────────────────────────────────────
describe('GET /api/rpg/avatar', () => {
  it('returns 401 without auth', async () => {
    const ctx = await buildRpgServer({ authUser: null, membershipRole: null });
    try {
      const r = await req(ctx.baseUrl, '/api/rpg/avatar');
      assert.strictEqual(r.status, 401);
    } finally { await ctx.close(); }
  });

  it('returns eligible=false when user has no school membership', async () => {
    const ctx = await buildRpgServer({ authUser: { id: USER_ID, email: 'a@b.c' }, membershipRole: null });
    try {
      const r = await req(ctx.baseUrl, '/api/rpg/avatar');
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.eligible, false);
      assert.strictEqual(r.body.role, null);
      assert.strictEqual(r.body.school_name, null);
    } finally { await ctx.close(); }
  });

  it('returns eligible=true for admin', async () => {
    const ctx = await buildRpgServer({ authUser: { id: USER_ID, email: 'a@b.c' }, membershipRole: 'admin' });
    try {
      const r = await req(ctx.baseUrl, '/api/rpg/avatar');
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.eligible, true);
      assert.strictEqual(r.body.role, 'admin');
    } finally { await ctx.close(); }
  });

  it('returns eligible=true for teacher', async () => {
    const ctx = await buildRpgServer({ authUser: { id: USER_ID, email: 'a@b.c' }, membershipRole: 'teacher' });
    try {
      const r = await req(ctx.baseUrl, '/api/rpg/avatar');
      assert.strictEqual(r.body.eligible, true);
      assert.strictEqual(r.body.role, 'teacher');
    } finally { await ctx.close(); }
  });

  it('returns eligible=true for student', async () => {
    const ctx = await buildRpgServer({ authUser: { id: USER_ID, email: 'a@b.c' }, membershipRole: 'student' });
    try {
      const r = await req(ctx.baseUrl, '/api/rpg/avatar');
      assert.strictEqual(r.body.eligible, true);
      assert.strictEqual(r.body.role, 'student');
    } finally { await ctx.close(); }
  });

  it('returns eligible=false for parent role (blocked)', async () => {
    const ctx = await buildRpgServer({ authUser: { id: USER_ID, email: 'a@b.c' }, membershipRole: 'parent' });
    try {
      const r = await req(ctx.baseUrl, '/api/rpg/avatar');
      assert.strictEqual(r.body.eligible, false);
    } finally { await ctx.close(); }
  });

  it('returns available manifest with 7 avatars', async () => {
    const ctx = await buildRpgServer({ authUser: { id: USER_ID, email: 'a@b.c' }, membershipRole: 'student' });
    try {
      const r = await req(ctx.baseUrl, '/api/rpg/avatar');
      assert.strictEqual(r.body.available.length, 7);
      const ids = r.body.available.map(a => a.id);
      assert.deepStrictEqual(ids, [2, 3, 4, 5, 6, 7, 8]);
    } finally { await ctx.close(); }
  });

  it('returns avatar_switch_cost and coins', async () => {
    const ctx = await buildRpgServer({ authUser: { id: USER_ID, email: 'a@b.c' }, membershipRole: 'student', initialCoins: 12345 });
    try {
      const r = await req(ctx.baseUrl, '/api/rpg/avatar');
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.avatar_switch_cost, RPG_AVATAR_SWITCH_COST);
      assert.strictEqual(r.body.coins, 12345);
    } finally { await ctx.close(); }
  });

  it('returns current_avatar_id when set', async () => {
    const ctx = await buildRpgServer({ authUser: { id: USER_ID, email: 'a@b.c' }, membershipRole: 'admin', currentAvatarId: 5 });
    try {
      const r = await req(ctx.baseUrl, '/api/rpg/avatar');
      assert.strictEqual(r.body.current_avatar_id, 5);
    } finally { await ctx.close(); }
  });

  it('returns current_avatar_id=null when not set', async () => {
    const ctx = await buildRpgServer({ authUser: { id: USER_ID, email: 'a@b.c' }, membershipRole: 'admin', currentAvatarId: null });
    try {
      const r = await req(ctx.baseUrl, '/api/rpg/avatar');
      assert.strictEqual(r.body.current_avatar_id, null);
    } finally { await ctx.close(); }
  });
});

// ─────────────────────────────────────────────────────────────
describe('PATCH /api/rpg/avatar', () => {
  it('returns 401 without auth', async () => {
    const ctx = await buildRpgServer({ authUser: null, membershipRole: null });
    try {
      const r = await req(ctx.baseUrl, '/api/rpg/avatar', {
        method: 'PATCH', body: JSON.stringify({ avatar_id: 2 })
      });
      assert.strictEqual(r.status, 401);
    } finally { await ctx.close(); }
  });

  it('returns 403 when user has no school membership', async () => {
    const ctx = await buildRpgServer({ authUser: { id: USER_ID, email: 'a@b.c' }, membershipRole: null });
    try {
      const r = await req(ctx.baseUrl, '/api/rpg/avatar', {
        method: 'PATCH', body: JSON.stringify({ avatar_id: 2 })
      });
      assert.strictEqual(r.status, 403);
    } finally { await ctx.close(); }
  });

  it('returns 403 for parent role', async () => {
    const ctx = await buildRpgServer({ authUser: { id: USER_ID, email: 'a@b.c' }, membershipRole: 'parent' });
    try {
      const r = await req(ctx.baseUrl, '/api/rpg/avatar', {
        method: 'PATCH', body: JSON.stringify({ avatar_id: 2 })
      });
      assert.strictEqual(r.status, 403);
    } finally { await ctx.close(); }
  });

  it('accepts valid avatar_id=2 (Scholar)', async () => {
    const ctx = await buildRpgServer({ authUser: { id: USER_ID, email: 'a@b.c' }, membershipRole: 'student' });
    try {
      const r = await req(ctx.baseUrl, '/api/rpg/avatar', {
        method: 'PATCH', body: JSON.stringify({ avatar_id: 2 })
      });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.ok, true);
      assert.strictEqual(r.body.avatar_id, 2);
      assert.strictEqual(r.body.cost_paid, RPG_AVATAR_SWITCH_COST);
      assert.strictEqual(r.body.coins_remaining, 100000 - RPG_AVATAR_SWITCH_COST);
    } finally { await ctx.close(); }
  });

  it('accepts valid avatar_id=8 (Knight)', async () => {
    const ctx = await buildRpgServer({ authUser: { id: USER_ID, email: 'a@b.c' }, membershipRole: 'teacher' });
    try {
      const r = await req(ctx.baseUrl, '/api/rpg/avatar', {
        method: 'PATCH', body: JSON.stringify({ avatar_id: 8 })
      });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.avatar_id, 8);
      assert.strictEqual(r.body.cost_paid, RPG_AVATAR_SWITCH_COST);
    } finally { await ctx.close(); }
  });

  it('accepts null (deselect avatar)', async () => {
    const ctx = await buildRpgServer({ authUser: { id: USER_ID, email: 'a@b.c' }, membershipRole: 'admin' });
    try {
      const r = await req(ctx.baseUrl, '/api/rpg/avatar', {
        method: 'PATCH', body: JSON.stringify({ avatar_id: null })
      });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.ok, true);
      assert.strictEqual(r.body.avatar_id, null);
      assert.strictEqual(r.body.cost_paid, 0);
    } finally { await ctx.close(); }
  });

  it('returns 402 when coins are below avatar switch cost', async () => {
    const ctx = await buildRpgServer({
      authUser: { id: USER_ID, email: 'a@b.c' },
      membershipRole: 'student',
      initialCoins: 100,
    });
    try {
      const r = await req(ctx.baseUrl, '/api/rpg/avatar', {
        method: 'PATCH',
        body: JSON.stringify({ avatar_id: 2 }),
      });
      assert.strictEqual(r.status, 402);
      assert.strictEqual(r.body.code, 'INSUFFICIENT_COINS');
      assert.strictEqual(r.body.required, RPG_AVATAR_SWITCH_COST);
    } finally { await ctx.close(); }
  });

  it('rejects avatar_id=1 (sprite sheet, not selectable)', async () => {
    const ctx = await buildRpgServer({ authUser: { id: USER_ID, email: 'a@b.c' }, membershipRole: 'student' });
    try {
      const r = await req(ctx.baseUrl, '/api/rpg/avatar', {
        method: 'PATCH', body: JSON.stringify({ avatar_id: 1 })
      });
      assert.strictEqual(r.status, 400);
    } finally { await ctx.close(); }
  });

  it('rejects avatar_id=0', async () => {
    const ctx = await buildRpgServer({ authUser: { id: USER_ID, email: 'a@b.c' }, membershipRole: 'student' });
    try {
      const r = await req(ctx.baseUrl, '/api/rpg/avatar', {
        method: 'PATCH', body: JSON.stringify({ avatar_id: 0 })
      });
      assert.strictEqual(r.status, 400);
    } finally { await ctx.close(); }
  });

  it('rejects avatar_id=9 (out of range)', async () => {
    const ctx = await buildRpgServer({ authUser: { id: USER_ID, email: 'a@b.c' }, membershipRole: 'student' });
    try {
      const r = await req(ctx.baseUrl, '/api/rpg/avatar', {
        method: 'PATCH', body: JSON.stringify({ avatar_id: 9 })
      });
      assert.strictEqual(r.status, 400);
    } finally { await ctx.close(); }
  });

  it('rejects avatar_id=999', async () => {
    const ctx = await buildRpgServer({ authUser: { id: USER_ID, email: 'a@b.c' }, membershipRole: 'student' });
    try {
      const r = await req(ctx.baseUrl, '/api/rpg/avatar', {
        method: 'PATCH', body: JSON.stringify({ avatar_id: 999 })
      });
      assert.strictEqual(r.status, 400);
    } finally { await ctx.close(); }
  });

  it('rejects avatar_id=-1', async () => {
    const ctx = await buildRpgServer({ authUser: { id: USER_ID, email: 'a@b.c' }, membershipRole: 'student' });
    try {
      const r = await req(ctx.baseUrl, '/api/rpg/avatar', {
        method: 'PATCH', body: JSON.stringify({ avatar_id: -1 })
      });
      assert.strictEqual(r.status, 400);
    } finally { await ctx.close(); }
  });

  it('rejects avatar_id="2" (string, not number)', async () => {
    const ctx = await buildRpgServer({ authUser: { id: USER_ID, email: 'a@b.c' }, membershipRole: 'student' });
    try {
      const r = await req(ctx.baseUrl, '/api/rpg/avatar', {
        method: 'PATCH', body: JSON.stringify({ avatar_id: '2' })
      });
      assert.strictEqual(r.status, 400);
    } finally { await ctx.close(); }
  });

  it('rate limits after 10 requests', async () => {
    const ctx = await buildRpgServer({ authUser: { id: USER_ID, email: 'a@b.c' }, membershipRole: 'admin' });
    try {
      // Use up 10 requests
      for (let i = 0; i < 10; i++) {
        const r = await req(ctx.baseUrl, '/api/rpg/avatar', {
          method: 'PATCH', body: JSON.stringify({ avatar_id: 2 })
        });
        assert.strictEqual(r.status, 200, `request ${i + 1} should succeed`);
      }
      // 11th should be rate limited
      const r = await req(ctx.baseUrl, '/api/rpg/avatar', {
        method: 'PATCH', body: JSON.stringify({ avatar_id: 3 })
      });
      assert.strictEqual(r.status, 429);
    } finally { await ctx.close(); }
  });

  it('all three valid roles can change avatar', async () => {
    for (const role of ['admin', 'teacher', 'student']) {
      const ctx = await buildRpgServer({ authUser: { id: USER_ID, email: 'a@b.c' }, membershipRole: role });
      try {
        const r = await req(ctx.baseUrl, '/api/rpg/avatar', {
          method: 'PATCH', body: JSON.stringify({ avatar_id: 4 })
        });
        assert.strictEqual(r.status, 200, `${role} should be able to set avatar`);
      } finally { await ctx.close(); }
    }
  });
});
