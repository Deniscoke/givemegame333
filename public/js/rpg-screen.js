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

  const THEME_KEYS = ['scholar', 'builder', 'healer', 'shadow', 'alchemist', 'sage', 'knight', 'neutral'];
  const LOGO_BY_THEME = {
    scholar: '📚 RPG PROFIL',
    builder: '🔧 RPG PROFIL',
    healer: '💚 RPG PROFIL',
    shadow: '🌑 RPG PROFIL',
    alchemist: '⚗️ RPG PROFIL',
    sage: '✨ RPG PROFIL',
    knight: '⚔️ RPG PROFIL',
    neutral: '⚔️ RPG PROFIL',
  };

  // Panel registry — add ready:true as panels are built
  const PANELS = [
    { id: 'talents',      label: '⚔️  Talenты',    ready: true  },
    { id: 'stats',        label: '📊 Štatistiky',  ready: true  },
    { id: 'perks',        label: '🎁 Odmeny',       ready: true  },
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
    if (screen) {
      screen.style.display = 'none';
      THEME_KEYS.forEach(t => screen.classList.remove(`rpg-theme--${t}`));
      screen.classList.add('rpg-theme--neutral');
      const flavorEl = document.getElementById('rpg-screen-flavor');
      if (flavorEl) {
        flavorEl.textContent = '';
        flavorEl.hidden = true;
      }
      const sideFlavor = document.getElementById('rpg-sidebar-flavor');
      if (sideFlavor) {
        sideFlavor.textContent = '';
        sideFlavor.hidden = true;
      }
      const logoEl = document.getElementById('rpg-screen-logo');
      if (logoEl) logoEl.textContent = LOGO_BY_THEME.neutral;
    }
    document.body.style.overflow = '';
  }

  // ─── Load & Render ───────────────────────────────────────────────
  async function _loadAndRender() {
    if (!window.RpgTalents) return;
    const data = await RpgTalents.load();
    _lastData = data;
    _updateSidebar(data);
    _applyAvatarTheme(data);
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

    // Class name (prefer server avatar_meta.label when present)
    const classEl = document.getElementById('rpg-sidebar-class');
    if (classEl) {
      const fromMeta = data?.avatar_meta?.label;
      classEl.textContent = fromMeta
        || (data?.class_id ? (CLASS_LABELS[data.class_id] || `Trieda ${data.class_id}`) : null)
        || '— Bez triedy —';
    }

    const sideFlavor = document.getElementById('rpg-sidebar-flavor');
    if (sideFlavor) {
      const f = data?.avatar_meta?.flavor;
      if (f) {
        sideFlavor.textContent = f;
        sideFlavor.hidden = false;
      } else {
        sideFlavor.textContent = '';
        sideFlavor.hidden = true;
      }
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

  /** Per-avatar visual theme on #rpg-screen (colors + header copy). */
  function _applyAvatarTheme(data) {
    const screen = document.getElementById('rpg-screen');
    if (!screen) return;
    THEME_KEYS.forEach(t => screen.classList.remove(`rpg-theme--${t}`));
    const meta = data?.avatar_meta;
    const raw = meta?.theme;
    const theme = raw && THEME_KEYS.includes(raw) && raw !== 'neutral' ? raw : 'neutral';
    screen.classList.add(`rpg-theme--${theme}`);

    const logoEl = document.getElementById('rpg-screen-logo');
    if (logoEl) logoEl.textContent = LOGO_BY_THEME[theme] || LOGO_BY_THEME.neutral;

    const flavorEl = document.getElementById('rpg-screen-flavor');
    if (flavorEl) {
      if (meta?.flavor) {
        flavorEl.textContent = meta.flavor;
        flavorEl.hidden = false;
      } else {
        flavorEl.textContent = '';
        flavorEl.hidden = true;
      }
    }
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
    if (panelId === 'perks') {
      _renderPerksPanel();
    }
  }

  // ─── Perks Panel (IRL rewards unlocked by level) ─────────────────
  async function _renderPerksPanel() {
    const el = document.getElementById('rpg-panel-perks');
    if (!el) return;
    el.innerHTML = '<div class="rpg-coming-soon">🎁<br>Načítavam odmeny…</div>';

    try {
      const token = await _token();
      if (!token) {
        el.innerHTML = '<div class="rpg-coming-soon">🔒<br>Prihlás sa pre zobrazenie odmien.</div>';
        return;
      }
      const res = await fetch('/api/rpg/perks', { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) { el.innerHTML = '<div class="rpg-coming-soon">⚠️<br>Odmeny sa nepodarilo načítať.</div>'; return; }
      const data = await res.json();

      const userLevel = data.user_level || 1;
      const rows = (data.perks || []).map(p => {
        const cooldownLeftH = Math.ceil(p.cooldown_left_ms / 3600000);
        let statusBadge = '';
        let actionBtn = '';
        if (!p.unlocked) {
          statusBadge = `<span class="rpg-perk-badge rpg-perk-locked">🔒 Level ${p.level}</span>`;
          actionBtn = `<button class="btn btn-retro rpg-perk-btn" disabled>Zamknuté</button>`;
        } else if (p.pending) {
          statusBadge = `<span class="rpg-perk-badge rpg-perk-pending">⏳ Čaká na učiteľa</span>`;
          actionBtn = `<button class="btn btn-retro rpg-perk-btn" disabled>Rozhoduje sa</button>`;
        } else if (p.cooldown_left_ms > 0) {
          statusBadge = `<span class="rpg-perk-badge rpg-perk-cooldown">⏱ ${cooldownLeftH} h</span>`;
          actionBtn = `<button class="btn btn-retro rpg-perk-btn" disabled>Cooldown</button>`;
        } else {
          actionBtn = `<button class="btn btn-retro rpg-perk-btn rpg-perk-btn--go" data-perk="${p.perk_key}">Použiť</button>`;
        }
        const durLabel = p.duration_minutes ? ` · ${p.duration_minutes} min` : '';
        const noteLine = p.teacher_note ? `<p class="rpg-perk-note">📝 ${_esc(p.teacher_note)}</p>` : '';
        return `
          <div class="rpg-perk-card ${p.unlocked ? '' : 'rpg-perk-card--locked'}">
            <div class="rpg-perk-icon">${p.icon}</div>
            <div class="rpg-perk-body">
              <div class="rpg-perk-header">
                <h4 class="rpg-perk-title">${_esc(p.title)}</h4>
                <span class="rpg-perk-level">Lv ${p.level}${durLabel}</span>
              </div>
              <p class="rpg-perk-desc">${_esc(p.description)}</p>
              ${noteLine}
              <div class="rpg-perk-footer">
                ${statusBadge}
                ${actionBtn}
              </div>
            </div>
          </div>`;
      }).join('');

      el.innerHTML = `
        <div class="rpg-perks-panel">
          <section class="rpg-stats-section">
            <h3 class="rpg-stats-heading">🎁 Odmeny zo života</h3>
            <p class="rpg-perks-intro">
              Každý level ti odomkne jeden reálny benefit v škole. Klikni <b>Použiť</b> — ak si v škole
              registrovaný v gIVEMEGAMEEDU, žiadosť pôjde učiteľovi na schválenie. Mimo EDU sa uplatní hneď.
              <br><span style="opacity:.7">Tvoj level: <b>Lv ${userLevel}</b></span>
            </p>
            <div class="rpg-perks-grid">${rows}</div>
          </section>
        </div>`;

      el.querySelectorAll('.rpg-perk-btn--go').forEach(btn => {
        btn.addEventListener('click', () => _claimPerk(btn.dataset.perk, btn));
      });
    } catch (e) {
      el.innerHTML = '<div class="rpg-coming-soon">⚠️<br>Chyba pri načítaní odmien.</div>';
    }
  }

  async function _claimPerk(perkKey, btn) {
    if (!perkKey) return;
    btn.disabled = true;
    btn.textContent = '⏳';
    try {
      const token = await _token();
      if (!token) { btn.disabled = false; btn.textContent = 'Použiť'; return; }
      const res = await fetch(`/api/rpg/perks/${encodeURIComponent(perkKey)}/use`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (!res.ok) {
        (window.GameUI?.toast || alert)(`❌ ${data.error || 'Nepodarilo sa použiť perk'}`);
      } else if (data.needs_approval) {
        (window.GameUI?.toast || alert)(`⏳ Žiadosť odoslaná učiteľovi: ${data.perk_title}`);
      } else {
        (window.GameUI?.toast || alert)(`✅ Uplatnené: ${data.perk_title}`);
      }
    } catch (e) {
      (window.GameUI?.toast || alert)(`❌ ${e.message}`);
    } finally {
      _renderPerksPanel();
    }
  }

  async function _token() {
    try {
      const { data: { session } } = await window.supabaseClient.auth.getSession();
      return session?.access_token || null;
    } catch { return null; }
  }

  function _esc(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // ─── Stats Panel ────────────────────────────────────────────────
  const STAT_SOURCES = {
    insight:       'Digitálna gramotnosť, Riešenie problémov',
    focus:         'Kompetencia k učeniu, Koncentrácia',
    creativity:    'Kultúrna kompetencia, Umenie',
    resilience:    'Občianska kompetencia, Vytrvalosť',
    communication: 'Komunikácia, Sociálna kompetencia',
    strategy:      'Matematika, Pracovná kompetencia',
  };
  function _getStatSources(statKey) {
    return STAT_SOURCES[statKey] || '';
  }

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

    const attrMapRows = hasClass ? Object.entries(STAT_META).map(([key, meta]) => {
      const src = _getStatSources(key);
      return `<div class="rpg-attr-map-row">
        <span class="rpg-attr-map-icon">${meta.icon}</span>
        <span class="rpg-attr-map-label">${meta.label}</span>
        <span class="rpg-attr-map-src">${src}</span>
      </div>`;
    }).join('') : '';

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
          <h3 class="rpg-stats-heading">📊 Atribúty postavy</h3>
          ${noClassNote}
          <div class="rpg-stat-list">
            ${statRows}
          </div>
          ${hasClass && Object.values(bonuses).some(v => v > 0)
            ? '<p class="rpg-stats-bonus-note">Hodnoty <span class="rpg-stat-bonus">+zelené</span> sú bonusy z talent tree.</p>'
            : ''}
        </section>

        ${hasClass ? `<section class="rpg-stats-section">
          <h3 class="rpg-stats-heading">🎯 Čo trénuje aký atribút</h3>
          <div class="rpg-attr-map">${attrMapRows}</div>
        </section>` : ''}
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

  /** Reload talents/progression from API when RPG screen is open (e.g. after solo XP award). */
  async function refresh() {
    const screen = document.getElementById('rpg-screen');
    if (!screen || screen.style.display === 'none') return;
    await _loadAndRender();
  }

  document.addEventListener('DOMContentLoaded', _init);

  return { open, close, updateCoinsDisplay, refresh };
})();

window.RpgScreen = RpgScreen;
