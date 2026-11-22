/* ═══════════════════════════════════════════════════════════════════
   gIVEMEGAME.IO — RPG Screen (full-screen RPG profile layer)

   Replaces the widened-modal approach with a true full-viewport
   RPG interface. Layout: fixed sidebar + scrollable main panel.

   Sections (nav):
     • Talenty    — talent tree (implemented)
     • Štatistiky — coming soon
     • Atribúty   — coming soon
     • Úlohy      — coming soon
     • Úspechy    — coming soon

   Entry: RpgScreen.open()
   Close: RpgScreen.close() or ESC key

   Security: same gating as talent/avatar — school member + role check
   is enforced server-side. The client only shows "Nie si členom školy"
   when the server sends is_school_member: false.

   States (via RpgNet): loading → data | offline (retry) | login (401 only).

   Depends on: RpgNet (rpg-net.js), RpgTalents (rpg-talents.js),
               RpgAvatar (rpg-avatar.js), PxModal (px-modal.js, focus trap)
   Exposes: window.RpgScreen
   ═══════════════════════════════════════════════════════════════════ */

const RpgScreen = (() => {
  'use strict';

  // ─── Constants ──────────────────────────────────────────────────
  const CLASS_LABELS = {
    2: 'Scholar', 3: 'Builder', 4: 'Healer', 5: 'Shadow',
    6: 'Alchemist', 7: 'Sage', 8: 'Knight',
  };
  const ROLE_LABELS  = { admin: 'Admin', teacher: 'Učiteľ', student: 'Žiak', player: 'Hráč' };
  const ROLE_CLASSES = { admin: 'rpg-role-admin', teacher: 'rpg-role-teacher', student: 'rpg-role-student', player: 'rpg-role-player' };
  const _t = (key, fallback) => (window.RpgNet ? RpgNet.t(key, fallback) : fallback);
  const _roleLabel = (role) => (window.RpgNet ? RpgNet.roleLabel(role) : (ROLE_LABELS[role] || ROLE_LABELS.player));

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
    { id: 'talents',      label: '⚔️  Talenty',    ready: true  },
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
  let _lastKind = 'loading'; // outcome of the last talents load: loading|ok|offline|login|error
  let _perksCtrl = null;     // AbortController of the running perks request

  // ─── Open / Close ────────────────────────────────────────────────
  function open() {
    const screen = document.getElementById('rpg-screen');
    if (!screen) return;
    document.body.style.overflow = 'hidden';
    if (window.PxModal) {
      // Focus trap + Escape + focus restore (M19); the overlay is full-screen, no backdrop click.
      PxModal.open(screen, { display: 'flex', closeOnBackdrop: false, onClose: _cleanup });
    } else {
      screen.style.display = 'flex';
      screen.focus();
    }
    _loadAndRender();
  }

  function close() {
    const screen = document.getElementById('rpg-screen');
    if (screen && window.PxModal?.isOpen(screen)) {
      PxModal.close(screen); // calls _cleanup via onClose
      return;
    }
    if (screen) screen.style.display = 'none';
    _cleanup();
  }

  function _cleanup() {
    if (_perksCtrl) { _perksCtrl.abort(); _perksCtrl = null; }
    const screen = document.getElementById('rpg-screen');
    if (screen) {
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
    _lastKind = 'loading';
    if (!_lastData) _switchPanel(_currentPanel); // show "loading" instead of stale or empty panels
    const result = RpgTalents.loadResult ? await RpgTalents.loadResult() : { kind: 'ok', data: await RpgTalents.load() };
    const data = result.kind === 'ok' ? result.data : null;
    _lastKind = result.kind;
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
      classEl.textContent = !data ? ''
        : fromMeta
          || (data.class_id ? (CLASS_LABELS[data.class_id] || `Trieda ${data.class_id}`) : null)
          || _t('rpg_no_class', 'Bez avatara');
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
      if (!data) {
        metaEl.innerHTML = '';
      } else if (data.is_school_member === true) {
        const role = data.membership?.role || data.role;
        metaEl.innerHTML = `
          <span class="rpg-avatar-role-badge ${ROLE_CLASSES[role] || ''}">${_esc(_roleLabel(role))}</span>
          <span class="rpg-sidebar-school">${_esc(data.membership?.school_name || data.school_name || '')}</span>`;
      } else if (data.is_school_member === false) {
        // Only from the server flag, never guessed from missing fields.
        metaEl.innerHTML = `
          <span class="rpg-avatar-role-badge rpg-role-player">${_esc(_roleLabel('player'))}</span>
          <span class="rpg-sidebar-no-school">${_esc(_t('rpg_not_member', 'Nie si členom školy'))}</span>`;
      } else {
        metaEl.innerHTML = `<span class="rpg-avatar-role-badge rpg-role-player">${_esc(_roleLabel(data.role))}</span>`;
      }
    }

    // Coin balance (unknown while offline: show nothing rather than a fake 0)
    if (data) _refreshCoins(data.coins ?? 0);
    else { const c = document.getElementById('rpg-sidebar-coins'); if (c) c.textContent = ''; }

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
    if (el) el.textContent = `${Number(amount).toLocaleString()} 🪙`;
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
    if (!window.RpgNet) return;
    RpgNet.renderState(el, 'loading', { text: _t('rpg_perks_loading', 'Načítavam odmeny…') });

    if (_perksCtrl) _perksCtrl.abort();
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    _perksCtrl = ctrl;
    try {
      const result = await RpgNet.request('/api/rpg/perks', ctrl ? { signal: ctrl.signal } : {});
      if (ctrl && ctrl.signal.aborted) return; // screen closed or panel re-opened
      if (result.kind !== 'ok') {
        RpgNet.renderState(el, result.kind, {
          onRetry: _renderPerksPanel,
          onLogin: () => { close(); window.App?.Profile?.open?.(); },
        });
        return;
      }
      const data = result.data;

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
              <span class="rpg-perks-deal">🤝 Odmeny platia, len ak s nimi súhlasí tvoj učiteľ. Dohodni sa s ním vopred, ktoré odmeny u vás platia.</span>
              <br><span style="opacity:.7">Tvoj level: <b>Lv ${userLevel}</b></span>
            </p>
            <div class="rpg-perks-grid">${rows}</div>
          </section>
        </div>`;

      el.querySelectorAll('.rpg-perk-btn--go').forEach(btn => {
        btn.addEventListener('click', () => _claimPerk(btn.dataset.perk, btn));
      });
    } catch (e) {
      RpgNet.renderState(el, 'offline', { onRetry: _renderPerksPanel });
    } finally {
      if (_perksCtrl === ctrl) _perksCtrl = null;
    }
  }

  async function _claimPerk(perkKey, btn) {
    if (!perkKey) return;
    btn.disabled = true;
    btn.textContent = '⏳';
    try {
      const result = await RpgNet.request(`/api/rpg/perks/${encodeURIComponent(perkKey)}/use`, { method: 'POST' });
      const data = result.data || {};
      if (result.kind === 'offline') {
        (window.GameUI?.toast || alert)(`${_t('rpg_state_offline_title', 'Server nedostupný')}. ${_t('rpg_retry', 'Skúsiť znova')}.`);
      } else if (result.kind !== 'ok') {
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
      if (window.RpgNet) {
        RpgNet.renderState(el, _lastKind === 'ok' ? 'loading' : _lastKind, {
          onRetry: _loadAndRender,
          onLogin: () => { close(); window.App?.Profile?.open?.(); },
        });
      }
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
      ? `<p class="rpg-stats-no-class">${_esc(_t('rpg_pick_avatar_hint', 'Vyber si avatara a uvidíš atribúty svojej postavy.'))}</p>`
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

        <section class="rpg-stats-section rpg-play-attrs" id="rpg-play-attrs"></section>
      </div>`;
    _renderPlayAttributes();
  }

  // ─── Training from play (Phase 5: GET /api/play/attributes) ─────
  // Escapes quotes too (title attributes); the shared _esc below does not.
  const _escq = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const _tr = (key, fallback) => (window.givemegame_t || ((k, f) => f || k))(key, fallback);
  const SUBTAG_META = {
    motorika:  { key: 'attr_subtag_motorika',  fb: 'Motorika',  icon: '✋' },
    vyziva:    { key: 'attr_subtag_vyziva',    fb: 'Výživa',    icon: '🥕' },
    digitalna: { key: 'attr_subtag_digitalna', fb: 'Digitálne zručnosti', icon: '💻' },
  };
  const COMP_LABELS = {
    'k-uceni':             ['play_comp_k_uceni', 'Učenie'],
    'k-reseni-problemu':   ['play_comp_k_reseni', 'Riešenie problémov'],
    'komunikativni':       ['play_comp_komunikativni', 'Komunikácia'],
    'socialni-personalni': ['play_comp_socialni', 'Spolupráca'],
    'obcanske':            ['play_comp_obcanske', 'Občianske správanie'],
    'pracovni':            ['play_comp_pracovni', 'Práca s úlohou'],
    'digitalni':           ['play_comp_digitalni', 'Digitálne zručnosti'],
  };
  const MODE_FALLBACK = { party: 'Párty', classroom: 'Trieda', reflection: 'Chill', circus: 'Cirkus',
    cooking: 'Varenie', meditation: 'Meditácia', online: 'Online' };

  async function _renderPlayAttributes() {
    const box = document.getElementById('rpg-play-attrs');
    if (!box) return;
    box.innerHTML = `<h3 class="rpg-stats-heading">🌱 ${_escq(_tr('play_attrs_title', 'Tréning z hier'))}</h3>
      <p class="rpg-xp-hint">${_escq(_tr('play_attrs_loading', 'Načítavam…'))}</p>`;
    let data = null;
    try {
      const token = await _token();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      try {
        const res = await fetch('/api/play/attributes', {
          headers: token ? { 'Authorization': `Bearer ${token}` } : {},
          signal: ctrl.signal,
        });
        if (res.ok) data = await res.json();
      } finally { clearTimeout(timer); }
    } catch { data = null; }
    if (!document.body.contains(box)) return;
    if (!data) {
      box.innerHTML = `<h3 class="rpg-stats-heading">🌱 ${_escq(_tr('play_attrs_title', 'Tréning z hier'))}</h3>
        <p class="rpg-xp-hint">${_escq(_tr('play_attrs_error', 'Tréning sa nepodarilo načítať.'))}</p>`;
      return;
    }
    box.innerHTML = _playAttributesHtml(data);
  }

  function _playAttributesHtml(data) {
    const statXp = data.stat_xp || {};
    const manifest = data.manifest || { modes: {}, subtags: {} };
    const max = Math.max(1, ...Object.keys(STAT_META).map(k => statXp[k] || 0));
    const rows = Object.entries(STAT_META).map(([key, meta]) => {
      const xp = statXp[key] || 0;
      const subs = Object.entries(manifest.subtags || {})
        .filter(([tag, parent]) => parent === key && (statXp[tag] || 0) > 0 && SUBTAG_META[tag])
        .map(([tag]) => `
          <div class="rpg-subtag-row">
            <span class="rpg-subtag-icon">${SUBTAG_META[tag].icon}</span>
            <span class="rpg-subtag-label">${_escq(_tr(SUBTAG_META[tag].key, SUBTAG_META[tag].fb))}</span>
            <span class="rpg-subtag-value">${statXp[tag]} XP</span>
          </div>`).join('');
      return `
        <div class="rpg-stat-row">
          <span class="rpg-stat-icon">${meta.icon}</span>
          <span class="rpg-stat-label">${_escq(_tr(`rpg_stat_${key}`, meta.label))}</span>
          <div class="rpg-stat-bar-wrap">
            <div class="rpg-stat-bar" style="width:${Math.round(xp / max * 100)}%;background:${meta.color}"></div>
          </div>
          <span class="rpg-stat-value">${xp} XP</span>
        </div>${subs}`;
    }).join('');

    const comps = (data.competencies || []).map(c => {
      const [k, fb] = COMP_LABELS[c.key] || [null, c.key];
      const avg = c.avg_rating == null ? '' : ` · ${_escq(_tr('play_attrs_avg', 'priemer sebahodnotenia'))} ${c.avg_rating}/5`;
      return `<li class="rpg-play-comp">${_escq(k ? _tr(k, fb) : fb)}: ${c.games} ${_escq(_tr('play_attrs_games_short', 'hier'))}${avg}</li>`;
    }).join('');

    const modes = Object.entries(manifest.modes || {}).map(([mode, m]) => {
      const why = _tr(m.rationale_key, m.rationale);
      const trains = [...m.stats.map(s => _tr(`rpg_stat_${s}`, STAT_META[s]?.label || s)),
        ...m.subtags.map(t => _tr(SUBTAG_META[t]?.key || t, SUBTAG_META[t]?.fb || t))].join(', ');
      return `<div class="rpg-attr-map-row" title="${_escq(why)}">
        <span class="rpg-attr-map-label">${_escq(_tr(`mode_${mode}`, MODE_FALLBACK[mode] || mode))}</span>
        <span class="rpg-attr-map-src">${_escq(trains)}</span>
        <small class="rpg-attr-why">${_escq(why)}</small>
      </div>`;
    }).join('');

    const summary = _tr('play_attrs_summary', 'Odohrané hry: {games} · s reflexiou: {reflected}')
      .replace('{games}', String(data.games || 0)).replace('{reflected}', String(data.reflected || 0));
    return `
      <h3 class="rpg-stats-heading">🌱 ${_escq(_tr('play_attrs_title', 'Tréning z hier'))}</h3>
      <p class="rpg-xp-hint">${_escq(summary)}</p>
      <div class="rpg-stat-list">${rows}</div>
      ${comps ? `<h4 class="rpg-stats-subheading">${_escq(_tr('play_attrs_comp_title', 'Kompetencie a sebahodnotenie'))}</h4>
        <ul class="rpg-play-comp-list">${comps}</ul>` : ''}
      <h4 class="rpg-stats-subheading">${_escq(_tr('play_attrs_modes_title', 'Čo trénuje ktorý režim'))}</h4>
      <div class="rpg-attr-map">${modes}</div>`;
  }

  // ─── DOM wiring (runs once) ──────────────────────────────────────
  function _init() {
    if (_initialized) return;
    _initialized = true;

    const screen = document.getElementById('rpg-screen');
    if (!screen) return;

    // ESC fallback when PxModal is missing (PxModal handles Escape + Tab trap itself)
    screen.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !window.PxModal) close();
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

  /** @returns {boolean} true while the RPG screen is visible */
  function isOpen() {
    const screen = document.getElementById('rpg-screen');
    return Boolean(screen) && screen.style.display !== 'none' && screen.style.display !== '';
  }

  document.addEventListener('DOMContentLoaded', _init);

  return { open, close, updateCoinsDisplay, refresh, isOpen };
})();

window.RpgScreen = RpgScreen;
