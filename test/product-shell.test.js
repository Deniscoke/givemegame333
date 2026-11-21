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

test('generator exposes one named, accessible tools surface without removing profile or RPG entry points', () => {
  const generator = read('public/index.html');

  // Phase 3: the icon is the pixel sprite (<svg class="px-icon"><use …#i-tools>) instead of a Bootstrap <i>.
  assert.match(generator, /id="btn-game-tools"[^>]*aria-controls="game-tools-panel"[^>]*>\s*<svg class="px-icon"[^>]*><use href="\/ui\/icons\/px-icons\.svg#i-tools"><\/use><\/svg>\s*<span(?: data-i18n="tools_button")?>Nástroje<\/span>/i);
  assert.match(generator, /<aside\b[^>]*id="game-tools-panel"[^>]*class="[^"]*right-panel[^"]*game-tools[^"]*"[^>]*aria-label="Herné nástroje"/i);
  assert.match(generator, /class="game-tools-title"[^>]*>Herné nástroje</i);
  assert.match(generator, /role="tablist"[^>]*aria-label="Herné nástroje"/i);

  for (const [tool, label] of [
    ['smarta', 'SMARTA'],
    ['history', 'Questy a história'],
    ['tamagochi', 'gIVEMEGOCHI'],
    ['stats', 'Štatistiky'],
  ]) {
    assert.match(generator, new RegExp(`role="tab"[^>]*data-tool="${tool}"[^>]*aria-controls="tool-panel-${tool}"[\\s\\S]{0,120}>[\\s\\S]{0,80}${label}`, 'i'));
    assert.match(generator, new RegExp(`id="tool-panel-${tool}"[^>]*role="tabpanel"[^>]*aria-labelledby="tool-tab-${tool}"`, 'i'));
  }

  assert.match(generator, /onclick="App\.Profile\.open\(\)"[^>]*>\s*Môj profil\s*</i);
  assert.match(generator, /onclick="window\.RpgScreen\s*&&\s*RpgScreen\.open\(\)"[^>]*>\s*RPG profil\s*</i);
});

test('generator tools are a static wide panel and an explicit compact drawer', () => {
  const styles = read('public/ui/generator-shell.css');

  assert.doesNotMatch(styles, /body\.generator-shell:not\(\.mobile-smarta-open\)\s+aside\.right-panel\s*\{[\s\S]*?display:\s*none/);
  assert.match(styles, /@media\s*\(min-width:\s*1200px\)[\s\S]*body\.generator-shell\s+aside\.game-tools\s*\{[\s\S]*display:\s*flex/);
  assert.match(styles, /@media\s*\(max-width:\s*1199px\)[\s\S]*body\.generator-shell\.mobile-smarta-open\s+aside\.game-tools\s*\{[\s\S]*transform:\s*translateX\(0\)/);
  assert.match(styles, /body\.session-focused\s+aside\.game-tools\s*\{[\s\S]*display:\s*none\s*!important/);
  assert.match(styles, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
});

test('GameUI opens named tools and preserves legacy SMARTA and history entry points', () => {
  const listeners = {};
  const classes = new Set();
  const attrs = new Map();
  const makeNode = (id) => ({
    id,
    hidden: false,
    tabIndex: 0,
    focus() { this.focused = true; },
    scrollIntoView() {},
    setAttribute(name, value) { attrs.set(`${id}:${name}`, String(value)); },
    getAttribute(name) { return attrs.get(`${id}:${name}`) ?? null; },
  });
  const nodes = new Map([
    ['btn-game-tools', makeNode('btn-game-tools')],
    ['game-tools-panel', makeNode('game-tools-panel')],
    ['game-tools-close', makeNode('game-tools-close')],
  ]);
  const tabs = ['smarta', 'history', 'tamagochi', 'stats'].map(tool => {
    const node = makeNode(`tool-tab-${tool}`);
    node.dataset = { tool };
    nodes.set(node.id, node);
    return node;
  });
  const panels = ['smarta', 'history', 'tamagochi', 'stats'].map(tool => {
    const node = makeNode(`tool-panel-${tool}`);
    node.setAttribute('data-tool-panel', tool);
    nodes.set(node.id, node);
    return node;
  });
  const context = vm.createContext({
    console,
    setTimeout,
    window: {},
    document: {
      activeElement: { id: 'history-trigger', focus() { this.focused = true; } },
      body: {
        classList: {
          add(...names) { names.forEach(name => classes.add(name)); },
          remove(...names) { names.forEach(name => classes.delete(name)); },
          contains(name) { return classes.has(name); },
          toggle(name) { classes.has(name) ? classes.delete(name) : classes.add(name); return classes.has(name); },
        },
      },
      getElementById(id) { return nodes.get(id) || null; },
      querySelectorAll(selector) {
        if (selector === '[role="tab"][data-tool]') return tabs;
        if (selector === '[role="tabpanel"][data-tool-panel]') return panels;
        return [];
      },
      addEventListener(type, handler) { listeners[type] = handler; },
    },
  });
  context.window = context;
  vm.runInContext(read('public/js/game-ui.js'), context, { filename: 'game-ui.js' });

  context.GameUI.initTools();
  context.GameUI.toggleHistory();
  assert.equal(classes.has('mobile-smarta-open'), true);
  assert.equal(attrs.get('btn-game-tools:aria-expanded'), 'true');
  assert.equal(attrs.get('tool-tab-history:aria-selected'), 'true');
  assert.equal(nodes.get('tool-panel-history').hidden, false);
  assert.equal(nodes.get('tool-panel-smarta').hidden, true);

  context.GameUI.toggleMobileSmarta();
  assert.equal(attrs.get('tool-tab-smarta:aria-selected'), 'true');
  listeners.keydown({ key: 'Escape' });
  assert.equal(classes.has('mobile-smarta-open'), false);
  assert.equal(attrs.get('btn-game-tools:aria-expanded'), 'false');
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
    '/index.html?view=library',
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
    assert.deepEqual(currentLabels(role, '/index.html?view=library'), ['Knižnica a živé hry']);
  }
  assert.deepEqual(currentLabels('student', '/edu/assessments.html'), ['Moje aktivity']);
});

test('educator library route opens the existing generator library state', async () => {
  const modal = { style: { display: 'none' } };
  const list = { innerHTML: '' };
  const context = vm.createContext({
    window: { location: { origin: 'https://example.test', search: '?view=library' } },
    document: {
      addEventListener() {},
      getElementById(id) {
        if (id === 'library-modal') return modal;
        if (id === 'library-list') return list;
        return null;
      },
      querySelectorAll: () => [],
    },
    getCurrentUser: () => null,
    setTimeout,
    clearTimeout,
    URLSearchParams,
    AbortController,
    fetch: async () => { throw new Error('unauthenticated library view should not fetch'); },
  });
  vm.runInContext(read('public/js/library.js'), context, { filename: 'library.js' });

  assert.equal(typeof context.window.Library.openRequestedView, 'function');
  assert.equal(await context.window.Library.openRequestedView(), true);
  assert.equal(modal.style.display, 'flex');
  assert.match(list.innerHTML, /prístup ku knižnici sa prihlás/i);
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

test('authenticated educator small buttons preserve a 44px interactive box', () => {
  const css = read('public/edu/css/edu.css');
  const declarations = declarationsFor(css, '.edu-btn-sm');

  assertMinTouchTarget(css, '.edu-btn-sm', 'public/edu/css/edu.css');
  assert.match(declarations, /min-width:\s*44px/i);
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

test('pending lobby survives an unauthenticated generator reload', async () => {
  const pending = new Map();
  const location = {
    origin: 'https://example.test',
    pathname: '/index.html',
    search: '?lobby=AB12CD',
    hash: '',
  };
  const context = vm.createContext({
    window: { location },
    history: {
      replaceState(_state, _title, next) {
        location.search = next.includes('?') ? `?${next.split('?')[1].split('#')[0]}` : '';
      },
    },
    document: {
      getElementById: () => null,
      body: { classList: { toggle() {}, remove() {} } },
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: {
      getItem: (key) => pending.get(key) || null,
      setItem: (key, value) => pending.set(key, value),
      removeItem: (key) => pending.delete(key),
    },
    GameUI: { toast() {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URLSearchParams,
    AbortController,
    fetch: async () => { throw new Error('unauthenticated restore should not fetch'); },
  });
  vm.runInContext(read('public/js/session.js'), context, { filename: 'session.js' });

  await context.window.Session.restoreFromUrlOrStorage();
  assert.equal(pending.get('givemegame_pending_lobby'), 'AB12CD');
  await context.window.Session.restoreFromUrlOrStorage();
  assert.equal(pending.get('givemegame_pending_lobby'), 'AB12CD');
});

test('login performs one pending-lobby redirect when auth callbacks race', async () => {
  const pending = new Map([['givemegame_pending_lobby', 'AB12CD']]);
  const navigations = [];
  let authCallback;
  let profileWrites = 0;
  let roleLookups = 0;
  const user = {
    id: 'user-1',
    email: 'student@example.test',
    user_metadata: { full_name: 'Student' },
  };
  const session = { access_token: 'access-token', user };
  const location = {
    origin: 'https://example.test',
    pathname: '/login.html',
    search: '',
    hash: '',
    get href() { return 'https://example.test/login.html'; },
    set href(value) { navigations.push(value); },
  };
  const client = {
    from: () => ({
      upsert: async () => {
        profileWrites += 1;
        await Promise.resolve();
        return { error: null };
      },
    }),
    auth: {
      getSession: async () => ({ data: { session } }),
      onAuthStateChange(callback) { authCallback = callback; },
    },
  };
  const button = { addEventListener() {}, classList: { add() {}, remove() {} } };
  const context = vm.createContext({
    window: {
      location,
      history: { replaceState() {} },
      supabase: { createClient: () => client },
      PostLoginRouter: {
        async fetchSchoolRole() { roleLookups += 1; return 'student'; },
        destinationFor: router.destinationFor,
      },
      fetch: async () => { throw new Error('router fetch is stubbed'); },
    },
    document: { getElementById: (id) => id === 'btn-google' ? button : null },
    sessionStorage: {
      getItem: (key) => pending.get(key) || null,
      setItem: (key, value) => pending.set(key, value),
      removeItem: (key) => pending.delete(key),
    },
    URLSearchParams,
    Date,
    console,
    setTimeout: (callback) => { queueMicrotask(callback); return 1; },
  });
  const loginScripts = [...read('public/login.html').matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
  vm.runInContext(loginScripts.at(-1)[1], context, { filename: 'login-inline.js' });
  authCallback('INITIAL_SESSION', session);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(profileWrites, 1);
  assert.equal(roleLookups, 1);
  assert.deepEqual(navigations, ['/index.html?lobby=AB12CD']);
  assert.equal(pending.has('givemegame_pending_lobby'), false);
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

test('session dialogs trap focus, close with Escape and restore the invoking control', async () => {
  const elements = new Map();
  const bodyChildren = [];
  const classes = new Set();
  let nextTimer = 0;
  const scheduledTimers = new Set();
  let document;

  function makeElement(tagName = 'div') {
    const listeners = new Map();
    let html = '';
    const element = {
      tagName: tagName.toUpperCase(),
      id: '',
      hidden: false,
      disabled: false,
      inert: false,
      className: '',
      style: {},
      _focusables: [],
      classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
      addEventListener(type, callback) { listeners.set(type, callback); },
      dispatch(type, event) { listeners.get(type)?.({ target: element, ...event }); },
      focus() { document.activeElement = element; },
      contains(node) { return node === element || element._focusables.includes(node); },
      querySelectorAll() { return element._focusables; },
      querySelector() { return null; },
    };
    Object.defineProperty(element, 'innerHTML', {
      get: () => html,
      set(value) {
        html = String(value);
        element._focusables = [];
        for (const match of html.matchAll(/<(button|input|a)\b([^>]*)>/gi)) {
          const control = makeElement(match[1]);
          control.id = match[2].match(/\bid="([^"]+)"/i)?.[1] || '';
          control.hidden = /\bhidden\b/i.test(match[2]);
          if (control.id) elements.set(control.id, control);
          element._focusables.push(control);
        }
        for (const id of html.matchAll(/\bid="([^"]+)"/gi)) {
          if (!elements.has(id[1])) {
            const child = makeElement();
            child.id = id[1];
            elements.set(child.id, child);
          }
        }
      },
    });
    return element;
  }

  const body = {
    children: bodyChildren,
    classList: {
      toggle(name, active) { classes[active ? 'add' : 'delete'](name); },
      remove(...names) { names.forEach((name) => classes.delete(name)); },
    },
    appendChild(element) {
      bodyChildren.push(element);
      if (element.id) elements.set(element.id, element);
    },
  };
  document = {
    activeElement: null,
    body,
    createElement: makeElement,
    getElementById: (id) => elements.get(id) || null,
  };
  const workspace = makeElement('main');
  workspace.id = 'workspace';
  body.appendChild(workspace);
  const joinTrigger = makeElement('button');
  joinTrigger.id = 'btn-join-session';
  body.appendChild(joinTrigger);

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
      : { ok: true, json: async () => ({ status: 'waiting', participants: [] }) },
    setTimeout: (callback, delay = 0) => { if (delay < 8000) callback(); return 1; },
    clearTimeout,
    setInterval: () => { const id = ++nextTimer; scheduledTimers.add(id); return id; },
    clearInterval: (id) => scheduledTimers.delete(id),
    URLSearchParams,
    AbortController,
    confirm: () => true,
  });
  vm.runInContext(read('public/js/session.js'), context, { filename: 'session.js' });

  document.activeElement = joinTrigger;
  context.window.Session.openJoinDialog();
  const joinModal = elements.get('session-join-modal');
  const joinInput = elements.get('join-code-input');
  const joinSubmit = elements.get('btn-join-submit');
  assert.equal(workspace.inert, true);
  assert.equal(document.activeElement, joinInput);

  document.activeElement = joinSubmit;
  let prevented = false;
  joinModal.dispatch('keydown', { key: 'Tab', shiftKey: false, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(document.activeElement, joinInput);
  document.activeElement = joinInput;
  joinModal.dispatch('keydown', { key: 'Tab', shiftKey: true, preventDefault() {} });
  assert.equal(document.activeElement, joinSubmit);
  joinModal.dispatch('keydown', { key: 'Escape', preventDefault() {} });
  assert.equal(joinModal.hidden, true);
  assert.equal(workspace.inert, false);
  assert.equal(document.activeElement, joinTrigger);

  document.activeElement = joinTrigger;
  await context.window.Session.create({ title: 'Čakajúca hra' });
  const lobby = elements.get('session-lobby-modal');
  const badge = elements.get('session-badge');
  assert.equal(document.activeElement, elements.get('session-lobby-close'));
  assert.equal(workspace.inert, true);
  lobby.dispatch('keydown', { key: 'Escape', preventDefault() {} });
  assert.equal(lobby.hidden, true);
  assert.equal(workspace.inert, false);
  assert.equal(badge.hidden, false, 'Escape must preserve the waiting-lobby recovery badge');
  assert.equal(document.activeElement, joinTrigger);

  const badgeOpen = badge._focusables[0];
  document.activeElement = badgeOpen;
  context.window.Session._openLobbyFromBadge();
  lobby.dispatch('keydown', { key: 'Escape', preventDefault() {} });
  assert.equal(document.activeElement, badgeOpen);
  assert.equal(scheduledTimers.size, 0);
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
