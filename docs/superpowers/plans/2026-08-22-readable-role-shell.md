# Readable Role-Based Product Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a readable, role-aware gIVEMEGAME product shell where students can join a game immediately and educators can create or manage learning activities without competing navigation systems.

**Architecture:** Keep the existing Express multi-page application and backend APIs. Add a small shared CSS/JavaScript presentation layer, pure role-routing helpers, a dedicated student home, and progressively apply the shared shell to the generator and educator surfaces without rewriting game business logic.

**Tech Stack:** Node.js, Express 4, vanilla HTML/CSS/JavaScript, Node test runner, Supabase Auth/PostgreSQL, Vercel.

**Spec:** `docs/superpowers/specs/2026-08-22-readable-role-shell-design.md`

## Global Constraints

- Atkinson Hyperlegible is the body/control face at a minimum of 16px; IBM Plex Mono is reserved for codes, timers and data.
- Press Start 2P is used only for the logo, short product badges and selected celebratory game moments, never for paragraphs, form controls, table cells or navigation labels.
- Existing Express, vanilla JavaScript, Supabase, Stripe and server authorization boundaries remain in place.
- Active/pending lobby intent takes precedence over role-based post-login routing.
- Students land on `/student/`; teachers/admins land on `/edu/`; users without a school role land on `/index.html`.
- Existing public URLs and backend response shapes remain compatible.
- Controls have at least 44px touch targets, visible `:focus-visible` treatment and reduced-motion support.
- No horizontal page scroll is allowed at 375px, 768px or desktop widths.
- User-authored changes in `AI_CONTEXT_PROMPT.md` and `Avatars/` remain outside task commits.
- Every task ends with focused tests, `git diff --check`, an independent review and a small commit.

---

### Task 1: Shared readable design tokens and shell primitives

**Files:**
- Create: `public/ui/tokens.css`
- Create: `public/ui/shell.css`
- Create: `public/ui/shell.js`
- Create: `test/product-shell.test.js`

**Interfaces:**
- Consumes: no earlier task output.
- Produces: CSS variables under `:root`; `.product-shell`, `.product-nav`, `.product-card`, `.product-button`, `.product-field`, `.product-state` primitives; `ProductShell.setActiveNavigation(root, pathname)` and `ProductShell.toggleMenu(button, panel)`.

- [ ] **Step 1: Write failing static contract tests**

Add tests that read the three new assets and assert the readable font roles, focus treatment, touch target, reduced motion and CommonJS/browser export:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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
```

- [ ] **Step 2: Run the test and verify the assets are missing**

Run: `node --test test/product-shell.test.js`  
Expected: FAIL because `public/ui/tokens.css` does not exist.

- [ ] **Step 3: Create the token stylesheet**

Define the exact shared families and core colors:

```css
@import url("https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&family=IBM+Plex+Mono:wght@400;600&family=Press+Start+2P&display=swap");

:root {
  --font-body: "Atkinson Hyperlegible", system-ui, sans-serif;
  --font-data: "IBM Plex Mono", ui-monospace, monospace;
  --font-pixel: "Press Start 2P", monospace;
  --shell-bg: #0b1020;
  --shell-surface: #121a2f;
  --shell-raised: #18233f;
  --shell-text: #f4f7ff;
  --shell-muted: #a9b4cc;
  --shell-violet: #8b5cf6;
  --shell-cyan: #22d3ee;
  --shell-yellow: #facc15;
  --shell-danger: #fb7185;
  --shell-success: #4ade80;
  --shell-focus: #facc15;
  --shell-radius: 14px;
  --shell-space-1: .5rem;
  --shell-space-2: .75rem;
  --shell-space-3: 1rem;
  --shell-space-4: 1.5rem;
  --shell-space-5: 2rem;
}
```

- [ ] **Step 4: Create shared shell CSS and JS**

Implement scoped layout primitives, skip link, labeled navigation, 44px controls, responsive navigation and reduced-motion handling. Export the helper through UMD so Node tests and browser pages use the same source:

```js
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ProductShell = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function setActiveNavigation(root, pathname) {
    if (!root) return;
    root.querySelectorAll('[data-shell-route]').forEach(link => {
      const active = pathname === link.getAttribute('href')
        || pathname.startsWith(link.dataset.shellRoute || '__never__');
      link.toggleAttribute('aria-current', active);
    });
  }

  function toggleMenu(button, panel) {
    const expanded = button.getAttribute('aria-expanded') === 'true';
    button.setAttribute('aria-expanded', String(!expanded));
    panel.hidden = expanded;
  }

  return { setActiveNavigation, toggleMenu };
});
```

- [ ] **Step 5: Verify and commit**

Run: `node --test test/product-shell.test.js`  
Expected: PASS.  
Run: `node --check public/ui/shell.js` and `git diff --check`.  
Commit: `feat(ui): add readable product shell foundation`.

---

### Task 2: Role-aware post-login routing

**Files:**
- Create: `public/js/post-login-router.js`
- Modify: `public/login.html`
- Modify: `server.js`
- Modify: `test/product-shell.test.js`

**Interfaces:**
- Consumes: Supabase session access token; `/api/edu/me`; session storage key `givemegame_pending_lobby`.
- Produces: `PostLoginRouter.destinationFor({ pendingLobby, schoolRole }) -> string`; `PostLoginRouter.fetchSchoolRole(accessToken, fetchImpl) -> Promise<string|null>`; canonical `/student` and `/student/` routes.

- [ ] **Step 1: Add failing routing tests**

```js
const router = require('../public/js/post-login-router.js');

test('pending lobby wins over role routing', () => {
  assert.equal(router.destinationFor({ pendingLobby: 'AB12CD', schoolRole: 'student' }), '/index.html?lobby=AB12CD');
});

test('role routing sends each user to the next task', () => {
  assert.equal(router.destinationFor({ schoolRole: 'student' }), '/student/');
  assert.equal(router.destinationFor({ schoolRole: 'teacher' }), '/edu/');
  assert.equal(router.destinationFor({ schoolRole: 'admin' }), '/edu/');
  assert.equal(router.destinationFor({ schoolRole: null }), '/index.html');
});
```

- [ ] **Step 2: Verify failure**

Run: `node --test test/product-shell.test.js`  
Expected: FAIL because `post-login-router.js` is missing.

- [ ] **Step 3: Implement the pure router and role fetch**

Use a UMD module. Normalize lobby codes with `/^[A-Z0-9]{6}$/`; accept only `student`, `teacher` and `admin` roles from `/api/edu/me`; return `null` on 401, 403 or network failure without granting access.

```js
function destinationFor({ pendingLobby = '', schoolRole = null } = {}) {
  const code = String(pendingLobby).trim().toUpperCase();
  if (/^[A-Z0-9]{6}$/.test(code)) return `/index.html?lobby=${encodeURIComponent(code)}`;
  if (schoolRole === 'student') return '/student/';
  if (schoolRole === 'teacher' || schoolRole === 'admin') return '/edu/';
  return '/index.html';
}
```

- [ ] **Step 4: Integrate login and server routes**

Load `/js/post-login-router.js` before login logic. In `saveUserAndRedirect`, read and remove `givemegame_pending_lobby`, call `fetchSchoolRole(session.access_token, window.fetch)`, and assign the pure destination. Add Express `sendFile` routes for `/student` and `/student/`; do not add a server-side role bypass.

- [ ] **Step 5: Verify and commit**

Run: `node --test test/product-shell.test.js test/edu-auth.test.js`.  
Run: `node --check public/js/post-login-router.js server.js` and `git diff --check`.  
Commit: `feat(auth): route users to role-based homes`.

---

### Task 3: Join-first student home

**Files:**
- Create: `public/student/index.html`
- Create: `public/student/student.css`
- Create: `public/student/student.js`
- Modify: `test/product-shell.test.js`

**Interfaces:**
- Consumes: `ProductShell`; Supabase browser session; `/api/edu/me`; `/api/assessment-results/me`; existing `/index.html?lobby=CODE` session entry.
- Produces: `StudentHome.normalizeJoinCode(value) -> string`; `StudentHome.joinDestination(value) -> string|null`; accessible `/student/` page.

- [ ] **Step 1: Write failing route, landmark and helper tests**

Start an existing test server as used by `test/institution-dashboard.test.js`, request `/student/`, and assert:

```js
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
```

- [ ] **Step 2: Verify failure**

Run: `node --test test/product-shell.test.js`  
Expected: FAIL because the page/assets are missing.

- [ ] **Step 3: Build semantic student home markup**

Use a skip link, labeled product navigation, a single `h1`, a six-cell join portal backed by one accessible text input, active-session state, assessment/activity state, progress card and a secondary solo-play link. Copy is Slovak and task-oriented: “Pripoj sa do hry”, “Kód dostaneš od učiteľa”, “Moje aktivity”, “Pokrok” and “Hrať sám”.

- [ ] **Step 4: Implement student behavior**

Export pure code helpers through UMD. On submit, prevent navigation for invalid codes, set a visible error message and focus it; for a valid code set `window.location.assign(joinDestination(code))`. Load profile and assessment results only with the current access token. Render all remote text through `textContent`.

- [ ] **Step 5: Add student responsive styling**

Use the shared tokens. The join portal is the only pixel-forward signature. At 375px, cards become one column, the input remains usable without page overflow and navigation exposes at most four primary destinations plus “Viac”.

- [ ] **Step 6: Verify and commit**

Run: `node --test test/product-shell.test.js`.  
Run: `node --check public/student/student.js` and `git diff --check`.  
Browser smoke: `/student/` at 1440x900 and 375x812.  
Commit: `feat(student): add join-first home`.

---

### Task 4: Reframe the generator as a focused creation flow

**Files:**
- Modify: `public/index.html`
- Create: `public/ui/generator-shell.css`
- Modify: `public/script.js`
- Modify: `test/product-shell.test.js`

**Interfaces:**
- Consumes: existing element IDs and `App.generate()`, `App.surprise()`, `App.setMode()`, `Session.openJoinDialog()` behavior.
- Produces: essential creation region `#creation-basics`; collapsed `<details id="advanced-options">`; labeled Join action; account/preferences menu; body state `generator-shell`.

- [ ] **Step 1: Add failing generator hierarchy tests**

```js
const generator = read('public/index.html');
assert.match(generator, /id="creation-basics"/);
assert.match(generator, /<details\b[^>]*id="advanced-options"/i);
assert.match(generator, /id="btn-join-session"[\s\S]*Pripojiť sa do hry/i);
assert.match(generator, /href="\/ui\/generator-shell\.css"/i);
assert.doesNotMatch(generator, /id="btn-join-session"[\s\S]{0,160}>\s*🔑\s*<\/button>/i);
```

- [ ] **Step 2: Verify failure**

Run: `node --test test/product-shell.test.js`  
Expected: FAIL because the new hierarchy is absent.

- [ ] **Step 3: Restructure markup without changing behavior IDs**

Move mode, audience, duration, description and primary generation action into `#creation-basics`. Move curriculum, competency, energy, map and optional variations inside `#advanced-options`. Replace the key-only join button with a labeled 44px button near the top of the creation panel. Group language, theme, music and account links under one labeled preferences menu.

- [ ] **Step 4: Add scoped readable generator styling**

Load shared tokens and `generator-shell.css` after legacy `style.css`. Under `body.generator-shell`, override UI copy to `var(--font-body)`, codes/data to `var(--font-data)`, remove horizontal header overflow, constrain the creation column and hide unrelated right-rail widgets from the initial task view. Do not alter generated game content rendering selectors.

- [ ] **Step 5: Preserve behavior and verify**

Run: `node --test test/product-shell.test.js test/plan-entitlements.test.js`.  
Run: `node --check public/script.js` and `git diff --check`.  
Browser smoke: generator default, advanced options open, Join action, 375px filters drawer.  
Commit: `feat(generator): clarify the activity creation flow`.

---

### Task 5: Unify educator, assessment and INVOK navigation

**Files:**
- Create: `public/edu/js/edu-shell.js`
- Modify: `public/edu/css/edu.css`
- Modify: `public/edu/index.html`
- Modify: `public/edu/classes.html`
- Modify: `public/edu/gradebook.html`
- Modify: `public/edu/attendance.html`
- Modify: `public/edu/members.html`
- Modify: `public/edu/perk-requests.html`
- Modify: `public/edu/assessments.html`
- Modify: `public/institution/index.html`
- Modify: `public/institution/institution.css`
- Modify: `test/institution-dashboard.test.js`
- Modify: `test/assessments-frontend.test.js`
- Modify: `test/product-shell.test.js`

**Interfaces:**
- Consumes: `EduAuth.getProfile()` and existing page routes.
- Produces: `EduShell.itemsForRole(role) -> Array<{ href, label, group }>` and `EduShell.mount({ root, role, pathname })`; a single role-filtered navigation vocabulary shared by EDU, assessments and INVOK.

- [ ] **Step 1: Write failing navigation tests**

```js
const shell = require('../public/edu/js/edu-shell.js');
const studentLabels = shell.itemsForRole('student').map(item => item.label);
const teacherLabels = shell.itemsForRole('teacher').map(item => item.label);
assert.deepEqual(studentLabels, ['Prehľad', 'Moje aktivity', 'Pokrok']);
assert.ok(teacherLabels.includes('Vytvoriť aktivitu'));
assert.ok(teacherLabels.includes('Assessmenty'));
assert.ok(teacherLabels.includes('Výsledky INVOK'));
assert.equal(teacherLabels.includes('Členovia'), true);
```

Static tests assert every educator page loads `tokens.css`, `shell.css`, `edu-shell.js` and contains one `[data-edu-shell]` mount point instead of a copied list.

- [ ] **Step 2: Verify failure**

Run: `node --test test/product-shell.test.js test/institution-dashboard.test.js test/assessments-frontend.test.js`  
Expected: FAIL because the shared educator shell does not exist.

- [ ] **Step 3: Implement role-filtered educator navigation**

Use DOM node creation and `textContent`, not HTML interpolation for labels. Teacher/admin top-level items are Prehľad, Vytvoriť aktivitu, Knižnica a živé hry, Triedy, Assessmenty, Výsledky INVOK and Účet. Student EDU items are Prehľad, Moje aktivity and Pokrok. School-management links remain in a labeled secondary group for authorized roles.

- [ ] **Step 4: Replace copied navigation and align styles**

Change each page to a common mount point and load shared assets in a stable order: tokens, shell, page stylesheet, Supabase SDK, EduAuth, EduShell, page script. Convert EDU body/control typography to Atkinson Hyperlegible and reserve IBM Plex Mono for numeric/data cells. Keep INVOK's Impact Trail while aligning its shell/navigation.

- [ ] **Step 5: Verify and commit**

Run: `node --test test/product-shell.test.js test/institution-dashboard.test.js test/assessments-frontend.test.js test/edu-auth.test.js`.  
Run: `node --check public/edu/js/edu-shell.js` and `git diff --check`.  
Browser smoke: EDU, assessment and INVOK no-auth/access states plus mobile navigation.  
Commit: `feat(edu): unify educator and evidence navigation`.

---

### Task 6: Focused lobby and live-game state

**Files:**
- Create: `public/ui/session-shell.css`
- Modify: `public/js/session.js`
- Modify: `public/index.html`
- Modify: `test/product-shell.test.js`

**Interfaces:**
- Consumes: existing `Session.create`, `Session.join`, `Session.start`, `Session.complete`, `_closeLobby` and `_quitSession` flows.
- Produces: body class `session-focused`; semantic `.session-dialog`, `.session-code`, `.session-participants`, `.session-actions`; `Session.setFocusedState(active)`.

- [ ] **Step 1: Write failing session-shell tests**

Assert `session.js` exports `setFocusedState`, no longer injects `style="..."` in join/lobby markup, and uses dialog headings, labeled close/leave actions and `aria-live` participant state. Assert `session-shell.css` hides `.left-panel`, `.right-panel` and unrelated header actions only while `body.session-focused` is active.

- [ ] **Step 2: Verify failure**

Run: `node --test test/product-shell.test.js`  
Expected: FAIL because session markup still uses inline presentation.

- [ ] **Step 3: Move session presentation into CSS**

Replace dynamically injected inline declarations with stable classes. Use IBM Plex Mono for the lobby code and timer, Atkinson Hyperlegible for instructions/actions, at least 44px buttons and a single-column mobile dialog.

- [ ] **Step 4: Implement deterministic focused state**

```js
function setFocusedState(active) {
  document.body.classList.toggle('session-focused', Boolean(active));
}
```

Activate it when a pending lobby opens, a lobby is created/joined or a session becomes active. Clear it only after quit/completion returns the user to creation or student home. Preserve session restoration and polling behavior.

- [ ] **Step 5: Verify and commit**

Run: `node --test test/product-shell.test.js test/integration/rate-limit.test.js`.  
Run: `node --check public/js/session.js` and `git diff --check`.  
Browser smoke: manual Join dialog, waiting lobby and mobile focused state using mocked DOM/session data.  
Commit: `feat(session): focus the live game experience`.

---

### Task 7: Apply readable typography to public and account surfaces

**Files:**
- Modify: `public/home.html`
- Modify: `public/home.css`
- Modify: `public/login.html`
- Modify: `public/account.html`
- Modify: `public/pricing.html`
- Modify: `public/game.html`
- Modify: `public/billing/success.html`
- Modify: `public/billing/cancel.html`
- Modify: `test/product-shell.test.js`

**Interfaces:**
- Consumes: shared tokens and shell assets.
- Produces: consistent public/auth/account typography and focus behavior; unchanged login, billing and public game behavior.

- [ ] **Step 1: Add failing typography-role tests**

For each listed HTML file, assert `tokens.css` is loaded. For the linked/page stylesheet source, reject Press Start declarations applied to `body`, `p`, `input`, `select`, `textarea`, `button`, `table`, `td`, navigation labels or text smaller than 10px. Assert login and billing controls use shared button/field classes or equivalent 44px minimum sizing.

- [ ] **Step 2: Verify failure**

Run: `node --test test/product-shell.test.js`  
Expected: FAIL on legacy pixel typography.

- [ ] **Step 3: Apply shared type roles without changing product behavior**

Load shared assets and replace page body/control fonts with `var(--font-body)`. Keep Press Start on brand marks and short badges only. Keep IBM Plex Mono on prices, codes and status data. Remove 6–9px UI text and normalize readable line-height.

- [ ] **Step 4: Fix public wording and route clarity**

Use Slovak task labels consistently. Make `/game/:id` link to `/index.html` when the action says “Otvoriť generátor”. Update Free copy from two to the implemented three generations per day. Do not change pricing amounts or legal claims.

- [ ] **Step 5: Verify and commit**

Run: `node --test test/product-shell.test.js test/billing-subscriptions.test.js`.  
Run: `git diff --check`.  
Browser smoke: `/`, `/login.html`, `/account.html`, `/pricing.html`, billing success/cancel and public game shell at desktop/mobile widths.  
Commit: `feat(ui): make public and account surfaces readable`.

---

### Task 8: Whole-product QA, GitHub push and Vercel Preview

**Files:**
- Modify: `PROJECT_STATE.md`
- Modify: `docs/superpowers/plans/2026-08-22-readable-role-shell.md`
- Review: all files changed by Tasks 1–7.

**Interfaces:**
- Consumes: complete implementation and all focused verification evidence.
- Produces: reviewed GitHub branch and `Ready` Vercel Preview URL; no production promotion.

- [ ] **Step 1: Run complete automated verification**

Run: `npm test` and require zero failures/natural exit.  
Run `node --check` on `server.js`, every `lib/*.js`, `public/ui/*.js`, `public/student/*.js`, `public/edu/js/*.js` and modified public scripts.  
Run: `git diff --check d05dab8..HEAD`.

- [ ] **Step 2: Run responsive browser QA**

At 1440x900, 768x1024 and 375x812 verify `/`, `/login.html`, `/student/`, `/index.html`, `/edu/`, `/edu/assessments.html` and `/institution/`. For each width, record title/primary heading, horizontal overflow, visible focus, navigation count and console errors. Verify `prefers-reduced-motion` behavior and direct `/index.html?lobby=ABC123` routing without submitting a live join.

- [ ] **Step 3: Run independent QA review**

Review information hierarchy, student join discoverability, educator navigation, XSS-safe rendering, auth routing, keyboard behavior, mobile touch targets and regressions. Fix all Critical/Important findings and rerun affected tests.

- [ ] **Step 4: Update project state and plan evidence**

Record completed routes, typography rules, test count, known external dependencies and Preview-only release status. Mark all implemented task checkboxes complete.

- [ ] **Step 5: Push and verify Vercel Preview**

Push `codex/readable-student-shell` to `origin`. Wait for the Git-integrated Vercel Preview to reach `Ready`. Use authenticated `vercel curl` to verify `/`, `/student/`, `/index.html`, `/edu/`, `/institution/` and `/api/billing/public-config`. Confirm production aliases were not changed.

- [ ] **Step 6: Final handoff**

Provide the GitHub branch, commit SHA, Vercel Preview URL, test results, routes to exercise and any action that still requires the repository owner. Do not claim live student/teacher data success without staging credentials and seeded accounts.

