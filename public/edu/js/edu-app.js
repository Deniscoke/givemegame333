/**
 * gIVEMEEDU — App shell controller
 * Initializes auth, renders sidebar/topbar, manages page state.
 */
const EduApp = (function () {
  'use strict';

  let _profile = null;

  // ─── HTML escape ─────────────────────────────────────────────
  function esc(str) {
    const d = document.createElement('div');
    d.textContent = String(str || '');
    return d.innerHTML;
  }

  async function init() {
    try {
      _profile = await EduAuth.loadProfile();
    } catch (e) {
      window.location.href = '/';
      return null;
    }
    renderTopbar();
    renderSidebarState();
    return _profile;
  }

  function renderTopbar() {
    const userEl = document.getElementById('edu-topbar-user');
    if (!userEl || !_profile) return;
    const u = _profile.user;
    const s = _profile.school;
    userEl.innerHTML = `
      ${s ? `<span class="edu-topbar-role">${esc(s.role)}</span>` : ''}
      <span>${esc(u.email || 'User')}</span>
      <button onclick="EduAuth.logout()" class="edu-btn edu-btn-sm edu-btn-secondary">Odhlasiť</button>
    `;
  }

  function renderSidebarState() {
    // Highlight active nav item based on current page
    const path = window.location.pathname;
    document.querySelectorAll('.edu-sidebar-nav a').forEach(a => {
      a.classList.toggle('active', a.getAttribute('href') === path || a.getAttribute('href') === path.replace(/\/$/, ''));
    });
  }

  function getRole() {
    return _profile?.school?.role || null;
  }

  function getSchoolId() {
    return _profile?.school?.id || null;
  }

  function hasSchool() {
    return !!_profile?.school;
  }

  // showAlert treats `message` as trusted HTML — callers MUST escape user-controlled
  // content before passing (e.g. esc(err.message)). Only `type` is auto-escaped here
  // to prevent CSS class injection if a bad value is ever passed programmatically.
  function showAlert(containerId, message, type = 'info') {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = `<div class="edu-alert edu-alert-${esc(type)}">${message}</div>`;
  }

  function clearAlert(containerId) {
    const el = document.getElementById(containerId);
    if (el) el.innerHTML = '';
  }

  /**
   * Show a full-page access denied message and disable further interaction.
   * Call this when the current user's role does not permit viewing the page.
   * @param {string} [reason] - Optional human-readable reason.
   */
  function showAccessDenied(reason) {
    const main = document.querySelector('.edu-content') || document.querySelector('main');
    if (!main) return;
    main.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
                  padding:64px 24px;text-align:center;color:#6b7280">
        <div style="font-size:48px;margin-bottom:16px">🔒</div>
        <h2 style="font-size:20px;font-weight:700;color:#374151;margin-bottom:8px">Prístup zamietnutý</h2>
        <p style="max-width:360px;line-height:1.6">${reason || 'Nemáte oprávnenie na zobrazenie tejto stránky.'}</p>
        <a href="/edu/index.html" style="margin-top:24px;padding:10px 20px;background:#2563eb;
           color:#fff;border-radius:8px;text-decoration:none;font-weight:600">← Späť na dashboard</a>
      </div>`;
  }

  // Mobile sidebar toggle
  function toggleSidebar() {
    document.querySelector('.edu-sidebar')?.classList.toggle('open');
  }

  return { init, getRole, getSchoolId, hasSchool, showAlert, clearAlert, toggleSidebar, showAccessDenied };
})();
