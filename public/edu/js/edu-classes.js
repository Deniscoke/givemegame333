/**
 * gIVEMEEDU — Classes page logic
 */
const EduClasses = (function () {
  'use strict';

  let _classes = [];
  let _currentClassId = null; // tracks which class the modal is showing

  async function load() {
    const { classes, role } = await EduAuth.apiFetch('/classes');
    _classes = classes || [];
    render(role);
  }

  function render(role) {
    const container = document.getElementById('classes-list');
    if (!container) return;

    if (_classes.length === 0) {
      container.innerHTML = `<div class="edu-empty"><div class="edu-empty-icon">&#128218;</div><p>Ziadne triedy</p></div>`;
      return;
    }

    let html = `<table class="edu-table">
      <thead><tr>
        <th>Nazov</th><th>Rocnik</th><th>Skolsky rok</th><th>Ziaci</th><th></th>
      </tr></thead><tbody>`;

    for (const c of _classes) {
      html += `<tr>
        <td><strong>${esc(c.name)}</strong></td>
        <td>${c.grade_level || '-'}</td>
        <td>${esc(c.school_year)}</td>
        <td>${c.student_count || '-'}</td>
        <td>
          <button class="edu-btn edu-btn-sm edu-btn-secondary"
            data-action="show-students"
            data-class-id="${esc(c.id)}"
            data-class-name="${esc(c.name)}">Ziaci</button>
        </td>
      </tr>`;
    }
    html += '</tbody></table>';
    container.innerHTML = html;
    attachClassListeners();
  }

  async function showStudents(classId, className) {
    const modal = document.getElementById('students-modal');
    const body = document.getElementById('students-modal-body');
    const title = document.getElementById('students-modal-title');
    if (!modal || !body) return;

    _currentClassId = classId;
    title.textContent = 'Ziaci \u2014 ' + className;
    body.innerHTML = '<div class="edu-loading"><div class="edu-spinner"></div></div>';
    modal.style.display = 'flex';

    // Show enroll form only for admins
    const enrollForm = document.getElementById('enroll-student-form');
    if (enrollForm) {
      enrollForm.style.display = EduApp.getRole() === 'admin' ? 'block' : 'none';
    }
    // Clear previous enroll state
    const enrollMsg = document.getElementById('enroll-msg');
    if (enrollMsg) enrollMsg.textContent = '';
    const enrollEmail = document.getElementById('enroll-email');
    if (enrollEmail) enrollEmail.value = '';

    await _loadStudentList(classId, body);
  }

  async function _loadStudentList(classId, body) {
    try {
      const { students } = await EduAuth.apiFetch(`/students?class_id=${classId}`);
      if (!students || students.length === 0) {
        body.innerHTML = '<p style="color:var(--edu-text-muted)">Ziadni ziaci v triede.</p>';
        return;
      }
      let html = '<table class="edu-table"><thead><tr><th>Meno</th><th>Zapisany</th></tr></thead><tbody>';
      for (const s of students) {
        html += `<tr><td>${esc(s.display_name || 'Bez mena')}</td><td>${new Date(s.enrolled_at).toLocaleDateString('sk')}</td></tr>`;
      }
      html += '</tbody></table>';
      body.innerHTML = html;
    } catch (e) {
      body.innerHTML = `<div class="edu-alert edu-alert-error">${esc(e.message)}</div>`;
    }
  }

  async function enrollStudent() {
    const emailEl = document.getElementById('enroll-email');
    const msgEl = document.getElementById('enroll-msg');
    const btn = document.getElementById('btn-enroll-student');
    const email = (emailEl?.value || '').trim().toLowerCase();

    if (!email) { _setEnrollMsg(msgEl, 'Zadaj email ziaka', 'error'); return; }
    if (!_currentClassId) { _setEnrollMsg(msgEl, 'Ziadna trieda', 'error'); return; }

    if (btn) btn.disabled = true;
    _setEnrollMsg(msgEl, 'Hladam...', '');

    try {
      // Step 1: resolve email → user id
      const { user } = await EduAuth.apiFetch(`/users/by-email?email=${encodeURIComponent(email)}`);
      if (!user?.id) { _setEnrollMsg(msgEl, 'Pou\u017e\u00edvate\u013e nebol n\u00e1jden\u00fd', 'error'); return; }

      // Step 2: enroll the student
      await EduAuth.apiFetch('/students', {
        method: 'POST',
        body: { class_id: _currentClassId, student_id: user.id }
      });

      _setEnrollMsg(msgEl, '\u2713 Ziak bol zap\u00edsan\u00fd', 'success');
      if (emailEl) emailEl.value = '';

      // Refresh the student list in place
      const body = document.getElementById('students-modal-body');
      if (body) await _loadStudentList(_currentClassId, body);
    } catch (e) {
      _setEnrollMsg(msgEl, esc(e.message), 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function _setEnrollMsg(el, text, type) {
    if (!el) return;
    el.textContent = text;
    el.style.color = type === 'error' ? 'var(--edu-danger,#ef4444)'
      : type === 'success' ? 'var(--edu-success,#22c55e)'
      : 'var(--edu-text-muted,#6b7280)';
  }

  function closeModal() {
    const modal = document.getElementById('students-modal');
    if (modal) modal.style.display = 'none';
  }

  async function createClass() {
    const name = document.getElementById('new-class-name').value.trim();
    const year = document.getElementById('new-class-year').value.trim();
    const grade = document.getElementById('new-class-grade').value;
    if (!name || !year) {
      EduApp.showAlert('alerts', 'Nazov a skolsky rok su povinne', 'error');
      return;
    }
    try {
      await EduAuth.apiFetch('/classes', {
        method: 'POST',
        body: { name, school_year: year, grade_level: grade ? parseInt(grade) : null }
      });
      EduApp.clearAlert('alerts');
      document.getElementById('create-class-form').style.display = 'none';
      await load();
    } catch (e) {
      EduApp.showAlert('alerts', 'Chyba: ' + esc(e.message), 'error');
    }
  }

  // ─── Attach event listeners after rendering ──────────────────
  // Uses data-* attributes instead of inline onclick to avoid XSS via class name.
  function attachClassListeners() {
    const container = document.getElementById('classes-list');
    if (!container) return;
    container.querySelectorAll('[data-action="show-students"]').forEach(btn => {
      btn.addEventListener('click', () => {
        showStudents(btn.dataset.classId, btn.dataset.className);
      });
    });
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  return { load, showStudents, closeModal, createClass, enrollStudent };
})();
