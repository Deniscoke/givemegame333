'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ASSESSMENT_ID = '10000000-0000-4000-8000-000000000001';
const CLASS_A_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const CLASS_B_ID = 'bbbbbbbb-0000-4000-8000-000000000002';
const INVENTED_CLASS_ID = 'cccccccc-0000-4000-8000-000000000003';

class FakeElement {
  constructor(id) {
    this.id = id;
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.dataset = {};
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this._innerHTML = '';
    this.textContent = '';
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  appendChild(child) {
    this.children.push(child);
  }

  querySelectorAll(selector) {
    if (this.id === 'assess-list-container'
        && selector === '[data-take]'
        && this._innerHTML.includes('data-take')) {
      return [this.takeButton];
    }
    if (selector === '.question-block') return this.children;
    return [];
  }

  querySelector(selector) {
    if (this.id === 'assess-list-container'
        && selector === '#assessment-class-context'
        && this._innerHTML.includes('id="assessment-class-context"')) {
      return this.classSelect;
    }
    if (this.id === 'assess-list-container'
        && selector === '#assessment-context-retry'
        && this._innerHTML.includes('id="assessment-context-retry"')) {
      return this.retryButton;
    }
    return null;
  }

  async dispatch(type) {
    const listener = this.listeners.get(type);
    assert.equal(typeof listener, 'function', this.id + ' is missing a ' + type + ' listener');
    return listener({ preventDefault() {} });
  }
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function bootAssessmentFrontend(config = {}) {
  const {
    classes = [],
    role = 'student',
    profilePlan = [],
    classesPlan = [],
  } = config;
  let onReady;
  const elements = new Map();
  const takeButton = new FakeElement('take-button');
  takeButton.dataset.take = ASSESSMENT_ID;
  const classSelect = new FakeElement('assessment-class-context');
  const retryButton = new FakeElement('assessment-context-retry');

  function getElement(id) {
    if (!elements.has(id)) elements.set(id, new FakeElement(id));
    return elements.get(id);
  }

  const listContainer = getElement('assess-list-container');
  listContainer.takeButton = takeButton;
  listContainer.classSelect = classSelect;
  listContainer.retryButton = retryButton;

  const document = {
    readyState: 'loading',
    addEventListener(type, listener) {
      if (type === 'DOMContentLoaded') onReady = listener;
    },
    createElement() {
      return new FakeElement('created');
    },
    getElementById(id) {
      if (id === 'assessment-class-context'
          && listContainer.innerHTML.includes('id="assessment-class-context"')) {
        return classSelect;
      }
      if (id === 'assessment-context-retry'
          && listContainer.innerHTML.includes('id="assessment-context-retry"')) {
        return retryButton;
      }
      return getElement(id);
    },
    querySelector() {
      return null;
    },
  };

  const calls = [];
  let profileRequest = 0;
  let classesRequest = 0;
  function plannedResponse(plan, index, fallback) {
    if (!plan.length) return fallback;
    return plan[Math.min(index, plan.length - 1)];
  }

  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    let body;
    let status = 200;
    if (url === '/api/edu/me') {
      const outcome = plannedResponse(profilePlan, profileRequest++, {
        body: {
          user: { id: 'student-user', email: 'student@example.test' },
          school: role ? { id: 'school-a', name: 'School A', role } : null,
        },
      });
      if (outcome instanceof Error) throw outcome;
      status = outcome.status || 200;
      body = outcome.body;
    } else if (url === '/api/edu/classes') {
      const outcome = plannedResponse(classesPlan, classesRequest++, {
        body: { classes, role },
      });
      if (outcome instanceof Error) throw outcome;
      status = outcome.status || 200;
      body = outcome.body;
    } else if (url === '/api/assessments') {
      body = {
        items: [{
          id: ASSESSMENT_ID,
          title: 'Pre test',
          description: '',
          module_key: 'entrepreneurship',
          assessment_type: 'pre',
          created_at: '2026-08-01T00:00:00.000Z',
          is_mine: false,
        }],
      };
    } else if (url === '/api/assessments/' + ASSESSMENT_ID) {
      body = {
        id: ASSESSMENT_ID,
        title: 'Pre test',
        description: '',
        questions: [],
      };
    } else if (url === '/api/assessments/' + ASSESSMENT_ID + '/start') {
      body = {
        attempt_id: '80000000-0000-4000-8000-000000000001',
        started_at: '2026-08-01T00:00:00.000Z',
      };
    } else {
      throw new Error('Unexpected frontend request: ' + url);
    }
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };

  const windowObject = {
    document,
    fetch: fetchImpl,
    EduAuth: {
      getAccessToken: async () => 'authorized-browser-token',
    },
  };
  windowObject.window = windowObject;

  const source = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'edu', 'js', 'assessments.js'),
    'utf8'
  );
  const context = vm.createContext({
    console,
    document,
    fetch: fetchImpl,
    Response,
    setTimeout,
    window: windowObject,
  });
  vm.runInContext(source, context, { filename: 'assessments.js' });
  assert.equal(typeof onReady, 'function');

  onReady();
  await flush();

  return {
    calls,
    classSelect,
    listContainer,
    retryButton,
    takeButton,
  };
}

test('student role loads authorized classes and sends the selected start context', async () => {
  const app = await bootAssessmentFrontend({
    role: 'student',
    classes: [
      { id: CLASS_A_ID, name: 'Trieda <A>', grade_level: 8, school_year: '2026/2027' },
      { id: CLASS_B_ID, name: 'Trieda B', grade_level: 9, school_year: '2026/2027' },
    ],
  });

  assert.deepEqual(app.calls.slice(0, 3).map((call) => call.url).sort(), [
    '/api/assessments',
    '/api/edu/classes',
    '/api/edu/me',
  ]);
  assert.ok(app.calls.slice(0, 3).every((call) =>
    call.options.headers.Authorization === 'Bearer authorized-browser-token'));
  assert.match(app.listContainer.innerHTML, /id="assessment-class-context"/);
  assert.match(app.listContainer.innerHTML, /Trieda &lt;A&gt;/);
  assert.equal(app.classSelect.value, CLASS_A_ID,
    'the first server-authorized class should be the default reporting context');

  app.classSelect.value = CLASS_B_ID;
  await app.classSelect.dispatch('change');
  await app.takeButton.dispatch('click');
  await flush();

  const start = app.calls.find((call) => call.url.endsWith('/start'));
  assert.ok(start);
  assert.deepEqual(JSON.parse(start.options.body), { class_id: CLASS_B_ID });
  assert.equal(start.options.headers.Authorization, 'Bearer authorized-browser-token');
});

test('student can explicitly choose a solo start after context loads successfully', async () => {
  const app = await bootAssessmentFrontend({
    role: 'student',
    classes: [
      { id: CLASS_A_ID, name: 'Trieda A', grade_level: 8, school_year: '2026/2027' },
    ],
  });

  app.classSelect.value = '';
  await app.classSelect.dispatch('change');
  await app.takeButton.dispatch('click');
  await flush();

  const start = app.calls.find((call) => call.url.endsWith('/start'));
  assert.deepEqual(JSON.parse(start.options.body), {});
});

test('a DOM-invented class id is never sent', async () => {
  const app = await bootAssessmentFrontend({
    role: 'student',
    classes: [
      { id: CLASS_A_ID, name: 'Trieda A', grade_level: 8, school_year: '2026/2027' },
    ],
  });

  app.classSelect.value = INVENTED_CLASS_ID;
  await app.classSelect.dispatch('change');
  await app.takeButton.dispatch('click');
  await flush();

  const start = app.calls.find((call) => call.url.endsWith('/start'));
  assert.deepEqual(JSON.parse(start.options.body), {});
});

test('a successful empty student class list permits solo start', async () => {
  const app = await bootAssessmentFrontend({ role: 'student', classes: [] });

  assert.ok(app.calls.some((call) =>
    call.url === '/api/edu/classes'
    && call.options.headers.Authorization === 'Bearer authorized-browser-token'));
  assert.doesNotMatch(app.listContainer.innerHTML, /assessment-class-context/);
  await app.takeButton.dispatch('click');
  await flush();

  const start = app.calls.find((call) => call.url.endsWith('/start'));
  assert.deepEqual(JSON.parse(start.options.body), {});
});

for (const role of ['teacher', 'admin']) {
  test(role + ' assessment previews remain solo even when the server lists classes', async () => {
    const app = await bootAssessmentFrontend({
      role,
      classes: [
        { id: CLASS_A_ID, name: 'Trieda A', grade_level: 8, school_year: '2026/2027' },
      ],
    });

    assert.doesNotMatch(app.listContainer.innerHTML, /assessment-class-context/);
    await app.takeButton.dispatch('click');
    await flush();

    const start = app.calls.find((call) => call.url.endsWith('/start'));
    assert.deepEqual(JSON.parse(start.options.body), {});
  });
}

test('a failed class request blocks starts, is not cached, and succeeds on retry', async () => {
  const app = await bootAssessmentFrontend({
    role: 'student',
    classes: [
      { id: CLASS_A_ID, name: 'Trieda A', grade_level: 8, school_year: '2026/2027' },
    ],
    classesPlan: [
      { status: 500, body: { error: 'Class service unavailable', code: 'CLASSES_ERROR' } },
      {
        status: 200,
        body: {
          classes: [
            { id: CLASS_A_ID, name: 'Trieda A', grade_level: 8, school_year: '2026/2027' },
          ],
          role: 'student',
        },
      },
    ],
  });

  assert.match(app.listContainer.innerHTML, /assessment-context-retry/);
  assert.equal(app.takeButton.listeners.has('click'), false);
  assert.equal(app.calls.filter((call) => call.url === '/api/edu/classes').length, 1);

  await app.retryButton.dispatch('click');
  await flush();

  assert.equal(app.calls.filter((call) => call.url === '/api/edu/classes').length, 2);
  assert.match(app.listContainer.innerHTML, /assessment-class-context/);
  await app.takeButton.dispatch('click');
  await flush();

  const start = app.calls.find((call) => call.url.endsWith('/start'));
  assert.deepEqual(JSON.parse(start.options.body), { class_id: CLASS_A_ID });
});

test('an expired context session shows a useful retry state and blocks start', async () => {
  const app = await bootAssessmentFrontend({
    role: 'student',
    classes: [],
    profilePlan: [{
      status: 401,
      body: { error: 'Unauthorized', code: 'AUTH_REQUIRED' },
    }],
  });

  assert.match(app.listContainer.innerHTML, /assessment-context-retry/);
  assert.match(app.listContainer.innerHTML, /Prihlásenie|session|auth/i);
  assert.equal(app.takeButton.listeners.has('click'), false);
  assert.equal(app.calls.some((call) => call.url.endsWith('/start')), false);
});

test('a network failure loading classes is not treated as successful solo context', async () => {
  const app = await bootAssessmentFrontend({
    role: 'student',
    classes: [],
    classesPlan: [new Error('network unavailable')],
  });

  assert.match(app.listContainer.innerHTML, /assessment-context-retry/);
  assert.equal(app.takeButton.listeners.has('click'), false);
  assert.equal(app.calls.some((call) => call.url.endsWith('/start')), false);
});
