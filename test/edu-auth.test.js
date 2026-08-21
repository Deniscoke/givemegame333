'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function bootEduAuth({ tokens, responseStatuses = [] }) {
  let sessionReads = 0;
  const requests = [];
  const auth = {
    async getSession() {
      const token = tokens[Math.min(sessionReads, tokens.length - 1)];
      sessionReads++;
      return {
        data: {
          session: token ? { access_token: token } : null,
        },
      };
    },
    async signOut() {},
  };
  const windowObject = {
    location: { href: '/edu/' },
    supabase: {
      createClient() {
        return { auth };
      },
    },
  };
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    const status = responseStatuses[requests.length - 1] || 200;
    return new Response(JSON.stringify(
      status === 401
        ? { error: 'Unauthorized', code: 'AUTH_REQUIRED' }
        : { ok: true }
    ), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  windowObject.fetch = fetchImpl;
  windowObject.window = windowObject;

  const source = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'edu', 'js', 'edu-auth.js'),
    'utf8'
  );
  vm.runInContext(source, vm.createContext({
    console,
    fetch: fetchImpl,
    Response,
    sessionStorage: { removeItem() {} },
    window: windowObject,
  }), { filename: 'edu-auth.js' });

  return {
    eduAuth: windowObject.EduAuth,
    requests,
    sessionReads: () => sessionReads,
    windowObject,
  };
}

test('each authenticated request reads the current Supabase session token', async () => {
  const app = bootEduAuth({ tokens: ['token-before-refresh', 'token-after-refresh'] });
  assert.equal(typeof app.eduAuth.getAccessToken, 'function');
  assert.equal(typeof app.eduAuth.apiFetch, 'function');

  await app.eduAuth.apiFetch('/me');
  await app.eduAuth.apiFetch('/classes');

  assert.equal(app.sessionReads(), 2);
  assert.deepEqual(app.requests.map((request) =>
    request.options.headers.Authorization), [
    'Bearer token-before-refresh',
    'Bearer token-after-refresh',
  ]);
});

test('an authenticated API 401 exposes a useful auth error and redirects safely', async () => {
  const app = bootEduAuth({
    tokens: ['expired-token'],
    responseStatuses: [401],
  });

  await assert.rejects(
    app.eduAuth.apiFetch('/me'),
    (error) => error.message === 'Unauthorized'
      && error.code === 'AUTH_REQUIRED'
      && error.status === 401
  );
  assert.equal(app.windowObject.location.href, '/');
});
