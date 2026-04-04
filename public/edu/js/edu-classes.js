/**
 * gIVEMEEDU — Classes page logic
 */
const EduClasses = (function () {
  'use strict';

  let _classes = [];

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
          <button class="edu-btn edu-btn-sm edu-btn-secondary" onclick="EduClasses.showStudents('${c.id}', '${esc(c.name)}')">Ziaci</button>
        </td>
      </tr>`;
    }
    html += '</tbody></table>';
    container.innerHTML = html;
  }

  async function showStudents(classId, className) {
    const modal = document.getElementById('students-modal');
    const body = document.getElementById('students-modal-body');
    const title = document.getElementById('students-modal-title');
    if (!modal || !body) return;

    title.textContent = 'Ziaci — ' + className;
    body.innerHTML = '<div class="edu-loading"><div class="edu-spinner"></div></div>';
    modal.style.display = 'flex';

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
      body.innerHTML = `<div class="edu-alert edu-alert-error">${e.message}</div>`;
    }
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
      EduApp.showAlert('alerts', 'Chyba: ' + e.message, 'error');
    }
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  return { load, showStudents, closeModal, createClass };
})();
