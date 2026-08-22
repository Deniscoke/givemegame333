const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const router = require('../public/js/post-login-router.js');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

let server;
let origin;

before(async () => {
  process.env.VERCEL = '1';
  const app = require('../server');
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

test('student home exposes its join portal and canonical lobby helpers', async () => {
  const response = await fetch(`${origin}/student/`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /<main\b[^>]*id="main-content"/i);
  assert.match(html, /<form\b[^>]*id="join-game-form"/i);
  assert.match(html, /aria-label="6-znakový kód hry"/i);
  assert.match(html, /href="\/ui\/tokens\.css"/i);
  assert.match(html, /src="\/student\/student\.js"/i);

  const student = require('../public/student/student.js');
  assert.equal(student.normalizeJoinCode(' ab-12 cd '), 'AB12CD');
  assert.equal(student.joinDestination('ab12cd'), '/index.html?lobby=AB12CD');
  assert.equal(student.joinDestination('123'), null);
});

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
    return {
      ok: true,
      json: async () => ({
        user: { id: 'user-1', email: 'student@example.test' },
        school: { id: 'school-1', name: 'Example School', role: 'student' },
      }),
    };
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
  const noSchool = async () => ({
    ok: true,
    json: async () => ({ user: { id: 'user-1', email: 'player@example.test' }, school: null }),
  });
  const invalidRole = async () => ({
    ok: true,
    json: async () => ({
      user: { id: 'user-1', email: 'player@example.test' },
      school: { id: 'school-1', name: 'Example School', role: 'player' },
    }),
  });
  const networkFailure = async () => { throw new Error('offline'); };

  assert.equal(await router.fetchSchoolRole('access-token', unauthorized), null);
  assert.equal(await router.fetchSchoolRole('access-token', forbidden), null);
  assert.equal(await router.fetchSchoolRole('access-token', noSchool), null);
  assert.equal(await router.fetchSchoolRole('access-token', invalidRole), null);
  assert.equal(await router.fetchSchoolRole('access-token', networkFailure), null);
});
