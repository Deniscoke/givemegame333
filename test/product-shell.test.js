const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const router = require('../public/js/post-login-router.js');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('shared shell reserves the pixel face for display accents', () => {
  const tokens = read('public/ui/tokens.css');
  const shell = read('public/ui/shell.css');
  assert.match(tokens, /--font-body:\s*"Atkinson Hyperlegible"/);
  assert.match(tokens, /--font-data:\s*"IBM Plex Mono"/);
  assert.match(tokens, /--font-pixel:\s*"Press Start 2P"/);
  assert.match(shell, /body[\s\S]*font-family:\s*var\(--font-body\)/);
  assert.match(shell, /:focus-visible/);
  assert.match(shell, /min-height:\s*44px/);
  assert.match(shell, /prefers-reduced-motion:\s*reduce/);
});

test('shell helper exports deterministic menu helpers', () => {
  const shell = require('../public/ui/shell.js');
  assert.equal(typeof shell.setActiveNavigation, 'function');
  assert.equal(typeof shell.toggleMenu, 'function');
});

test('pending lobby wins over role routing', () => {
  assert.equal(router.destinationFor({ pendingLobby: 'AB12CD', schoolRole: 'student' }), '/index.html?lobby=AB12CD');
});

test('role routing sends each user to the next task', () => {
  assert.equal(router.destinationFor({ schoolRole: 'student' }), '/student/');
  assert.equal(router.destinationFor({ schoolRole: 'teacher' }), '/edu/');
  assert.equal(router.destinationFor({ schoolRole: 'admin' }), '/edu/');
  assert.equal(router.destinationFor({ schoolRole: null }), '/index.html');
});

test('school role lookup accepts a valid authenticated school role', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({ role: 'student' }) };
  };

  assert.equal(await router.fetchSchoolRole('access-token', fetchImpl), 'student');
  assert.deepEqual(requests, [{
    url: '/api/edu/me',
    options: { headers: { Authorization: 'Bearer access-token' } },
  }]);
});

test('school role lookup never grants a role after a failed or invalid response', async () => {
  const unauthorized = async () => ({ ok: false, status: 401 });
  const forbidden = async () => ({ ok: false, status: 403 });
  const invalidRole = async () => ({ ok: true, json: async () => ({ role: 'player' }) });
  const networkFailure = async () => { throw new Error('offline'); };

  assert.equal(await router.fetchSchoolRole('access-token', unauthorized), null);
  assert.equal(await router.fetchSchoolRole('access-token', forbidden), null);
  assert.equal(await router.fetchSchoolRole('access-token', invalidRole), null);
  assert.equal(await router.fetchSchoolRole('access-token', networkFailure), null);
});
