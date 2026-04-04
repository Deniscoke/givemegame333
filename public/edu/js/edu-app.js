/**
 * gIVEMEEDU — App shell controller
 * Initializes auth, renders sidebar/topbar, manages page state.
 */
const EduApp = (function () {
  'use strict';

  let _profile = null;

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
      ${s ? `<span class="edu-topbar-role">${s.role}</span>` : ''}
      <span>${u.email || 'User'}</span>
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

  function showAlert(containerId, message, type = 'info') {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = `<div class="edu-alert edu-alert-${type}">${message}</div>`;
  }

  function clearAlert(containerId) {
    const el = document.getElementById(containerId);
    if (el) el.innerHTML = '';
  }

  // Mobile sidebar toggle
  function toggleSidebar() {
    document.querySelector('.edu-sidebar')?.classList.toggle('open');
  }

  return { init, getRole, getSchoolId, hasSchool, showAlert, clearAlert, toggleSidebar };
})();
