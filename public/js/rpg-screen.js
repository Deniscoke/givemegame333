/* ═══════════════════════════════════════════════════════════════════
   gIVEMEGAME.IO — RPG Screen (full-screen RPG profile layer)

   Replaces the widened-modal approach with a true full-viewport
   RPG interface. Layout: fixed sidebar + scrollable main panel.

   Sections (nav):
     • Talenты   — talent tree (implemented)
     • Štatistiky — coming soon
     • Atribúty   — coming soon
     • Úlohy      — coming soon
     • Úspechy    — coming soon

   Entry: RpgScreen.open()
   Close: RpgScreen.close() or ESC key

   Security: same gating as talent/avatar — school member + role check
   is enforced server-side. Client shows CTA if not eligible.

   Depends on: RpgTalents (rpg-talents.js), RpgAvatar (rpg-avatar.js)
   Exposes: window.RpgScreen
   ═══════════════════════════════════════════════════════════════════ */

const RpgScreen = (() => {
  'use strict';

  // ─── Constants ──────────────────────────────────────────────────
  const CLASS_LABELS = {
    2: 'Scholar', 3: 'Builder', 4: 'Healer', 5: 'Shadow',
    6: 'Alchemist', 7: 'Sage', 8: 'Knight',
  };
  const ROLE_LABELS  = { admin: 'Admin', teacher: 'Učiteľ', student: 'Žiak' };
  const ROLE_CLASSES = { admin: 'rpg-role-admin', teacher: 'rpg-role-teacher', student: 'rpg-role-student' };

  // Panel registry — add ready:true as panels are built
  const PANELS = [
    { id: 'talents',      label: '⚔️  Talenты',    ready: true  },
    { id: 'stats',        label: '📊 Štatistiky',  ready: true  },
    { id: 'attributes',   label: '✨ Atribúty',    ready: false },
    { id: 'quests',       label: '📜 Úlohy',       ready: false },
    { id: 'achievements', label: '🏆 Úspechy',     ready: false },
  ];

  // Stat display config: key → { label, icon, color }
  const STAT_META = {
    insight:       { label: 'Insight',       icon: '🔍', color: '#7dd3fc' },
    focus:         { label: 'Focus',         icon: '🎯', color: '#a5f3fc' },
    creativity:    { label: 'Creativity',    icon: '🎨', color: '#f9a8d4' },
    resilience:    { label: 'Resilience',    icon: '🛡️', color: '#86efac' },
    communication: { label: 'Communication', icon: '💬', color: '#fde68a' },
    strategy:      { label: 'Strategy',      icon: '♟️', color: '#c4b5fd' },
  };

  let _initialized = false;
  let _currentPanel = 'talents';

  // ─── Open / Close ────────────────────────────────────────────────
  function open() {
    const screen = document.getElementById('rpg-screen');
    if (!screen) return;
    screen.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    screen.focus();
    _loadAndRender();
  }

  function close() {
    const screen = document.getElementById('rpg-screen');
    if (screen) screen.style.display = 'none';
    document.body.style.overflow = '';
  }

  // ─── Load & Render ───────────────────────────────────────────────
  async function _loadAndRender() {
    if (!window.RpgTalents) return;
    const data = await RpgTalents.load();
    _lastData = data;
    _updateSidebar(data);
    _switchPanel(_currentPanel);
  }

  // ─── Sidebar population ─────────────────────────────────────────
  function _updateSidebar(data) {
    // Avatar image
    const avatarWrap = document.getElementById('rpg-sidebar-avatar');
    if (avatarWrap) {
      if (data?.class_id) {
        avatarWrap.innerHTML = `
          <img src="/avatars/${data.class_id}.png"
               alt="${_esc(CLASS_LABELS[data.class_id] || 'Avatar')}"
               class="rpg-sidebar-avatar-img rpg-avatar-idle">`;
      } else {
        avatarWrap.innerHTML = `<span class="rpg-sidebar-avatar-placeholder">⚔️</span>`;
      }
    }

    // Class name
    const classEl = document.getElementById('rpg-sidebar-class');
    if (classEl) {
      classEl.textContent = data?.class_id
        ? (CLASS_LABELS[data.class_id] || `Trieda ${data.class_id}`)
        : '— Bez triedy —';
    }

    // Role badge + school name
    const metaEl = document.getElementById('rpg-sidebar-meta');
    if (metaEl) {
      if (data?.eligible && data.role) {
        const roleLabel = ROLE_LABELS[data.role] || data.role;
        const roleClass = ROLE_CLASSES[data.role] || '';
        metaEl.innerHTML = `
          <span class="rpg-avatar-role-badge ${roleClass}">${_esc(roleLabel)}</span>
          <span class="rpg-sidebar-school">${_esc(data.school_name || '')}</span>`;
      } else {
        metaEl.innerHTML = `<span class="rpg-sidebar-no-school">Nie si členom školy</span>`;
      }
    }

    // Coin balance
    _refreshCoins(data?.coins ?? 0);

    // Level badge in sidebar
    const levelEl = document.getElementById('rpg-sidebar-level');
    if (levelEl && data?.progression) {
      levelEl.textContent = `Lv. ${data.progression.level}`;
      levelEl.style.display = 'block';
    } else if (levelEl) {
      levelEl.style.display = 'none';
    }

    // Change-avatar button — only for eligible users
    const pickerBtn = document.getElementById('rpg-sidebar-picker-btn');
    if (pickerBtn) pickerBtn.style.display = data?.eligible ? 'block' : 'none';
  }

  function _refreshCoins(amount) {
    const el = document.getElementById('rpg-sidebar-coins');
    if (el) el.textContent = `🪙 ${Number(amount).toLocaleString()}`;
  }

  // ─── Panel switching ─────────────────────────────────────────────
  function _switchPanel(panelId) {
    _currentPanel = panelId;

    // Hide all panels
    document.querySelectorAll('.rpg-panel').forEach(p => {
      p.style.display = 'none';
    });

    // Show target panel
    const target = document.getElementById(`rpg-panel-${panelId}`);
    if (target) target.style.display = 'block';

    // Update nav active state
    document.querySelectorAll('.rpg-nav-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.panel === panelId);
    });

    // Load panel content
    if (panelId === 'talents' && window.RpgTalents) {
      RpgTalents.render('rpg-panel-talents');
    }
    if (panelId === 'stats') {
      _renderStatsPanel();
    }
  }

  // ─── Stats Panel ────────────────────────────────────────────────
  let _lastData = null; // cached from last _loadAndRender call

  function _renderStatsPanel() {
    const el = document.getElementById('rpg-panel-stats');
    if (!el) return;
    if (!_lastData) {
      el.innerHTML = '<div class="rpg-coming-soon">📊<br>Načítavam…</div>';
      return;
    }

    const data = _lastData;
    const prog = data.progression || { level: 1, xp: 0, xpToNext: 500, progressPct: 0 };
    const stats = data.stats || {};
    const base      = stats.base      || {};
    const bonuses   = stats.bonuses   || {};
    const effective = stats.effective || {};

    const hasClass = Boolean(data.class_id);
    const levelLabel = `Level ${prog.level}`;
    const xpLabel = prog.xpToNext
      ? `${prog.xp.toLocaleString()} / ${prog.xpToNext.toLocaleString()} XP`
      : `${prog.xp.toLocaleString()} XP — MAX LEVEL`;

    // Build stat rows
    const statRows = Object.entries(STAT_META).map(([key, meta]) => {
      const eff  = effective[key] || 0;
      const bon  = bonuses[key]   || 0;
      const barW = hasClass ? Math.min(100, Math.round(eff / 20 * 100)) : 0;
      const bonHtml = bon > 0
        ? `<span class="rpg-stat-bonus">+${bon}</span>`
        : '';
      return `
        <div class="rpg-stat-row">
          <span class="rpg-stat-icon">${meta.icon}</span>
          <span class="rpg-stat-label">${meta.label}</span>
          <div class="rpg-stat-bar-wrap">
            <div class="rpg-stat-bar" style="width:${barW}%;background:${meta.color}"></div>
          </div>
          <span class="rpg-stat-value">${eff}${bonHtml}</span>
        </div>`;
    }).join('');

    const noClassNote = !hasClass
      ? '<p class="rpg-stats-no-class">Vyber si avatara pre zobrazenie štatistík tvojej triedy.</p>'
      : '';

    el.innerHTML = `
      <div class="rpg-stats-panel">
        <section class="rpg-stats-section">
          <h3 class="rpg-stats-heading">⚡ Postup</h3>
          <div class="rpg-level-display">
            <span class="rpg-level-badge">${levelLabel}</span>
            <span class="rpg-level-xp">${xpLabel}</span>
          </div>
          <div class="rpg-xp-bar-wrap" title="${prog.progressPct}%">
            <div class="rpg-xp-bar" style="width:${prog.progressPct}%"></div>
          </div>
          ${prog.xpToNext ? `<p class="rpg-xp-hint">Chýba ti ${(prog.xpToNext - prog.xp).toLocaleString()} XP do ďalšieho levelu</p>` : '<p class="rpg-xp-hint">Dosiahol si maximálny level! 🏆</p>'}
        </section>

        <section class="rpg-stats-section">
          <h3 class="rpg-stats-heading">📊 Štatistiky postavy</h3>
          ${noClassNote}
          <div class="rpg-stat-list">
            ${statRows}
          </div>
          ${hasClass && Object.values(bonuses).some(v => v > 0)
            ? '<p class="rpg-stats-bonus-note">Hodnoty <span class="rpg-stat-bonus">+zelené</span> sú bonusy z talent tree.</p>'
            : ''}
        </section>
      </div>`;
  }

  // ─── DOM wiring (runs once) ──────────────────────────────────────
  function _init() {
    if (_initialized) return;
    _initialized = true;

    const screen = document.getElementById('rpg-screen');
    if (!screen) return;

    // ESC key + keyboard trap
    screen.addEventListener('keydown', e => {
      if (e.key === 'Escape') close();
    });

    // Close button
    document.getElementById('rpg-screen-close')
      ?.addEventListener('click', close);

    // Nav buttons
    document.querySelectorAll('.rpg-nav-btn:not([disabled])').forEach(btn => {
      btn.addEventListener('click', () => _switchPanel(btn.dataset.panel));
    });

    // Avatar picker button in sidebar
    document.getElementById('rpg-sidebar-picker-btn')
      ?.addEventListener('click', () => {
        if (window.RpgAvatar) RpgAvatar.openPicker();
      });
  }

  // ─── Helpers ────────────────────────────────────────────────────
  function _esc(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  // Exposed for rpg-talents.js to refresh coins display after unlock
  function updateCoinsDisplay(amount) { _refreshCoins(amount); }

  document.addEventListener('DOMContentLoaded', _init);

  return { open, close, updateCoinsDisplay };
})();

window.RpgScreen = RpgScreen;
