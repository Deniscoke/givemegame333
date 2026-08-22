const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const router = require('../public/js/post-login-router.js');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

const educatorPages = [
  ['public/edu/index.html', '/edu/css/edu.css'],
  ['public/edu/classes.html', '/edu/css/edu.css'],
  ['public/edu/gradebook.html', '/edu/css/edu.css'],
  ['public/edu/attendance.html', '/edu/css/edu.css'],
  ['public/edu/members.html', '/edu/css/edu.css'],
  ['public/edu/perk-requests.html', '/edu/css/edu.css'],
  ['public/edu/assessments.html', '/edu/css/edu.css'],
  ['public/institution/index.html', '/institution/institution.css'],
];

const publicTypographyPages = [
  ['public/home.html', ['public/home.css']],
  ['public/login.html', []],
  ['public/account.html', []],
  ['public/pricing.html', []],
  ['public/game.html', []],
  ['public/billing/success.html', []],
  ['public/billing/cancel.html', []],
];

const voidElements = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

function assertHtmlTreeIsBalanced(html) {
  const stack = [];
  const tags = html.matchAll(/<!--[\s\S]*?-->|<\/?([a-z][\w-]*)\b[^>]*>/gi);

  for (const match of tags) {
    const source = match[0];
    const tag = match[1]?.toLowerCase();
    if (!tag || source.startsWith('<!--') || voidElements.has(tag) || /\/\s*>$/.test(source)) continue;

    if (source.startsWith('</')) {
      assert.equal(
        stack.pop(),
        tag,
        `expected </${tag}> to close its direct parent near character ${match.index}`,
      );
    } else {
      stack.push(tag);
    }
  }

  assert.deepEqual(stack, [], 'all generator markup elements close in their original hierarchy');
}

function pageOwnedStyles(file, linkedStylesheets) {
  const html = read(file);
  const inlineStyles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((match) => match[1]);
  const styleAttributes = [...html.matchAll(/\bstyle="([^"]*)"/gi)].map((match) => `.__inline { ${match[1]} }`);
  return [...linkedStylesheets.map(read), ...inlineStyles, ...styleAttributes]
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

function declarationsFor(css, selector) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((match) => match[1].split(',').some((part) => part.trim() === selector))
    .map((match) => match[2])
    .join('\n');
}

function assertMinTouchTarget(css, selector, file) {
  const declaration = declarationsFor(css, selector).match(/min-(?:height|block-size):\s*([0-9.]+)(px|rem)/i);
  const pixels = declaration && Number(declaration[1]) * (declaration[2].toLowerCase() === 'rem' ? 16 : 1);
  assert.ok(pixels >= 44, `${file} ${selector} should preserve a 44px minimum touch target`);
}

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

test('student assessment summary uses submitted attempts and the canonical delta map', () => {
  const student = require('../public/student/student.js');
  const summary = student.summarizeAssessmentResults({
    attempts: [
      { id: 'attempt-draft', status: 'in_progress' },
      { id: 'attempt-done', status: 'submitted' },
    ],
    deltas: {
      entrepreneurship: { pre_percent: 45, post_percent: 70 },
      critical_media_thinking: { pre_percent: 60, post_percent: 75 },
    },
  });

  assert.deepEqual(summary, { completedActivities: 1, progressAreas: 2 });
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

test('public and account surfaces load the readable shell and reserve pixel type for short accents', () => {
  const forbiddenPixelSelector = /(?:^|[\s>+~,])(?:body|p|input|select|textarea|button|table|td)(?:$|[\s.#:[>+~,])|\.(?:btn|nav)(?:[-_][\w-]+)?/i;
  const pixelDeclaration = /font-family:\s*(?:var\(--font-pixel\)|['"]Press Start 2P['"])/i;

  for (const [file, linkedStylesheets] of publicTypographyPages) {
    const html = read(file);
    const css = pageOwnedStyles(file, linkedStylesheets);

    assert.match(html, /href="(?:\.\.\/|\/)?ui\/tokens\.css(?:\?[^"']*)?"/i, `${file} should load tokens.css`);
    assert.match(html, /href="(?:\.\.\/|\/)?ui\/shell\.css(?:\?[^"']*)?"/i, `${file} should load shell.css`);

    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = match[1].trim();
      const declarations = match[2];
      if (forbiddenPixelSelector.test(selector)) {
        assert.doesNotMatch(declarations, pixelDeclaration, `${file} ${selector} should use readable type`);
      }
      for (const size of declarations.matchAll(/font-size:\s*([0-9.]+)px/gi)) {
        assert.ok(Number(size[1]) >= 10, `${file} ${selector} should not render ${size[1]}px text`);
      }
    }
  }
});

test('core login and generator surfaces expose one primary heading', () => {
  for (const file of ['public/login.html', 'public/index.html']) {
    const headings = read(file).match(/<h1\b/gi) || [];
    assert.equal(headings.length, 1, `${file} should expose exactly one h1`);
  }
});

test('embedded social script can coexist with the Supabase browser global', () => {
  const socialScript = read('public/gIVEME/script.js');
  assert.doesNotThrow(() => new vm.Script(`var supabase = {};\n${socialScript}`));
  assert.match(socialScript, /window\.supabase\.createClient/);
});

test('public authentication, account, pricing, game and billing controls keep 44px touch targets', () => {
  const controls = [
    ['public/home.html', ['public/home.css'], ['.brand', '.nav-links a', '.btn', '.hc-dot-btn', '.footer a']],
    ['public/login.html', [], ['.btn-login', '.login-lang-btn', '.btn-skip']],
    ['public/account.html', [], ['.btn']],
    ['public/pricing.html', [], ['.plan-card button', '.consent-modal label', '.consent-modal button']],
    ['public/game.html', [], ['.gp-back', '.game-card-footer .btn-action']],
    ['public/billing/success.html', [], ['.billing-page .btn']],
    ['public/billing/cancel.html', [], ['.billing-page .btn']],
  ];

  for (const [file, linkedStylesheets, selectors] of controls) {
    const css = pageOwnedStyles(file, linkedStylesheets);
    for (const selector of selectors) assertMinTouchTarget(css, selector, file);
  }
});

test('long account, pricing and billing documents override the legacy fixed viewport', () => {
  for (const file of [
    'public/account.html',
    'public/pricing.html',
    'public/billing/success.html',
    'public/billing/cancel.html',
  ]) {
    const body = declarationsFor(pageOwnedStyles(file, []), 'body');
    assert.match(body, /display:\s*block/i, `${file} should use document flow`);
    assert.match(body, /min-height:\s*100vh/i, `${file} should cover short viewports`);
    assert.match(body, /height:\s*auto/i, `${file} should grow beyond one viewport`);
    assert.match(body, /overflow-y:\s*auto/i, `${file} should keep lower content reachable`);
    assert.doesNotMatch(body, /overflow(?:-y)?:\s*hidden/i, `${file} should not clip vertical content`);
  }
});

test('public game disclosure controls expose native keyboard and expanded-state semantics', () => {
  const game = read('public/game.html');
  const css = pageOwnedStyles('public/game.html', []);
  const toggles = [...game.matchAll(/<button\b[^>]*class="[^"]*section-toggle[^"]*"[^>]*>/gi)];

  assert.equal(toggles.length, 5);
  assert.doesNotMatch(game, /<h3\b[^>]*onclick=/i);
  for (const toggle of toggles) {
    assert.match(toggle[0], /type="button"/i);
    assert.match(toggle[0], /aria-expanded="true"/i);
    const controlledId = toggle[0].match(/aria-controls="([^"]+)"/i)?.[1];
    assert.ok(controlledId, 'each disclosure button should identify its controlled region');
    assert.match(game, new RegExp(`<div\\b[^>]*id="${controlledId}"`, 'i'));
    assert.match(toggle[0], /onclick="[^"]*GP\.toggleSection\('[^']+'\)[^"]*aria-expanded/i);
  }
  assertMinTouchTarget(css, '.section-toggle', 'public/game.html');
  assert.match(declarationsFor(css, '.section-toggle'), /font:\s*inherit/i);
});

test('public task labels are Slovak and generator actions use the canonical route', () => {
  for (const [file] of publicTypographyPages) {
    assert.match(read(file), /<html\s+lang="sk">/i, `${file} should declare Slovak UI copy`);
  }

  const home = read('public/home.html');
  assert.match(home, /3 AI hry denne zadarmo/i);
  assert.match(home, /<li>3 AI hry denne<\/li>/i);
  assert.doesNotMatch(home, /2 AI hry denne/i);

  const game = read('public/game.html');
  const generatorLinks = [...game.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>(?:(?!<\/a>)[\s\S])*?Otvoriť generátor(?:(?!<\/a>)[\s\S])*?<\/a>/gi)];
  assert.ok(generatorLinks.length >= 2);
  assert.ok(generatorLinks.every((match) => match[1] === '/index.html'));
});

test('pricing presents plan and consent tasks consistently in Slovak', () => {
  const pricing = read('public/pricing.html');

  for (const copy of [
    '/ mesiac',
    'Učiteľ – mesačný',
    'Učiteľ – ročný',
    'Škola – pilotný',
    'Pred presmerovaním na platobnú bránu',
    'Načítava sa…',
    'Súhlasom zároveň potvrdzujete',
    'Obchodné podmienky',
    'Zásady ochrany osobných údajov',
  ]) {
    assert.match(pricing, new RegExp(copy, 'i'));
  }
  assert.doesNotMatch(
    pricing,
    /měsíc|měsíční|roční|pilotní|Před přesměrováním|Načítá se|Souhlasem zároveň|Obchodní podmínky|osobních údajů/i,
  );
});

test('generator foregrounds activity basics and keeps optional controls collapsed', () => {
  const generator = read('public/index.html');

  assert.match(generator, /id="creation-basics"/);
  assert.match(generator, /<details\b[^>]*id="advanced-options"/i);
  assert.match(generator, /id="btn-join-session"[\s\S]*Pripojiť sa do hry/i);
  assert.match(generator, /href="\/ui\/generator-shell\.css"/i);
  assert.doesNotMatch(generator, /id="btn-join-session"[\s\S]{0,160}>\s*🔑\s*<\/button>/i);
});

test('generator preserves the workspace hierarchy around the creation controls', () => {
  const generator = read('public/index.html');

  assertHtmlTreeIsBalanced(generator.slice(generator.indexOf('<body'), generator.lastIndexOf('</html>')));
});

test('generator styles keep advanced controls hidden until their details element opens', () => {
  const styles = read('public/ui/generator-shell.css');

  assert.match(styles, /#advanced-options\s*>\s*\.advanced-options__content\s*\{[\s\S]*display:\s*none/);
  assert.match(styles, /#advanced-options\[open\]\s*>\s*\.advanced-options__content\s*\{[\s\S]*display:\s*grid/);
});

test('generator mobile header leaves the preferences popover outside its clipping area', () => {
  const styles = read('public/ui/generator-shell.css');
  const mobileStyles = styles.slice(styles.indexOf('@media (max-width: 600px)'));

  assert.doesNotMatch(mobileStyles, /body\.generator-shell header\s*\{[\s\S]*overflow:\s*hidden/);
});

test('shell helper exports deterministic menu helpers', () => {
  const shell = require('../public/ui/shell.js');
  assert.equal(typeof shell.setActiveNavigation, 'function');
  assert.equal(typeof shell.toggleMenu, 'function');
});

test('educator shell exposes one role-filtered navigation vocabulary', () => {
  const shell = require('../public/edu/js/edu-shell.js');
  const studentLabels = shell.itemsForRole('student').map((item) => item.label);
  const teacherLabels = shell.itemsForRole('teacher').map((item) => item.label);

  assert.deepEqual(studentLabels, ['Prehľad', 'Moje aktivity', 'Pokrok']);
  assert.ok(teacherLabels.includes('Vytvoriť aktivitu'));
  assert.ok(teacherLabels.includes('Assessmenty'));
  assert.ok(teacherLabels.includes('Výsledky INVOK'));
  assert.equal(teacherLabels.includes('Členovia'), true);
  assert.equal(
    shell.itemsForRole('teacher').find((item) => item.label === 'Knižnica a živé hry').href,
    '/index.html',
  );
});

test('educator shell mounts DOM nodes and marks only the current route active', () => {
  class TestNode {
    constructor(tagName, ownerDocument) {
      this.tagName = tagName;
      this.ownerDocument = ownerDocument;
      this.children = [];
      this.attributes = new Map();
      this.className = '';
      this.textContent = '';
    }

    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = [...children]; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
  }

  const ownerDocument = { createElement: (tagName) => new TestNode(tagName, ownerDocument) };
  const root = new TestNode('div', ownerDocument);
  const shell = require('../public/edu/js/edu-shell.js');

  shell.mount({ root, role: 'teacher', pathname: '/edu/assessments.html' });

  const descendants = [];
  const visit = (node) => {
    descendants.push(node);
    node.children.forEach(visit);
  };
  root.children.forEach(visit);
  const currentLinks = descendants.filter((node) => node.attributes.get('aria-current') === 'page');

  assert.equal(root.children[0].tagName, 'nav');
  assert.equal(currentLinks.length, 1);
  assert.equal(currentLinks[0].textContent, 'Assessmenty');
  assert.equal(currentLinks[0].attributes.get('href'), '/edu/assessments.html');
});

test('educator shell keeps active navigation unique across the role and route matrix', () => {
  class TestNode {
    constructor(tagName, ownerDocument) {
      this.tagName = tagName;
      this.ownerDocument = ownerDocument;
      this.children = [];
      this.attributes = new Map();
      this.className = '';
      this.textContent = '';
    }

    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = [...children]; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
  }

  const shell = require('../public/edu/js/edu-shell.js');
  const currentLabels = (role, pathname) => {
    const ownerDocument = { createElement: (tagName) => new TestNode(tagName, ownerDocument) };
    const root = new TestNode('div', ownerDocument);
    shell.mount({ root, role, pathname });
    const current = [];
    const visit = (node) => {
      if (node.attributes.get('aria-current') === 'page') current.push(node.textContent);
      node.children.forEach(visit);
    };
    root.children.forEach(visit);
    return current;
  };

  for (const role of ['teacher', 'admin']) {
    for (const pathname of shell.itemsForRole(role).map((item) => item.href)) {
      assert.ok(currentLabels(role, pathname).length <= 1, `${role} ${pathname} should have at most one current link`);
    }
    assert.deepEqual(currentLabels(role, '/index.html'), ['Vytvoriť aktivitu']);
  }
  assert.deepEqual(currentLabels('student', '/edu/assessments.html'), ['Moje aktivity']);
});

test('EDU surface typography keeps labels readable and pixel text at least 10px', () => {
  const css = read('public/edu/css/edu.css');
  const scopedSources = [
    css,
    read('public/edu/members.html'),
    read('public/edu/perk-requests.html'),
  ];

  assert.match(css, /\.edu-table th\s*\{[^}]*font-family:\s*var\(--edu-font-data\)/i);
  assert.match(css, /\.edu-form-group label\s*\{[^}]*font-family:\s*var\(--edu-font-body\)/i);

  for (const source of scopedSources) {
    for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = match[1].trim();
      const declarations = match[2];
      const sizes = [...declarations.matchAll(/font-size:\s*([0-9.]+)px/gi)];
      for (const size of sizes) {
        assert.ok(Number(size[1]) >= 10, `${selector} should not render ${size[1]}px text`);
      }
      if (/font-family:\s*(?:var\(--edu-font-pixel\)|['"]Press Start 2P['"])/i.test(declarations)) {
        assert.ok(sizes.every((size) => Number(size[1]) >= 10), `${selector} uses pixel text below 10px`);
      }
    }
  }
});

test('rendered perk level metadata uses readable data typography at 10px or larger', async () => {
  const list = {
    innerHTML: '',
    querySelectorAll() { return []; },
  };
  const document = {
    createElement() {
      let text = '';
      return {
        set textContent(value) { text = String(value); },
        get innerHTML() { return text; },
      };
    },
    getElementById(id) { return id === 'perk-req-list' ? list : null; },
  };
  const context = vm.createContext({
    document,
    EduApp: { getRole: () => 'teacher' },
    EduAuth: {
      apiFetch: async () => ({
        requests: [{
          id: 'request-1',
          perk_title: 'Prestávka navyše',
          perk_level: 3,
          duration_minutes: 15,
          student_name: 'Alex',
          claimed_at: '2026-08-22T10:00:00Z',
        }],
      }),
    },
    Date,
    setTimeout,
  });
  const source = `${read('public/edu/js/edu-perks.js')}\n;globalThis.TestEduPerks = EduPerks;`;
  vm.runInContext(source, context, { filename: 'edu-perks.js' });

  await context.TestEduPerks.init();

  assert.match(list.innerHTML, /<span class="perk-req-level">Lv 3 · 15 min<\/span>/);
  assert.doesNotMatch(list.innerHTML, /<span\b[^>]*style=/i);

  const html = read('public/edu/perk-requests.html');
  const declarations = html.match(/\.perk-req-level\s*\{([^}]*)\}/i)?.[1] || '';
  assert.match(declarations, /font-family:\s*var\(--edu-font-data\)/i);
  const size = Number(declarations.match(/font-size:\s*([0-9.]+)px/i)?.[1]);
  assert.ok(Number.isFinite(size) && size >= 10, 'perk level metadata should render at 10px or larger');
});

test('every educator surface exposes a skip link, main target and one primary heading', () => {
  for (const [file] of educatorPages) {
    const html = read(file);
    assert.match(html, /<a\b[^>]*class="[^"]*skip-link[^"]*"[^>]*href="#main-content"/i,
      `${file} should offer a skip link to its main content`);
    assert.match(html, /<main\b[^>]*id="main-content"/i, `${file} should expose the skip target`);
    assert.equal((html.match(/<h1\b/gi) || []).length, 1, `${file} should contain one primary heading`);
  }
});

test('assessment tabs and actions preserve the 44px touch target minimum', () => {
  const html = read('public/edu/assessments.html');
  assert.match(html, /\.assess-tab\s*\{[^}]*min-height:\s*44px/i);
  assert.match(html, /\.assess-btn\s*\{[^}]*min-height:\s*44px/i);
});

test('every educator surface loads the shared shell once in stable asset order', () => {
  for (const [file, pageStylesheet] of educatorPages) {
    const html = read(file);
    const mountPoints = html.match(/\bdata-edu-shell(?:\s|=|>)/gi) || [];
    const tokensIndex = html.indexOf('href="/ui/tokens.css"');
    const shellStylesIndex = html.indexOf('href="/ui/shell.css"');
    const pageStylesIndex = html.indexOf(`href="${pageStylesheet}`);
    const supabaseIndex = html.indexOf('src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"');
    const authIndex = html.indexOf('src="/edu/js/edu-auth.js"');
    const educatorShellIndex = html.indexOf('src="/edu/js/edu-shell.js"');

    assert.equal(mountPoints.length, 1, `${file} should contain one educator shell mount point`);
    assert.ok(tokensIndex >= 0, `${file} should load tokens.css`);
    assert.ok(shellStylesIndex > tokensIndex, `${file} should load shell.css after tokens.css`);
    assert.ok(pageStylesIndex > shellStylesIndex, `${file} should load its page stylesheet after shell.css`);
    assert.ok(supabaseIndex > pageStylesIndex, `${file} should load Supabase after styles`);
    assert.ok(authIndex > supabaseIndex, `${file} should load EduAuth after Supabase`);
    assert.ok(educatorShellIndex > authIndex, `${file} should load EduShell after EduAuth`);
    assert.doesNotMatch(html, /<ul\b[^>]*class="[^"]*edu-sidebar-nav/i,
      `${file} should not copy the educator navigation list`);
  }
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

test('session shell exposes a focused state helper for the live game experience', () => {
  const classes = new Set(['mobile-filters-open', 'mobile-smarta-open']);
  const context = vm.createContext({
    window: { location: { origin: 'https://example.test' } },
    document: {
      getElementById: () => null,
      body: {
        classList: {
          toggle: (name, active) => classes[active ? 'add' : 'delete'](name),
          remove: (...names) => names.forEach((name) => classes.delete(name)),
        },
      },
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URLSearchParams,
    AbortController,
    fetch: async () => { throw new Error('not used by focused-state test'); },
  });

  vm.runInContext(read('public/js/session.js'), context, { filename: 'session.js' });

  assert.equal(typeof context.window.Session.setFocusedState, 'function');
  context.window.Session.setFocusedState(true);
  context.window.Session.setFocusedState(0);
  assert.equal(classes.has('session-focused'), false);
  assert.equal(classes.has('mobile-filters-open'), false);
  assert.equal(classes.has('mobile-smarta-open'), false);
});

test('session dialogs use semantic classes and accessible live participant state', () => {
  const session = read('public/js/session.js');

  assert.doesNotMatch(session, /style\s*=/i, 'session presentation should live in session-shell.css');
  assert.match(session, /class="session-dialog session-dialog--join"/);
  assert.match(session, /class="session-dialog session-dialog--lobby"/);
  assert.match(session, /role="dialog"[\s\S]*aria-modal="true"[\s\S]*aria-labelledby=/);
  assert.match(session, /<h2 id="session-(?:join|lobby)-title"/);
  assert.match(session, /class="session-code"/);
  assert.match(session, /class="session-participants"[^>]*aria-live="polite"/);
  assert.match(session, /aria-label="\$\{_t\('close','Zavrieť'\)\}"/);
  assert.match(session, /aria-label="\$\{_t\('sess_quit','Opustiť session'\)\}"/);
});

test('focused session styles isolate the live game without changing the normal workspace', () => {
  const styles = read('public/ui/session-shell.css');

  assert.match(styles, /body\.session-focused\s+aside\.left-panel\s*\{[\s\S]*display:\s*none/);
  assert.match(styles, /body\.session-focused\s+aside\.right-panel\s*\{[\s\S]*display:\s*none/);
  assert.match(styles, /body\.session-focused\s+\.header-actions\s*\{[\s\S]*display:\s*none/);
  assert.match(styles, /\.session-code\s*\{[\s\S]*font-family:\s*var\(--font-data\)/);
  assert.match(styles, /\.session-actions\s+button[\s\S]*min-height:\s*44px/);
  assert.match(styles, /@media\s*\(max-width:\s*600px\)[\s\S]*\.session-dialog\s*\{[\s\S]*grid-template-columns:\s*1fr/);
});

test('waiting lobby can close, reopen and quit without stranding focused session controls', async () => {
  const elements = new Map();
  const classes = new Set();
  let nextTimer = 0;
  const scheduledTimers = new Set();
  const makeElement = () => ({
    hidden: false,
    className: '',
    innerHTML: '',
    style: {},
    addEventListener() {},
    focus() {},
  });
  const body = {
    classList: {
      toggle(name, active) { classes[active ? 'add' : 'delete'](name); },
      remove(...names) { names.forEach((name) => classes.delete(name)); },
    },
    appendChild(element) { elements.set(element.id, element); },
  };
  const document = {
    body,
    createElement: makeElement,
    getElementById: (id) => elements.get(id) || null,
  };
  const sessionResponse = () => ({ ok: true, json: async () => ({ status: 'waiting', participants: [] }) });
  const context = vm.createContext({
    window: { location: { origin: 'https://example.test' } },
    document,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    supabaseClient: {
      auth: { getSession: async () => ({ data: { session: { access_token: 'token' } } }) },
      channel: () => ({ on() { return this; }, subscribe() { return this; }, unsubscribe() {} }),
    },
    GameUI: { toast() {} },
    fetch: async (url) => url === '/api/sessions'
      ? { ok: true, json: async () => ({ id: 'session-1', join_code: 'AB12CD' }) }
      : sessionResponse(),
    setTimeout,
    clearTimeout,
    setInterval: () => { const id = ++nextTimer; scheduledTimers.add(id); return id; },
    clearInterval: (id) => scheduledTimers.delete(id),
    URLSearchParams,
    AbortController,
    confirm: () => true,
  });
  vm.runInContext(read('public/js/session.js'), context, { filename: 'session.js' });

  await context.window.Session.create({ title: 'Čakajúca hra' });
  const lobby = elements.get('session-lobby-modal');
  const badge = elements.get('session-badge');
  assert.equal(classes.has('session-focused'), true);
  assert.equal(lobby.hidden, false);
  assert.ok(badge, 'waiting users need a visible recovery control');
  assert.equal(badge.hidden, false);

  context.window.Session._closeLobby();
  assert.equal(lobby.hidden, true);
  assert.equal(badge.hidden, false);
  assert.equal(scheduledTimers.size, 0);

  context.window.Session._openLobbyFromBadge();
  assert.equal(lobby.hidden, false);
  assert.equal(scheduledTimers.size, 1, 'reopening a waiting lobby restarts fallback polling');

  context.window.Session._quitSession();
  assert.equal(classes.has('session-focused'), false);
  assert.equal(badge.hidden, true);
  assert.equal(scheduledTimers.size, 0);
});

test('mobile focused cascade hides stale generator drawers and uses data type for the active timer', () => {
  const combined = `${read('public/style.css')}\n${read('public/ui/session-shell.css')}`;
  const rules = [...combined.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match, index) => ({
    selector: match[1].trim(),
    declarations: match[2],
    index,
  }));
  const computedDisplay = (panel) => {
    const applicable = rules.filter((rule) => {
      if (!rule.selector.includes(`aside.${panel}-panel`)) return false;
      if (rule.selector.includes('body.session-focused') === false && rule.selector !== `aside.${panel}-panel`) return false;
      return true;
    }).flatMap((rule) => [...rule.declarations.matchAll(/display\s*:\s*([^;!]+)(\s*!important)?/g)].map((declaration) => ({
      value: declaration[1].trim(),
      important: Boolean(declaration[2]),
      index: rule.index,
    })));
    return applicable.sort((a, b) => Number(a.important) - Number(b.important) || a.index - b.index).at(-1)?.value;
  };

  assert.equal(computedDisplay('left'), 'none');
  assert.equal(computedDisplay('right'), 'none');
  assert.match(read('public/ui/session-shell.css'), /body\.session-focused\s+\.timer-display\s*\{[\s\S]*font-family:\s*var\(--font-data\)/);
});
