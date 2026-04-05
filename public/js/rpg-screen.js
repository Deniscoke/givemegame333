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

  // Future panel registry — add here as panels are built
  const PANELS = [
    { id: 'talents',      label: '⚔️  Talenты',    ready: true  },
    { id: 'stats',        label: '📊 Štatistiky',  ready: false },
    { id: 'attributes',   label: '✨ Atribúty',    ready: false },
    { id: 'quests',       label: '📜 Úlohy',       ready: false },
    { id: 'achievements', label: '🏆 Úspechy',     ready: false },
  ];

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
