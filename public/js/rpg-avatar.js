/* ═══════════════════════════════════════════════════════════════════
   gIVEMEGAME.IO — RPG Avatar Picker (Phase 1 Foundation)

   Manages avatar selection, persistence, and display.
   Gated behind school membership (checked server-side).

   Dependencies (resolved at call-time):
     • supabaseClient — var in script.js
     • GameUI          — global (game-ui.js)

   Future hooks (not implemented yet):
     • RpgAvatar.onSelect(cb)  — subscribe to avatar changes
     • RpgAvatar.getAnimClass() — CSS class for idle animation
     • RpgAvatar.playSfx(event) — avatar-specific sound effects

   Exposes: window.RpgAvatar
   ═══════════════════════════════════════════════════════════════════ */

const RpgAvatar = (() => {
  'use strict';

  // ─── State ──────────────────────────────────────────────────────
  let _data = null;       // cached GET /api/rpg/avatar response
  let _loading = false;
  let _listeners = [];    // future: onSelect callbacks

  // ─── Helpers ────────────────────────────────────────────────────
  async function _token() {
    try {
      if (!window.supabaseClient) return null;
      const { data: { session } } = await Promise.race([
        window.supabaseClient.auth.getSession(),
        new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 8000))
      ]);
      return session?.access_token || null;
    } catch { return null; }
  }

  async function _fetch(url, opts = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
    finally { clearTimeout(t); }
  }

  // ─── Load ───────────────────────────────────────────────────────
  // Fetches eligibility + current avatar + available list from server.
  async function load() {
    if (_loading) return _data;
    _loading = true;
    try {
      const token = await _token();
      if (!token) { _data = null; return null; }
      const res = await _fetch('/api/rpg/avatar', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) { _data = null; return null; }
      _data = await res.json();
      return _data;
    } catch {
      _data = null;
      return null;
    } finally {
      _loading = false;
    }
  }

  // ─── Select ─────────────────────────────────────────────────────
  async function select(avatarId) {
    const token = await _token();
    if (!token) return false;
    try {
      const res = await _fetch('/api/rpg/avatar', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ avatar_id: avatarId })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (window.GameUI?.toast) GameUI.toast(`\u274c ${err.error || 'Chyba'}`);
        return false;
      }
      // Update local state
      if (_data) _data.current_avatar_id = avatarId;
      _listeners.forEach(cb => { try { cb(avatarId); } catch {} });
      return true;
    } catch {
      return false;
    }
  }

  // ─── Getters ────────────────────────────────────────────────────
  function isEligible()     { return _data?.eligible === true; }
  function getCurrentId()   { return _data?.current_avatar_id || null; }
  function getAvatarSrc(id) { return id ? `/avatars/${id}.png` : null; }
  function getAvailable()   { return _data?.available || []; }
  function getRole()        { return _data?.role || null; }
  function getSchoolName()  { return _data?.school_name || null; }

  // ─── Render: Profile Avatar Section ─────────────────────────────
  // Always shows — school members see the picker, non-members see a CTA
  // to join a school via gIVEMEEDU.
  function renderProfileAvatar(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.style.display = 'block';

    // Not eligible: no school membership → show teaser / CTA
    if (!_data || !_data.eligible) {
      container.innerHTML = `
        <div class="rpg-avatar-section rpg-avatar-empty">
          <div class="rpg-avatar-display rpg-avatar-placeholder">
            <span class="rpg-avatar-placeholder-icon">\u2694\ufe0f</span>
          </div>
          <div class="rpg-avatar-info" style="flex:1">
            <span style="font-family:'Press Start 2P',cursive;font-size:9px;display:block;margin-bottom:4px">RPG Avatar</span>
            <span style="font-size:11px;opacity:0.65">Zapoj sa do školy cez gIVEMEEDU a vyber si svojho hrdinu.</span>
          </div>
          <a href="/edu/index.html" class="btn btn-retro rpg-avatar-change-btn" style="text-decoration:none;font-size:10px !important">&#127982; gIVEMEEDU</a>
        </div>`;
      return;
    }

    const currentId = _data.current_avatar_id;
    const schoolName = _data.school_name || '';
    const role = _data.role || '';
    const roleLabels = { admin: 'Admin', teacher: 'Učiteľ', student: 'Žiak' };
    const roleBadge = roleLabels[role] || role;

    if (currentId) {
      container.innerHTML = `
        <div class="rpg-avatar-section">
          <div class="rpg-avatar-display">
            <img src="/avatars/${currentId}.png" alt="RPG Avatar" class="rpg-avatar-img rpg-avatar-idle" loading="lazy">
          </div>
          <div class="rpg-avatar-info">
            <span class="rpg-avatar-role-badge rpg-role-${role}">${_esc(roleBadge)}</span>
            <span class="rpg-avatar-school">${_esc(schoolName)}</span>
          </div>
          <button class="btn btn-retro rpg-avatar-change-btn" data-action="open-rpg-screen">\u2694\ufe0f RPG Profil</button>
        </div>`;
    } else {
      container.innerHTML = `
        <div class="rpg-avatar-section rpg-avatar-empty">
          <div class="rpg-avatar-display rpg-avatar-placeholder">
            <span class="rpg-avatar-placeholder-icon">\u2694\ufe0f</span>
          </div>
          <div class="rpg-avatar-info">
            <span class="rpg-avatar-role-badge rpg-role-${role}">${_esc(roleBadge)}</span>
            <span class="rpg-avatar-school">${_esc(schoolName)}</span>
          </div>
          <button class="btn btn-retro rpg-avatar-change-btn" data-action="open-rpg-screen">\u2694\ufe0f RPG Profil &#9654;</button>
        </div>`;
    }

    container.querySelector('[data-action="open-rpg-screen"]')?.addEventListener('click', () => {
      if (window.RpgScreen) RpgScreen.open();
    });
  }

  // ─── Render: Full Picker Modal ──────────────────────────────────
  function openPicker() {
    if (!_data || !_data.eligible) return;

    let modal = document.getElementById('rpg-avatar-picker-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'rpg-avatar-picker-modal';
      modal.className = 'modal-overlay';
      document.body.appendChild(modal);
    }
    modal.style.display = 'flex';

    const avatars = _data.available || [];
    const currentId = _data.current_avatar_id;

    modal.innerHTML = `
      <div class="modal-box rpg-picker-box">
        <div class="modal-header" style="justify-content:space-between">
          <h3>\u2694\ufe0f Vyber si avatara</h3>
          <button class="modal-close" data-action="close-picker">\u2715</button>
        </div>
        <p class="rpg-picker-hint">Tvoj pixel-art avatar pre RPG svet gIVEMEGAME</p>
        <div class="rpg-avatar-grid">
          ${avatars.map(a => `
            <button class="rpg-avatar-option ${a.id === currentId ? 'rpg-avatar-selected' : ''}"
              data-avatar-id="${a.id}" title="${_esc(a.label)}">
              <img src="${_esc(a.src)}" alt="${_esc(a.label)}" loading="lazy">
              <span class="rpg-avatar-label">${_esc(a.label)}</span>
            </button>
          `).join('')}
        </div>
        <div class="rpg-picker-actions">
          <button class="btn btn-retro rpg-picker-deselect" data-action="deselect-avatar"
            style="${currentId ? '' : 'display:none'}">Zrusit vyber</button>
          <button class="btn btn-retro" data-action="close-picker">Zavriet</button>
        </div>
      </div>`;

    // Bind events
    modal.querySelectorAll('[data-action="close-picker"]').forEach(btn => {
      btn.addEventListener('click', () => { modal.style.display = 'none'; });
    });
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.style.display = 'none';
    });

    modal.querySelectorAll('.rpg-avatar-option').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = parseInt(btn.dataset.avatarId);
        if (isNaN(id)) return;
        // Optimistic UI
        modal.querySelectorAll('.rpg-avatar-option').forEach(b => b.classList.remove('rpg-avatar-selected'));
        btn.classList.add('rpg-avatar-selected');
        const ok = await select(id);
        if (ok) {
          // Refresh profile display
          renderProfileAvatar('rpg-avatar-container');
          _updateProfileHeaderAvatar(id);
          if (window.GameUI?.toast) GameUI.toast('\u2694\ufe0f Avatar zmeneny!');
        }
      });
    });

    modal.querySelector('[data-action="deselect-avatar"]')?.addEventListener('click', async () => {
      const ok = await select(null);
      if (ok) {
        renderProfileAvatar('rpg-avatar-container');
        _updateProfileHeaderAvatar(null);
        modal.style.display = 'none';
        if (window.GameUI?.toast) GameUI.toast('Avatar zruseny');
      }
    });
  }

  // ─── Update the main profile-avatar element ─────────────────────
  function _updateProfileHeaderAvatar(avatarId) {
    const el = document.getElementById('profile-avatar');
    if (!el) return;
    if (avatarId) {
      el.innerHTML = `<img src="/avatars/${avatarId}.png" alt="RPG Avatar" style="width:100%;height:100%;object-fit:cover;border-radius:50%;image-rendering:pixelated;">`;
    } else {
      // Fall back to Google photo or default emoji
      const user = window.getCurrentUser ? window.getCurrentUser() : null;
      if (user?.photo) {
        el.innerHTML = `<img src="${user.photo}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`;
      } else {
        el.textContent = '\ud83d\udc64';
      }
    }
  }

  // ─── Future hooks (no-op for now) ───────────────────────────────
  function onSelect(cb) { _listeners.push(cb); }
  function getAnimClass() { return getCurrentId() ? 'rpg-avatar-idle' : ''; }

  // ─── Escape ─────────────────────────────────────────────────────
  function _esc(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  return {
    load,
    select,
    isEligible,
    getCurrentId,
    getAvatarSrc,
    getAvailable,
    getRole,
    getSchoolName,
    renderProfileAvatar,
    openPicker,
    onSelect,
    getAnimClass,
  };
})();

window.RpgAvatar = RpgAvatar;
