# Session & Progression System — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add session lobby, realtime multiplayer, reflection flow, and competency progression to gIVEMEGAME.IO.

**Architecture:** Supabase Realtime channels sync session state across clients. Backend REST API (server.js) handles all DB writes. Frontend split into new modules: `reflection.js` and `session.js` (same IIFE pattern as existing modules).

**Tech Stack:** Node.js/Express, PostgreSQL via `queryCoinsDb()`, Supabase Realtime (JS client), Vanilla JS IIFEs.

---

## Constants (define once, reference everywhere)

In `server.js`, add near the top with other config:
```js
const SESSION_JOIN_COST   = 200;   // coins per player on Start
const COMPETENCY_AWARD    = 50;    // points per competency per session
const COMPLETION_BONUS    = 100;   // coins bonus on session complete
const JOIN_CODE_CHARS     = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const JOIN_CODE_LENGTH    = 6;
```

In `public/js/session.js`, add same constants:
```js
const SESSION_JOIN_COST = 200;
```

---

## Task 1: DB Migration 011

**Files:**
- Create: `supabase/migrations/011_sessions_and_progression.sql`

**Step 1: Write the migration**

```sql
-- ═══════════════════════════════════════════════════════════════════
-- gIVEMEGAME.IO — Sessions + Competency Progression
-- Migration 011
-- ═══════════════════════════════════════════════════════════════════

-- 1. Competency points on profiles (JSONB — keys match rvp.json kompetence keys)
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS competency_points JSONB NOT NULL DEFAULT '{}';

-- 2. Sessions table
CREATE TABLE IF NOT EXISTS public.sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  game_json     JSONB NOT NULL,
  join_code     TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'waiting'
                  CHECK (status IN ('waiting','active','reflection','completed')),
  timer_ends_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT now(),
  completed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sessions_host     ON public.sessions(host_id);
CREATE INDEX IF NOT EXISTS idx_sessions_code     ON public.sessions(join_code);
CREATE INDEX IF NOT EXISTS idx_sessions_status   ON public.sessions(status);

-- 3. Session participants
CREATE TABLE IF NOT EXISTS public.session_participants (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id           UUID NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  user_id              UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  coins_paid           INTEGER NOT NULL DEFAULT 0,
  reflection_data      JSONB,
  reflection_done      BOOLEAN NOT NULL DEFAULT false,
  awarded_competencies JSONB,
  joined_at            TIMESTAMPTZ DEFAULT now(),
  UNIQUE(session_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_sp_session ON public.session_participants(session_id);
CREATE INDEX IF NOT EXISTS idx_sp_user    ON public.session_participants(user_id);

-- 4. RLS
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session_participants ENABLE ROW LEVEL SECURITY;

-- Sessions: anyone can read (needed for join by code); only host modifies
CREATE POLICY "Sessions readable by all authenticated"
  ON public.sessions FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Host can insert session"
  ON public.sessions FOR INSERT WITH CHECK (auth.uid() = host_id);
CREATE POLICY "Host can update session"
  ON public.sessions FOR UPDATE USING (auth.uid() = host_id);

-- Participants: user sees own rows + all rows in sessions they belong to
CREATE POLICY "Participants: view own rows"
  ON public.session_participants FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Participants: insert own row"
  ON public.session_participants FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Participants: update own row"
  ON public.session_participants FOR UPDATE USING (auth.uid() = user_id);

GRANT SELECT, INSERT, UPDATE ON public.sessions TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.session_participants TO authenticated;
```

**Step 2: Apply in Supabase Dashboard → SQL Editor**
Run the file. Verify in Table Editor: `sessions`, `session_participants` tables exist, `profiles` has `competency_points` column.

**Step 3: Enable Realtime on both new tables**
In Supabase Dashboard → Database → Replication → enable `sessions` and `session_participants`.

**Step 4: Commit**
```bash
git add supabase/migrations/011_sessions_and_progression.sql
git commit -m "feat: add sessions + competency_points migration (011)"
```

---

## Task 2: Timer Callback Hook

**Files:**
- Modify: `public/js/timer.js`

Timer's `complete()` currently calls rewards inline with no hook. We need to call a registerable callback so Session can show the reflection form after timer ends.

**Step 1: Add `onComplete` hook to Timer IIFE**

In `public/js/timer.js`, add one variable and one setter inside the IIFE:

```js
// After: let remainingSeconds = 0;
let _onCompleteCallback = null;

// New exported function:
function setOnComplete(fn) {
  _onCompleteCallback = typeof fn === 'function' ? fn : null;
}
```

At the END of the existing `complete()` function, before the closing `}`, add:
```js
  if (_onCompleteCallback) _onCompleteCallback();
```

Add `setOnComplete` to the return object:
```js
return { setup, start, stop, setOnComplete };
```

**Step 2: Verify `node --check public/js/timer.js` passes**

**Step 3: Commit**
```bash
git add public/js/timer.js
git commit -m "feat: add Timer.setOnComplete(fn) callback hook"
```

---

## Task 3: Reflection Module

**Files:**
- Create: `public/js/reflection.js`
- Modify: `public/index.html` (add script tag + modal HTML)

The reflection form shows after the timer ends. It generates 5 questions from the current game's RVP data: one question per competency in `game.rvp.kompetence` (up to 3, rated 1–5), plus two open text fields. Answers are submitted to `/api/sessions/:code/reflect`.

**Step 1: Create `public/js/reflection.js`**

```js
/* ═══════════════════════════════════════════════════════════════════
   gIVEMEGAME.IO — Reflection module
   Dependencies: GameUI (toast), window.currentGame (var in script.js)
   Exposes: window.Reflection
   ═══════════════════════════════════════════════════════════════════ */

const Reflection = (() => {
  const MODAL_ID = 'reflection-modal';

  // Build 5 questions from the game's RVP competencies
  function buildQuestions(game) {
    const questions = [];

    // Up to 3 competency self-rating questions (1–5 scale)
    const komps = (game.rvp?.kompetence || []).slice(0, 3);
    komps.forEach(key => {
      questions.push({ id: key, type: 'rating', label: _kompLabel(key) });
    });

    // Always include 2 open text questions
    questions.push({ id: 'darilo', type: 'text', label: 'Čo sa ti darilo?' });
    questions.push({ id: 'zlepsit', type: 'text', label: 'Čo by si zlepšil nabudúce?' });

    return questions;
  }

  // Map competency key → human label (fallback if rvp.json not loaded)
  const KOMP_LABELS = {
    'k-uceni':           'Ako sa ti darilo učiť sa nové veci?',
    'k-reseni-problemu': 'Ako si riešil/a problémy počas hry?',
    'komunikativni':     'Ako sa ti darilo komunikovať so skupinou?',
    'socialni-personalni':'Ako si spolupracoval/a s ostatnými?',
    'obcanske':          'Ako si dodržiaval/a pravidlá a férovosť?',
    'pracovni':          'Ako si pristupoval/a k úlohe a práci?'
  };
  function _kompLabel(key) {
    return KOMP_LABELS[key] || key;
  }

  function open(game, sessionCode, onSubmitted) {
    const modal = document.getElementById(MODAL_ID);
    if (!modal) return;

    const questions = buildQuestions(game);
    const form = modal.querySelector('#reflection-form');
    form.innerHTML = '';

    questions.forEach(q => {
      const div = document.createElement('div');
      div.className = 'reflection-question';
      if (q.type === 'rating') {
        div.innerHTML = `
          <label>${q.label}</label>
          <div class="reflection-rating" data-id="${q.id}">
            ${[1,2,3,4,5].map(n =>
              `<button type="button" class="rating-btn" data-val="${n}">${n}</button>`
            ).join('')}
          </div>`;
        div.querySelectorAll('.rating-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            div.querySelectorAll('.rating-btn').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            btn.closest('.reflection-rating').dataset.value = btn.dataset.val;
          });
        });
      } else {
        div.innerHTML = `
          <label>${q.label}</label>
          <textarea data-id="${q.id}" rows="2" maxlength="300"
            placeholder="Napíš pár viet..."></textarea>`;
      }
      form.appendChild(div);
    });

    // Submit button
    const submitBtn = modal.querySelector('#btn-reflection-submit');
    submitBtn.onclick = () => _submit(questions, form, sessionCode, onSubmitted);

    modal.style.display = 'flex';
  }

  async function _submit(questions, form, sessionCode, onSubmitted) {
    const data = {};
    let valid = true;

    questions.forEach(q => {
      if (q.type === 'rating') {
        const val = form.querySelector(`[data-id="${q.id}"]`)?.dataset.value;
        if (!val) { valid = false; return; }
        data[q.id] = parseInt(val, 10);
      } else {
        const val = form.querySelector(`textarea[data-id="${q.id}"]`)?.value?.trim();
        if (!val) { valid = false; return; }
        data[q.id] = val;
      }
    });

    if (!valid) {
      GameUI.toast('⚠️ Vyplň všetky otázky pred odoslaním');
      return;
    }

    const submitBtn = document.getElementById('btn-reflection-submit');
    if (submitBtn) submitBtn.disabled = true;

    try {
      const { data: { session: authSession } } = await supabaseClient.auth.getSession();
      const token = authSession?.access_token;
      if (!token) throw new Error('NOT_LOGGED_IN');

      if (sessionCode) {
        const res = await fetch(`/api/sessions/${sessionCode}/reflect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ reflection_data: data })
        });
        if (!res.ok) throw new Error((await res.json()).error || 'Chyba pri odosielaní');
      }

      document.getElementById(MODAL_ID).style.display = 'none';
      if (onSubmitted) onSubmitted(data);

    } catch (err) {
      GameUI.toast(`❌ ${err.message}`);
      if (submitBtn) submitBtn.disabled = false;
    }
  }

  function close() {
    const modal = document.getElementById(MODAL_ID);
    if (modal) modal.style.display = 'none';
  }

  return { open, close, buildQuestions };
})();

window.Reflection = Reflection;
```

**Step 2: Add modal HTML to `public/index.html`**

Before the closing `</body>` tag, add:
```html
<!-- ─── Reflection Modal ─── -->
<div id="reflection-modal" class="modal-overlay" style="display:none">
  <div class="modal-box" style="max-width:540px">
    <div class="modal-header">
      <h3>🧠 Reflexia aktivity</h3>
      <button class="modal-close" onclick="Reflection.close()">✕</button>
    </div>
    <p style="opacity:0.7;font-size:13px;margin-bottom:16px">
      Zhodnoť ako prebehla aktivita. Toto je krok pred získaním kompetentnostných bodov.
    </p>
    <form id="reflection-form" onsubmit="return false"></form>
    <button id="btn-reflection-submit" class="btn-primary" style="margin-top:16px;width:100%">
      ✅ Odoslať reflexiu
    </button>
  </div>
</div>
```

**Step 3: Add script tag in `public/index.html`**

In the scripts block, after `game-ui.js` and before `library.js`:
```html
<script src="js/reflection.js?v=1"></script>
```

**Step 4: Verify syntax**
```bash
node --check public/js/reflection.js
```

**Step 5: Commit**
```bash
git add public/js/reflection.js public/index.html
git commit -m "feat: add Reflection module + modal UI"
```

---

## Task 4: Solo Completion API + Competency Award

**Files:**
- Modify: `server.js` (add `/api/profile/complete-solo` endpoint)

This endpoint handles solo play: after reflection, awards competency points to the authenticated user based on a game's `rvp.kompetence`. No session required.

**Step 1: Add endpoint in `server.js`** (after existing `/api/coins/log` route):

```js
// ─── Solo game completion — awards competency points ───
app.post('/api/profile/complete-solo', async (req, res) => {
  if (!coinApiReady()) return respondCoinApiDisabled(res);
  const user = await requireSupabaseUser(req, res);
  if (!user) return;

  const { game_json } = req.body || {};
  if (!game_json?.rvp?.kompetence?.length) {
    return res.status(400).json({ error: 'game_json.rvp.kompetence je povinné', code: 'MISSING_COMPETENCIES' });
  }

  const kompetence = game_json.rvp.kompetence;
  const awarded = {};
  kompetence.forEach(k => { awarded[k] = COMPETENCY_AWARD; });

  // Build postgres jsonb merge expression: coalesce existing + new points
  const updateExpr = kompetence.map((k, i) =>
    `jsonb_set(
      competency_points,
      '{${k}}',
      to_jsonb(COALESCE((competency_points->>'${k}')::int, 0) + $${i + 2})
    )`
  ).reduce((acc, expr) => `jsonb_set(${acc}, '{${kompetence[kompetence.indexOf(expr.match(/'{(\w[^']*)}'/)?.[1])]}}', to_jsonb(COALESCE((${acc}->>'${kompetence[kompetence.indexOf(expr.match(/'{(\w[^']*)}'/)?.[1])]}')::int, 0) + ${COMPETENCY_AWARD}))`);

  // Simpler: use a single raw SQL with dynamic keys
  try {
    let updateSql = 'UPDATE public.profiles SET competency_points = competency_points';
    const params = [user.id];
    kompetence.forEach((k, i) => {
      updateSql += `
        || jsonb_build_object($${i + 2}::text,
            COALESCE((competency_points->>$${i + 2}::text)::int, 0) + $${i + 2 + kompetence.length}::int)`;
      params.push(k);
    });
    kompetence.forEach(() => params.push(COMPETENCY_AWARD));
    updateSql += ' WHERE id = $1 RETURNING competency_points';

    const { rows } = await queryCoinsDb(updateSql, params);

    // Award completion bonus coins
    await queryCoinsDb(
      'INSERT INTO public.coin_transactions (user_id, amount, action, metadata) VALUES ($1, $2, $3, $4)',
      [user.id, COMPLETION_BONUS, 'solo_complete', { kompetence: awarded }]
    );

    res.json({ ok: true, awarded, competency_points: rows[0]?.competency_points });
  } catch (err) {
    console.error('[Completion] solo complete failed:', err.message);
    res.status(500).json({ error: 'Nepodarilo sa udeliť body', code: 'AWARD_ERROR' });
  }
});
```

> **NOTE on the SQL:** The dynamic jsonb merge uses `||` operator (jsonb concatenation with last-value-wins). Each competency key is written as `jsonb_build_object(key, old_value + AWARD)` and merged via `||`. This is cleaner than nested `jsonb_set`. Rewrite the above using this simpler pattern:

```js
app.post('/api/profile/complete-solo', async (req, res) => {
  if (!coinApiReady()) return respondCoinApiDisabled(res);
  const user = await requireSupabaseUser(req, res);
  if (!user) return;

  const { game_json } = req.body || {};
  const kompetence = game_json?.rvp?.kompetence;
  if (!Array.isArray(kompetence) || kompetence.length === 0) {
    return res.status(400).json({ error: 'game_json.rvp.kompetence je povinné', code: 'MISSING_COMPETENCIES' });
  }

  try {
    // Fetch current points
    const { rows: profileRows } = await queryCoinsDb(
      'SELECT competency_points FROM public.profiles WHERE id = $1',
      [user.id]
    );
    const current = profileRows[0]?.competency_points || {};

    // Merge: add COMPETENCY_AWARD to each listed competency
    const updated = { ...current };
    const awarded = {};
    kompetence.forEach(k => {
      updated[k] = (parseInt(updated[k], 10) || 0) + COMPETENCY_AWARD;
      awarded[k] = COMPETENCY_AWARD;
    });

    // Write back
    await queryCoinsDb(
      'UPDATE public.profiles SET competency_points = $1 WHERE id = $2',
      [JSON.stringify(updated), user.id]
    );

    // Bonus coins
    await queryCoinsDb(
      'INSERT INTO public.coin_transactions (user_id, amount, action, metadata) VALUES ($1, $2, $3, $4)',
      [user.id, COMPLETION_BONUS, 'solo_complete', { kompetence: awarded }]
    );

    res.json({ ok: true, awarded, competency_points: updated });
  } catch (err) {
    console.error('[Completion] solo complete failed:', err.message);
    res.status(500).json({ error: 'Nepodarilo sa udeliť body', code: 'AWARD_ERROR' });
  }
});
```

**Step 2: Hook solo completion into Timer + Reflection in `public/script.js`**

In the App IIFE's init section (after `GameData.load()`), register the timer callback:
```js
Timer.setOnComplete(() => {
  if (!window.currentGame) return;
  Reflection.open(window.currentGame, null, async (reflectionData) => {
    // Solo completion — no session code
    try {
      const { data: { session } } = await supabaseClient.auth.getSession();
      const token = session?.access_token;
      if (!token) { GameUI.toast('Prihlás sa pre získanie bodov'); return; }

      const res = await fetch('/api/profile/complete-solo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ game_json: window.currentGame })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      // Show what was awarded
      const keys = Object.keys(data.awarded);
      GameUI.toast(`🧠 +${keys.length * 50} bodov do kompetencií! 🪙 +${100} coinov`);
      // Refresh coin display
      if (window.Coins?.load) window.Coins.load();
    } catch (err) {
      GameUI.toast(`❌ ${err.message}`);
    }
  });
});
```

**Step 3: Test manually**
1. Start dev server: `node server.js`
2. Open app, generate a game, start timer
3. Let timer run to 0 (or lower `totalSeconds` in timer.js to 5 for testing)
4. Reflection modal should appear
5. Fill answers, submit
6. Toast shows competency award
7. Check Supabase: `SELECT competency_points FROM profiles WHERE id = '<your-id>'`

**Step 4: Commit**
```bash
git add server.js public/script.js
git commit -m "feat: solo completion API + timer→reflection→award flow"
```

---

## Task 5: Profile Competency Panel UI

**Files:**
- Modify: `public/index.html` (add competency panel HTML)
- Modify: `public/js/game-ui.js` (add `renderCompetencies()`)
- Modify: `public/script.js` (call render after award + on profile load)

**Step 1: Add panel HTML in `public/index.html`**

In the right panel section (near the stats display), add:
```html
<!-- ─── Competency Stats Panel ─── -->
<div id="competency-panel" class="competency-panel" style="display:none">
  <div class="panel-heading">
    <i class="bi bi-bar-chart-fill"></i>
    <span data-i18n="competency_title">Kompetencie</span>
  </div>
  <div id="competency-bars"></div>
</div>
```

**Step 2: Add `renderCompetencies(points)` to `public/js/game-ui.js`**

Add inside the GameUI IIFE, before the `return` statement:

```js
// ─── Competency bars ───
// points: object { "k-uceni": 120, "komunikativni": 85, ... }
// colors come from public/data/rvp.json — same keys
const COMP_META = {
  'k-uceni':            { label: 'K učení',          color: '#4A90D9', icon: 'bi-book' },
  'k-reseni-problemu':  { label: 'K riešeniu prob.',  color: '#E8A838', icon: 'bi-puzzle' },
  'komunikativni':      { label: 'Komunikatívna',     color: '#50C878', icon: 'bi-chat-dots' },
  'socialni-personalni':{ label: 'Sociálna',          color: '#E84C8B', icon: 'bi-people' },
  'obcanske':           { label: 'Občianska',         color: '#8B5CF6', icon: 'bi-flag' },
  'pracovni':           { label: 'Pracovná',          color: '#F97316', icon: 'bi-tools' }
};

function renderCompetencies(points) {
  const panel = document.getElementById('competency-panel');
  const bars  = document.getElementById('competency-bars');
  if (!bars) return;

  bars.innerHTML = '';
  const allKeys = Object.keys(COMP_META);
  const hasAny = allKeys.some(k => (points[k] || 0) > 0);

  if (!hasAny) { if (panel) panel.style.display = 'none'; return; }
  if (panel) panel.style.display = '';

  const maxVal = Math.max(...allKeys.map(k => points[k] || 0), 1);

  allKeys.forEach(key => {
    const val  = points[key] || 0;
    const meta = COMP_META[key];
    const pct  = Math.round((val / maxVal) * 100);

    const row = document.createElement('div');
    row.className = 'comp-row';
    row.innerHTML = `
      <div class="comp-label">
        <i class="bi ${meta.icon}" style="color:${meta.color}"></i>
        <span>${meta.label}</span>
      </div>
      <div class="comp-bar-wrap">
        <div class="comp-bar" style="width:${pct}%;background:${meta.color}"></div>
      </div>
      <span class="comp-val">${val}</span>`;
    bars.appendChild(row);
  });
}
```

Add `renderCompetencies` to the GameUI return:
```js
return {
  showScreen, renderGame, renderQuickView, addToHistory, clearHistory, loadHistory,
  toggleSection, toggleTheme, openModal, closeModal,
  openHelp, toggleFullscreen, toggleHistory,
  toggleMobileFilters, toggleMobileSmarta, closeMobileOverlays,
  toast, setStatus, updateStats, renderCompetencies   // ← add this
};
```

**Step 3: Load and display competency points on startup**

In `public/script.js` App init, after coins load:
```js
async function loadCompetencies() {
  try {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session?.access_token) return;
    const res = await fetch('/api/profile/competencies', {
      headers: { 'Authorization': `Bearer ${session.access_token}` }
    });
    if (!res.ok) return;
    const { competency_points } = await res.json();
    GameUI.renderCompetencies(competency_points || {});
  } catch (e) { /* silent — not critical */ }
}
```

**Step 4: Add `/api/profile/competencies` GET endpoint in `server.js`**

```js
app.get('/api/profile/competencies', async (req, res) => {
  if (!coinApiReady()) return respondCoinApiDisabled(res);
  const user = await requireSupabaseUser(req, res);
  if (!user) return;
  try {
    const { rows } = await queryCoinsDb(
      'SELECT competency_points FROM public.profiles WHERE id = $1',
      [user.id]
    );
    res.json({ competency_points: rows[0]?.competency_points || {} });
  } catch (err) {
    res.status(500).json({ error: 'Nepodarilo sa načítať kompetencie', code: 'COMP_ERROR' });
  }
});
```

**Step 5: Add minimal CSS to `public/style.css`**

```css
/* ─── Competency Panel ─── */
.competency-panel { padding: 12px 16px; }
.comp-row { display:flex; align-items:center; gap:8px; margin-bottom:8px; }
.comp-label { width:130px; font-size:12px; display:flex; align-items:center; gap:4px; }
.comp-bar-wrap { flex:1; height:8px; background:rgba(255,255,255,0.1); border-radius:4px; overflow:hidden; }
.comp-bar { height:100%; border-radius:4px; transition:width 0.6s ease; }
.comp-val { font-size:11px; width:32px; text-align:right; opacity:0.7; }
```

**Step 6: Commit**
```bash
git add public/index.html public/js/game-ui.js public/script.js server.js public/style.css
git commit -m "feat: competency points display panel"
```

---

## Task 6: Session API (Backend)

**Files:**
- Modify: `server.js` (6 new routes)

Add all session routes after the existing games routes. Use the same `queryCoinsDb` + `requireSupabaseUser` pattern.

**Helper function — add once near other helpers:**
```js
function generateJoinCode() {
  let code = '';
  for (let i = 0; i < JOIN_CODE_LENGTH; i++) {
    code += JOIN_CODE_CHARS[Math.floor(Math.random() * JOIN_CODE_CHARS.length)];
  }
  return code;
}
```

**Route 1 — Create session:**
```js
app.post('/api/sessions', async (req, res) => {
  if (!coinApiReady()) return respondCoinApiDisabled(res);
  const user = await requireSupabaseUser(req, res);
  if (!user) return;
  const { game_json } = req.body || {};
  if (!game_json?.title) return res.status(400).json({ error: 'game_json je povinné', code: 'MISSING_GAME' });

  let join_code, attempts = 0;
  do {
    join_code = generateJoinCode();
    const { rows } = await queryCoinsDb('SELECT id FROM public.sessions WHERE join_code = $1', [join_code]);
    if (rows.length === 0) break;
    attempts++;
  } while (attempts < 10);

  try {
    const { rows } = await queryCoinsDb(
      `INSERT INTO public.sessions (host_id, game_json, join_code)
       VALUES ($1, $2, $3) RETURNING id, join_code, status, created_at`,
      [user.id, JSON.stringify(game_json), join_code]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('[Sessions] create failed:', err.message);
    res.status(500).json({ error: 'Nepodarilo sa vytvoriť session', code: 'CREATE_ERROR' });
  }
});
```

**Route 2 — Get session state:**
```js
app.get('/api/sessions/:code', async (req, res) => {
  if (!coinApiReady()) return respondCoinApiDisabled(res);
  const user = await requireSupabaseUser(req, res);
  if (!user) return;
  const { code } = req.params;
  try {
    const { rows: sRows } = await queryCoinsDb(
      'SELECT id, host_id, game_json, join_code, status, timer_ends_at, created_at FROM public.sessions WHERE join_code = $1',
      [code.toUpperCase()]
    );
    if (!sRows.length) return res.status(404).json({ error: 'Session nenájdená', code: 'NOT_FOUND' });
    const session = sRows[0];

    const { rows: pRows } = await queryCoinsDb(
      `SELECT sp.user_id, sp.coins_paid, sp.reflection_done, sp.joined_at,
              p.display_name
       FROM public.session_participants sp
       JOIN public.profiles p ON p.id = sp.user_id
       WHERE sp.session_id = $1`,
      [session.id]
    );
    res.json({ ...session, participants: pRows });
  } catch (err) {
    res.status(500).json({ error: 'Nepodarilo sa načítať session', code: 'FETCH_ERROR' });
  }
});
```

**Route 3 — Join session:**
```js
app.post('/api/sessions/:code/join', async (req, res) => {
  if (!coinApiReady()) return respondCoinApiDisabled(res);
  const user = await requireSupabaseUser(req, res);
  if (!user) return;
  const { code } = req.params;
  try {
    const { rows } = await queryCoinsDb(
      'SELECT id, status FROM public.sessions WHERE join_code = $1',
      [code.toUpperCase()]
    );
    if (!rows.length) return res.status(404).json({ error: 'Session nenájdená', code: 'NOT_FOUND' });
    const sess = rows[0];
    if (sess.status !== 'waiting') return res.status(409).json({ error: 'Session už beží', code: 'ALREADY_STARTED' });

    // Check coins
    const { rows: pRows } = await queryCoinsDb(
      'SELECT coins FROM public.profiles WHERE id = $1', [user.id]
    );
    const coins = parseInt(pRows[0]?.coins, 10) || 0;
    if (coins < SESSION_JOIN_COST) {
      return res.status(402).json({ error: `Potrebuješ aspoň ${SESSION_JOIN_COST} coinov`, code: 'INSUFFICIENT_COINS' });
    }

    await queryCoinsDb(
      `INSERT INTO public.session_participants (session_id, user_id)
       VALUES ($1, $2) ON CONFLICT (session_id, user_id) DO NOTHING`,
      [sess.id, user.id]
    );
    res.json({ ok: true, session_id: sess.id });
  } catch (err) {
    res.status(500).json({ error: 'Nepodarilo sa pripojiť', code: 'JOIN_ERROR' });
  }
});
```

**Route 4 — Start session (host only):**
```js
app.post('/api/sessions/:code/start', async (req, res) => {
  if (!coinApiReady()) return respondCoinApiDisabled(res);
  const user = await requireSupabaseUser(req, res);
  if (!user) return;
  const { code } = req.params;
  try {
    const { rows } = await queryCoinsDb(
      'SELECT id, host_id, game_json, status FROM public.sessions WHERE join_code = $1',
      [code.toUpperCase()]
    );
    if (!rows.length) return res.status(404).json({ error: 'Session nenájdená', code: 'NOT_FOUND' });
    const sess = rows[0];
    if (sess.host_id !== user.id) return res.status(403).json({ error: 'Len host môže štartovať', code: 'NOT_HOST' });
    if (sess.status !== 'waiting') return res.status(409).json({ error: 'Session už beží', code: 'ALREADY_STARTED' });

    const durationMin = sess.game_json?.duration?.max || 15;
    const timerEndsAt = new Date(Date.now() + durationMin * 60 * 1000).toISOString();

    // Deduct coins from all participants
    const { rows: parts } = await queryCoinsDb(
      'SELECT user_id FROM public.session_participants WHERE session_id = $1',
      [sess.id]
    );

    for (const p of parts) {
      await queryCoinsDb(
        'UPDATE public.profiles SET coins = GREATEST(0, coins - $1) WHERE id = $2',
        [SESSION_JOIN_COST, p.user_id]
      );
      await queryCoinsDb(
        'INSERT INTO public.coin_transactions (user_id, amount, action, metadata) VALUES ($1, $2, $3, $4)',
        [p.user_id, -SESSION_JOIN_COST, 'session_join', { session_code: code }]
      );
      await queryCoinsDb(
        'UPDATE public.session_participants SET coins_paid = $1 WHERE session_id = $2 AND user_id = $3',
        [SESSION_JOIN_COST, sess.id, p.user_id]
      );
    }

    await queryCoinsDb(
      `UPDATE public.sessions SET status = 'active', timer_ends_at = $1 WHERE id = $2`,
      [timerEndsAt, sess.id]
    );

    res.json({ ok: true, timer_ends_at: timerEndsAt });
  } catch (err) {
    console.error('[Sessions] start failed:', err.message);
    res.status(500).json({ error: 'Nepodarilo sa štartovať session', code: 'START_ERROR' });
  }
});
```

**Route 5 — Submit reflection:**
```js
app.post('/api/sessions/:code/reflect', async (req, res) => {
  if (!coinApiReady()) return respondCoinApiDisabled(res);
  const user = await requireSupabaseUser(req, res);
  if (!user) return;
  const { code } = req.params;
  const { reflection_data } = req.body || {};
  if (!reflection_data || typeof reflection_data !== 'object') {
    return res.status(400).json({ error: 'reflection_data je povinné', code: 'MISSING_DATA' });
  }
  try {
    const { rows } = await queryCoinsDb(
      'SELECT id, status FROM public.sessions WHERE join_code = $1',
      [code.toUpperCase()]
    );
    if (!rows.length) return res.status(404).json({ error: 'Session nenájdená', code: 'NOT_FOUND' });
    const sess = rows[0];
    if (!['active', 'reflection'].includes(sess.status)) {
      return res.status(409).json({ error: 'Session nie je v aktívnom stave', code: 'WRONG_STATUS' });
    }
    await queryCoinsDb(
      `UPDATE public.session_participants
       SET reflection_data = $1, reflection_done = true
       WHERE session_id = $2 AND user_id = $3`,
      [JSON.stringify(reflection_data), sess.id, user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Nepodarilo sa uložiť reflexiu', code: 'REFLECT_ERROR' });
  }
});
```

**Route 6 — Complete session (host only):**
```js
app.post('/api/sessions/:code/complete', async (req, res) => {
  if (!coinApiReady()) return respondCoinApiDisabled(res);
  const user = await requireSupabaseUser(req, res);
  if (!user) return;
  const { code } = req.params;
  try {
    const { rows } = await queryCoinsDb(
      'SELECT id, host_id, game_json, status FROM public.sessions WHERE join_code = $1',
      [code.toUpperCase()]
    );
    if (!rows.length) return res.status(404).json({ error: 'Session nenájdená', code: 'NOT_FOUND' });
    const sess = rows[0];
    if (sess.host_id !== user.id) return res.status(403).json({ error: 'Len host môže ukončiť', code: 'NOT_HOST' });

    const kompetence = sess.game_json?.rvp?.kompetence || [];
    const { rows: parts } = await queryCoinsDb(
      'SELECT user_id FROM public.session_participants WHERE session_id = $1 AND reflection_done = true',
      [sess.id]
    );

    const awarded = {};
    kompetence.forEach(k => { awarded[k] = COMPETENCY_AWARD; });

    for (const p of parts) {
      // Fetch + update competency points (same pattern as solo completion)
      const { rows: profRows } = await queryCoinsDb(
        'SELECT competency_points FROM public.profiles WHERE id = $1', [p.user_id]
      );
      const current = profRows[0]?.competency_points || {};
      const updated = { ...current };
      kompetence.forEach(k => {
        updated[k] = (parseInt(updated[k], 10) || 0) + COMPETENCY_AWARD;
      });
      await queryCoinsDb(
        'UPDATE public.profiles SET competency_points = $1 WHERE id = $2',
        [JSON.stringify(updated), p.user_id]
      );
      await queryCoinsDb(
        `UPDATE public.session_participants
         SET awarded_competencies = $1 WHERE session_id = $2 AND user_id = $3`,
        [JSON.stringify(awarded), sess.id, p.user_id]
      );
      // Completion bonus coins
      await queryCoinsDb(
        'UPDATE public.profiles SET coins = coins + $1 WHERE id = $2',
        [COMPLETION_BONUS, p.user_id]
      );
      await queryCoinsDb(
        'INSERT INTO public.coin_transactions (user_id, amount, action, metadata) VALUES ($1, $2, $3, $4)',
        [p.user_id, COMPLETION_BONUS, 'session_complete', { session_code: code, kompetence: awarded }]
      );
    }

    await queryCoinsDb(
      `UPDATE public.sessions SET status = 'completed', completed_at = now() WHERE id = $1`,
      [sess.id]
    );

    res.json({ ok: true, awarded, participants_rewarded: parts.length });
  } catch (err) {
    console.error('[Sessions] complete failed:', err.message);
    res.status(500).json({ error: 'Nepodarilo sa ukončiť session', code: 'COMPLETE_ERROR' });
  }
});
```

**Step 2: Commit**
```bash
git add server.js
git commit -m "feat: session API — create/join/start/reflect/complete routes"
```

---

## Task 7: Session Client Module

**Files:**
- Create: `public/js/session.js`
- Modify: `public/index.html` (add session UI + script tag)

**Step 1: Create `public/js/session.js`**

```js
/* ═══════════════════════════════════════════════════════════════════
   gIVEMEGAME.IO — Session module
   Dependencies: supabaseClient, GameUI, Reflection, window.Coins
   Exposes: window.Session
   ═══════════════════════════════════════════════════════════════════ */

const Session = (() => {
  const SESSION_JOIN_COST = 200;
  let _currentCode = null;
  let _sessionId   = null;
  let _isHost      = false;
  let _channel     = null;

  // ─── Create (host flow) ───
  async function create(gameJson) {
    const token = await _getToken();
    if (!token) { GameUI.toast('Prihlás sa pre vytvorenie session'); return; }

    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ game_json: gameJson })
    });
    const data = await res.json();
    if (!res.ok) { GameUI.toast(`❌ ${data.error}`); return; }

    _currentCode = data.join_code;
    _sessionId   = data.id;
    _isHost      = true;
    _openLobbyModal(data.join_code, true);
    _subscribeRealtime(data.join_code);
    _pollParticipants(data.join_code);
  }

  // ─── Join (player flow) ───
  async function join(code) {
    const token = await _getToken();
    if (!token) { GameUI.toast('Prihlás sa pre pripojenie do session'); return; }

    const upperCode = code.toUpperCase().trim();
    const res = await fetch(`/api/sessions/${upperCode}/join`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    if (!res.ok) { GameUI.toast(`❌ ${data.error}`); return; }

    _currentCode = upperCode;
    _sessionId   = data.session_id;
    _isHost      = false;
    GameUI.toast(`✅ Pripojený! Čakaj na štart hostitela.`);
    _openLobbyModal(upperCode, false);
    _subscribeRealtime(upperCode);
    _pollParticipants(upperCode);
  }

  // ─── Start (host only) ───
  async function start() {
    if (!_isHost || !_currentCode) return;
    const token = await _getToken();
    const res = await fetch(`/api/sessions/${_currentCode}/start`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    if (!res.ok) { GameUI.toast(`❌ ${data.error}`); return; }
    // Realtime will handle status transition
  }

  // ─── Complete (host only) ───
  async function complete() {
    if (!_isHost || !_currentCode) return;
    const token = await _getToken();
    const res = await fetch(`/api/sessions/${_currentCode}/complete`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    if (!res.ok) { GameUI.toast(`❌ ${data.error}`); return; }
    GameUI.toast(`🏆 Session ukončená! ${data.participants_rewarded} hráčov dostalo body.`);
  }

  // ─── Realtime ───
  function _subscribeRealtime(code) {
    if (_channel) _channel.unsubscribe();
    if (!supabaseClient) return;

    _channel = supabaseClient
      .channel(`session:${code}`)
      .on('postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'sessions', filter: `join_code=eq.${code}` },
          payload => _handleSessionChange(payload.new))
      .on('postgres_changes',
          { event: '*', schema: 'public', table: 'session_participants' },
          () => _pollParticipants(code))
      .subscribe();
  }

  function _handleSessionChange(session) {
    _renderLobbyStatus(session.status);
    if (session.status === 'active') _onSessionActive(session);
    if (session.status === 'reflection') _onSessionReflection();
    if (session.status === 'completed') _onSessionCompleted();
  }

  function _onSessionActive(session) {
    document.getElementById('lobby-start-btn')?.remove();
    // Show game card (already rendered in App) + start timer synced to server
    const msLeft = new Date(session.timer_ends_at) - Date.now();
    const secLeft = Math.max(0, Math.round(msLeft / 1000));
    if (window.Timer && secLeft > 0) {
      Timer.setup({ min: 0, max: Math.ceil(secLeft / 60) });
      // Override: jump straight to active with remaining seconds
      Timer._startFromSeconds?.(secLeft); // Optional — Timer can add this
      Timer.setOnComplete(() => {
        _setSessionStatus('reflection');
        Reflection.open(window.currentGame, _currentCode, () => {
          if (_isHost) _showCompleteButton();
        });
      });
    }
  }

  function _onSessionReflection() {
    if (!document.getElementById('reflection-modal')?.style.display !== 'none') {
      Reflection.open(window.currentGame, _currentCode, () => {
        if (_isHost) _showCompleteButton();
      });
    }
  }

  function _onSessionCompleted() {
    GameUI.toast('🏆 Session dokončená! Kompetencie udelené.');
    if (window.Coins?.load) window.Coins.load();
    _loadAndRenderCompetencies();
    document.getElementById('session-lobby-modal')?.remove();
    _channel?.unsubscribe();
  }

  async function _setSessionStatus(status) {
    // Only called client-side for timer-end transition to reflection
    // Real status update is handled by host /complete call
    _renderLobbyStatus(status);
  }

  function _showCompleteButton() {
    const btn = document.getElementById('btn-session-complete');
    if (btn) btn.style.display = '';
  }

  // ─── Poll participants ───
  async function _pollParticipants(code) {
    try {
      const token = await _getToken();
      const res = await fetch(`/api/sessions/${code}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) return;
      const data = await res.json();
      _renderParticipants(data.participants || []);
    } catch (e) { /* silent */ }
  }

  // ─── Lobby Modal ───
  function _openLobbyModal(code, isHost) {
    let modal = document.getElementById('session-lobby-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'session-lobby-modal';
      modal.className = 'modal-overlay';
      modal.innerHTML = `
        <div class="modal-box" style="max-width:480px">
          <div class="modal-header">
            <h3>🎮 Session Lobby</h3>
            <button class="modal-close" onclick="document.getElementById('session-lobby-modal').style.display='none'">✕</button>
          </div>
          <div id="session-code-display" style="text-align:center;font-size:32px;letter-spacing:8px;padding:16px;background:rgba(255,255,255,0.05);border-radius:8px;margin-bottom:16px"></div>
          <p style="text-align:center;opacity:0.6;font-size:13px;margin-bottom:16px">
            Hráči zadajú tento kód pre pripojenie · Vstup stojí ${SESSION_JOIN_COST} 🪙
          </p>
          <div id="session-status-label" style="text-align:center;margin-bottom:12px;opacity:0.8"></div>
          <div id="session-participants-list" style="margin-bottom:16px"></div>
          ${isHost ? `
            <button id="lobby-start-btn" class="btn-primary" onclick="Session.start()" style="width:100%;margin-bottom:8px">
              ▶️ Štart — Odráta ${SESSION_JOIN_COST} coinov
            </button>
            <button id="btn-session-complete" class="btn-primary" onclick="Session.complete()" style="width:100%;display:none">
              ✅ Potvrdiť dokončenie & udeliť body
            </button>
          ` : `
            <p style="text-align:center;opacity:0.6;font-size:13px">Čakaj na štart hostitela...</p>
          `}
        </div>`;
      document.body.appendChild(modal);
    }
    document.getElementById('session-code-display').textContent = code;
    modal.style.display = 'flex';
  }

  function _renderParticipants(participants) {
    const list = document.getElementById('session-participants-list');
    if (!list) return;
    if (!participants.length) {
      list.innerHTML = '<p style="opacity:0.5;text-align:center;font-size:13px">Zatiaľ žiadni hráči...</p>';
      return;
    }
    list.innerHTML = participants.map(p =>
      `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.05)">
        <span>${p.display_name || 'Hráč'}</span>
        <span>${p.reflection_done ? '✅' : '⏳'}</span>
      </div>`
    ).join('');
  }

  function _renderLobbyStatus(status) {
    const el = document.getElementById('session-status-label');
    if (!el) return;
    const labels = {
      waiting: '⏳ Čakám na hráčov',
      active: '🔥 Hra prebieha',
      reflection: '🧠 Reflexia',
      completed: '🏆 Dokončené'
    };
    el.textContent = labels[status] || status;
  }

  async function _loadAndRenderCompetencies() {
    try {
      const token = await _getToken();
      if (!token) return;
      const res = await fetch('/api/profile/competencies', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) return;
      const { competency_points } = await res.json();
      GameUI.renderCompetencies(competency_points || {});
    } catch (e) { /* silent */ }
  }

  async function _getToken() {
    try {
      const { data: { session } } = await supabaseClient.auth.getSession();
      return session?.access_token || null;
    } catch { return null; }
  }

  function openJoinDialog() {
    const code = prompt('Zadaj kód session (6 znakov):');
    if (code?.trim()) join(code.trim());
  }

  return { create, join, start, complete, openJoinDialog };
})();

window.Session = Session;
```

**Step 2: Add script tag and Create/Join buttons to `public/index.html`**

In the scripts block, after `reflection.js`:
```html
<script src="js/session.js?v=1"></script>
```

Add buttons near the Generate button (exact location depends on current HTML structure — find `btn-generate` and add siblings):
```html
<button id="btn-create-session" class="btn-secondary" onclick="Session.create(window.currentGame)"
  title="Vytvor hernú session pre skupinu" style="display:none">
  🎮 Session
</button>
<button id="btn-join-session" class="btn-secondary" onclick="Session.openJoinDialog()">
  🔑 Pripojiť sa
</button>
```

Show the `btn-create-session` button in `public/script.js` after a game is generated (in the `generate()` function, after `currentGame = game`):
```js
const sessionBtn = document.getElementById('btn-create-session');
if (sessionBtn) sessionBtn.style.display = '';
```

**Step 3: Verify syntax**
```bash
node --check public/js/session.js
node --check public/js/reflection.js
```

**Step 4: Manual integration test**
1. Open app in two browser windows (two different accounts)
2. Window A: Generate game → click Session → note the code
3. Window B: Click Pripojiť sa → enter code
4. Window A: Check participant appears in lobby → click Štart
5. Both windows: Timer should start
6. Timer ends → Reflection form appears
7. Fill reflection in both windows
8. Window A (host): Click "Potvrdiť dokončenie"
9. Check `profiles.competency_points` updated in Supabase

**Step 5: Commit**
```bash
git add public/js/session.js public/index.html public/script.js
git commit -m "feat: Session module — lobby UI, join flow, realtime, completion"
```

---

## Task 8: Notes / Share During Active Phase

**Files:**
- Modify: `public/js/session.js` (add notes textarea to active lobby view)
- Modify: `server.js` (add PATCH for participant notes — optional, can be localStorage only for v1)

This is the lowest-priority feature. For v1, notes are **localStorage only** — no server sync needed. Add a collapsible textarea to the game card that saves locally.

**Step 1: Add note field to game card in `public/index.html`**

After the game instructions section, add:
```html
<div id="session-notes-block" style="display:none">
  <div class="section-title">📝 Moje poznámky</div>
  <textarea id="session-notes-input" rows="3" maxlength="500"
    placeholder="Napíš si poznámky počas aktivity..."
    oninput="localStorage.setItem('session_notes', this.value)"></textarea>
</div>
```

**Step 2: Show notes block when session is active**

In `session.js`, in `_onSessionActive()`, add:
```js
const notesBlock = document.getElementById('session-notes-block');
if (notesBlock) {
  notesBlock.style.display = '';
  const saved = localStorage.getItem('session_notes') || '';
  const ta = document.getElementById('session-notes-input');
  if (ta) ta.value = saved;
}
```

**Step 3: Pre-fill reflection text with notes (good UX touch)**

In `reflection.js`, in `open()`, after `form.innerHTML = ''`:
```js
// Pre-fill open text fields from session notes
const savedNotes = localStorage.getItem('session_notes') || '';
```

Pass `savedNotes` as default value to the `darilo` textarea:
```js
// In the text question render:
<textarea ... >${q.id === 'darilo' ? savedNotes : ''}</textarea>
```

**Step 4: Commit**
```bash
git add public/js/session.js public/index.html
git commit -m "feat: session notes — localStorage textarea during active phase"
```

---

## Summary: Execution Order

| # | Task | Blocker for |
|---|------|------------|
| 1 | DB migration 011 | Everything |
| 2 | Timer.setOnComplete | Tasks 3, 4, 7 |
| 3 | Reflection module | Tasks 4, 7 |
| 4 | Solo completion API + award | Task 5 |
| 5 | Competency panel UI | — |
| 6 | Session API routes | Task 7 |
| 7 | Session client module | Task 8 |
| 8 | Notes feature | — |

Tasks 1–2 must be done in order. Tasks 3–5 can be done in order after Task 2. Tasks 6–7 can start after Task 3. Task 8 is always last.
