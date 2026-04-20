/**
 * edu-members.js — School membership management for gIVEMEEDU (Sprint 1)
 *
 * Active roles: admin, teacher, student
 * Deferred to Sprint 2: parent (requires edu_parent_student_links table)
 *
 * Access:
 *  - admin: view all, add members, change roles, remove members
 *  - teacher: view-only
 *  - student: redirected away (no access)
 */

const EduMembers = (() => {
  // Sprint 1 roles only. Do NOT add 'parent' here until Sprint 2.
  const ROLE_LABELS = {
    admin:   'Administrator',
    teacher: 'Ucitel',
    student: 'Ziak',
  };

  let members = [];
  let currentFilter = 'all';
  let isAdmin = false;

  // ─── Init ────────────────────────────────────────────────────
  async function init() {
    const role = EduApp.getRole();
    if (!role) {
      window.location.href = '/edu/index.html';
      return;
    }
    // Students have no access to member management
    if (role === 'student') {
      EduApp.showAccessDenied('Zoznam členov môžu zobrazovať len učitelia a administrátori.');
      return;
    }
    isAdmin = (role === 'admin');
    if (isAdmin) {
      document.getElementById('btn-show-add').style.display = '';
    }
    await loadMembers();
  }

  // ─── Load members from API ───────────────────────────────────
  async function loadMembers() {
    try {
      const data = await EduAuth.apiFetch('/members');
      members = data.members || [];
      renderStats();
      renderList();
    } catch (err) {
      EduApp.showAlert('alerts', 'Chyba pri načítaní členov: ' + err.message, 'error');
      document.getElementById('members-list').innerHTML = '';
    }
  }

  // ─── Render role stats ───────────────────────────────────────
  function renderStats() {
    const counts = { admin: 0, teacher: 0, student: 0 };
    members.forEach(m => { if (counts[m.role] !== undefined) counts[m.role]++; });
    document.getElementById('count-admin').textContent   = counts.admin;
    document.getElementById('count-teacher').textContent = counts.teacher;
    document.getElementById('count-student').textContent = counts.student;
  }

  // ─── Render member list (filtered) ──────────────────────────
  function renderList() {
    const list = document.getElementById('members-list');
    const filtered = currentFilter === 'all'
      ? members
      : members.filter(m => m.role === currentFilter);

    if (filtered.length === 0) {
      list.innerHTML = `
        <div class="edu-empty">
          <div class="edu-empty-icon">👥</div>
          <p>${currentFilter === 'all' ? 'Žiadni členovia' : 'Žiadni členovia v tejto role'}</p>
        </div>`;
      return;
    }

    list.innerHTML = filtered.map(m => memberRow(m)).join('');
    attachMemberListeners();
  }

  // ─── Single member row HTML ──────────────────────────────────
  // XSS note: no inline onclick/onchange — use data-* attributes + addEventListener.
  // esc() HTML-encodes attribute values (safe); data attributes never execute as JS.
  function memberRow(m) {
    const name = m.display_name || m.user_id.substring(0, 8) + '\u2026';
    const isSelf = m.user_id === EduAuth.getProfile()?.user?.id;

    const avatarHtml = m.avatar_url
      ? `<img class="member-avatar" src="${esc(m.avatar_url)}" alt="" onerror="this.style.display='none'">`
      : `<div class="member-avatar-placeholder">\u{1F464}</div>`;

    const roleSelectHtml = isAdmin
      ? `<select class="role-select" data-member-id="${esc(m.id)}"
           ${isSelf ? 'disabled title="Nem\u00f4\u017eete zmeni\u0165 vlastn\u00fa rolu"' : ''}>
           ${Object.entries(ROLE_LABELS).map(([val, label]) =>
             `<option value="${val}" ${m.role === val ? 'selected' : ''}>${label}</option>`
           ).join('')}
         </select>`
      : `<span class="role-badge ${m.role}">${ROLE_LABELS[m.role] || m.role}</span>`;

    const removeBtn = isAdmin && !isSelf
      ? `<button class="btn-remove" data-action="remove"
           data-member-id="${esc(m.id)}"
           data-member-name="${esc(name)}">Odstr\u00e1ni\u0165</button>`
      : '';

    const expandBtn = m.role === 'student'
      ? `<button class="btn-expand" data-action="expand" data-user-id="${esc(m.user_id)}" data-member-id="${esc(m.id)}">RPG &#9662;</button>`
      : '';

    return `
      <div class="member-row" id="member-row-${m.id}">
        ${avatarHtml}
        <div class="member-info">
          <div class="member-name">${esc(name)}</div>
          <div class="member-uid">${esc(m.user_id)}</div>
        </div>
        <div class="member-actions">
          ${expandBtn}
          ${roleSelectHtml}
          ${removeBtn}
        </div>
      </div>
      <div class="rpg-inline" id="rpg-inline-${esc(m.id)}" style="display:none"></div>`;
  }

  // ─── Attach event listeners after rendering ──────────────────
  // Uses dataset instead of inline JS — eliminates XSS via display_name.
  function attachMemberListeners() {
    const list = document.getElementById('members-list');
    if (!list) return;
    list.querySelectorAll('[data-action="remove"]').forEach(btn => {
      btn.addEventListener('click', () => {
        removeMember(btn.dataset.memberId, btn.dataset.memberName);
      });
    });
    list.querySelectorAll('select.role-select').forEach(sel => {
      sel.addEventListener('change', () => {
        changeRole(sel.dataset.memberId, sel.value);
      });
    });
    list.querySelectorAll('[data-action="expand"]').forEach(btn => {
      btn.addEventListener('click', () => toggleRpg(btn));
    });
  }

  // ─── Inline RPG detail (teacher view of student progress) ─────
  const _rpgCache = new Map();

  async function toggleRpg(btn) {
    const memberId = btn.dataset.memberId;
    const userId = btn.dataset.userId;
    const panel = document.getElementById(`rpg-inline-${memberId}`);
    if (!panel) return;
    const isOpen = panel.style.display !== 'none';
    if (isOpen) {
      panel.style.display = 'none';
      btn.classList.remove('open');
      btn.innerHTML = 'RPG \u25BE';
      return;
    }
    btn.classList.add('open');
    btn.innerHTML = 'RPG \u25B4';
    panel.style.display = 'block';
    if (_rpgCache.has(userId)) {
      renderRpgInline(panel, _rpgCache.get(userId));
      return;
    }
    panel.innerHTML = '<div class="edu-loading"><div class="edu-spinner"></div></div>';
    try {
      const data = await EduAuth.apiFetch(`/students/${encodeURIComponent(userId)}/rpg`);
      _rpgCache.set(userId, data);
      renderRpgInline(panel, data);
    } catch (err) {
      panel.innerHTML = `<div style="color:#fca5a5">Chyba: ${esc(err.message)}</div>`;
    }
  }

  function renderRpgInline(panel, data) {
    const p = data.progression || {};
    const s = data.student || {};
    const stats = data.stats || {};
    const talents = data.talents || [];
    const perks = data.perks || [];
    const xpPct = p.xp_to_next > 0
      ? Math.min(100, Math.round(((p.xp_in_level || 0) / (p.xp_to_next || 1)) * 100))
      : 100;

    const statsHtml = Object.entries(stats).map(([k, v]) => `
      <div class="rpg-inline-tile">
        <div class="rpg-inline-tile-label">${esc(k)}</div>
        <div class="rpg-inline-tile-val">${esc(v)}</div>
      </div>`).join('');

    const perksHtml = perks.map(pk => {
      const cls = ['rpg-inline-perk'];
      if (!pk.unlocked) cls.push('locked');
      if (pk.last_status === 'approved' || pk.last_status === 'auto_approved') cls.push('used');
      const title = `Lv${pk.level} · ${pk.title}${pk.last_status ? ' (' + pk.last_status + ')' : ''}`;
      return `<div class="${cls.join(' ')}" title="${esc(title)}">${esc(pk.icon || '🎁')}<span class="rpg-inline-perk-level">Lv${esc(pk.level)}</span></div>`;
    }).join('');

    const talentsLine = talents.length
      ? talents.map(t => esc(t.title)).join(' · ')
      : 'Ziadne odomknute talenty';

    panel.innerHTML = `
      <div><strong style="color:#e9d5ff">Level ${esc(p.level || 1)}</strong> · ${esc(p.xp || 0)} XP · Class: ${esc(s.class_id || '—')} · Hry: ${esc(s.games_generated || 0)}</div>
      <div class="rpg-xp-bar"><div class="rpg-xp-bar-fill" style="width:${xpPct}%"></div></div>
      <div style="font-size:14px;color:#94a3b8;margin-top:2px">${esc(p.xp_in_level || 0)} / ${esc(p.xp_to_next || 0)} do Lv ${esc((p.level || 1) + 1)}</div>

      <div class="rpg-inline-title">Staty</div>
      <div class="rpg-inline-grid">${statsHtml || '<div style="color:#64748b">—</div>'}</div>

      <div class="rpg-inline-title">Talenty</div>
      <div>${talentsLine}</div>

      <div class="rpg-inline-title">Odmeny (🎁)</div>
      <div class="rpg-inline-perks">${perksHtml}</div>
    `;
  }

  // ─── Filter by role ──────────────────────────────────────────
  function filter(role, btn) {
    currentFilter = role;
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    renderList();
  }

  // ─── Toggle add member form ───────────────────────────────────
  function toggleAddForm() {
    const form = document.getElementById('add-member-form');
    const visible = form.style.display !== 'none';
    form.style.display = visible ? 'none' : 'block';
    if (!visible) document.getElementById('add-email').focus();
    EduApp.clearAlert('add-alerts');
  }

  // ─── Add member by email ─────────────────────────────────────
  async function addMember() {
    const email = document.getElementById('add-email').value.trim();
    const role  = document.getElementById('add-role').value;
    if (!email) {
      EduApp.showAlert('add-alerts', 'Zadaj email pou\u017e\u00edvate\u013ea.', 'error');
      return;
    }
    try {
      // Step 1: resolve email → user_id
      const userData = await EduAuth.apiFetch(`/users/by-email?email=${encodeURIComponent(email)}`);
      const targetUser = userData.user;

      // Step 2: add/update membership — pass plain object, apiFetch handles stringify
      await EduAuth.apiFetch('/members', {
        method: 'POST',
        body: { user_id: targetUser.id, role }
      });

      EduApp.showAlert('add-alerts', `${esc(targetUser.display_name || email)} bol pridan\u00fd ako ${ROLE_LABELS[role]}.`, 'success');
      document.getElementById('add-email').value = '';
      await loadMembers();
    } catch (err) {
      EduApp.showAlert('add-alerts', esc(err.message), 'error');
    }
  }

  // ─── Change role via select dropdown ────────────────────────
  async function changeRole(memberId, newRole) {
    try {
      await EduAuth.apiFetch(`/members/${memberId}`, {
        method: 'PATCH',
        body: { role: newRole }  // plain object — apiFetch handles stringify
      });
      const idx = members.findIndex(m => m.id === memberId);
      if (idx !== -1) members[idx].role = newRole;
      renderStats();
      EduApp.showAlert('alerts', `Rola zmenen\u00e1 na ${ROLE_LABELS[newRole]}.`, 'success');
      setTimeout(() => EduApp.clearAlert('alerts'), 3000);
    } catch (err) {
      EduApp.showAlert('alerts', 'Chyba pri zmene roly: ' + esc(err.message), 'error');
      renderList(); // reset select to previous value
    }
  }

  // ─── Remove member ───────────────────────────────────────────
  async function removeMember(memberId, name) {
    if (!confirm(`Naozaj chcete odstr\u00e1ni\u0165 \u010dlena "${name}" zo \u0161k\u00f4ly?`)) return;
    try {
      await EduAuth.apiFetch(`/members/${memberId}`, { method: 'DELETE' });
      members = members.filter(m => m.id !== memberId);
      renderStats();
      renderList();
      EduApp.showAlert('alerts', `\u010clen "${esc(name)}" bol odstr\u00e1nen\u00fd.`, 'success');
      setTimeout(() => EduApp.clearAlert('alerts'), 4000);
    } catch (err) {
      EduApp.showAlert('alerts', 'Chyba pri odstra\u0148ovan\u00ed \u010dlena: ' + esc(err.message), 'error');
    }
  }

  // ─── HTML escape ─────────────────────────────────────────────
  function esc(str) {
    const d = document.createElement('div');
    d.textContent = String(str || '');
    return d.innerHTML;
  }

  return { init, filter, toggleAddForm, addMember, changeRole, removeMember };
})();
