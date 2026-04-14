/* ═══════════════════════════════════════════════════════════════════
   gIVEMEGAME.IO — RPG Avatar Picker (Phase 1 Foundation)

   Manages avatar selection, persistence, and display.
   Gated behind school membership (checked server-side).

   Avatar switch / first pick costs gIVEMECOIN (see GET /api/rpg/avatar
   avatar_switch_cost). Deselect (null) is free.

   Dependencies (resolved at call-time):
     • supabaseClient — var in script.js
     • GameUI          — global (game-ui.js)

   Exposes: window.RpgAvatar
   ═══════════════════════════════════════════════════════════════════ */

const RpgAvatar = (() => {
  'use strict';

  // ─── State ──────────────────────────────────────────────────────
  let _data = null;       // cached GET /api/rpg/avatar response
  let _loading = false;
  let _listeners = [];    // future: onSelect callbacks

  const DEFAULT_SWITCH_COST = 5000;

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
  /** @returns {Promise<{ ok: boolean, cost_paid?: number, coins_remaining?: number }>} */
  async function select(avatarId) {
    const token = await _token();
    if (!token) return { ok: false };
    try {
      const res = await _fetch('/api/rpg/avatar', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ avatar_id: avatarId })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 402 && json.code === 'INSUFFICIENT_COINS') {
          if (window.GameUI?.toast) GameUI.toast(`\u274c ${json.error || 'Nedostatok coinov'}`);
        } else if (window.GameUI?.toast) {
          GameUI.toast(`\u274c ${json.error || 'Chyba'}`);
        }
        return { ok: false };
      }

      if (_data) {
        _data.current_avatar_id = json.avatar_id;
        if (typeof json.coins_remaining === 'number') _data.coins = json.coins_remaining;
      }
      if (typeof json.coins_remaining === 'number') {
        if (window.RpgScreen?.updateCoinsDisplay) RpgScreen.updateCoinsDisplay(json.coins_remaining);
        const coinsEl = document.getElementById('profile-coins');
        if (coinsEl) coinsEl.textContent = json.coins_remaining;
        if (window.Coins?.load) await Coins.load();
      }
      if (window.RpgTalents?.clearCache) RpgTalents.clearCache();
      if (window.RpgScreen?.refresh) await RpgScreen.refresh();

      _listeners.forEach(cb => { try { cb(avatarId); } catch {} });
      return {
        ok: true,
        cost_paid: typeof json.cost_paid === 'number' ? json.cost_paid : 0,
        coins_remaining: json.coins_remaining,
      };
    } catch {
      return { ok: false };
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
  function renderProfileAvatar(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.style.display = 'block';

    if (!_data || !_data.eligible) {
      container.innerHTML = `
        <div class="rpg-avatar-section rpg-avatar-empty">
          <div class="rpg-avatar-display rpg-avatar-placeholder">
            <span class="rpg-avatar-placeholder-icon">\u2694\ufe0f</span>
          </div>
          <div class="rpg-avatar-content-col">
            <div class="rpg-avatar-info">
              <span style="font-family:'Press Start 2P',cursive;font-size:9px;display:block;margin-bottom:4px">RPG Avatar</span>
              <span style="font-size:11px;opacity:0.65">Zapoj sa do školy cez gIVEMEEDU a vyber si svojho hrdinu.</span>
            </div>
            <a href="/edu/index.html" class="btn btn-retro rpg-avatar-change-btn" style="text-decoration:none;font-size:10px !important">&#127982; gIVEMEEDU</a>
          </div>
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
          <div class="rpg-avatar-content-col">
            <div class="rpg-avatar-info">
              <span class="rpg-avatar-role-badge rpg-role-${role}">${_esc(roleBadge)}</span>
              <span class="rpg-avatar-school">${_esc(schoolName)}</span>
            </div>
            <button class="btn btn-retro rpg-avatar-change-btn" data-action="open-rpg-screen">\u2694\ufe0f RPG Profil</button>
          </div>
        </div>`;
    } else {
      container.innerHTML = `
        <div class="rpg-avatar-section rpg-avatar-empty">
          <div class="rpg-avatar-display rpg-avatar-placeholder">
            <span class="rpg-avatar-placeholder-icon">\u2694\ufe0f</span>
          </div>
          <div class="rpg-avatar-content-col">
            <div class="rpg-avatar-info">
              <span class="rpg-avatar-role-badge rpg-role-${role}">${_esc(roleBadge)}</span>
              <span class="rpg-avatar-school">${_esc(schoolName)}</span>
            </div>
            <button class="btn btn-retro rpg-avatar-change-btn" data-action="open-rpg-screen">\u2694\ufe0f RPG Profil &#9654;</button>
          </div>
        </div>`;
    }

    container.querySelector('[data-action="open-rpg-screen"]')?.addEventListener('click', () => {
      if (window.RpgScreen) RpgScreen.open();
    });
  }

  // ─── Render: Full Picker Modal ──────────────────────────────────
  async function openPicker() {
    await load();
    if (!_data || !_data.eligible) return;

    const cost = _data.avatar_switch_cost ?? DEFAULT_SWITCH_COST;
    const coins = typeof _data.coins === 'number' ? _data.coins : 0;

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
        <p class="rpg-picker-cost-line">Prvý výber alebo zmena inej postavy: <strong>🪙 ${cost.toLocaleString()}</strong> &middot; máš <strong>${coins.toLocaleString()}</strong></p>
        <div class="rpg-avatar-grid">
          ${avatars.map(a => {
            const isCurrent = a.id === currentId;
            const priceNote = isCurrent
              ? '<span class="rpg-avatar-price rpg-avatar-price--free">aktuálny</span>'
              : `<span class="rpg-avatar-price">${cost.toLocaleString()} 🪙</span>`;
            return `
            <button class="rpg-avatar-option ${isCurrent ? 'rpg-avatar-selected' : ''}"
              data-avatar-id="${a.id}" title="${_esc(a.label)}">
              <img src="${_esc(a.src)}" alt="${_esc(a.label)}" loading="lazy">
              <span class="rpg-avatar-label">${_esc(a.label)}</span>
              ${priceNote}
            </button>`;
          }).join('')}
        </div>
        <p class="rpg-picker-free-note">Zrušenie výberu (bez avatara) je zadarmo.</p>
        <div class="rpg-picker-actions">
          <button class="btn btn-retro rpg-picker-deselect" data-action="deselect-avatar"
            style="${currentId ? '' : 'display:none'}">Zrusit vyber</button>
          <button class="btn btn-retro" data-action="close-picker">Zavriet</button>
        </div>
      </div>`;

    modal.querySelectorAll('[data-action="close-picker"]').forEach(btn => {
      btn.addEventListener('click', () => { modal.style.display = 'none'; });
    });
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.style.display = 'none';
    });

    modal.querySelectorAll('.rpg-avatar-option').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = parseInt(btn.dataset.avatarId, 10);
        if (isNaN(id)) return;
        modal.querySelectorAll('.rpg-avatar-option').forEach(b => b.classList.remove('rpg-avatar-selected'));
        btn.classList.add('rpg-avatar-selected');
        const result = await select(id);
        if (result.ok) {
          renderProfileAvatar('rpg-avatar-container');
          _updateProfileHeaderAvatar(id);
          if (window.GameUI?.toast) {
            if (result.cost_paid > 0) {
              GameUI.toast(`\u2694\ufe0f Avatar zmenený! (\u2212${result.cost_paid.toLocaleString()} gIVEMECOIN)`);
            } else {
              GameUI.toast('\u2694\ufe0f Avatar aktualizovaný!');
            }
          }
        }
      });
    });

    modal.querySelector('[data-action="deselect-avatar"]')?.addEventListener('click', async () => {
      const result = await select(null);
      if (result.ok) {
        renderProfileAvatar('rpg-avatar-container');
        _updateProfileHeaderAvatar(null);
        modal.style.display = 'none';
        if (window.GameUI?.toast) GameUI.toast('Avatar zruseny');
      }
    });
  }

  function _updateProfileHeaderAvatar(avatarId) {
    const el = document.getElementById('profile-avatar');
    if (!el) return;
    if (avatarId) {
      el.innerHTML = `<img src="/avatars/${avatarId}.png" alt="RPG Avatar" style="width:100%;height:100%;object-fit:cover;border-radius:50%;image-rendering:pixelated;">`;
    } else {
      const user = window.getCurrentUser ? window.getCurrentUser() : null;
      if (user?.photo) {
        el.innerHTML = `<img src="${user.photo}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`;
      } else {
        el.textContent = '\ud83d\udc64';
      }
    }
  }

  function onSelect(cb) { _listeners.push(cb); }
  function getAnimClass() { return getCurrentId() ? 'rpg-avatar-idle' : ''; }

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
